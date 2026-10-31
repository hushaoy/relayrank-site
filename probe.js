"use strict";

/**
 * 真实探测引擎 —— 五维分数全部由本机发出的真实网络请求算出。
 *
 * 可用性 availability : DNS / TCP / TLS / TTFB 耗时
 * 稳定性 stability    : 连续多次探测的成功率 + TTFB 变异系数
 * 安全   security     : HTTPS、TLS 版本、证书剩余天数、HSTS、安全响应头
 * 完整性 integrity    : content-length 与实际字节、压缩、结构与关键响应头
 * 真实性 authenticity : /v1/models 公开性 + （提供 key 时）/v1/chat/completions 回包自检
 *
 * 没有 key 时真实性返回 null，绝不伪造；由调用方保留原值并标注来源。
 */

const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");
const { assertPublicUrl } = require("./security.js");

const UA = "RelayRank-Probe/1.0 (+benchmark-station)";
const DEFAULT_TIMEOUT = 30000;
const MAX_BODY_BYTES = Number(process.env.PROBE_MAX_BYTES || 2 * 1024 * 1024);

function now() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function round(v, digits = 1) {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

/**
 * 单次 HTTP 探测，记录 DNS / TCP / TLS / TTFB / 总耗时。
 */
async function requestOnce(rawUrl, { timeout = DEFAULT_TIMEOUT, method = "GET", body = null, headers = {}, family = 0 } = {}) {
  let guard;
  const hasAuthHeader = Object.keys(headers || {}).some((key) => key.toLowerCase() === "authorization");
  try {
    guard = await assertPublicUrl(rawUrl, { allowHttp: !hasAuthHeader });
  } catch (e) {
    return { ok: false, stage: "guard", error: e.message, marks: {} };
  }

  return new Promise((resolve) => {
    const u = guard.url;
    const lib = u.protocol === "https:" ? https : http;
    const marks = { dns: guard.dnsMs };
    const started = now();
    let settled = false;
    let totalTimer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      resolve({ ...payload, marks });
    };

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        agent: false,
        headers: {
          "user-agent": UA,
          accept: body ? "application/json" : "*/*",
          "accept-encoding": "identity",
          ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
          ...headers
        },
        lookup: (hostname, opts, cb) => {
          if (guard.lookup) return guard.lookup(hostname, opts, cb);
          const wantAll = Boolean(opts && opts.all);
          dns.lookup(hostname, { family: family || 0, all: wantAll }, (err, address, f) => {
            if (wantAll) cb(err, address);
            else {
              if (!err) marks.ip = address;
              cb(err, address, f);
            }
          });
        }
      },
      (res) => {
        marks.ttfb = round(now() - started);
        const chunks = [];
        let bytes = 0;
        let overflow = false;
        res.on("data", (c) => {
          if (overflow) return;
          if (marks.firstchunk === undefined) marks.firstchunk = round(now() - started);
          if (marks.firsttoken === undefined && /"(?:content|reasoning_content)"\s*:\s*"[^"]/.test(c.toString("utf8"))) {
            marks.firsttoken = round(now() - started);
          }
          bytes += c.length;
          if (bytes > MAX_BODY_BYTES) {
            overflow = true;
            req.destroy(new Error("response body too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("error", (e) => finish({ ok: false, error: e.message }));
        res.on("end", () => {
          if (overflow) return;
          marks.total = round(now() - started);
          const full = Buffer.concat(chunks).toString("utf8");
          finish({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            bytes,
            body: full,
            bodyTail: full.slice(-2000),
            bodyLength: full.length
          });
        });
      }
    );

    req.on("socket", (s) => {
      if (s.encrypted) {
        s.on("secureConnect", () => {
          marks.tls = round(now() - started);
          try {
            marks.protocol = s.getProtocol();
            const cert = s.getPeerCertificate();
            if (cert && cert.valid_to) {
              marks.certDays = Math.round((new Date(cert.valid_to) - Date.now()) / 86400000);
              marks.certIssuer = (cert.issuer && cert.issuer.O) || "";
              marks.certSubject = (cert.subject && cert.subject.CN) || "";
            }
          } catch (e) {
            /* TLS 附加信息缺失不影响主流程 */
          }
        });
      }
      s.on("connect", () => {
        marks.tcp = round(now() - started);
        marks.ip = s.remoteAddress || "";
        marks.ipFamily = s.remoteFamily || "";
      });
    });

    req.setTimeout(timeout, () => req.destroy(new Error(`timeout ${timeout}ms`)));
    totalTimer = setTimeout(() => req.destroy(new Error(`total timeout ${timeout + 2000}ms`)), timeout + 2000);
    req.on("error", (e) => finish({ ok: false, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * IPv4 / IPv6 并行竞速：同时发起 TCP 握手，取最早连上的地址族。
 * 不竞速的话 happy-eyeballs 会按 DNS 顺序先试 IPv6，双栈站会一直被算成慢的那条。
 */
async function chooseFamily(hostname, port, timeout = 2500, addresses = null) {
  const addrs = Array.isArray(addresses) && addresses.length
    ? addresses
    : await new Promise((resolve) => {
        dns.lookup(hostname, { all: true }, (err, list) => resolve(err ? [] : list || []));
      });
  if (!addrs.length) return { family: 0, ip: "", race: [] };
  if (addrs.length === 1) return { family: addrs[0].family, ip: addrs[0].address, race: [] };

  const race = await Promise.all(
    addrs.map((a) =>
      new Promise((resolve) => {
        const t = now();
        const sock = net.connect({ host: a.address, port });
        sock.setTimeout(timeout, () => { sock.destroy(); resolve(null); });
        sock.once("connect", () => { const ms = round(now() - t); sock.destroy(); resolve({ family: a.family, ip: a.address, ms }); });
        sock.once("error", () => { try { sock.destroy(); } catch (e) {} resolve(null); });
      })
    )
  );

  const ok = race.filter(Boolean).sort((a, b) => a.ms - b.ms);
  if (!ok.length) return { family: 0, ip: "", race: [] };
  return { family: ok[0].family, ip: ok[0].ip, race: ok };
}

function median(list) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(list, mean) {
  if (list.length < 2) return 0;
  const variance = list.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (list.length - 1);
  return Math.sqrt(variance);
}

/** 可用性：可达性 + 各阶段耗时。 */
function scoreAvailability(samples) {
  const good = samples.filter((s) => s.ok);
  if (!good.length) {
    return { score: 0, note: `全部 ${samples.length} 次探测均失败` };
  }

  const ttfb = median(good.map((s) => s.marks.ttfb || 0));
  const tcp = median(good.map((s) => s.marks.tcp || 0));
  const status = good[good.length - 1].status || 0;

  let score = 100;
  const notes = [];

  if (ttfb > 200) {
    const cut = Math.min(30, ((ttfb - 200) / 100) * 3);
    score -= cut;
    notes.push(`TTFB ${ttfb}ms 扣 ${round(cut)}`);
  }
  if (tcp > 200) {
    const cut = Math.min(15, ((tcp - 200) / 100) * 2);
    score -= cut;
    notes.push(`TCP 握手 ${tcp}ms 扣 ${round(cut)}`);
  }
  if (status >= 500) {
    score = Math.min(score, 40);
    notes.push(`HTTP ${status} 直接封顶 40`);
  } else if (status >= 400) {
    score = Math.min(score, 70);
    notes.push(`HTTP ${status} 封顶 70`);
  }

  return {
    score: clamp(round(score)),
    note: notes.length ? notes.join("；") : `TTFB ${ttfb}ms，TCP ${tcp}ms`
  };
}

/** 稳定性：成功率 70% + TTFB 变异系数 30%。 */
function scoreStability(samples) {
  const total = samples.length;
  const good = samples.filter((s) => s.ok);
  const successRate = total ? good.length / total : 0;

  const ttfbs = good.map((s) => s.marks.ttfb || 0);
  const mean = ttfbs.length ? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length : 0;
  const cv = mean > 0 ? stdev(ttfbs, mean) / mean : 0.5;
  const steadiness = Math.max(0, 1 - cv / 0.5);

  const score = successRate * 100 * 0.7 + steadiness * 100 * 0.3;
  return {
    score: clamp(round(score)),
    note: `成功率 ${good.length}/${total}，TTFB 中位数 ${round(mean)}ms，变异系数 ${round(cv, 2)}`
  };
}

/** 安全：协议、证书、响应头。 */
function scoreSecurity(sample) {
  if (!sample || !sample.ok) {
    return { score: 0, note: "探测失败，无法评估" };
  }

  const marks = sample.marks || {};
  const headers = sample.headers || {};
  const isHttps = sample.url ? sample.url.startsWith("https:") : Boolean(marks.protocol);
  let score = 0;
  const notes = [];

  if (isHttps) {
    score += 30;
    notes.push("HTTPS +30");
  } else {
    notes.push("明文 HTTP，安全分封顶 30");
  }

  const proto = marks.protocol || "";
  if (proto === "TLSv1.3") {
    score += 15;
    notes.push("TLS 1.3 +15");
  } else if (proto === "TLSv1.2") {
    score += 12;
    notes.push("TLS 1.2 +12");
  } else if (proto) {
    notes.push(`${proto} 不加分`);
  }

  const days = marks.certDays;
  if (typeof days === "number") {
    if (days > 30) {
      score += 20;
      notes.push(`证书剩余 ${days} 天 +20`);
    } else if (days > 7) {
      score += 12;
      notes.push(`证书剩余 ${days} 天 +12`);
    } else if (days > 0) {
      score += 4;
      notes.push(`证书 ${days} 天后到期 +4`);
    } else {
      notes.push("证书已过期 +0");
    }
  }

  if (headers["strict-transport-security"]) {
    score += 10;
    notes.push("HSTS +10");
  }
  if (String(headers["x-content-type-options"] || "").toLowerCase().includes("nosniff")) {
    score += 8;
    notes.push("nosniff +8");
  }
  if (headers["x-frame-options"] || headers["content-security-policy"]) {
    score += 7;
    notes.push("XFO/CSP +7");
  }
  if (!headers["server"] || !/\d+\.\d+/.test(String(headers["server"]))) {
    score += 10;
    notes.push("未暴露版本号 +10");
  } else {
    notes.push(`Server 暴露版本 ${headers["server"]}`);
  }

  if (!isHttps) score = Math.min(score, 30);
  return { score: clamp(round(score)), note: notes.join("；") };
}

/** 完整性：字节一致性、结构与关键响应头。 */
function scoreIntegrity(sample) {
  if (!sample || !sample.ok) {
    return { score: 0, note: "探测失败，无法评估" };
  }

  const headers = sample.headers || {};
  const body = sample.body || "";
  let score = 0;
  const notes = [];

  const declared = Number(headers["content-length"]);
  if (Number.isFinite(declared) && declared > 0) {
    if (declared === sample.bytes) {
      score += 30;
      notes.push("content-length 与实际字节一致 +30");
    } else {
      score += 10;
      notes.push(`content-length ${declared} ≠ 实收 ${sample.bytes}`);
    }
  } else {
    notes.push("无 content-length");
  }

  if (headers["content-type"]) {
    score += 15;
    notes.push(`content-type ${String(headers["content-type"]).split(";")[0]} +15`);
  }

  const tail = sample.bodyTail || body;
  const looksHtml = /<html[\s>]/i.test(body);
  const looksJson = /^\s*[{[]/.test(body);
  let structured = false;
  if (looksHtml) {
    structured = /<\/html>\s*$/i.test(tail.trim());
    notes.push(structured ? "HTML 完整闭合 +35" : "HTML 未闭合");
  } else if (looksJson) {
    try {
      JSON.parse(body);
      structured = true;
      notes.push("JSON 可解析 +35");
    } catch (e) {
      notes.push("JSON 截断或非法");
    }
  } else if (body.length > 0) {
    structured = true;
    notes.push("非空响应体 +35");
  }
  if (structured) score += 35;

  if (headers["date"]) {
    score += 10;
    notes.push("date 头 +10");
  }
  if (sample.bytes > 0) {
    score += 10;
  }

  return { score: clamp(round(score)), note: notes.join("；") };
}

/** 从一段响应里抽出模型 id 数组 */
function extractModelIds(resp) {
  if (!resp || !resp.ok || resp.status !== 200) return null;
  try {
    const parsed = JSON.parse(resp.body);
    const list = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : null;
    if (!Array.isArray(list) || !list.length) return null;
    const ids = list
      .map((m) => (typeof m === "string" ? m : m && (m.id || m.name || m.model_name)))
      .filter((x) => typeof x === "string" && x.length)
      .map((x) => x.slice(0, 120));
    return ids.length ? [...new Set(ids)] : null;
  } catch (e) {
    return null;
  }
}

/**
 * 只拉模型目录，不评分。
 * 给「提交者自己选模型」用：先探到真实清单，再让人勾。
 */
async function fetchModelList(rawUrl, { timeout = 10000, apiKey = "" } = {}) {
  let base;
  try {
    base = new URL(/^https?:\/\//.test(rawUrl) ? rawUrl : "https://" + rawUrl);
  } catch (e) {
    return { ok: false, models: [], error: "地址格式不正确" };
  }
  try {
    await assertPublicUrl(base.href, { allowHttp: !apiKey });
  } catch (e) {
    return { ok: false, models: [], error: e.message };
  }
  const root = base.origin + (base.pathname.replace(/\/+$/, "") === "" ? "" : base.pathname.replace(/\/+$/, ""));
  const tried = [];
  /* 主域名探不到时，自动再试 api.<host>（展示域名与 API 域名经常不是一个） */
  const roots = [root, ...apiSubdomainCandidates(root)];
  const candidates = [...new Set(roots.flatMap((r) => [r + "/v1/models", r + "/api/v1/models", r + "/models"]))];
  const headers = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  for (const target of candidates) {
    tried.push(target);
    const r = await requestOnce(target, { timeout, headers });
    const ids = extractModelIds(r);
    if (ids) return { ok: true, models: ids, source: target, tried };
  }
  return { ok: false, models: [], error: "该站未公开模型目录（/v1/models）", tried };
}

/**
 * 真实性：公开 API 面 + 提供 key 时的回包自检。
 * 没有 key 返回 null —— 不猜。
 */
async function scoreAuthenticity(site, baseUrl, timeout) {
  const roots = [];
  const base = baseUrl.replace(/\/+$/, "");
  for (const r of [base, ...apiSubdomainCandidates(base)]) {
    roots.push(r + "/v1/models");
    roots.push(r + "/api/v1/models");
    roots.push(r + "/api/pricing");
  }

  const extractModels = extractModelIds;

  let hit = null;
  let publicModels = null;
  for (const target of [...new Set(roots)]) {
    const r = await requestOnce(target, { timeout, headers: { accept: "application/json" } });
    const ids = extractModels(r);
    if (ids) {
      hit = { ...r, target };
      publicModels = ids;
      break;
    }
  }

  const key = site.apiKey ? String(site.apiKey).trim() : "";
  if (!key) {
    if (publicModels && publicModels.length) {
      const weak = clamp(Math.round(20 + Math.log2(publicModels.length) * 6));
      return {
        score: weak,
        basis: "public-models",
        note: `模型列表公开可读（${publicModels.length} 个），仅作弱信号；未提供 API Key，未验证是否调包`,
        publicModels
      };
    }
    return {
      score: null,
      basis: "unverified",
      note: "未提供 API Key，且模型列表不可公开读取，真实性不做判定",
      publicModels: null
    };
  }

  // 有 key：拉模型列表 + 发一次真实补全，检查回包是否自洽
  const authHeaders = { authorization: `Bearer ${key}`, accept: "application/json" };
  const modelsUrl = hit ? hit.target : base + "/v1/models";
  const listResp = publicModels ? hit : await requestOnce(modelsUrl, { timeout, headers: authHeaders });

  let models = [];
  if (listResp.ok && listResp.status === 200) {
    try {
      const parsed = JSON.parse(listResp.body);
      const list = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
      models = list.map((m) => m.id || m.name).filter(Boolean);
    } catch (e) {
      /* 忽略 */
    }
  }

let pick = String(site.probeModel || "").trim();
  if (models.length && (!pick || !models.includes(pick))) {
    const ci = pick ? models.find((m) => m.toLowerCase() === pick.toLowerCase()) : null;
    pick = ci || models[0];
  }
  if (!pick) pick = "gpt-4o-mini";
  const payload = JSON.stringify({
    model: pick,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
    max_tokens: 8,
    temperature: 0
  });
  const chat = await requestOnce(base + "/v1/chat/completions", {
    method: "POST",
    body: payload,
    timeout,
    headers: authHeaders
  });

  let echoedModel = null;
  let hasUsage = false;
  let finishReason = null;
  let content = "";
  if (chat.ok && chat.status === 200) {
    try {
      const parsed = JSON.parse(chat.body);
      echoedModel = parsed.model || null;
      hasUsage = Boolean(parsed.usage && Number(parsed.usage.prompt_tokens) > 0);
      finishReason = parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason;
      content = (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || "";
    } catch (e) {
      /* 回包非 JSON */
    }
  }

  let score = 0;
  const notes = [];

  if (models.length) {
    score += 25;
    notes.push(`模型列表 ${models.length} 个 +25`);
    if (models.includes(pick)) {
      score += 15;
      notes.push(`所请求的 ${pick} 在列表中 +15`);
    }
  } else {
    notes.push("模型列表不可读");
  }

  if (chat.ok && chat.status === 200) {
    score += 20;
    notes.push("补全请求 200 +20");
    if (echoedModel) {
      if (echoedModel === pick) {
        score += 15;
        notes.push(`回包 model 与请求一致 +15`);
      } else {
        notes.push(`回包 model=${echoedModel} 与请求 ${pick} 不一致`);
      }
    }
    if (hasUsage) {
      score += 15;
      notes.push("usage 完整 +15");
    }
    if (finishReason) {
      score += 5;
      notes.push(`finish_reason=${finishReason} +5`);
    }
    if (content.trim()) {
      score += 5;
      notes.push(`正文 ${round(content.trim().length, 0)} 字符 +5`);
    }
  } else {
    notes.push(`补全请求失败 ${chat.status || chat.error || ""}`);
  }

  return {
    score: clamp(round(score)),
    note: notes.join("；"),
    publicModels: models.length ? models : publicModels,
    echoedModel,
    requestedModel: pick,
    hasUsage
  };
}

function buildBase(site) {
  /* 探测地址优先：有的站展示页和 API 域名不是同一个 */
  const raw = String(site.evalBaseUrl || site.url || "").trim();
  if (raw) {
    try {
      const u = new URL(raw);
      let p = u.pathname.replace(/\/+$/, "");
      /* 用户常把 base 写成 .../v1 或 .../api/v1，剥掉，后面统一拼 /v1/xxx */
      p = p.replace(/\/(?:api\/)?v1$/i, "");
      return u.origin + p;
    } catch (e) {
      /* 落到下面 */
    }
  }
  return "https://" + String(site.domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * 展示域名和 API 域名常常不是同一个（aisa.one → api.aisa.one）。
 * 主域名探不到 /v1/models 时，自动再试一次 api.<host>。
 */
function apiSubdomainCandidates(root) {
  try {
    const u = new URL(root);
    if (/^api\./i.test(u.hostname)) return [];
    return [`${u.protocol}//api.${u.hostname}${u.pathname}`.replace(/\/+$/, "")];
  } catch (e) {
    return [];
  }
}

const CHAT_PROMPT = "Reply with the single word: pong";

function chatPayload(model, stream, maxTokens = 256) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: CHAT_PROMPT }],
    max_tokens: maxTokens,
    temperature: 0,
    ...(stream ? { stream: true } : {})
  });
}

/** 回包算不算「这一次成功」：流式看 SSE 帧，非流式看 choices 里有没有正文。 */
function isChatSuccess(r) {
  if (!r || !r.ok || r.status !== 200) return false;
  const body = String(r.body || "");

  /* 流式：逐帧解析，role-only 帧、error 帧、空 delta 都不算数 */
  if (/^data:/m.test(body)) {
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (!m) continue;
      let obj;
      try {
        obj = JSON.parse(m[1]);
      } catch (e) {
        continue;
      }
      if (obj.error) return false;
      const ch = (obj.choices && obj.choices[0]) || {};
      const d = ch.delta || {};
      const text = d.content ?? d.reasoning_content ?? ch.text ?? (ch.message && ch.message.content);
      if (typeof text === "string" && text.trim()) return true;
    }
    return false;
  }

  try {
    const parsed = JSON.parse(body);
    const choice = parsed.choices && parsed.choices[0];
    return Boolean(choice && choice.message && String(choice.message.content || "").trim());
  } catch (e) {
    return false;
  }
}

/**
 * 成功率五维：每一项都是「达标次数 / 尝试次数」。
 * 达标 = 请求成功 且 落在该项 SLA 时限内；超时的算失败，不给满分。
 * reach      GET /                  5 次   TTFB ≤ 3000ms
 * catalog    GET /v1/models         5 次   TTFB ≤ 5000ms
 * chat       POST 非流式补全         8 次   总耗时 ≤ 10000ms
 * stream     POST 流式补全（SSE）     8 次   首字节 ≤ 10000ms
 * concurrent POST 3 路 + 5 路        8 次   整轮 ≤ 30000ms
 * 拿不到模型名时，后三项记 null（未测），不按 0 计，避免冤枉站点。
 */
const SLA = { reach: 3000, catalog: 5000, chat: 10000, stream: 10000, concurrent: 30000 };

async function measureSuccessRates(site, baseUrl, { timeout = DEFAULT_TIMEOUT, tries = 5, chatTries = 8, report = null } = {}) {
  const base = baseUrl.replace(/\/+$/, "");
  const key = String(site.apiKey || "").trim();
  const jsonAuth = key ? { authorization: `Bearer ${key}`, accept: "application/json" } : { accept: "application/json" };
  const authOnly = key ? { authorization: `Bearer ${key}` } : {};

  const dims = { reach: null, catalog: null, chat: null, stream: null, concurrent: null };
  const detail = {};
  const over = (ms, limit) => (ms === undefined || ms === null ? true : ms > limit);
  const median = (arr) => {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  };

  /* 1. 连通成功率：首页 TTFB ≤ SLA.reach 才算达标 */
  let reachOk = 0;
  let reachSlow = 0;
  const evReach = [];
  for (let i = 0; i < tries; i += 1) {
    const r = await requestOnce(base + "/", { timeout });
    const alive = r.ok && r.status < 500;
    const ms = r.marks.ttfb;
    const ok = alive && !over(ms, SLA.reach);
    if (ok) reachOk += 1;
    else if (alive) reachSlow += 1;
    evReach.push({
      n: i + 1,
      ms: ms === undefined ? null : ms,
      ok,
      status: r.status || 0,
      note: alive ? (ok ? "" : `TTFB 超过 ${SLA.reach}ms`) : r.error || "连接失败"
    });
    if (report) report({ dim: "reach", n: i + 1, total: tries, ms: ms === undefined ? null : ms, ok, note: alive ? (ok ? "" : "超过 " + SLA.reach + "ms") : r.error || "连接失败" });
    if (!alive && i === 0) break;
  }
  dims.reach = round((reachOk / tries) * 100);
  detail.reach = `${reachOk}/${tries} 次首页达标（TTFB ≤ ${SLA.reach}ms）${reachSlow ? `，${reachSlow} 次偏慢` : ""}`;

  /* 2. 目录成功率：能解析出模型 且 TTFB ≤ SLA.catalog */
  const catUrls = [base + "/v1/models", base + "/api/v1/models"];
  let catUrl = catUrls[0];
  let models = [];
  let catOk = 0;
  let catSlow = 0;
  const evCatalog = [];
  for (let i = 0; i < tries; i += 1) {
    const r = await requestOnce(catUrl, { timeout, headers: jsonAuth });
    let ids = extractModelIds(r);
    let ms = r.marks.ttfb;
    if (!ids && i === 0 && catUrl !== catUrls[1]) {
      const alt = await requestOnce(catUrls[1], { timeout, headers: jsonAuth });
      const altIds = extractModelIds(alt);
      if (altIds) {
        catUrl = catUrls[1];
        ids = altIds;
        ms = alt.marks.ttfb;
      }
    }
    if (!ids) {
      evCatalog.push({ n: i + 1, ms: ms === undefined ? null : ms, ok: false, models: 0, status: r.status || 0, note: r.error || "没解析到模型" });
      if (report) report({ dim: "catalog", n: i + 1, total: tries, ms: ms === undefined ? null : ms, ok: false, note: r.error || "没解析到模型" });
      continue;
    }
    const ok = !over(ms, SLA.catalog);
    evCatalog.push({ n: i + 1, ms, ok, models: ids.length, status: r.status || 0, note: ok ? "" : `TTFB 超过 ${SLA.catalog}ms` });
    if (report) report({ dim: "catalog", n: i + 1, total: tries, ms, ok, note: ok ? "" : "超过 " + SLA.catalog + "ms" });
    if (!ok) catSlow += 1;
    else catOk += 1;
    if (ids.length > models.length) models = ids;
  }
  dims.catalog = round((catOk / tries) * 100);
  detail.catalog = `${catOk}/${tries} 次目录达标（≤ ${SLA.catalog}ms${models.length ? `，${models.length} 个模型` : ""}）${catSlow ? `，${catSlow} 次偏慢` : ""}`;

  /* 3~5. 补全类，先确定一个真实存在的模型名 */
  let pick = String(site.probeModel || "").trim();
  let modelNote = "";
  if (models.length) {
    if (!pick) {
      pick = models[0];
      modelNote = "未指定模型，取目录第一个";
    } else if (!models.includes(pick)) {
      const ci = models.find((m) => m.toLowerCase() === pick.toLowerCase());
      pick = ci || models[0];
      modelNote = ci ? `配置名大小写不一致，改用 ${ci}` : `配置名不在目录中，回退到 ${pick}`;
    }
  }
  detail.model = pick || null;
  if (modelNote) detail.modelNote = modelNote;

  if (!pick) {
    detail.chat = "没有可用模型名，补全类未测";
    detail.stream = "没有可用模型名，补全类未测";
    detail.concurrent = "没有可用模型名，补全类未测";
    return { dims, detail, evidence: { reach: evReach, catalog: evCatalog, chat: [], stream: [], concurrent: [] } };
  }

  const chatUrl = base + "/v1/chat/completions";

  /* 3. 补全成功率：拿到正文 且 总耗时 ≤ SLA.chat */
  let chatOk = 0;
  let chatSlow = 0;
  const chatMs = [];
  const evChat = [];
  for (let i = 0; i < chatTries; i += 1) {
    const r = await requestOnce(chatUrl, { method: "POST", body: chatPayload(pick, false), timeout, headers: authOnly });
    const good = isChatSuccess(r);
    const ok = good && !over(r.marks.total, SLA.chat);
    evChat.push({
      n: i + 1,
      ms: r.marks.total === undefined ? null : r.marks.total,
      ok,
      status: r.status || 0,
      note: good ? (ok ? "" : `总耗时超过 ${SLA.chat}ms`) : r.error || "没拿到正文"
    });
    if (report) report({ dim: "chat", n: i + 1, total: chatTries, ms: r.marks.total === undefined ? null : r.marks.total, ok, note: good ? (ok ? "" : "超过 " + SLA.chat + "ms") : r.error || "没拿到正文" });
    if (!good) continue;
    chatMs.push(r.marks.total);
    if (over(r.marks.total, SLA.chat)) chatSlow += 1;
    else chatOk += 1;
  }
  dims.chat = round((chatOk / chatTries) * 100);
  detail.chat = `${chatOk}/${chatTries} 次补全达标（≤ ${SLA.chat}ms），中位数 ${median(chatMs) ?? "—"}ms${chatSlow ? `，${chatSlow} 次偏慢` : ""}`;

  /* 4. 流式成功率：出字 且 首个 token ≤ SLA.stream */
  let streamOk = 0;
  let streamSlow = 0;
  const streamMs = [];
  const evStream = [];
  for (let i = 0; i < chatTries; i += 1) {
    const r = await requestOnce(chatUrl, { method: "POST", body: chatPayload(pick, true), timeout, headers: authOnly });
    const good = isChatSuccess(r);
    const tk = r.marks.firsttoken ?? r.marks.firstchunk;
    const ok = good && !over(tk, SLA.stream);
    evStream.push({
      n: i + 1,
      ms: tk === undefined ? null : tk,
      ok,
      status: r.status || 0,
      note: good ? (ok ? "" : `首个 token 超过 ${SLA.stream}ms`) : r.error || "流里没有正文"
    });
    if (report) report({ dim: "stream", n: i + 1, total: chatTries, ms: tk === undefined ? null : tk, ok, note: good ? (ok ? "" : "超过 " + SLA.stream + "ms") : r.error || "流里没有正文" });
    if (!good) continue;
    streamMs.push(tk);
    if (over(tk, SLA.stream)) streamSlow += 1;
    else streamOk += 1;
  }
  dims.stream = round((streamOk / chatTries) * 100);
  detail.stream = `${streamOk}/${chatTries} 次流式达标（首个 token ≤ ${SLA.stream}ms），中位数 ${median(streamMs) ?? "—"}ms${streamSlow ? `，${streamSlow} 次偏慢` : ""}`;

  /* 5. 并发成功率：3 路 + 5 路各一轮，整轮耗时 ≤ SLA.concurrent 才算这批达标 */
  const rounds = [3, 5];
  let burstOk = 0;
  let burstTotal = 0;
  let burstSlow = 0;
  const evConc = [];
  for (const width of rounds) {
    const t0 = now();
    const results = await Promise.all(
      Array.from({ length: width }, () => requestOnce(chatUrl, { method: "POST", body: chatPayload(pick, false, 16), timeout, headers: authOnly }))
    );
    const elapsed = round(now() - t0);
    burstTotal += width;
    const success = results.filter((r) => r && r.ok && r.status === 200).length;
    const within = elapsed <= SLA.concurrent;
    /* 这一批算达标：整轮没超时，且每一个请求都正常返回 200（并发只看能不能扛住，不看输出内容） */
    const ok = within && success === width;
    if (within) burstOk += success;
    else burstSlow += width;
    const note = !within ? `整轮超过 ${SLA.concurrent}ms` : success < width ? `${width - success}/${width} 个请求没成功` : "";
    evConc.push({
      n: evConc.length + 1,
      width,
      ms: elapsed,
      ok,
      passed: success,
      note
    });
    if (report) report({ dim: "concurrent", n: evConc.length, total: rounds.length, ms: elapsed, ok, width, note });
  }
  dims.concurrent = round((burstOk / burstTotal) * 100);
  detail.concurrent = `${burstOk}/${burstTotal} 次并发请求成功（3 路 + 5 路，整轮 ≤ ${SLA.concurrent}ms）${burstSlow ? `，${burstSlow} 次因整轮超时不计` : ""}`;

  return { dims, detail, evidence: { reach: evReach, catalog: evCatalog, chat: evChat, stream: evStream, concurrent: evConc } };
}

/**
 * 完整探测：3 次可用性采样 + 安全 + 完整性 + 真实性。
 */
async function probeSite(site, { samples = 3, timeout = DEFAULT_TIMEOUT, onProgress = null } = {}) {
  const base = buildBase(site);
  const started = Date.now();
  const runs = [];

  let guard;
  try {
    guard = await assertPublicUrl(base, { allowHttp: true });
  } catch (e) {
    const dims = { reach: null, catalog: null, chat: null, stream: null, concurrent: null };
    return {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      base,
      reachable: false,
      samples: 0,
      dims,
      evidence: null,
      legacy: {},
      basis: { reach: "unmeasured", catalog: "unmeasured", chat: "unmeasured", stream: "unmeasured", concurrent: "unmeasured" },
      details: { error: "目标地址不允许探测：" + e.message },
      metrics: {},
      publicModels: null,
      error: "目标地址不允许探测：" + e.message
    };
  }

  let family = 0;
  let race = [];
  try {
    const u = guard.url;
    const picked = await chooseFamily(u.hostname, Number(u.port || (u.protocol === "https:" ? 443 : 80)), 2500, guard.addresses);
    family = picked.family;
    race = picked.race || [];
    if (picked.ip) runs.raceIp = picked.ip;
  } catch (e) {
    /* 竞速失败就交给 DNS 默认顺序 */
  }

  for (let i = 0; i < samples; i += 1) {
    const r = await requestOnce(base + "/", { timeout, family });
    r.url = base + "/";
    runs.push(r);
    if (!r.ok && i === 0) break; // 首次完全不通就不再多打
  }

  const reachable = runs.some((r) => r.ok);
  const best = runs.find((r) => r.ok) || runs[0] || { ok: false, marks: {} };

  const availability = scoreAvailability(runs);
  const stability = scoreStability(runs);
  const security = scoreSecurity(best);
  const integrity = scoreIntegrity(best);
  const authenticity = reachable ? await scoreAuthenticity(site, base, timeout) : { score: null, note: "站点不可达，真实性未判定" };

  // 五维全换成真实请求成功率
  const rates = await measureSuccessRates(site, base, { timeout, report: onProgress });
  const dims = rates.dims;

  // 旧的混合评分留档，只看历史，不再参与总分
  const legacy = {
    availability: availability.score,
    stability: stability.score,
    security: security.score,
    integrity: integrity.score
  };
  if (authenticity.score !== null) legacy.authenticity = authenticity.score;

  const basis = {};
  for (const key of ["reach", "catalog", "chat", "stream", "concurrent"]) {
    basis[key] = dims[key] === null ? "unmeasured" : "probe";
  }

  return {
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    base,
    reachable,
    samples: runs.length,
    dims,
    evidence: rates.evidence || null,
    legacy,
    basis,
    details: {
      ...rates.detail,
      availability: availability.note,
      stability: stability.note,
      security: security.note,
      integrity: integrity.note,
      authenticity: authenticity.note
    },
    metrics: {
      dns: median(runs.map((r) => (r.marks && r.marks.dns) || 0)),
      tcp: median(runs.map((r) => (r.marks && r.marks.tcp) || 0)),
      tls: median(runs.map((r) => (r.marks && r.marks.tls) || 0)),
      ttfb: median(runs.map((r) => (r.marks && r.marks.ttfb) || 0)),
      total: median(runs.map((r) => (r.marks && r.marks.total) || 0)),
      status: best.status || 0,
      bytes: best.bytes || 0,
      protocol: (best.marks && best.marks.protocol) || "",
      certDays: (best.marks && best.marks.certDays) || null,
      certIssuer: (best.marks && best.marks.certIssuer) || "",
      ip: (best.marks && best.marks.ip) || "",
      ipFamily: (best.marks && best.marks.ipFamily) || "",
      familyRace: race,
      server: (best.headers && best.headers.server) || ""
    },
    publicModels: authenticity.publicModels || null,
    error: reachable ? null : best.error || "unreachable"
  };
}

module.exports = { probeSite, requestOnce, fetchModelList, extractModelIds, SLA };

if (require.main === module) {
  (async () => {
    const targets = process.argv.slice(2);
    for (const t of targets) {
      const site = /^https?:\/\//.test(t) ? { url: t, domain: new URL(t).hostname } : { domain: t, url: "https://" + t };
      const r = await probeSite(site);
      console.log(
        JSON.stringify(
          {
            target: t,
            reachable: r.reachable,
            durationMs: r.durationMs,
            dims: r.dims,
            basis: r.basis,
            metrics: r.metrics,
            details: r.details,
            error: r.error
          },
          null,
          1
        )
      );
      console.log("---");
    }
  })();
}

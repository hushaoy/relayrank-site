/**
 * 中转站测评榜单 —— 自带后台的单文件服务
 * 零依赖 node:http + JSON 存储 + scrypt 会话鉴权 + CSRF
 *
 * 启动：node server.js [--port 8803]
 * 首次启动会生成 data/db.json 与 data/initial-admin.txt（管理员账号密码）
 */
"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { sha256, safeHttpUrl, clientIp, cookieHeader, assertPublicUrl } = require("./security.js");
const { probeSite, fetchModelList, SLA } = require("./probe.js");
const { evalModel } = require("./eval-models.js");
const { isEncrypted, encryptSecret, decryptSecret } = require("./secret-box.js");
const { LoginGuard, maskIp } = require("./login-guard.js");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DB_BACKUP = path.join(DATA_DIR, "db.json.bak");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const PORT = Number(process.env.PORT || (process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 8803);
const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(ROOT, "logs");
let ACCESS_LOG = null;

function logLine(method, pathname, status, extra) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    if (!ACCESS_LOG) ACCESS_LOG = fs.createWriteStream(path.join(LOG_DIR, "access.log"), { flags: "a", mode: 0o600 });
    const cleanPath = String(pathname || "/")
      .replace(/([?&](?:tk|token|key|apiKey|password|secret)=)[^&]*/gi, "$1[REDACTED]")
      .replace(/[\r\n]/g, "");
    const cleanExtra = String(extra || "").replace(/[\r\n]/g, " ").slice(0, 120);
    ACCESS_LOG.write(`${new Date().toISOString()} ${method} ${cleanPath} ${status} ${cleanExtra}\n`);
  } catch {
    /* 日志失败不影响请求 */
  }
}

function securityLog(event, detail) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const line = `${new Date().toISOString()} ${event} ${String(detail || "").replace(/[\r\n]/g, " ").slice(0, 300)}\n`;
    fs.appendFileSync(path.join(LOG_DIR, "security.log"), line, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* 日志失败不影响登录流程 */
  }
}

const HOST = process.env.HOST || "127.0.0.1";
const SESSION_TTL = 1000 * 60 * 60 * 8;
const COOKIE_NAME = "bs_sid";

const loginGuard = new LoginGuard({
  file: path.join(DATA_DIR, "login-guard.json"),
  accountMax: 5,
  accountWindowMs: 15 * 60 * 1000,
  accountLockMs: 15 * 60 * 1000,
  ipMax: 20,
  ipWindowMs: 15 * 60 * 1000,
  ipLockMs: 30 * 60 * 1000,
  globalMax: 120,
  globalWindowMs: 60 * 1000
});

const rateBuckets = new Map();
function rateHit(key, max, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || now > current.reset) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > max;
}
function rateReset(key) {
  rateBuckets.delete(key);
}
function ratePrune() {
  const now = Date.now();
  for (const [key, value] of rateBuckets) {
    if (!value || now > value.reset) rateBuckets.delete(key);
  }
}
const ratePruneTimer = setInterval(ratePrune, 10 * 60 * 1000);
ratePruneTimer.unref?.();

function applySecurityHeaders(res) {
  res.setHeader("x-frame-options", "SAMEORIGIN");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'self'"
  );
}
// 五维全部是真实请求成功率，权重按「能不能真用」排序
const WEIGHTS = { reach: 0.1, catalog: 0.15, chat: 0.25, stream: 0.25, concurrent: 0.25 };
const DIMS = ["reach", "catalog", "chat", "stream", "concurrent"];
const DIM_LABELS = {
  reach: "连通成功率",
  catalog: "目录成功率",
  chat: "补全成功率",
  stream: "流式成功率",
  concurrent: "并发成功率"
};

/* ---------------- 种子数据 ---------------- */

const SEED_SITES = [
  { name: "SecToken", domain: "sectoken.cqcyht.com", url: "https://sectoken.cqcyht.com/", logo: "seed/sectoken.png", note: "稳定可靠 · 模型支持全面", dims: { reach: 97.8, catalog: 96, chat: 100, stream: 86, concurrent: 91.9 }, models: 9, issues: 0, down: 0, tags: ["推荐"] },
  { name: "Requesty", domain: "requesty.ai", url: "https://www.requesty.ai/", logo: "seed/requesty.ico", note: "响应快速 · 服务稳定", dims: { reach: 99, catalog: 87.2, chat: 91.5, stream: 85.6, concurrent: 92.3 }, models: 10, issues: 0, down: 0, tags: ["推荐"] },
  { name: "AISA", domain: "aisa.one", url: "https://aisa.one/", logo: "", note: "模型覆盖广", dims: { reach: 94.5, catalog: 89.2, chat: 100, stream: 86.5, concurrent: 90.5 }, models: 20, issues: 1, down: 0, tags: [] },
  { name: "AIHubMix", domain: "aihubmix.com", url: "https://aihubmix.com/", logo: "seed/aihubmix.ico", note: "综合表现优秀", dims: { reach: 98.3, catalog: 93.8, chat: 99.2, stream: 92.3, concurrent: 95.3 }, models: 6, issues: 0, down: 0, tags: ["推荐"] },
  { name: "302.AI", domain: "302.ai", url: "https://302.ai/", logo: "", note: "模型丰富 · 稳定性待提升", dims: { reach: 98.4, catalog: 87.5, chat: 99.1, stream: 77.4, concurrent: 87.9 }, models: 19, issues: 2, down: 0, tags: [] },
  { name: "OhMyGPT", domain: "ohmygpt.com", url: "https://ohmygpt.com/", logo: "", note: "真实性高", dims: { reach: 93.3, catalog: 94.1, chat: 100, stream: 84.3, concurrent: 88.8 }, models: 9, issues: 1, down: 0, tags: [] },
  { name: "CanalAPI", domain: "canalapi.com", url: "https://canalapi.com/", logo: "", note: "响应完整 · 可用性一般", dims: { reach: 70, catalog: 98, chat: 100, stream: 70, concurrent: 70 }, models: 5, issues: 0, down: 0, tags: [] },
  { name: "DMXAPI", domain: "dmxapi.com", url: "https://dmxapi.com/", logo: "", note: "表现均衡", dims: { reach: 92, catalog: 92.4, chat: 96.7, stream: 79.2, concurrent: 85.6 }, models: 5, issues: 0, down: 0, tags: [] },
  { name: "OpenCode Go", domain: "opencode.ai", url: "https://opencode.ai/", logo: "", note: "代码模型支持好", dims: { reach: 87.1, catalog: 88.2, chat: 96.2, stream: 82.1, concurrent: 84.6 }, models: 7, issues: 0, down: 0, tags: [] },
  { name: "NextBit", domain: "nextbit256.com", url: "https://nextbit256.com/", logo: "", note: "小站点 · 真实性高", dims: { reach: 100, catalog: 96.8, chat: 93.3, stream: 87.5, concurrent: 93.8 }, models: 2, issues: 0, down: 0, tags: [] },
  { name: "lulurouter", domain: "lulurouter.com", url: "https://lulurouter.com/", logo: "seed/lulurouter.png", note: "多个模型不可用", dims: { reach: 20, catalog: 30, chat: 30, stream: 22, concurrent: 21 }, models: 8, issues: 8, down: 8, tags: ["风险"] },
  { name: "Zovelox", domain: "zovelox.com", url: "https://www.zovelox.com/", logo: "seed/zovelox.ico", note: "上游欠费 · 多个模型不可用", dims: { reach: 26, catalog: 34, chat: 33, stream: 18, concurrent: 22 }, models: 4, issues: 4, down: 4, tags: ["风险"] },
  { name: "4router", domain: "4router.net", url: "https://4router.net/", logo: "seed/4router.svg", note: "多个模型不可用", dims: { reach: 28, catalog: 36, chat: 28, stream: 25, concurrent: 26.5 }, models: 7, issues: 7, down: 7, tags: ["风险"] },
  { name: "TokenMix", domain: "tokenmix.ai", url: "https://tokenmix.ai/", logo: "", note: "访客提交，待核验", dims: { reach: 88, catalog: 82, chat: 85, stream: 74, concurrent: 81 }, models: 12, issues: 1, down: 0, tags: [], status: "pending", submittedBy: "visitor" },
  { name: "KeleAI", domain: "kele-ai.com", url: "https://kele-ai.com/", logo: "", note: "访客提交，待核验", dims: { reach: 80, catalog: 71, chat: 70, stream: 63, concurrent: 71.5 }, models: 6, issues: 2, down: 1, tags: [], status: "pending", submittedBy: "visitor" }
];

/* ---------------- 工具 ---------------- */

const nowIso = () => new Date().toISOString();
const dbSnapshot = () =>
  JSON.stringify(
    db,
    (key, value) => (key === "apiKey" && typeof value === "string" && value ? encryptSecret(value) : value),
    2
  );
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const round1 = (n) => Math.round(n * 10) / 10;

function slugify(text) {
  const base = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "site";
}

function computeScore(dims) {
  // 五维都是成功率；缺测（null）按 0 计入总分 —— 榜单只认实测，没测到就是没有分数支撑
  let total = 0;
  for (const key of DIMS) {
    const value = dims[key];
    total += (value === null || value === undefined || value === "" ? 0 : clamp(value)) * WEIGHTS[key];
  }
  return round1(total);
}

function gradeOf(score) {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  return "D";
}

const scryptAsync = require("node:util").promisify(crypto.scrypt);

async function hashPassword(password, salt) {
  return (await scryptAsync(String(password), salt, 64)).toString("hex");
}

async function verifyPassword(password, salt, expected) {
  const actual = Buffer.from(await hashPassword(password, salt), "hex");
  const b = Buffer.from(String(expected), "hex");
  return actual.length === b.length && crypto.timingSafeEqual(actual, b);
}

function cleanModels(input) {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .filter((item) => typeof item === "string")
        .map((item) => item.trim().slice(0, 120))
        .filter(Boolean)
    )
  ].slice(0, 60);
}

function detectImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return ".ico";
  return "";
}

function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

/* ---------------- 存储 ---------------- */

let db = null;

function normalizeSite(input, existing) {
  const dims = {};
  for (const key of DIMS) {
    // 显式给了 dims 就用；否则退回 input[key]；再否则沿用已有维度，绝不清零
    const raw =
      input.dims && input.dims[key] !== undefined
        ? input.dims[key]
        : input[key] !== undefined
          ? input[key]
          : existing?.dims?.[key];
    // null 表示这一维没测到，保留 null，交给 computeScore 归一化
    dims[key] = raw === undefined || raw === null || raw === "" ? null : clamp(raw);
  }
  const score = computeScore(dims);
  const name = String(input.name || existing?.name || "").trim().slice(0, 80);
  const domain = String(input.domain || existing?.domain || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
  const models = input.models === undefined ? existing?.models ?? 0 : Math.max(0, parseInt(input.models, 10) || 0);
  const issues = input.issues === undefined ? existing?.issues ?? 0 : Math.max(0, parseInt(input.issues, 10) || 0);
  const down = input.down === undefined ? existing?.down ?? 0 : Math.max(0, parseInt(input.down, 10) || 0);

  return {
    id: existing?.id || "st_" + randomId(6),
    slug: existing?.slug || slugify(domain || name),
    name,
    domain,
    url: safeHttpUrl(input.url || existing?.url || (domain ? `https://${domain}` : "")),
    logo: (() => {
      const raw = String(input.logo === undefined ? existing?.logo || "" : input.logo).trim().slice(0, 300);
      if (!raw) return "";
      if (raw.startsWith("/uploads/") && /^\/uploads\/[a-zA-Z0-9._/-]+$/.test(raw) && !raw.includes("..")) return raw;
      if (/^https?:\/\//i.test(raw)) return safeHttpUrl(raw);
      if (/^[a-zA-Z0-9._/-]+$/.test(raw) && !raw.includes("..")) {
        return "/uploads/" + raw.replace(/^\.?\//, "");
      }
      return "";
    })(),
    note: String(input.note ?? existing?.note ?? "").trim().slice(0, 120),
    tags: Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 32)
      : typeof input.tags === "string" && input.tags.trim()
        ? input.tags.split(/[|,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 32)
        : existing?.tags ?? [],
    dims,
    score,
    grade: gradeOf(score),
    models,
    issues,
    down,
    kind: ["commercial", "public"].includes(input.kind) ? input.kind : existing?.kind || "commercial",
    views: Math.max(0, parseInt(input.views ?? existing?.views ?? 0, 10) || 0),
    modelList: Array.isArray(input.modelList) ? input.modelList : existing?.modelList ?? null,
    selectedModels: Array.isArray(input.selectedModels)
      ? input.selectedModels.map((x) => String(x).slice(0, 120)).slice(0, 60)
      : existing?.selectedModels ?? null,
    modelListAt: input.modelListAt || existing?.modelListAt || null,
    status: ["draft", "pending", "published", "rejected"].includes(input.status)
      ? input.status
      : existing?.status || "pending",
    reviewNote: String(input.reviewNote ?? existing?.reviewNote ?? "").slice(0, 200),
    submittedBy: String(input.submittedBy ?? existing?.submittedBy ?? "admin").slice(0, 60),
    reviewedAt: existing?.reviewedAt || null,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    probe: input.probe === undefined ? existing?.probe || null : input.probe,
    apiKey: String(input.apiKey === undefined || input.apiKey === "********" ? existing?.apiKey || "" : input.apiKey).trim().slice(0, 200),
    probeModel: String(input.probeModel === undefined ? existing?.probeModel || "" : input.probeModel).trim().slice(0, 120),
    evalBaseUrl: String(input.evalBaseUrl === undefined ? existing?.evalBaseUrl || "" : input.evalBaseUrl).trim().slice(0, 300),
    modelEval: input.modelEval === undefined ? existing?.modelEval || null : input.modelEval,
    modelScore: input.modelScore === undefined ? existing?.modelScore ?? null : input.modelScore,
    modelEvals: input.modelEvals === undefined ? existing?.modelEvals || null : input.modelEvals,
    modelCount: input.modelCount === undefined ? existing?.modelCount ?? null : input.modelCount
  };
}

/* Windows 上手工编辑过的 db.json 经常带 UTF-8 BOM，JSON.parse 会直接报错。
   统一在这里剥掉，避免“数据库损坏”把整个站点拦在启动阶段。 */
function parseJsonText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
}

async function readJsonFile(file) {
  return parseJsonText(await fsp.readFile(file, "utf8"));
}

async function ensureDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await loginGuard.load();

  if (fs.existsSync(DB_FILE)) {
    let loaded = null;
    try {
      loaded = await readJsonFile(DB_FILE);
    } catch (err) {
      if (fs.existsSync(DB_BACKUP)) {
        loaded = await readJsonFile(DB_BACKUP);
        console.error("[db] 主库损坏，已回滚 db.json.bak");
      } else {
        throw new Error("db.json 损坏且没有备份：" + err.message);
      }
    }

    db = loaded && typeof loaded === "object" ? loaded : {};
    db.sites = Array.isArray(db.sites) ? db.sites : [];
    db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
    db.reviews = Array.isArray(db.reviews) ? db.reviews : [];
    db.submissions = Array.isArray(db.submissions) ? db.submissions : [];
    db.settings = normalizeSettings(db.settings);

    for (const site of db.sites) {
      if (!site || !site.apiKey) continue;
      try {
        site.apiKey = decryptSecret(site.apiKey);
      } catch (err) {
        throw new Error("无法解密站点 API Key：" + err.message);
      }
    }

    /* 旧版明文会话一律失效：session 只存 sha256(sid) */
    const legacySessions = db.sessions.some((s) => s && (s.sid || s.token || s.tokenHash));
    db.sessions = db.sessions.filter((s) => s && s.id && s.sidHash && s.expiresAt > Date.now());
    if (legacySessions) console.log("[security] 已清除旧版明文会话，请重新登录");

    /* 老库补字段：访问量从 0 起算 */
    for (const site of db.sites) {
      if (typeof site.views !== "number" || !Number.isFinite(site.views)) site.views = 0;
    }
    db.securityVersion = 2;
    await saveDb();
    return;
  }

  const envPassword = String(process.env.ADMIN_PASSWORD || "");
  const password = envPassword.length >= 12
    ? envPassword
    : crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 20);
  const salt = crypto.randomBytes(16).toString("hex");
  const admin = {
    username: "admin",
    salt,
    hash: await hashPassword(password, salt),
    createdAt: nowIso()
  };

  const sites = process.env.SEED_DEMO === "1"
    ? SEED_SITES.map((s) => normalizeSite({ ...s, status: s.status || "published" }))
    : [];
  db = {
    version: 1,
    securityVersion: 2,
    createdAt: nowIso(),
    sessions: [],
    reviews: [],
    submissions: [],
    settings: normalizeSettings(null),
    admin,
    sites
  };

  await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.writeFile(
    path.join(DATA_DIR, "initial-admin.txt"),
    `中转站榜单后台\n地址: http://127.0.0.1:${PORT}/admin\n用户名: admin\n密码: ${password}\n生成时间: ${nowIso()}\n（首次登录后请在后台修改密码，然后删除本文件）\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  console.log("[init] 已生成后台账号 admin（密码写入 data/initial-admin.txt，权限 600）");
}

let saveQueue = Promise.resolve();
function saveDb() {
  const snapshot = dbSnapshot();
  saveQueue = saveQueue
    .then(async () => {
      const tmp = DB_FILE + ".tmp";
      await fsp.writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(tmp, DB_FILE);
      await fsp.chmod(DB_FILE, 0o600).catch(() => {});
      await fsp.copyFile(DB_FILE, DB_BACKUP).catch(() => {});
      await fsp.chmod(DB_BACKUP, 0o600).catch(() => {});
    })
    .catch((err) => {
      console.error("[db] 写入失败", err.message);
    });
  return saveQueue;
}

/* ---------------- HTTP 工具 ---------------- */

function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": body.length, ...headers });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      /* 忽略非法 Cookie，避免单个坏值让请求 500 */
    }
  }
  return out;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("JSON 解析失败");
    err.status = 400;
    throw err;
  }
}

/* ---------------- 会话 ---------------- */

function newSession() {
  const sid = randomId(24);
  const csrf = randomId(24);
  return {
    sid,
    csrf,
    record: {
      id: randomId(8),
      sidHash: sha256(sid),
      csrf,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL
    }
  };
}

/* 出站跳转计数：同一来源 6 小时内对同一站点只算一次 */
const VISIT_DEDUPE_MS = 6 * 60 * 60 * 1000;
const visitSeen = new Map();

/* 出站跳转：记一次访问量再 302。同一来源 6 小时内对同一站点只算一次 */
function handleVisit(req, res, url) {
  const id = (url.pathname.match(/^\/go\/([a-zA-Z0-9_]+)$/) || [])[1];
  const site = id ? db.sites.find((s) => s.id === id && s.status === "published") : null;
  if (!site) return redirect(res, "/");

  const target = safeHttpUrl(site.url) || (site.domain ? safeHttpUrl(`https://${site.domain}`) : "");
  if (!target) return redirect(res, "/");

  /* 只认真实浏览器点击：爬虫 / 预取 / 空 UA / 非 GET 一律不计数 */
  const ua = String(req.headers["user-agent"] || "");
  const purpose = String(req.headers.purpose || req.headers["sec-purpose"] || req.headers["x-purpose"] || "").toLowerCase();
  const isBot = !ua || /bot|spider|crawl|preview|headless|curl|wget|python|axios|httpclient|scrapy/i.test(ua);
  const isPrefetch = /prefetch|preview|prerender/.test(purpose);

  if (req.method === "GET" && !isBot && !isPrefetch) {
    const session = currentSession(req);
    const who = (session && session.id) || clientIp(req) || "anon";
    const key = site.id + ":" + who;
    const last = visitSeen.get(key) || 0;

    if (Date.now() - last > VISIT_DEDUPE_MS) {
      visitSeen.set(key, Date.now());
      if (visitSeen.size > 10000) {
        const cutoff = Date.now() - VISIT_DEDUPE_MS;
        for (const [k, at] of visitSeen) if (at < cutoff) visitSeen.delete(k);
      }
      site.views = (Number(site.views) || 0) + 1;
      site.lastViewAt = nowIso();
      saveDb().catch(() => {});
    }
  }
  return redirect(res, target);
}

function currentSession(req) {
  if (!db) return null;

  const sid = parseCookies(req)[COOKIE_NAME];
  const session = sid ? db.sessions.find((s) => s.sidHash === sha256(sid)) : null;
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    db.sessions = db.sessions.filter((s) => s.id !== session.id);
    saveDb();
    return null;
  }
  return session;
}

function requireSession(req, res) {
  const session = currentSession(req);
  if (!session) {
    sendJson(res, 401, { error: "未登录或会话已过期" });
    return null;
  }
  return session;
}

function requireCsrf(req, res, session) {
  const token = Buffer.from(String(req.headers["x-csrf-token"] || ""));
  const expected = Buffer.from(String(session.csrf || ""));
  if (!token.length || token.length !== expected.length || !crypto.timingSafeEqual(token, expected)) {
    sendJson(res, 403, { error: "CSRF 校验失败，请刷新页面重试" });
    return false;
  }
  return true;
}

function submitLimited(ip) {
  return rateHit(`submit:${ip}`, 10, 10 * 60 * 1000);
}

function catalogLimited(ip) {
  return rateHit(`catalog:${ip}`, 10, 10 * 60 * 1000);
}

/* 登录防爆破：持久化计数 + 指数退避锁定，重启进程不会清空 */
function loginBlocked(username, ip) {
  const state = loginGuard.check(username, ip);
  return state.ok ? null : state;
}

function loginFailed(username, ip, reason) {
  const result = loginGuard.fail(username, ip);
  securityLog("login_fail", `ip=${maskIp(ip)} user=${String(username || "").slice(0, 32)} reason=${reason} accountFails=${result.accountFails} ipFails=${result.ipFails}`);
}

function loginSucceeded(username, ip) {
  loginGuard.success(username, ip);
  securityLog("login_ok", `ip=${maskIp(ip)} user=${String(username || "").slice(0, 32)}`);
}

function loginRetryMessage(state) {
  const minutes = Math.max(1, Math.ceil((state.retryAfterSec || 60) / 60));
  return `登录尝试过于频繁，已锁定 ${minutes} 分钟后再试`;
}

function safeTextEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};

function requestUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

const LOGIN_SIMPLE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>后台登录</title></head>
<body style="font-family:system-ui,sans-serif;background:#eef2f9;margin:0;padding:48px 16px">
<form method="post" action="/login-form" style="max-width:360px;margin:0 auto;background:#fff;padding:26px;border-radius:14px;box-shadow:0 8px 26px rgba(34,66,124,.1)">
  <h2 style="margin:0 0 4px;font-size:19px;color:#101828">后台登录</h2>
  <p style="margin:0 0 18px;font-size:12.5px;color:#64718a">账号 admin · 连续 5 次失败锁定 15 分钟</p>
  <input type="hidden" name="next" value="%%NEXT%%">
  <label style="display:block;font-size:12.5px;color:#475467;margin-bottom:6px">用户名</label>
  <input name="username" value="admin" autocomplete="username" maxlength="64" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d5deeb;border-radius:8px;font-size:14px;margin-bottom:14px">
  <label style="display:block;font-size:12.5px;color:#475467;margin-bottom:6px">密码</label>
  <input name="password" type="password" autocomplete="current-password" maxlength="200" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d5deeb;border-radius:8px;font-size:14px;margin-bottom:18px">
  %%ERROR%%
  <button type="submit" style="width:100%;padding:10px;border:0;border-radius:9px;background:#2b53ca;color:#fff;font-size:14px;font-weight:600;cursor:pointer">登录</button>
</form>
</body></html>`;

function loginSimpleHtml(next, error) {
  const message = error ? `<p style="margin:0 0 14px;padding:8px 10px;border:1px solid #f2b8b5;border-radius:8px;background:#fff1f0;color:#b42318;font-size:12.5px;line-height:1.5">${HTML_ESC(error)}</p>` : "";
  return LOGIN_SIMPLE_HTML.replace("%%NEXT%%", String(next || "/admin")).replace("%%ERROR%%", message);
}

const LOGIN_PROMPT_HTML = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">
<body style="font-family:system-ui;padding:40px;line-height:1.7">
<h2>需要登录</h2>
<p>请使用后台账号登录后再访问该页面。</p>
<p>直接刷新本页，或改用 <a href="/admin">后台登录页</a>。</p>
</body></html>`;

/* ---------------- Model Detective 反向代理 ---------------- */
// 5000 端口的 Flask 检测台挂到 /detective 下，同源嵌入 iframe。
// 它的静态资源和接口都写成绝对路径（/static、/api），所以统一改写前缀，
// 否则会打到本站自己的 /api/* 和静态目录上。
const DETECTIVE_DEFAULT = {
  enabled: true,
  requireLogin: false,
  autostart: true,
  host: "127.0.0.1",
  port: 5000,
  dir: "",
  python: "",
  script: "run_web.py"
};

function loadDetectiveConfig() {
  const cfg = Object.assign({}, DETECTIVE_DEFAULT);
  try {
    const raw = fs.readFileSync(path.join(ROOT, "detective.config.json"), "utf8").replace(/^\uFEFF/, "");
    const file = JSON.parse(raw);
    if (file && typeof file === "object") Object.assign(cfg, file);
  } catch {
    /* 没有配置文件就用默认值 */
  }
  if (process.env.DETECTIVE_HOST) cfg.host = process.env.DETECTIVE_HOST;
  if (process.env.DETECTIVE_PORT) cfg.port = Number(process.env.DETECTIVE_PORT) || cfg.port;
  if (process.env.DETECTIVE_DIR) cfg.dir = process.env.DETECTIVE_DIR;
  if (process.env.DETECTIVE_PYTHON) cfg.python = process.env.DETECTIVE_PYTHON;
  if (process.env.DETECTIVE_SCRIPT) cfg.script = process.env.DETECTIVE_SCRIPT;
  if (process.env.ENABLE_DETECTIVE === "0") cfg.enabled = false;
  if (process.env.ENABLE_DETECTIVE === "1") cfg.enabled = true;
  if (process.env.DETECTIVE_REQUIRE_LOGIN === "1") cfg.requireLogin = true;
  if (process.env.DETECTIVE_AUTOSTART === "0") cfg.autostart = false;
  return cfg;
}

const DETECTIVE = loadDetectiveConfig();
const DETECTIVE_HOST = DETECTIVE.host;
const DETECTIVE_PORT = DETECTIVE.port;

const DETECTIVE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

function applyDetectiveHeaders(res) {
  res.setHeader("content-security-policy", DETECTIVE_CSP);
  res.setHeader("x-frame-options", "SAMEORIGIN");
  res.setHeader("referrer-policy", "same-origin");
}

function rewriteDetectiveBody(body) {
  return body
    .replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, "")
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/gi, "")
    .replace(/(["'`(])\/static\//g, "$1/detective/static/")
    .replace(/(["'`(])\/api\//g, "$1/detective/api/");
}

function checkTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function resolveDetectiveDir() {
  const candidates = [
    DETECTIVE.dir,
    path.join(ROOT, "..", "model-detective-v5"),
    path.join(ROOT, "..", "..", "model-detective-v5"),
    "D:\\新建文件夹\\model-detective-v5",
    process.env.DETECTIVE_DIR
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(path.join(candidate, DETECTIVE.script || "run_web.py"))) return path.resolve(candidate);
    } catch {
      /* 忽略非法路径 */
    }
  }
  return "";
}

function resolveDetectivePython(dir) {
  if (DETECTIVE.python && fs.existsSync(DETECTIVE.python)) return DETECTIVE.python;
  const local = process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
  if (fs.existsSync(local)) return local;
  return process.platform === "win32" ? "python" : "python3";
}

let detectiveChild = null;
let detectiveStarting = false;
let detectiveLastAttempt = 0;

async function ensureDetectiveRunning(force = false) {
  if (!DETECTIVE.enabled || !DETECTIVE.autostart) return false;
  if (await checkTcp(DETECTIVE_HOST, DETECTIVE_PORT)) return true;
  if (detectiveStarting) return false;
  if (!force && Date.now() - detectiveLastAttempt < 60 * 1000) return false;

  const dir = resolveDetectiveDir();
  if (!dir) {
    console.warn("[detective] 找不到 Model Detective 目录，跳过自动启动（可在 detective.config.json 配置 dir）");
    return false;
  }

  detectiveStarting = true;
  detectiveLastAttempt = Date.now();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(path.join(LOG_DIR, "detective.log"), "a", 0o600);
    const python = resolveDetectivePython(dir);
    console.log(`[detective] 启动检测台：${python} ${DETECTIVE.script || "run_web.py"} (cwd=${dir})`);
    detectiveChild = spawn(python, [DETECTIVE.script || "run_web.py"], {
      cwd: dir,
      env: Object.assign({}, process.env, { HOST: DETECTIVE_HOST, PORT: String(DETECTIVE_PORT), PYTHONUNBUFFERED: "1" }),
      stdio: ["ignore", logFd, logFd],
      windowsHide: true
    });
    fs.closeSync(logFd);
    detectiveChild.once("exit", (code) => {
      console.warn(`[detective] 检测台进程退出 code=${code}`);
      detectiveChild = null;
    });
    detectiveChild.once("error", (err) => {
      console.error("[detective] 启动失败：", err.message);
      detectiveChild = null;
    });
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await checkTcp(DETECTIVE_HOST, DETECTIVE_PORT)) return true;
    }
    return await checkTcp(DETECTIVE_HOST, DETECTIVE_PORT);
  } catch (err) {
    console.error("[detective] 启动异常：", err.message);
    return false;
  } finally {
    detectiveStarting = false;
  }
}

async function detectiveStatus() {
  const up = DETECTIVE.enabled ? await checkTcp(DETECTIVE_HOST, DETECTIVE_PORT) : false;
  return {
    enabled: DETECTIVE.enabled,
    requireLogin: DETECTIVE.requireLogin,
    autostart: DETECTIVE.autostart,
    host: DETECTIVE_HOST,
    port: DETECTIVE_PORT,
    up,
    dir: resolveDetectiveDir() || null
  };
}

function proxyDetective(req, res, url) {
  const upstreamPath = (url.pathname.replace(/^\/detective/, "") || "/") + (url.search || "");
  const headers = Object.assign({}, req.headers);
  delete headers.connection;
  delete headers["keep-alive"];
  delete headers.cookie;
  delete headers.authorization;
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers["x-real-ip"];
  headers.host = `${DETECTIVE_HOST}:${DETECTIVE_PORT}`;
  headers["accept-encoding"] = "identity";

  const MAX_PROXY_BYTES = 2 * 1024 * 1024;
  const upReq = http.request(
    { host: DETECTIVE_HOST, port: DETECTIVE_PORT, method: req.method, path: upstreamPath, headers },
    (up) => {
      const ct = String(up.headers["content-type"] || "");
      const skip = new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "content-length",
        "content-encoding",
        "set-cookie",
        "content-security-policy",
        "x-frame-options",
        "strict-transport-security"
      ]);
      const outHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!skip.has(k.toLowerCase())) outHeaders[k] = v;
      }

      // SSE（/api/status/:job）必须边收边发，攒起来就永远等不到结果
      if (/text\/event-stream/i.test(ct)) {
        res.writeHead(up.statusCode || 200, outHeaders);
        return up.pipe(res);
      }

      if (!/text\/|javascript|json|css/i.test(ct)) {
        res.writeHead(up.statusCode || 200, outHeaders);
        return up.pipe(res);
      }

      const chunks = [];
      let bytes = 0;
      up.on("data", (c) => {
        bytes += c.length;
        if (bytes > MAX_PROXY_BYTES) {
          up.destroy(new Error("upstream response too large"));
          return;
        }
        chunks.push(c);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("上游响应中断");
      });
      up.on("end", () => {
        if (res.writableEnded) return;
        const body = rewriteDetectiveBody(Buffer.concat(chunks).toString("utf8"));
        const buf = Buffer.from(body, "utf8");
        outHeaders["content-length"] = buf.length;
        res.writeHead(up.statusCode || 200, outHeaders);
        res.end(buf);
      });
    }
  );

  upReq.setTimeout(30000, () => upReq.destroy(new Error("detective timeout")));
  upReq.on("error", (err) => {
    if (res.headersSent) return res.end();
    ensureDetectiveRunning(true).catch(() => {});
    const html = `<!doctype html><meta charset="utf-8"><title>模型侦探未启动</title>
<div style="font:14px/1.9 system-ui;padding:48px;max-width:660px;margin:0 auto;color:#334">
<h2 style="margin:0 0 12px">检测台没有响应</h2>
<p>反向代理目标 <code>${DETECTIVE_HOST}:${DETECTIVE_PORT}</code> 连不上。</p>
<p style="color:#667">${String(err.code || err.message)}</p>
<p style="color:#667">服务端已尝试自动拉起 Model Detective。等待 10 秒后刷新本页即可。</p>
<p><a href="/detective/?t=${Date.now()}" style="display:inline-block;margin-top:8px;padding:8px 16px;border-radius:8px;background:#2b53ca;color:#fff;text-decoration:none">重新连接</a></p>
</div>`;
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  req.pipe(upReq);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 404, "Not Found");
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel === "/admin" || rel === "/admin/") rel = "/admin.html";
  if (rel === "/favicon.ico") rel = "/uploads/favicon.ico";

  const target = path.join(PUBLIC_DIR, rel);
  const relative = path.relative(PUBLIC_DIR, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("not a file");
    const realTarget = await fsp.realpath(target);
    const realRoot = await fsp.realpath(PUBLIC_DIR);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return sendText(res, 403, "Forbidden");
    }
    const ext = path.extname(target).toLowerCase();
    const noCache = [".html", ".js", ".css"].includes(ext);

    // HTML：直接注入服务端登录态，前端即使脚本异常也能进后台
    if (ext === ".html") {
      let html = await fsp.readFile(target, "utf8");

      // 资源版本号取文件内容 SHA1 前 10 位：内容一变 URL 必变，不依赖文件时间戳
      const assetRefs = [...html.matchAll(/(?:src|href)="\/([^"?#]+\.(?:js|css))(?:\?v=[^"]*)?"/g)];
      const seenRef = new Set();
      for (const m of assetRefs) {
        if (seenRef.has(m[0])) continue;
        seenRef.add(m[0]);
        let ver = "0";
        try {
          const buf = await fsp.readFile(path.join(PUBLIC_DIR, m[1]));
          ver = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 10);
        } catch {}
        html = html.split(m[0]).join(m[0].replace(/(\?v=[^"]*)?(")$/, `?v=${ver}$2`));
      }

      if (rel === "/admin.html") {
        const session = currentSession(req);
        if (session) {
          html = html.replace("<body>", `<body data-authed="1" data-csrf="${session.csrf}">`);
          html = html.replace(
            "</head>",
            `<noscript><meta http-equiv="refresh" content="0;url=/admin?plain=1"></noscript></head>`
          );
          html = html.replace(
            "</body>",
            `<noscript><div style="position:fixed;left:0;right:0;bottom:0;padding:10px 14px;background:#fff9e9;color:#a46900;font:13px/1.8 system-ui;border-top:1px solid #dfc890;z-index:999">
              已登录。无脚本模式请打开 <a href="/admin?plain=1" style="color:#2b53ca;text-decoration:underline">/admin?plain=1</a>
            </div></noscript></body>`
          );
        } else if (requestUrl(req).searchParams.get("err") === "1") {
          html = html.replace(
            '<p class="form-error" id="login-error" hidden></p>',
            '<p class="form-error" id="login-error">用户名或密码错误，请重新输入</p>'
          );
        } else if (requestUrl(req).searchParams.get("err") === "2") {
          const wait = Math.max(1, Math.ceil(Number(requestUrl(req).searchParams.get("wait")) || 60));
          const minutes = Math.max(1, Math.ceil(wait / 60));
          html = html.replace(
            '<p class="form-error" id="login-error" hidden></p>',
            `<p class="form-error" id="login-error">尝试次数过多，已锁定 ${minutes} 分钟。请 ${minutes} 分钟后再试，或联系管理员解锁。</p>`
          );
        } else if (requestUrl(req).searchParams.get("basic") === "1") {
          res.writeHead(302, { location: "/login", "cache-control": "no-store" });
          return res.end();
        }
      }
      if (rel === "/admin.html") {
        const ua = String(req.headers["user-agent"] || "");
        const short = /Edg\//.test(ua) ? "Edge" : /Chrome\/(\d+)/.test(ua) ? "Chrome " + ua.match(/Chrome\/(\d+)/)[1] : /Firefox/.test(ua) ? "Firefox" : /MSIE|Trident/.test(ua) ? "IE 内核" : "其他内核";
        html = html.replace('<p class="login-hint" id="diag">正在检测服务端…</p>',
          `<p class="login-hint" id="diag">浏览器 ${short} · 正在检测服务端…</p>`);
      }

      if (rel === "/admin.html" || rel.startsWith("/admin")) {
        res.setHeader("x-robots-tag", "noindex, nofollow");
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-cache, no-store, must-revalidate"
      });
      return res.end(html);
    }

    if (ext === ".svg") {
      res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": noCache ? "public, max-age=31536000, immutable" : "public, max-age=300"
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    if (rel.endsWith(".html")) return sendText(res, 404, "页面不存在");
    sendText(res, 404, "Not Found");
  }
}

/* ---------------- 公开数据 ---------------- */

function publicSite(site) {
  return {
    id: site.id,
    slug: site.slug,
    name: site.name,
    domain: site.domain,
    url: site.url,
    logo: site.logo,
    note: site.note,
    tags: site.tags,
    dims: site.dims,
    score: site.score,
    grade: site.grade,
    models: site.models,
    views: Number(site.views) || 0,
    lastViewAt: site.lastViewAt || null,
    kind: site.kind || "commercial",
    modelList: Array.isArray(site.modelList) ? site.modelList : null,
    selectedModels: Array.isArray(site.selectedModels) ? site.selectedModels : null,
    modelListAt: site.modelListAt || null,
    issues: site.issues,
    down: site.down,
    updatedAt: site.updatedAt,
    probe: site.probe ? { at: site.probe.at, reachable: site.probe.reachable, basis: site.probe.basis, metrics: site.probe.metrics } : null,
    modelScore: site.modelScore ?? null,
    modelEval: site.modelEval
      ? { at: site.modelEval.at, model: site.modelEval.model, score: site.modelEval.score, parts: site.modelEval.parts, perf: site.modelEval.perf, ability: site.modelEval.ability, context: site.modelEval.context }
      : null,
    modelCount: site.modelCount ?? (site.modelEval ? 1 : null),
    modelEvals: site.modelEvals
      ? Object.values(site.modelEvals)
          .filter((r) => r && r.ok)
          .map((r) => ({
            model: r.model,
            score: r.score,
            ttft: r.perf ? r.perf.ttft : null,
            tps: r.perf ? r.perf.tps : null,
            ability: r.ability ? r.ability.rate : null,
            passed: r.ability ? r.ability.pass : null,
            total: r.ability ? r.ability.total : null,
            ctx: r.context ? r.context.maxVerified : null,
            thinking: r.thinking ? r.thinking.share : 0
          }))
      : null
  };
}

function buildStats(sites) {
  const models = sites.reduce((n, s) => n + (s.models || 0), 0);
  const issues = sites.reduce((n, s) => n + (s.issues || 0), 0);
  const down = sites.reduce((n, s) => n + (s.down || 0), 0);
  return { sites: sites.length, models, issues, down };
}

function adminSiteView(site) {
  return {
    ...site,
    hasApiKey: Boolean(site.apiKey),
    apiKey: site.apiKey ? "********" : ""
  };
}

function buildAdminStats() {
  const by = (status) => db.sites.filter((s) => s.status === status).length;
  return { total: db.sites.length, pending: by("pending"), published: by("published"), rejected: by("rejected"), draft: by("draft") };
}

function pushReview(site, action, reason) {
  db.reviews.unshift({
    id: "rv_" + randomId(5),
    siteId: site.id,
    siteName: site.name,
    domain: site.domain,
    action,
    reason: reason || "",
    by: db.admin.username,
    at: nowIso()
  });
  db.reviews = db.reviews.slice(0, 500);
}

/* ---------------- 真实探测队列 ---------------- */

let probeChain = Promise.resolve();
let probeBusy = 0;
const probeProgress = new Map();

function applyProbe(site, result) {
  const merged = {};
  for (const key of DIMS) {
    const next = result.dims[key];
    // 这一维没测到就保留上一次的值，别把已测过的成功率抹成 null；同时顺手丢掉历史维度键
    merged[key] = next === null || next === undefined ? (site.dims && site.dims[key] !== undefined ? site.dims[key] : null) : next;
  }
  site.dims = merged;
  site.score = computeScore(merged);
  site.grade = gradeOf(site.score);
  if (Array.isArray(result.publicModels) && result.publicModels.length) {
    site.modelList = result.publicModels.slice(0, 200);
    site.modelListAt = result.at;
    site.models = site.modelList.length;
  } else if (result.reachable) {
    site.modelList = [];
    site.modelListAt = result.at;
    site.models = 0;
  }
  // 提交者勾的模型必须真实出现在目录里，否则剔除
  if (Array.isArray(site.selectedModels) && site.selectedModels.length) {
    if (Array.isArray(site.modelList) && site.modelList.length) {
      const valid = site.selectedModels.filter((m) => site.modelList.includes(m));
      if (valid.length !== site.selectedModels.length) {
        pushReview(site, "probe", `模型核对：剔除 ${site.selectedModels.length - valid.length} 个目录中不存在的模型`);
      }
      site.selectedModels = valid;
    }
  }
  site.probe = {
    at: result.at,
    durationMs: result.durationMs,
    base: result.base,
    reachable: result.reachable,
    samples: result.samples,
    basis: result.basis,
    details: result.details,
    metrics: result.metrics,
    evidence: result.evidence || null,
    sla: SLA,
    error: result.error
  };
  site.updatedAt = nowIso();
}

/* ---------------- 提交自动审核 ---------------- */

/*
 * 访客提交后自动跑一次实测，够线就直接上线，不用人工点。
 * 五维里有三维（目录/补全/流式/并发）都要 API Key 才测得到，
 * 所以没填 Key 的提交只能测到连通，必然不够 minDims，会留在待审队列里等人工。
 */
const AUTO_REVIEW_DEFAULT = {
  enabled: true,
  minScore: 75, // 综合分下限
  minDim: 60, // 已测维度各自的成功率下限
  minDims: 5 // 至少要测到几维才允许自动通过
};

function autoReviewVerdict(site) {
  const cfg = (db.settings && db.settings.autoReview) || AUTO_REVIEW_DEFAULT;
  if (!cfg.enabled) return { approved: false, reason: "自动审核未启用" };
  if (!site || site.status !== "pending") return { approved: false, reason: "不在待审状态" };
  const p = site.probe;
  if (!p || !p.at) return { approved: false, reason: "还没有实测数据" };
  if (!p.reachable) return { approved: false, reason: "站点不可达" };
  const dims = site.dims || {};
  const measured = DIMS.filter((k) => typeof dims[k] === "number" && Number.isFinite(dims[k]));
  if (measured.length < cfg.minDims) {
    return {
      approved: false,
      reason: `只测到 ${measured.length}/${DIMS.length} 维（没填 API Key 测不到目录/补全/流式/并发）`
    };
  }
  const low = measured.filter((k) => dims[k] < cfg.minDim);
  if (low.length) {
    return {
      approved: false,
      reason: `${low.map((k) => DIM_LABELS[k]).join("、")}低于 ${cfg.minDim}（${low.map((k) => dims[k]).join(" / ")}）`
    };
  }
  const score = Number(site.score) || 0;
  if (score < cfg.minScore) {
    return { approved: false, reason: `综合分 ${score} 低于 ${cfg.minScore}` };
  }
  return {
    approved: true,
    reason: `综合分 ${score}（${site.grade}）· 连通 ${fmtNum(dims.reach)} / 目录 ${fmtNum(dims.catalog)} / 补全 ${fmtNum(dims.chat)} / 流式 ${fmtNum(dims.stream)} / 并发 ${fmtNum(dims.concurrent)}`
  };
}

/* 跑完实测立刻判定；只有待审站点会被自动改状态 */
function applyAutoReview(site) {
  if (!site || site.status !== "pending") return;
  const verdict = autoReviewVerdict(site);
  if (verdict.approved) {
    site.status = "published";
    site.reviewedAt = nowIso();
    site.reviewedBy = "auto";
    site.updatedAt = nowIso();
    pushReview(site, "approve", `自动审核通过 — ${verdict.reason}`);
  } else {
    pushReview(site, "auto-review", `自动审核未通过 — ${verdict.reason}`);
  }
}

function queueProbe(site) {
  probeBusy += 1;
  const progress = {
    siteId: site.id,
    name: site.name,
    domain: site.domain,
    startedAt: Date.now(),
    done: 0,
    total: 28,
    dim: "",
    state: "queued",
    log: []
  };
  probeProgress.set(site.id, progress);
  probeChain = probeChain
    .then(async () => {
      progress.state = "running";
      const result = await probeSite(site, {
        onProgress: (ev) => {
          progress.done += 1;
          progress.dim = ev.dim;
          progress.log.push({ dim: ev.dim, n: ev.n, total: ev.total, ms: ev.ms, ok: ev.ok, note: ev.note || "", at: Date.now() });
          if (progress.log.length > 80) progress.log.shift();
        }
      });
      applyProbe(site, result);
      pushReview(site, "probe", `实测成功率 连通${fmtNum(site.dims.reach)} 目录${fmtNum(site.dims.catalog)} 补全${fmtNum(site.dims.chat)} 流式${fmtNum(site.dims.stream)} 并发${fmtNum(site.dims.concurrent)}`);
      applyAutoReview(site);
      await saveDb();
      return result;
    })
    .catch((e) => { console.error("[probe]", site.domain, e.message); })
    .finally(() => {
      probeBusy -= 1;
      probeProgress.delete(site.id);
    });
  return probeChain;
}

/* ---------------- 自动实测调度（默认 1 小时一轮） ---------------- */

const AUTO_PROBE_DEFAULT = {
  enabled: true,
  intervalMinutes: 5,
  scope: "published",
  requireApiKey: true,
  lastRunAt: null,
  lastFinishedAt: null,
  nextRunAt: null,
  lastSummary: null
};

function normalizeSettings(input) {
  const raw = input && typeof input === "object" ? input : {};
  const auto = raw.autoProbe && typeof raw.autoProbe === "object" ? raw.autoProbe : {};
  const intervalMinutes = Math.min(1440, Math.max(5, parseInt(auto.intervalMinutes, 10) || AUTO_PROBE_DEFAULT.intervalMinutes));
  const enabled = auto.enabled === undefined ? AUTO_PROBE_DEFAULT.enabled : Boolean(auto.enabled);
  const scope = auto.scope === "all" ? "all" : "published";
  const requireApiKey = auto.requireApiKey === undefined ? AUTO_PROBE_DEFAULT.requireApiKey : Boolean(auto.requireApiKey);
  const nextRunAt =
    typeof auto.nextRunAt === "string" && !Number.isNaN(Date.parse(auto.nextRunAt))
      ? auto.nextRunAt
      : new Date(Date.now() + 30 * 1000).toISOString();
  const review = raw.autoReview && typeof raw.autoReview === "object" ? raw.autoReview : {};
  return {
    autoReview: {
      enabled: review.enabled === undefined ? AUTO_REVIEW_DEFAULT.enabled : Boolean(review.enabled),
      minScore: Number.isFinite(Number(review.minScore)) ? Math.min(100, Math.max(0, Number(review.minScore))) : AUTO_REVIEW_DEFAULT.minScore,
      minDim: Number.isFinite(Number(review.minDim)) ? Math.min(100, Math.max(0, Number(review.minDim))) : AUTO_REVIEW_DEFAULT.minDim,
      minDims: Number.isFinite(Number(review.minDims))
        ? Math.min(DIMS.length, Math.max(1, parseInt(review.minDims, 10)))
        : AUTO_REVIEW_DEFAULT.minDims
    },
    autoProbe: {
      enabled,
      intervalMinutes,
      scope,
      requireApiKey,
      lastRunAt: typeof auto.lastRunAt === "string" ? auto.lastRunAt : null,
      lastFinishedAt: typeof auto.lastFinishedAt === "string" ? auto.lastFinishedAt : null,
      nextRunAt,
      lastSummary:
        auto.lastSummary && typeof auto.lastSummary === "object" && Number(auto.lastSummary.total) > 0
          ? {
              at: auto.lastSummary.at || null,
              total: Number(auto.lastSummary.total) || 0,
              ok: Number(auto.lastSummary.ok) || 0,
              failed: Number(auto.lastSummary.failed) || 0,
              durationMs: Number(auto.lastSummary.durationMs) || 0,
              reason: auto.lastSummary.reason || "schedule",
              sites: Array.isArray(auto.lastSummary.sites) ? auto.lastSummary.sites.slice(0, 30) : []
            }
          : null
    }
  };
}

function autoProbeTargets() {
  const cfg = db.settings.autoProbe;
  return db.sites.filter((site) => {
    const inScope = cfg.scope === "all" ? site.status === "published" || site.status === "pending" : site.status === "published";
    if (!inScope) return false;
    if (cfg.requireApiKey !== false && !site.apiKey) return false;
    return true;
  });
}

function autoProbeStatus() {
  const cfg = db.settings.autoProbe;
  return {
    enabled: cfg.enabled,
    intervalMinutes: cfg.intervalMinutes,
    scope: cfg.scope,
    requireApiKey: cfg.requireApiKey,
    lastRunAt: cfg.lastRunAt,
    lastFinishedAt: cfg.lastFinishedAt,
    nextRunAt: cfg.nextRunAt,
    lastSummary: cfg.lastSummary,
    running: autoProbeBusy,
    queued: probeBusy,
    targets: autoProbeTargets().length,
    skipped: db.sites.filter((site) => site.status === "published" && !site.apiKey).length,
    progress: Array.from(probeProgress.values()).map((p) => ({
      siteId: p.siteId,
      name: p.name,
      state: p.state,
      done: p.done,
      total: p.total,
      dim: p.dim
    }))
  };
}

let autoProbeBusy = false;
let autoProbeTimer = null;

async function runAutoProbe(reason = "schedule") {
  if (autoProbeBusy) return { ok: false, error: "自动实测正在运行中" };
  const cfg = db.settings.autoProbe;
  const targets = autoProbeTargets();
  const startedAt = Date.now();
  autoProbeBusy = true;
  cfg.lastRunAt = new Date(startedAt).toISOString();
  cfg.nextRunAt = new Date(startedAt + cfg.intervalMinutes * 60 * 1000).toISOString();
  await saveDb();

  const results = [];
  try {
    for (const site of targets) {
      const before = site.probe && site.probe.at ? site.probe.at : null;
      await queueProbe(site);
      const after = site.probe && site.probe.at ? site.probe.at : null;
      results.push({
        id: site.id,
        name: site.name,
        ok: Boolean(after && after !== before),
        score: site.score,
        at: after
      });
    }
    const okCount = results.filter((item) => item.ok).length;
    cfg.lastSummary = {
      at: new Date().toISOString(),
      total: targets.length,
      ok: okCount,
      failed: targets.length - okCount,
      durationMs: Date.now() - startedAt,
      reason,
      sites: results
    };
    if (targets.length) {
      pushReview(
        { id: "auto_probe", name: "自动实测", domain: "system" },
        "auto-probe",
        `${reason === "manual" ? "手动触发" : "定时任务"}：${targets.length} 个站点，成功 ${okCount} 个，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`
      );
    }
    return { ok: true, summary: cfg.lastSummary };
  } catch (err) {
    cfg.lastSummary = {
      at: new Date().toISOString(),
      total: targets.length,
      ok: results.filter((item) => item.ok).length,
      failed: targets.length - results.filter((item) => item.ok).length,
      durationMs: Date.now() - startedAt,
      reason,
      error: err.message,
      sites: results
    };
    console.error("[auto-probe]", err.message);
    return { ok: false, error: err.message, summary: cfg.lastSummary };
  } finally {
    autoProbeBusy = false;
    cfg.lastFinishedAt = nowIso();
    cfg.nextRunAt = new Date(Date.now() + cfg.intervalMinutes * 60 * 1000).toISOString();
    await saveDb();
  }
}

function autoProbeTick() {
  if (!db || !db.settings || !db.settings.autoProbe) return;
  const cfg = db.settings.autoProbe;
  if (!cfg.enabled || autoProbeBusy) return;
  const next = Date.parse(cfg.nextRunAt || "");
  if (Number.isFinite(next) && Date.now() < next) return;
  if (!autoProbeTargets().length) {
    cfg.nextRunAt = new Date(Date.now() + cfg.intervalMinutes * 60 * 1000).toISOString();
    saveDb().catch(() => {});
    return;
  }
  runAutoProbe("schedule").catch((err) => console.error("[auto-probe] tick", err.message));
}

function startAutoProbeScheduler() {
  if (autoProbeTimer) clearInterval(autoProbeTimer);
  autoProbeTimer = setInterval(autoProbeTick, 30 * 1000);
  autoProbeTimer.unref?.();
  setTimeout(autoProbeTick, 8 * 1000).unref?.();
}

/* ---------------- 模型质量评测队列 ---------------- */

let evalChain = Promise.resolve();
let evalBusy = 0;

function queueEval(site, opts) {
  evalBusy += 1;
  evalChain = evalChain
    .then(async () => {
      const result = await evalModel(site, opts);
      if (result.ok) {
        site.modelEvals = site.modelEvals && typeof site.modelEvals === "object" ? site.modelEvals : {};
        site.modelEvals[result.model] = result;
        site.modelEval = result;
        // 清掉历史遗留的「假成功」：ok 但没有 perf 的记录等于一次都没通
        for (const [k, v] of Object.entries(site.modelEvals)) {
          if (!v || !v.ok || !v.perf) delete site.modelEvals[k];
        }
        site.evalFail = null;
        const done = Object.values(site.modelEvals).filter((r) => r && r.ok && r.perf);
        site.modelScore = done.length
          ? Math.round((done.reduce((a, b) => a + b.score, 0) / done.length) * 10) / 10
          : result.score;
        site.modelCount = done.length;
        if (result.model) site.probeModel = result.model;
        pushReview(site, "eval", `模型评测 ${result.model} → ${result.score} 分（能力 ${result.parts.ability}%）`);
        await saveDb();
      } else {
        site.evalFail = {
          ok: false,
          at: new Date().toISOString(),
          model: result.model || site.probeModel || "",
          error: result.error || "评测失败",
          modelNote: result.modelNote || ""
        };
        pushReview(site, "eval-fail", `模型评测失败 ${site.evalFail.model}：${site.evalFail.error}`);
        console.error("[eval]", site.domain, result.error);
        await saveDb();
      }
      return result;
    })
    .catch((e) => { console.error("[eval]", site.domain, e.message); })
    .finally(() => { evalBusy -= 1; });
  return evalChain;
}

/* ---------------- 无 JS 兜底后台 ---------------- */

const HTML_ESC = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function plainPage(session, msg = "") {
  const draft = {
    pending: db.sites.filter((s) => s.status === "pending"),
    published: db.sites.filter((s) => s.status === "published"),
    rejected: db.sites.filter((s) => s.status === "rejected"),
    draft: db.sites.filter((s) => s.status === "draft")
  };
  const all = [...draft.pending, ...draft.published, ...draft.rejected, ...draft.draft];
  const csrf = session.csrf;

  const row = (s) => `<tr class="${s.status === "pending" ? "pending-row" : ""}">
    <td><b>${HTML_ESC(s.name)}</b><br><small>${HTML_ESC(s.domain)}</small></td>
    <td>${fmtNum(s.score)}</td>
    <td>${s.grade}</td>
    <td class="dims">${["reach","catalog","chat","stream","concurrent"].map((k) => `<span class="pb"><i style="width:${Math.max(3, Math.min(100, Number(s.dims[k]) || 0))}%;background:${(Number(s.dims[k]) || 0) >= 88 ? "#12a06a" : (Number(s.dims[k]) || 0) >= 72 ? "#e2a03a" : "#e05252"}"></i></span>`).join("")}<small>${["reach","catalog","chat","stream","concurrent"].map((k) => s.dims[k] === null || s.dims[k] === undefined ? "—" : Math.round(Number(s.dims[k]))).join("·")}</small></td>
    <td>${s.models} / ${s.issues} / ${s.down}</td>
    <td>${STATUS_ZH[s.status] || s.status}</td>
    <td>
      <form method="post" action="/admin/action" style="display:inline">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="id" value="${s.id}">
        <input type="hidden" name="action" value="approve">
        <button type="submit" ${s.status === "published" ? "disabled" : ""}>通过</button>
      </form>
      <form method="post" action="/admin/action" style="display:inline">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="id" value="${s.id}">
        <input type="hidden" name="action" value="reject">
        <input name="reason" placeholder="驳回原因" size="10" required>
        <button type="submit" ${s.status === "rejected" ? "disabled" : ""}>驳回</button>
      </form>
      <form method="post" action="/admin/action" style="display:inline">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="id" value="${s.id}">
        <input type="hidden" name="action" value="delete">
        <button type="submit" onclick="return confirm('确认删除？')">删除</button>
      </form>
    </td>
  </tr>`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>后台精简模式 · 中转站榜单</title>
<link rel="stylesheet" href="/admin.css?v=5">
<style>
  body{background:#f4f7fd;padding:20px}
  .plain-wrap{max-width:1400px;margin:0 auto}
  .plain-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
  .plain-head h1{font-size:18px;margin:0}
  .plain-msg{padding:8px 12px;border-radius:8px;background:#ebf9f3;color:#13855f;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e0e7f2;border-radius:10px;overflow:hidden;font-size:12.5px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eef2f9;white-space:nowrap}
  th{background:#f8fbff;font-size:11.5px;color:#64718a}
  button{padding:4px 9px;border-radius:7px;border:1px solid #d5deeb;background:#fff;cursor:pointer;font-size:12px}
  button:hover{border-color:#2b53ca;color:#2b53ca}
  button[disabled]{opacity:.4;cursor:not-allowed}
  input[name=reason]{padding:4px 6px;border:1px solid #e0e7f2;border-radius:6px;font-size:12px}
  .plain-note{font-size:12px;color:#64718a;margin-top:10px;line-height:1.8}
  td.dims{white-space:nowrap}
  td.dims .pb{display:inline-block;width:26px;height:5px;margin-right:3px;background:#e8eef8;border-radius:3px;overflow:hidden;vertical-align:middle}
  td.dims .pb i{display:block;height:100%;border-radius:3px}
  td.dims small{display:block;margin-top:3px;font-size:10.5px;color:#8a94a8;font-variant-numeric:tabular-nums}
  tr.pending-row td:first-child{box-shadow:inset 3px 0 0 #e2a03a}
</style></head><body>
<div class="plain-wrap">
  <div class="plain-head">
    <h1>中转站榜单 · 后台精简模式</h1>
    <div>
      <span class="badge pending">待审 ${draft.pending.length}</span>
      <span class="badge published">已通过 ${draft.published.length}</span>
      <span class="badge rejected">已驳回 ${draft.rejected.length}</span>
      &nbsp;<a href="/admin?full=1">完整后台（需要脚本）</a> · <a href="/" target="_blank">前台</a>
    </div>
  </div>
  ${msg ? `<div class="plain-msg">${HTML_ESC(msg)}</div>` : ""}
  <table>
    <thead><tr>
      <th>站点</th><th>综合分</th><th>等级</th><th>五维（真/稳/可/安/完）</th><th>模型/问题/故障</th><th>状态</th><th>操作</th>
    </tr></thead>
    <tbody>${all.length ? all.map(row).join("") : `<tr><td colspan="11">暂无数据</td></tr>`}</tbody>
  </table>
  <p class="plain-note">
    这是服务端渲染的无脚本后台：所有按钮都是原生表单 POST，不依赖 JavaScript；登录依赖 HttpOnly Cookie，浏览器需启用 Cookie。
    新增 / 编辑 / 批量导入 / 上传图标请用完整后台。
  </p>
</div>
</body></html>`;
}

const STATUS_ZH = { pending: "待审核", published: "已通过", rejected: "已驳回", draft: "草稿" };
const fmtNum = (n) => (n === null || n === undefined || n === "" ? "—" : (Math.round(Number(n) * 10) / 10).toFixed(1));

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

async function handlePlainRoutes(req, res, url) {
  // 原生表单登录（无 JS）
  if (url.pathname === "/login-form" && req.method === "POST") {
    const raw = await readBody(req, 64 * 1024);
    const form = new URLSearchParams(raw);
    const username = String(form.get("username") || "").trim();
    const password = String(form.get("password") || "");
    const ip = clientIp(req);

    const next = String(form.get("next") || "");
    const target = next === "/admin?plain=1" ? "/admin?plain=1" : "/admin?full=1";
    const extra = (query) => target + (target.includes("?") ? "&" : "?") + query;

    const blocked = loginBlocked(username, ip);
    if (blocked) {
      securityLog("login_blocked", `ip=${maskIp(ip)} user=${username.slice(0, 32)} scope=${blocked.scope} retry=${blocked.retryAfterSec}s form=1`);
      return redirect(res, extra(`err=2&wait=${encodeURIComponent(blocked.retryAfterSec || 60)}`));
    }

    const passOk = await verifyPassword(password, db.admin.salt, db.admin.hash).catch(() => false);
    const userOk = safeTextEqual(username, db.admin.username);
    if (!userOk || !passOk) {
      loginFailed(username, ip, userOk ? "bad_password" : "bad_username");
      await new Promise((resolve) => setTimeout(resolve, 350));
      return redirect(res, extra("err=1"));
    }

    loginSucceeded(username, ip);
    const sess = newSession();
    db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now());
    db.sessions.push(sess.record);
    db.admin.lastLoginAt = nowIso();
    db.admin.lastLoginIp = maskIp(ip);
    await saveDb();

    res.writeHead(302, {
      location: target,
      "set-cookie": cookieHeader(req, COOKIE_NAME, sess.sid, SESSION_TTL / 1000),
      "cache-control": "no-store"
    });
    return res.end();
  }

  // 极简登录页（无 CSS、无 JS，纯 HTML 表单）
  if (url.pathname === "/login") {
    const next = url.searchParams.get("next") === "plain" ? "/admin?plain=1" : "/admin";
    const error = url.searchParams.get("err") === "2"
      ? "尝试次数过多，账号已临时锁定，请稍后再试"
      : url.searchParams.get("err") === "1"
        ? "用户名或密码错误"
        : "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(loginSimpleHtml(next, error));
  }

  // 精简模式页面
  if (url.pathname === "/admin" && url.searchParams.get("plain") === "1") {
    const session = currentSession(req);
    if (!session) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(loginSimpleHtml("/admin?plain=1", ""));
    }
    const html = plainPage(session, url.searchParams.get("msg") || "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }

  // 精简模式的动作
  if (url.pathname === "/admin/action" && req.method === "POST") {
    const raw = await readBody(req);
    const form = new URLSearchParams(raw);
    const session = currentSession(req);
    if (!session) return redirect(res, "/login?next=plain");

    if (String(form.get("csrf") || "") !== session.csrf) {
      return redirect(res, "/admin?plain=1&msg=" + encodeURIComponent("CSRF 校验失败，请刷新页面重试"));
    }

    const id = String(form.get("id") || "");
    const action = String(form.get("action") || "");
    const reason = String(form.get("reason") || "").slice(0, 200);
    const site = db.sites.find((s) => s.id === id);
    if (!site) return redirect(res, "/admin?plain=1&msg=" + encodeURIComponent("记录不存在"));

    if (action === "delete") {
      db.sites = db.sites.filter((s) => s.id !== id);
      pushReview(site, "delete", "精简模式删除");
      await saveDb();
      return redirect(res, "/admin?plain=1&msg=" + encodeURIComponent("已删除 " + site.name));
    }

    if (["approve", "reject", "reset"].includes(action)) {
      site.status = action === "approve" ? "published" : action === "reject" ? "rejected" : "pending";
      site.reviewNote = reason || (action === "approve" ? "审核通过" : action === "reject" ? "审核驳回" : "重新排队");
      site.reviewedAt = nowIso();
      site.updatedAt = nowIso();
      pushReview(site, action, site.reviewNote);
      await saveDb();
      return redirect(res, "/admin?plain=1&msg=" + encodeURIComponent(`${site.name} → ${STATUS_ZH[site.status]}`));
    }

    return redirect(res, "/admin?plain=1&msg=" + encodeURIComponent("未知操作"));
  }

  return false;
}
/* ---------------- API 路由 ---------------- */

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "RelayRank",
      time: nowIso()
    });
  }

  /* ---- 公开 ---- */
  if (pathname === "/api/sites" && method === "GET") {
    const published = db.sites.filter((s) => s.status === "published");
    const sorted = published.slice().sort((a, b) => b.score - a.score);
    return sendJson(res, 200, {
      sites: sorted.map(publicSite),
      stats: buildStats(published),
      updatedAt: sorted.reduce((t, s) => (s.updatedAt > t ? s.updatedAt : t), db.createdAt),
      weights: WEIGHTS,
      dimLabels: DIM_LABELS
    });
  }

  /* ---- 公开：拉取某站的真实模型目录（提交者勾选用） ---- */
  if (pathname === "/api/model-catalog" && method === "POST") {
    if (catalogLimited(clientIp(req))) return sendJson(res, 429, { error: "请求过于频繁，请稍后再试" });
    const body = await readJson(req).catch(() => ({}));
    const raw = String(body.url || body.domain || "").trim().slice(0, 200);
    if (!raw) return sendJson(res, 400, { error: "请先填写访问地址或域名" });
    const apiKey = String(body.apiKey || "").trim().slice(0, 200);
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      await assertPublicUrl(normalized, { allowHttp: !apiKey });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    const result = await fetchModelList(normalized, { timeout: 10000, apiKey });
    if (!result.ok) return sendJson(res, 200, { ok: false, models: [], error: "目录拉取失败" });
    const models = result.models.slice(0, 300);
    return sendJson(res, 200, { ok: true, models, total: result.models.length, shown: models.length, source: result.source });
  }

  /* ---- 公开提交（进入待审核队列） ---- */
  if (pathname === "/api/submit" && method === "POST") {
    if (submitLimited(clientIp(req))) return sendJson(res, 429, { error: "提交过于频繁，请稍后再试" });

    const body = await readJson(req).catch(() => ({}));
    if (body.honey) return sendJson(res, 200, { ok: true, message: "已收到，等待审核" });

    const name = String(body.name || "").trim().slice(0, 80);
    const domain = String(body.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase().slice(0, 120);
    if (!name || !domain) return sendJson(res, 400, { error: "站点名称与域名必填" });
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return sendJson(res, 400, { error: "域名格式不正确" });
    const existing = db.sites.find((s) => s.domain === domain);
    const pickedNow = cleanModels(body.selectedModels);
    const proposedUrl = safeHttpUrl(body.url);

    if (existing) {
      /*
       * 公开提交永远不直接修改已发布站点，也不允许改待审站点的 URL/Key。
       * 待审站点只有在“没有存过 Key + URL 仍属于同一域名”时才允许补充模型/备注。
       */
      let sameHost = false;
      try {
        sameHost = Boolean(proposedUrl && new URL(proposedUrl).hostname === existing.domain);
      } catch {
        sameHost = false;
      }

      if (existing.status === "pending" && !existing.apiKey && sameHost) {
        if (proposedUrl) existing.url = proposedUrl;
        if (body.note) existing.note = String(body.note).trim().slice(0, 200);
        if (pickedNow.length) {
          existing.modelList = pickedNow.slice();
          existing.tags = pickedNow.slice();
          existing.modelListAt = nowIso();
          existing.models = pickedNow.length;
        }
        existing.updatedAt = nowIso();
      } else {
        db.submissions.unshift({
          id: "sub_" + randomId(6),
          siteId: existing.id,
          name,
          domain,
          url: proposedUrl,
          note: String(body.note || "").trim().slice(0, 200),
          selectedModels: pickedNow,
          status: "pending",
          at: nowIso()
        });
      }

      db.reviews.unshift({
        id: "rv_" + randomId(5),
        siteId: existing.id,
        siteName: existing.name,
        domain: existing.domain,
        action: "resubmit",
        reason: `重新提交，模型 ${pickedNow.length} 个（待审核）`,
        by: "visitor",
        at: nowIso()
      });
      await saveDb();
      return sendJson(res, 202, { ok: true, updated: false, id: existing.id, message: "已提交更新申请，等待管理员审核" });
    }

    const site = normalizeSite({
      name,
      domain,
      url: proposedUrl || `https://${domain}`,
      evalBaseUrl: String(body.evalBaseUrl || "").trim().slice(0, 300),
      note: String(body.note || "").trim().slice(0, 200),
      logo: "",
      kind: ["commercial", "public"].includes(body.kind) ? body.kind : "commercial",
      selectedModels: pickedNow,
      apiKey: String(body.apiKey || "").trim().slice(0, 200),
      models: pickedNow.length,
      views: 0,
      issues: 0,
      down: 0,
      dims: {},
      status: "pending",
      submittedBy: "visitor"
    });

    /* 提交时勾的模型一并入库，审核通过后前台直接显示 */
    if (pickedNow.length) {
      site.tags = pickedNow.slice();
      site.modelList = pickedNow.slice();
      site.modelListAt = nowIso();
      site.models = pickedNow.length;
    }

    db.sites.push(site);
    db.submissions.unshift({
      id: "sub_" + randomId(6),
      siteId: site.id,
      name,
      domain,
      url: site.url,
      note: site.note,
      selectedModels: pickedNow,
      status: "pending",
      at: nowIso()
    });
    db.reviews.unshift({
      id: "rv_" + randomId(5),
      siteId: site.id,
      siteName: site.name,
      domain: site.domain,
      action: "submit",
      reason: `访客提交，模型 ${pickedNow.length} 个`,
      by: "visitor",
      at: nowIso()
    });
    await saveDb();
    if (site.apiKey) queueProbe(site);
    return sendJson(res, 201, {
      ok: true,
      status: "pending",
      autoReview: Boolean(site.apiKey),
      message: site.apiKey
        ? "提交成功，正在自动实测；综合分与五维达标后自动上线，不达标进人工审核。"
        : "提交成功，已进入人工审核队列（没填 API Key 测不了补全/流式/并发，只能人工核验）。",
      id: site.id
    });
  }

  /* ---- 登录 ---- */
  if (pathname === "/api/admin/login" && method === "POST") {
    const ip = clientIp(req);
    const body = await readJson(req).catch(() => ({}));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (!username || !password) return sendJson(res, 400, { error: "请输入用户名和密码" });

    const blocked = loginBlocked(username, ip);
    if (blocked) {
      securityLog("login_blocked", `ip=${maskIp(ip)} user=${username.slice(0, 32)} scope=${blocked.scope} retry=${blocked.retryAfterSec}s`);
      return sendJson(
        res,
        429,
        { error: loginRetryMessage(blocked), retryAfter: blocked.retryAfterSec, scope: blocked.scope },
        { "retry-after": String(blocked.retryAfterSec || 60) }
      );
    }

    const passOk = await verifyPassword(password, db.admin.salt, db.admin.hash).catch(() => false);
    const userOk = safeTextEqual(username, db.admin.username);
    if (!userOk || !passOk) {
      loginFailed(username, ip, userOk ? "bad_password" : "bad_username");
      await new Promise((resolve) => setTimeout(resolve, 350));
      return sendJson(res, 401, { error: "用户名或密码错误" });
    }

    loginSucceeded(username, ip);
    const sess = newSession();
    db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now());
    db.sessions.push(sess.record);
    db.admin.lastLoginAt = nowIso();
    db.admin.lastLoginIp = maskIp(ip);
    await saveDb();

    return sendJson(
      res,
      200,
      { ok: true, username: db.admin.username, csrf: sess.csrf, expiresAt: sess.record.expiresAt },
      { "set-cookie": cookieHeader(req, COOKIE_NAME, sess.sid, SESSION_TTL / 1000) }
    );
  }

  if (pathname === "/api/admin/logout" && method === "POST") {
    const session = currentSession(req);
    if (session) {
      db.sessions = db.sessions.filter((s) => s.id !== session.id);
      await saveDb();
    }
    return sendJson(res, 200, { ok: true }, { "set-cookie": cookieHeader(req, COOKIE_NAME, "", 0) });
  }

  /* ---- 以下都需要登录 ---- */
  if (!pathname.startsWith("/api/admin/")) {
    return sendJson(res, 404, { error: "接口不存在" });
  }

  const session = requireSession(req, res);
  if (!session) return;

  if (method !== "GET" && !requireCsrf(req, res, session)) return;

  if (pathname === "/api/admin/session" && method === "GET") {
    return sendJson(res, 200, {
      username: db.admin.username,
      csrf: session.csrf,
      expiresAt: session.expiresAt,
      lastLoginAt: db.admin.lastLoginAt || null,
      lastLoginIp: db.admin.lastLoginIp || null,
      auth: "cookie"
    });
  }

  /* ---- 后台设置：自动实测 / 检测台状态 ---- */
  if (pathname === "/api/admin/settings" && method === "GET") {
    return sendJson(res, 200, {
      autoProbe: autoProbeStatus(),
      autoReview: db.settings.autoReview,
      detective: await detectiveStatus()
    });
  }

  if (pathname === "/api/admin/settings/auto-probe" && method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const wasEnabled = db.settings.autoProbe.enabled;
    db.settings = normalizeSettings({
      autoReview: {
        ...db.settings.autoReview,
        enabled: body.reviewEnabled === undefined ? db.settings.autoReview.enabled : Boolean(body.reviewEnabled),
        minScore: body.reviewMinScore === undefined ? db.settings.autoReview.minScore : body.reviewMinScore,
        minDim: body.reviewMinDim === undefined ? db.settings.autoReview.minDim : body.reviewMinDim,
        minDims: body.reviewMinDims === undefined ? db.settings.autoReview.minDims : body.reviewMinDims
      },
      autoProbe: {
        ...db.settings.autoProbe,
        enabled: body.enabled === undefined ? db.settings.autoProbe.enabled : Boolean(body.enabled),
        intervalMinutes: body.intervalMinutes === undefined ? db.settings.autoProbe.intervalMinutes : body.intervalMinutes,
        scope: body.scope === undefined ? db.settings.autoProbe.scope : body.scope,
        requireApiKey: body.requireApiKey === undefined ? db.settings.autoProbe.requireApiKey : Boolean(body.requireApiKey)
      }
    });
    if (db.settings.autoProbe.enabled && !wasEnabled) {
      db.settings.autoProbe.nextRunAt = new Date(Date.now() + 10 * 1000).toISOString();
    }
    await saveDb();
    return sendJson(res, 200, { ok: true, autoProbe: autoProbeStatus(), autoReview: db.settings.autoReview });
  }

  if (pathname === "/api/admin/auto-probe/run" && method === "POST") {
    if (autoProbeBusy) return sendJson(res, 409, { error: "自动实测正在运行，请等待当前任务结束" });
    const targets = autoProbeTargets();
    if (!targets.length) return sendJson(res, 400, { error: "当前没有可实测的站点" });
    runAutoProbe("manual").catch((err) => console.error("[auto-probe] manual", err.message));
    return sendJson(res, 202, { ok: true, queued: targets.length, message: `已开始实测 ${targets.length} 个站点` });
  }

  /* ---- 登录防护状态 / 手动解锁 ---- */
  if (pathname === "/api/admin/security/login-guard" && method === "GET") {
    return sendJson(res, 200, { ...loginGuard.list(), limits: { accountMax: 5, accountWindowMinutes: 15, accountLockMinutes: 15, ipMax: 20, ipLockMinutes: 30 } });
  }

  if (pathname === "/api/admin/security/login-guard/unlock" && method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    if (body.all === true) {
      loginGuard.unlockAll();
      securityLog("login_unlock", `all by=${db.admin.username}`);
      return sendJson(res, 200, { ok: true, unlocked: "all" });
    }
    const id = String(body.id || "");
    if (!id) return sendJson(res, 400, { error: "缺少要解锁的记录 id" });
    const ok = loginGuard.unlock(id);
    if (!ok) return sendJson(res, 404, { error: "记录不存在或已过期" });
    securityLog("login_unlock", `id=${id} by=${db.admin.username}`);
    return sendJson(res, 200, { ok: true, unlocked: id });
  }

  if (pathname === "/api/admin/model-catalog" && method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const raw = String(body.url || "").trim().slice(0, 200);
    if (!raw) return sendJson(res, 400, { error: "先填访问地址" });
    const apiKey = String(body.apiKey || "").trim().slice(0, 200);
    if (!apiKey) return sendJson(res, 400, { error: "先填 API Key" });
    const result = await fetchModelList(raw, { timeout: 12000, apiKey });
    if (!result.ok) return sendJson(res, 200, { ok: false, models: [], error: result.error });
    const models = result.models.slice(0, 300);
    return sendJson(res, 200, { ok: true, models, total: result.models.length, source: result.source });
  }

  if (pathname === "/api/admin/probes" && method === "GET") {
    return sendJson(res, 200, { probes: Array.from(probeProgress.values()) });
  }

  if (pathname === "/api/admin/sites" && method === "GET") {
    const status = url.searchParams.get("status") || "all";
    const list = db.sites
      .filter((s) => (status === "all" ? true : s.status === status))
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sendJson(res, 200, {
      sites: list.map(adminSiteView),
      stats: buildAdminStats(),
      publicStats: buildStats(db.sites.filter((s) => s.status === "published")),
      total: db.sites.length,
      probing: probeBusy,
      evaling: evalBusy
    });
  }

  if (pathname === "/api/admin/sites" && method === "POST") {
    const body = await readJson(req);
    if (!body.name) return sendJson(res, 400, { error: "站点名称必填" });
    const derivedDomain = String(body.domain || body.url || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .trim()
      .toLowerCase();
    if (!derivedDomain) return sendJson(res, 400, { error: "需要填写访问地址" });
    if (db.sites.some((s) => s.domain === derivedDomain)) {
      return sendJson(res, 409, { error: "该地址已存在，请直接编辑原记录" });
    }
    const status = body.status || "published";
    const site = normalizeSite({ ...body, domain: derivedDomain, status });
    db.sites.push(site);
    pushReview(site, "create", status === "published" ? "创建并直接发布" : "创建，等待审核");
    await saveDb();
    queueProbe(site);
    return sendJson(res, 201, { ok: true, site: adminSiteView(site), stats: buildAdminStats() });
  }

  /* ---- 真实探测：单条 ---- */
  const probeMatch = pathname.match(/^\/api\/admin\/sites\/([a-zA-Z0-9_]+)\/probe$/);
  if (probeMatch && method === "POST") {
    const site = db.sites.find((s) => s.id === probeMatch[1]);
    if (!site) return sendJson(res, 404, { error: "站点不存在" });
    const body = await readJson(req).catch(() => ({}));
    if (body && typeof body.apiKey === "string" && body.apiKey.trim() && body.apiKey.trim() !== "********") site.apiKey = body.apiKey.trim().slice(0, 200);
    if (body && typeof body.probeModel === "string" && body.probeModel.trim()) site.probeModel = body.probeModel.trim().slice(0, 120);
    queueProbe(site);
    return sendJson(res, 202, { ok: true, queued: 1, id: site.id, message: "正在探测 " + site.domain });
  }

  /* ---- 用站点已存的 API Key 同步模型目录 ---- */
  const catMatch = pathname.match(/^\/api\/admin\/sites\/([a-zA-Z0-9_]+)\/model-catalog$/);
  if (catMatch && method === "POST") {
    const site = db.sites.find((x) => x.id === catMatch[1]);
    if (!site) return sendJson(res, 404, { error: "站点不存在" });
    const body = await readJson(req).catch(() => ({}));
    const key = String(body.apiKey || site.apiKey || "").trim();
    if (!key) return sendJson(res, 400, { error: "该站点还没存 API Key" });
    const result = await fetchModelList(site.evalBaseUrl || site.url || site.domain, { timeout: 12000, apiKey: key });
    if (!result.ok) return sendJson(res, 200, { ok: false, models: [], error: result.error });
    /* 只认这次拉到的目录，旧的一律不掺 */
    const models = result.models.slice(0, 300);
    if (!models.length) return sendJson(res, 200, { ok: false, models: [], error: "该站返回的目录是空的" });
    site.modelList = models;
    site.modelListAt = nowIso();
    site.models = models.length;
    site.updatedAt = nowIso();
    await saveDb();
    return sendJson(res, 200, { ok: true, models, total: models.length, source: result.source, modelsCount: models.length });
  }

  /* ---- 真实探测：全部已发布 ---- */
  if (pathname === "/api/admin/probe-all" && method === "POST") {
    const targets = db.sites.filter((s) => s.status === "published");
    if (!targets.length) return sendJson(res, 400, { error: "没有已发布的站点" });
    for (const s of targets) queueProbe(s);
    return sendJson(res, 202, { ok: true, queued: targets.length });
  }

  /* ---- 模型质量评测（需要 API Key） ---- */
  const evalMatch = pathname.match(/^\/api\/admin\/sites\/([a-zA-Z0-9_]+)\/eval$/);
  if (evalMatch && method === "POST") {
    const site = db.sites.find((s) => s.id === evalMatch[1]);
    if (!site) return sendJson(res, 404, { error: "站点不存在" });
    const body = await readJson(req).catch(() => ({}));
    if (body && typeof body.apiKey === "string" && body.apiKey.trim() && body.apiKey.trim() !== "********") site.apiKey = body.apiKey.trim().slice(0, 200);
    if (body && typeof body.model === "string" && body.model.trim()) site.probeModel = body.model.trim().slice(0, 120);
    if (body && typeof body.baseUrl === "string" && body.baseUrl.trim()) site.evalBaseUrl = body.baseUrl.trim().slice(0, 300);
    if (!site.apiKey) return sendJson(res, 400, { error: "先在该站点的编辑弹窗里填 API Key" });
    queueEval(site, { apiKey: site.apiKey, model: site.probeModel, baseUrl: site.evalBaseUrl });
    return sendJson(res, 202, { ok: true, queued: 1, id: site.id, message: "正在评测 " + site.domain + " 的模型，约 30-90 秒" });
  }



  if (pathname === "/api/admin/reviews" && method === "GET") {
    return sendJson(res, 200, { reviews: db.reviews.slice(0, 200), total: db.reviews.length });
  }

  if (pathname === "/api/admin/reviews/bulk" && method === "POST") {
    const body = await readJson(req);
    const action = String(body.action || "");
    if (!["approve", "reject"].includes(action)) return sendJson(res, 400, { error: "action 只能是 approve 或 reject" });
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return sendJson(res, 400, { error: "请选择至少一条记录" });

    const done = [];
    for (const id of ids) {
      const site = db.sites.find((s) => s.id === id);
      if (!site) continue;
      site.status = action === "approve" ? "published" : "rejected";
      site.reviewNote = String(body.reason || (action === "approve" ? "审核通过" : "审核驳回")).slice(0, 200);
      site.reviewedAt = nowIso();
      site.updatedAt = nowIso();
      pushReview(site, action, site.reviewNote);
      done.push(id);
    }
    await saveDb();
    return sendJson(res, 200, { ok: true, count: done.length, ids: done, stats: buildAdminStats() });
  }

  const reviewMatch = pathname.match(/^\/api\/admin\/sites\/([a-zA-Z0-9_]+)\/review$/);
  if (reviewMatch && method === "POST") {
    const site = db.sites.find((s) => s.id === reviewMatch[1]);
    if (!site) return sendJson(res, 404, { error: "记录不存在" });

    const body = await readJson(req);
    const action = String(body.action || "");
    if (!["approve", "reject", "reset"].includes(action)) {
      return sendJson(res, 400, { error: "action 只能是 approve / reject / reset" });
    }

    if (action === "approve") site.status = "published";
    if (action === "reject") site.status = "rejected";
    if (action === "reset") site.status = "pending";

    site.reviewNote = String(body.reason || (action === "approve" ? "审核通过" : action === "reject" ? "审核驳回" : "重新排队")).slice(0, 200);
    site.reviewedAt = nowIso();
    site.updatedAt = nowIso();
    pushReview(site, action, site.reviewNote);
    await saveDb();
    return sendJson(res, 200, { ok: true, site: adminSiteView(site), stats: buildAdminStats() });
  }

  const siteMatch = pathname.match(/^\/api\/admin\/sites\/([a-zA-Z0-9_]+)$/);
  if (siteMatch) {
    const site = db.sites.find((s) => s.id === siteMatch[1]);
    if (!site) return sendJson(res, 404, { error: "记录不存在" });

    if (method === "PUT") {
      const body = await readJson(req);
      if (!body.domain && body.url) {
        body.domain = String(body.url).replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
      }
      const before = site.status;
      Object.assign(site, normalizeSite(body, site));
      if (before !== site.status) {
        site.reviewedAt = nowIso();
        pushReview(site, site.status === "published" ? "approve" : site.status === "rejected" ? "reject" : "reset", "编辑时变更状态");
      }
      await saveDb();
      // 上线时补一次真实探测：拿到 /v1/models 才能核对提交者勾选的模型
      if (before !== "published" && site.status === "published") queueProbe(site);
      return sendJson(res, 200, { ok: true, site: adminSiteView(site), stats: buildAdminStats() });
    }
    if (method === "DELETE") {
      db.sites = db.sites.filter((s) => s.id !== site.id);
      await saveDb();
      return sendJson(res, 200, { ok: true, id: site.id });
    }
    return sendJson(res, 405, { error: "方法不允许" });
  }

  if (pathname === "/api/admin/import" && method === "POST") {
    const body = await readJson(req);
    const format = String(body.format || "json").toLowerCase();
    const text = String(body.text || "");
    if (!text.trim()) return sendJson(res, 400, { error: "导入内容为空" });

    let items = [];
    if (format === "json") {
      try {
        const parsed = JSON.parse(text);
        items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.sites) ? parsed.sites : [parsed];
      } catch (err) {
        return sendJson(res, 400, { error: "JSON 解析失败：" + err.message });
      }
    } else {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return sendJson(res, 400, { error: "CSV 内容为空" });
      const header = lines[0].split(",").map((h) => h.trim());
      items = lines.slice(1).map((line) => {
        const cells = line.split(",");
        const obj = {};
        header.forEach((key, i) => (obj[key] = (cells[i] || "").trim()));
        if (obj.dims || obj.dimensions) return obj;
        return {
          name: obj.name,
          domain: obj.domain,
          url: obj.url,
          logo: obj.logo,
          note: obj.note,
          tags: obj.tags,
          models: obj.models,
          issues: obj.issues,
          down: obj.down,
          dims: {
            reach: obj.reach,
            catalog: obj.catalog,
            chat: obj.chat,
            stream: obj.stream,
            concurrent: obj.concurrent
          }
        };
      });
    }

    const created = [];
    const skipped = [];
    for (const item of items) {
      const rawDomain = String(item.domain || item.url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
      if (!item.name && !rawDomain) {
        skipped.push({ reason: "缺少 name/domain", item });
        continue;
      }
      if (rawDomain && db.sites.some((s) => s.domain === rawDomain)) {
        skipped.push({ reason: "域名已存在：" + rawDomain, item });
        continue;
      }
      const site = normalizeSite({ ...item, domain: rawDomain || item.domain, status: item.status === "published" ? "published" : "pending" });
      db.sites.push(site);
      created.push(site);
      pushReview(site, "create", "批量导入，等待审核");
    }
    await saveDb();
    return sendJson(res, 200, { ok: true, created: created.length, skipped, sites: created.map(adminSiteView), stats: buildAdminStats() });
  }

  if (pathname === "/api/admin/upload" && method === "POST") {
    const body = await readJson(req);
    const data = String(body.data || "");
    const match = data.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/i);
    if (!match) return sendJson(res, 400, { error: "文件格式不正确（需要 data:image/...;base64）" });

    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 2 * 1024 * 1024) return sendJson(res, 413, { error: "图片不能超过 2 MB" });

    const extMap = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico" };
    if (!extMap[mime]) return sendJson(res, 415, { error: "仅支持 PNG / JPG / WEBP / ICO" });
    const ext = detectImageExt(buffer);
    if (!ext) return sendJson(res, 415, { error: "图片内容与格式不符" });

    const name = crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16) + ext;
    await fsp.writeFile(path.join(UPLOAD_DIR, name), buffer);
    return sendJson(res, 200, { ok: true, url: "/uploads/" + name, size: buffer.length });
  }

  if (pathname === "/api/admin/export" && method === "GET") {
    const payload = {
      exportedAt: nowIso(),
      sites: db.sites.map((s) => ({
        ...s,
        hasApiKey: Boolean(s.apiKey),
        apiKey: s.apiKey ? "********" : ""
      }))
    };
    return sendJson(res, 200, payload, {
      "content-disposition": `attachment; filename="stations-${Date.now()}.json"`
    });
  }

  if (pathname === "/api/admin/password" && method === "POST") {
    const body = await readJson(req);
    const next = String(body.password || "");
    if (next.length < 12) return sendJson(res, 400, { error: "新密码至少 12 位" });
    if (!(await verifyPassword(String(body.current || ""), db.admin.salt, db.admin.hash))) {
      return sendJson(res, 400, { error: "当前密码不正确" });
    }
    db.admin.salt = crypto.randomBytes(16).toString("hex");
    db.admin.hash = await hashPassword(next, db.admin.salt);
    db.sessions = db.sessions.filter((s) => s.id === session.id);
    await saveDb();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "接口不存在" });
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  } catch {
    return sendText(res, 400, "Bad Request");
  }

  applySecurityHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-csrf-token" });
    return res.end();
  }

  res.on("finish", () =>
    logLine(req.method, url.pathname, res.statusCode, `${clientIp(req)} ${String(req.headers["user-agent"] || "").slice(0, 60)}`)
  );

  try {
    if (url.pathname === "/detective" || url.pathname.startsWith("/detective/")) {
      if (!DETECTIVE.enabled) return sendText(res, 404, "Not Found");
      if (DETECTIVE.requireLogin && !currentSession(req)) {
        if (String(req.headers.accept || "").includes("text/html")) return redirect(res, "/admin");
        return sendJson(res, 401, { error: "需要登录后使用模型侦探" });
      }
      if (rateHit(`detective:${clientIp(req)}`, 240, 60 * 1000)) {
        return sendText(res, 429, "请求过于频繁，请稍后再试");
      }
      if (url.pathname === "/detective") {
        res.writeHead(302, { location: "/detective/" });
        return res.end();
      }
      applyDetectiveHeaders(res);
      return proxyDetective(req, res, url);
    }

    if (url.pathname === "/api/detective/status" && req.method === "GET") {
      return sendJson(res, 200, await detectiveStatus());
    }

    if (url.pathname.startsWith("/go/")) return handleVisit(req, res, url);

    const handled = await handlePlainRoutes(req, res, url);
    if (handled !== false) return;

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method Not Allowed");
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error("[error]", req.method, url.pathname, err.message);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : "服务器错误" });
    else res.end();
  }
});

async function applyPasswordOverride() {
  const arg = process.argv.find((a) => a.startsWith("--password="));
  const next = String(process.env.ADMIN_PASSWORD || (arg ? arg.slice("--password=".length) : "")).trim();
  if (!next) return;
  if (next.length < 12) {
    console.error("[init] 管理员密码至少 12 位，已忽略本次覆盖");
    return;
  }
  if (await verifyPassword(next, db.admin.salt, db.admin.hash)) {
    console.log("[init] 密码未变化，跳过重置");
    return;
  }
  db.admin.salt = crypto.randomBytes(16).toString("hex");
  db.admin.hash = await hashPassword(next, db.admin.salt);
  db.sessions = [];
  await saveDb();
  await fsp.writeFile(
    path.join(DATA_DIR, "initial-admin.txt"),
    `中转站榜单后台\n地址: http://127.0.0.1:${PORT}/admin\n用户名: admin\n密码: ${next}\n生成时间: ${nowIso()}\n（登录后请立即修改密码并删除本文件）\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  console.log("[init] 管理员密码已重置，所有旧会话失效；新密码在 data/initial-admin.txt");
}

ensureDb()
  .then(applyPasswordOverride)
  .then(() => {
    server.listen(PORT, HOST, () => {
      const published = db.sites.filter((s) => s.status === "published").length;
      const auto = db.settings.autoProbe;
      console.log(`[ready] 榜单 http://${HOST}:${PORT}/  |  后台 http://${HOST}:${PORT}/admin  |  已发布 ${published} 条`);
      console.log(`[auto-probe] ${auto.enabled ? `已开启，每 ${auto.intervalMinutes} 分钟一次，下次 ${auto.nextRunAt}` : "未开启"}`);
    });
    startAutoProbeScheduler();
    ensureDetectiveRunning()
      .then((up) => console.log(`[detective] ${up ? "检测台在线" : "检测台未在线（已尝试自动启动）"}`))
      .catch((err) => console.warn("[detective] 自动启动失败：", err.message));
  })
  .catch((err) => {
    console.error("[fatal] 启动失败：", err.message);
    process.exit(1);
  });

server.on("error", (err) => {
  console.error("[fatal] HTTP 服务错误：", err.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，正在保存数据`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  server.close(async () => {
    await saveDb();
    await loginGuard.flush().catch(() => {});
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
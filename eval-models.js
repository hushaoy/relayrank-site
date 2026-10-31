"use strict";

/**
 * 模型质量评测引擎 —— 打分全部由程序判定，不请模型当裁判。
 *
 * 三个面：
 *   性能   TTFT（首 token 延迟，流式实测）、tok/s（输出速度）、3 次抖动
 *   能力   固定题库：数学 / 指令跟随 / 中文理解 / 代码（本地跑单测）/ 工具调用
 *   真实性 上下文长度是否真给：埋 needle，逐级加大输入，看能不能捞回来
 *
 * 判分方式：
 *   数学    唯一数值，正则提取后比对
 *   指令    严格格式约束，正则/JSON 校验
 *   中文    关键词命中
 *   代码    提取代码块 → 写临时文件 → 本地 python 跑单测 → 通过率
 *   工具    tool_calls 结构 + arguments 合法 JSON
 *   上下文  needle 是否出现在回答里
 *
 * 所有请求串行，单题超时可控。不执行任何远端给出的 shell 命令。
 */

const http = require("node:http");
const https = require("node:https");
const { assertPublicUrl } = require("./security.js");
const { runPython } = require("./eval-sandbox.js");

const DEFAULT_TIMEOUT = 45000;
const MAX_RESPONSE_BYTES = Number(process.env.EVAL_MAX_BYTES || 4 * 1024 * 1024);

function now() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function round(v, d = 1) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

/* ------------------------------------------------------------------ */
/* 底层请求                                                            */
/* ------------------------------------------------------------------ */

/**
 * 发一次 chat/completions。stream=true 时用 SSE 抓 TTFT。
 */
async function chatRequest(baseUrl, apiKey, payload, { timeout = DEFAULT_TIMEOUT } = {}) {
  const endpoint = String(baseUrl || "").replace(/\/+$/, "") + "/v1/chat/completions";
  let guard;
  try {
    guard = await assertPublicUrl(endpoint, { allowHttp: !apiKey });
  } catch (e) {
    return { ok: false, error: "目标地址不允许：" + e.message };
  }

  return new Promise((resolve) => {
    const u = guard.url;
    const body = JSON.stringify(payload);
    const lib = u.protocol === "https:" ? https : http;
    const started = now();
    let ttft = null;
    let settled = false;
    let totalTimer = null;

    const done = (r) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      resolve(r);
    };

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          authorization: "Bearer " + apiKey,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          accept: payload.stream ? "text/event-stream" : "application/json",
          "user-agent": "RelayRank-Eval/1.0"
        },
        lookup: guard.lookup || undefined
      },
      (res) => {
        const chunks = [];
        let raw = "";
        let bytes = 0;
        let overflow = false;

        res.on("data", (c) => {
          if (overflow) return;
          if (ttft === null) ttft = round(now() - started);
          bytes += c.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            overflow = true;
            req.destroy(new Error("response body too large"));
            return;
          }
          chunks.push(c);
          raw += c.toString("utf8");
        });

        res.on("error", (e) => done({ ok: false, error: e.message, ttft, total: round(now() - started) }));
        res.on("end", () => {
          if (overflow) return;
          const total = round(now() - started);
          const text = Buffer.concat(chunks).toString("utf8");
          const out = { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, ttft, total, headers: res.headers };

          if (payload.stream) {
            // 从 SSE 里拼内容
            let content = "";
            let usage = null;
            let model = "";
            for (const line of raw.split("\n")) {
              const s = line.trim();
              if (!s.startsWith("data:")) continue;
              const data = s.slice(5).trim();
              if (data === "[DONE]") continue;
              try {
                const j = JSON.parse(data);
                if (j.model) model = j.model;
                if (j.usage) usage = j.usage;
                const delta = j.choices && j.choices[0] && j.choices[0].delta;
                if (delta && typeof delta.content === "string") content += delta.content;
              } catch (e) {
                /* 跳过非 JSON 行 */
              }
            }
            out.content = content;
            out.usage = usage;
            out.thinking = (usage && (usage.completion_thinking_tokens || (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens))) || 0;
            out.model = model;
            out.streamed = content.length > 0;
          } else {
            try {
              const j = JSON.parse(text);
              out.json = j;
              out.model = j.model || "";
              out.usage = j.usage || null;
              out.thinking = (j.usage && (j.usage.completion_thinking_tokens || (j.usage.completion_tokens_details && j.usage.completion_tokens_details.reasoning_tokens))) || 0;
              const msg = j.choices && j.choices[0] && j.choices[0].message;
              out.content = (msg && msg.content) || "";
              out.toolCalls = (msg && msg.tool_calls) || null;
              out.finishReason = (j.choices && j.choices[0] && j.choices[0].finish_reason) || "";
            } catch (e) {
              out.content = "";
              out.raw = text.slice(0, 400);
              out.parseError = e.message;
            }
          }
          done(out);
        });
      }
    );

    req.setTimeout(timeout, () => req.destroy(new Error("timeout " + timeout + "ms")));
    totalTimer = setTimeout(() => req.destroy(new Error("total timeout " + timeout + "ms")), timeout + 2000);
    req.on("error", (e) => done({ ok: false, error: e.message, ttft, total: round(now() - started) }));
    req.write(body);
    req.end();
  });
}

async function listModels(baseUrl, apiKey, timeout = 15000) {
  const endpoint = String(baseUrl || "").replace(/\/+$/, "") + "/v1/models";
  let guard;
  try {
    guard = await assertPublicUrl(endpoint, { allowHttp: !apiKey });
  } catch {
    return [];
  }

  return new Promise((resolve) => {
    const u = guard.url;
    const lib = u.protocol === "https:" ? https : http;
    let settled = false;
    let totalTimer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      resolve(value);
    };
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: "GET",
        headers: { authorization: "Bearer " + apiKey, accept: "application/json" },
        lookup: guard.lookup || undefined
      },
      (res) => {
        let raw = "";
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy();
            return;
          }
          raw += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(raw);
            const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
            done(list.map((m) => m.id || m.name).filter(Boolean).slice(0, 500));
          } catch {
            done([]);
          }
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy());
    totalTimer = setTimeout(() => req.destroy(), timeout + 2000);
    req.on("error", () => done([]));
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 题库                                                                */
/* ------------------------------------------------------------------ */

const num = (text) => {
  const m = String(text).replace(/[，,]/g, "").match(/-?\d+(?:\.\d+)?/g);
  return m ? m.map(Number) : [];
};

const SUITE = [
  /* --- 数学：唯一数值 --- */
  {
    id: "math-1",
    cat: "数学",
    prompt: "17 × 23 等于多少？只输出数字。",
    maxTokens: 220,
    check: (t) => ({ pass: num(t).includes(391), got: num(t).slice(0, 3).join(",") })
  },
  {
    id: "math-2",
    cat: "数学",
    prompt: "一个数的 3 倍减去 7 等于 26，这个数是多少？只输出数字。",
    maxTokens: 240,
    check: (t) => ({ pass: num(t).includes(11), got: num(t).slice(0, 3).join(",") })
  },
  {
    id: "math-3",
    cat: "数学",
    prompt: "1 加到 100 的和是多少？只输出数字。",
    maxTokens: 220,
    check: (t) => ({ pass: num(t).includes(5050), got: num(t).slice(0, 3).join(",") })
  },
  {
    id: "math-4",
    cat: "数学",
    prompt: "5 台机器 5 分钟生产 5 个零件。100 台机器生产 100 个零件需要几分钟？只输出数字。",
    maxTokens: 320,
    check: (t) => {
      const ns = num(t);
      return { pass: ns.length > 0 && ns[ns.length - 1] === 5, got: ns.join(",") };
    }
  },
  {
    id: "math-5",
    cat: "数学",
    prompt: "甲乙两地相距 120 公里，两车相向而行，速度分别是 40 和 20 公里每小时，几小时相遇？只输出数字。",
    maxTokens: 320,
    check: (t) => ({ pass: num(t).includes(2), got: num(t).slice(0, 3).join(",") })
  },

  /* --- 指令跟随：格式约束 --- */
  {
    id: "ins-1",
    cat: "指令跟随",
    prompt: "只输出 OK 两个字母，不要标点，不要解释。",
    maxTokens: 400,
    check: (t) => {
      const s = String(t).trim();
      return { pass: s === "OK", got: JSON.stringify(s.slice(0, 30)) };
    }
  },
  {
    id: "ins-2",
    cat: "指令跟随",
    prompt: '输出一个 JSON 对象，恰好包含 name（字符串）和 age（数字）两个键。只输出 JSON，不要代码块围栏。',
    maxTokens: 420,
    check: (t) => {
      const s = String(t).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      try {
        const j = JSON.parse(s);
        const pass = typeof j.name === "string" && typeof j.age === "number" && Object.keys(j).length === 2;
        return { pass, got: Object.keys(j).join(",") };
      } catch (e) {
        return { pass: false, got: "非 JSON" };
      }
    }
  },
  {
    id: "ins-3",
    cat: "指令跟随",
    prompt: "列出 3 个质数，用英文逗号分隔，不要空格，不要其他任何文字。",
    maxTokens: 220,
    check: (t) => {
      const s = String(t).trim();
      const m = s.match(/^(\d+),(\d+),(\d+)$/);
      if (!m) return { pass: false, got: JSON.stringify(s.slice(0, 30)) };
      const isPrime = (n) => {
        if (n < 2) return false;
        for (let i = 2; i * i <= n; i += 1) if (n % i === 0) return false;
        return true;
      };
      const ok = [m[1], m[2], m[3]].every((x) => isPrime(Number(x)));
      return { pass: ok, got: s };
    }
  },
  {
    id: "ins-4",
    cat: "指令跟随",
    prompt: '把 "abcdef" 逐字倒序输出，只要倒序后的字符串本身。',
    maxTokens: 320,
    check: (t) => {
      const s = String(t).trim().replace(/["'`]/g, "");
      return { pass: s === "fedcba", got: JSON.stringify(s.slice(0, 20)) };
    }
  },
  {
    id: "ins-5",
    cat: "指令跟随",
    prompt: "回答 1+1 等于几，但必须用英文单词表示结果，不要用阿拉伯数字。",
    maxTokens: 220,
    check: (t) => {
      const s = String(t).trim();
      const hasWord = /\btwo\b/i.test(s);
      const hasDigit = /2/.test(s);
      return { pass: hasWord && !hasDigit, got: s.slice(0, 40) };
    }
  },

  /* --- 中文理解 --- */
  {
    id: "zh-1",
    cat: "中文理解",
    prompt: "画蛇添足这个成语比喻什么？只输出一个四字成语。",
    maxTokens: 320,
    check: (t) => {
      const s = String(t).trim();
      const pass = /多此一举|画蛇添足|弄巧成拙/.test(s) && s.length <= 20;
      return { pass, got: s.slice(0, 30) };
    }
  },
  {
    id: "zh-2",
    cat: "中文理解",
    prompt: "下面哪个词和其他三个不同类：苹果、香蕉、白菜、橘子。只输出那个词。",
    maxTokens: 320,
    check: (t) => {
      const s = String(t).trim();
      return { pass: s.includes("白菜"), got: s.slice(0, 30) };
    }
  },
  {
    id: "zh-3",
    cat: "中文理解",
    prompt: "他差点没摔倒。请问他摔倒了还是没摔倒？只回答摔倒了或没摔倒。",
    maxTokens: 220,
    check: (t) => {
      const s = String(t).trim();
      return { pass: /没摔倒|没倒|没有摔倒/.test(s) && !/^摔倒/.test(s), got: s.slice(0, 30) };
    }
  },
  {
    id: "zh-4",
    cat: "中文理解",
    prompt: '用"虽然……但是……"造句，句子中必须出现"下雨"两个字。只输出这个句子。',
    maxTokens: 320,
    check: (t) => {
      const s = String(t).trim();
      return { pass: s.includes("虽然") && s.includes("但是") && s.includes("下雨"), got: s.slice(0, 50) };
    }
  },

  /* --- 代码：本地跑单测 --- */
  {
    id: "code-1",
    cat: "代码",
    lang: "python",
    prompt: "写一个 Python 函数 add(a, b) 返回两数之和。只输出代码块，不要解释。",
    maxTokens: 900,
    tests: "assert add(2,3)==5\nassert add(-1,1)==0\nassert add(0,0)==0"
  },
  {
    id: "code-2",
    cat: "代码",
    lang: "python",
    prompt: "写一个 Python 函数 reverse_string(s) 返回倒序字符串。只输出代码块，不要解释。",
    maxTokens: 900,
    tests: 'assert reverse_string("abc")=="cba"\nassert reverse_string("")==""'
  },
  {
    id: "code-3",
    cat: "代码",
    lang: "python",
    prompt: "写一个 Python 函数 is_prime(n) 判断是否为质数，返回布尔值。只输出代码块，不要解释。",
    maxTokens: 900,
    tests: "assert is_prime(2)==True\nassert is_prime(17)==True\nassert is_prime(1)==False\nassert is_prime(9)==False"
  },
  {
    id: "code-4",
    cat: "代码",
    lang: "python",
    prompt: "写一个 Python 函数 fib(n) 返回斐波那契数列第 n 项（fib(1)=1, fib(2)=1）。只输出代码块，不要解释。",
    maxTokens: 900,
    tests: "assert fib(1)==1\nassert fib(2)==1\nassert fib(7)==13\nassert fib(10)==55"
  }
];

/* ------------------------------------------------------------------ */
/* 判分                                                                */
/* ------------------------------------------------------------------ */

function extractCode(text, lang) {
  const s = String(text || "");
  const fenced = s.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return s.trim();
}

async function runPythonTests(code, tests, timeout = 6000) {
  return runPython(code, tests, { timeout });
}

/* ------------------------------------------------------------------ */
/* 工具调用题                                                          */
/* ------------------------------------------------------------------ */

const TOOL_QUESTION = {
  id: "tool-1",
  cat: "工具调用",
  prompt: "北京今天天气怎么样？",
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "查询指定城市的天气",
        parameters: {
          type: "object",
          properties: { city: { type: "string", description: "城市名" } },
          required: ["city"]
        }
      }
    }
  ]
};

/* ------------------------------------------------------------------ */
/* 上下文真实性                                                        */
/* ------------------------------------------------------------------ */

const NEEDLE = "ZEBRA-7741";

function buildHaystack(targetTokens) {
  // 中文填充块，约 40 字 ≈ 40 token 保守估计，按 1 字 ≈ 1.5 token 折算
  const unit = "这是一段用于占用上下文长度的无关填充文本，内容不具备任何信息价值。";
  const perUnit = 30; // 该句约 30 字
  const need = Math.max(1, Math.ceil((targetTokens * 1.4) / perUnit));
  const head = new Array(Math.ceil(need / 2)).fill(unit).join("");
  const tail = new Array(Math.floor(need / 2)).fill(unit).join("");
  return `${head}\n\n重要信息：本次会话的秘密口令是 ${NEEDLE}，请记住它。\n\n${tail}`;
}

async function testContext(baseUrl, apiKey, model, level, timeout) {
  const hay = buildHaystack(level);
  const r = await chatRequest(
    baseUrl,
    apiKey,
    {
      model,
      messages: [
        { role: "system", content: "你会收到一段长文本，请仔细阅读后回答问题。" },
        { role: "user", content: hay + "\n\n问题：上面提到的秘密口令是什么？只输出口令本身。" }
      ],
      max_tokens: 200,
      temperature: 0
    },
    { timeout }
  );

  const content = r.content || "";
  const found = content.includes(NEEDLE);
  return {
    level,
    approxTokens: Math.round((level * 1.4) / 1.4 * 1) || level,
    status: r.status || 0,
    ok: Boolean(r.ok),
    found,
    finishReason: r.finishReason || "",
    got: content.trim().slice(0, 40),
    error: r.error || (r.ok ? "" : String(r.raw || "").slice(0, 80))
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function evalModel(site, options = {}) {
  const started = Date.now();
  const baseUrl = String(options.baseUrl || site.evalBaseUrl || site.url || "https://" + site.domain).replace(/\/+$/, "");
  const apiKey = String(options.apiKey || site.apiKey || "").trim();
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT;

  if (!apiKey) {
    return { ok: false, error: "缺少 API Key", at: new Date().toISOString() };
  }

  const models = await listModels(baseUrl, apiKey);
  const wanted = String(options.model || site.probeModel || "").trim();
  let model = wanted;
  let modelNote = "";
  if (models.length) {
    if (!wanted) {
      model = models[0];
      modelNote = "未指定模型，使用目录第一个";
    } else if (!models.includes(wanted)) {
      const ci = models.find((m) => m.toLowerCase() === wanted.toLowerCase());
      model = ci || models[0];
      modelNote = ci
        ? `配置名 ${wanted} 大小写不一致，改用 ${ci}`
        : `配置名 ${wanted} 不在站点目录中，已回退到 ${model}`;
    }
  }
  if (!model) {
    return { ok: false, error: "无法确定模型名：模型列表为空且未指定 probeModel", at: new Date().toISOString() };
  }

  const result = {
    ok: true,
    at: new Date().toISOString(),
    durationMs: 0,
    baseUrl,
    model,
    modelCount: models.length,
    modelNote,
    modelSample: models.slice(0, 12),
    perf: null,
    ability: null,
    context: null,
    score: 0,
    items: [],
    errors: []
  };

  /* --- 1. 性能：3 次流式 --- */
  const perfRuns = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await chatRequest(
      baseUrl,
      apiKey,
      {
        model,
        messages: [{ role: "user", content: "用一句话解释什么是 TCP 三次握手。" }],
        max_tokens: 300,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true }
      },
      { timeout }
    );
    if (r.ok) {
      const total = r.total || 0;
      const ttft = r.ttft || 0;
      const outTokens = (r.usage && r.usage.completion_tokens) || Math.max(1, Math.round((r.content || "").length / 2));
      const genMs = Math.max(1, total - ttft);
      perfRuns.push({ ttft, total, outTokens, tps: round((outTokens / genMs) * 1000, 2), streamed: r.streamed });
    } else {
      result.errors.push("perf: " + (r.error || r.status));
    }
  }

  if (perfRuns.length) {
    const ttfbs = perfRuns.map((x) => x.ttft).sort((a, b) => a - b);
    const tpss = perfRuns.map((x) => x.tps);
    const ttfbMedian = ttfbs[Math.floor(ttfbs.length / 2)];
    const tpsAvg = tpss.reduce((a, b) => a + b, 0) / tpss.length;
    const spread = ttfbs[ttfbs.length - 1] - ttfbs[0];
    const jitter = ttfbMedian > 0 ? spread / ttfbMedian : 1;

    // TTFT：<300ms 满分，>3000ms 归零
    const ttftScore = clamp(100 - Math.max(0, ttfbMedian - 300) / 27);
    // 速度：>=60 tok/s 满分，<5 归零
    const tpsScore = clamp(((tpsAvg - 5) / 55) * 100);
    // 抖动：<=0.2 满分，>=1.5 归零
    const jitterScore = clamp(100 - Math.max(0, jitter - 0.2) * 77);

    result.perf = {
      runs: perfRuns.length,
      ttft: round(ttfbMedian),
      tps: round(tpsAvg, 2),
      jitter: round(jitter, 2),
      ttftScore: round(ttftScore),
      tpsScore: round(tpsScore),
      jitterScore: round(jitterScore),
      score: round(ttftScore * 0.4 + tpsScore * 0.4 + jitterScore * 0.2)
    };
  }

  /* --- 2. 能力题库 --- */
  const byCat = {};
  for (const q of SUITE) {
    const r = await chatRequest(
      baseUrl,
      apiKey,
      {
        model,
        messages: [
          { role: "system", content: "你是被测模型，请严格按题目要求输出，不要多余解释。" },
          { role: "user", content: q.prompt }
        ],
        max_tokens: q.maxTokens,
        temperature: 0
      },
      { timeout }
    );

    let verdict;
    if (!r.ok) {
      verdict = { pass: false, got: "请求失败 " + (r.status || r.error || "") };
    } else if (q.tests) {
      const code = extractCode(r.content, q.lang);
      const t = await runPythonTests(code, q.tests);
      verdict = { pass: t.pass, got: t.detail };
    } else {
      verdict = q.check(r.content);
    }

    byCat[q.cat] = byCat[q.cat] || { total: 0, pass: 0 };
    byCat[q.cat].total += 1;
    if (verdict.pass) byCat[q.cat].pass += 1;

    result.items.push({
      id: q.id,
      cat: q.cat,
      pass: verdict.pass,
      got: String(verdict.got || "").slice(0, 120),
      ms: r.total || 0,
      finishReason: r.finishReason || "",
      echoedModel: r.model || "",
      thinking: r.thinking || 0,
      completion: (r.usage && r.usage.completion_tokens) || 0
    });
  }

  /* --- 3. 工具调用 --- */
  {
    const r = await chatRequest(
      baseUrl,
      apiKey,
      {
        model,
        messages: [{ role: "user", content: TOOL_QUESTION.prompt }],
        tools: TOOL_QUESTION.tools,
        tool_choice: "auto",
        max_tokens: 400,
        temperature: 0
      },
      { timeout }
    );

    let pass = false;
    let got = "未返回 tool_calls";
    if (r.ok && Array.isArray(r.toolCalls) && r.toolCalls.length) {
      const call = r.toolCalls[0];
      const fn = call.function || {};
      let argsOk = false;
      try {
        const a = JSON.parse(fn.arguments || "{}");
        argsOk = typeof a.city === "string" && a.city.length > 0;
      } catch (e) {
        argsOk = false;
      }
      pass = fn.name === "get_weather" && argsOk;
      got = `${fn.name}(${String(fn.arguments || "").slice(0, 60)})`;
    } else if (r.ok) {
      got = "纯文本回答：" + String(r.content || "").slice(0, 60);
    } else {
      got = "请求失败 " + (r.status || r.error || "");
    }

    byCat["工具调用"] = { total: 1, pass: pass ? 1 : 0 };
    result.items.push({ id: TOOL_QUESTION.id, cat: "工具调用", pass, got, ms: r.total || 0 });
  }

  const thinkTotal = result.items.reduce((a, b) => a + (b.thinking || 0), 0);
  const compTotal = result.items.reduce((a, b) => a + (b.completion || 0), 0);
  result.thinking = {
    total: thinkTotal,
    completion: compTotal,
    share: compTotal > 0 ? round((thinkTotal / compTotal) * 100) : 0,
    note: thinkTotal > 0 ? `思考占输出 token 的 ${compTotal > 0 ? round((thinkTotal / compTotal) * 100) : 0}%，这部分用户看不见也照样计费` : "无推理开销"
  };

  const abilityTotal = Object.values(byCat).reduce((a, b) => a + b.total, 0);
  const abilityPass = Object.values(byCat).reduce((a, b) => a + b.pass, 0);
  result.ability = {
    total: abilityTotal,
    pass: abilityPass,
    rate: round((abilityPass / abilityTotal) * 100),
    byCat: Object.entries(byCat).map(([cat, v]) => ({ cat, pass: v.pass, total: v.total, rate: round((v.pass / v.total) * 100) }))
  };

  /* --- 4. 上下文真实性：分级放量 --- */
  const levels = [8000, 32000];
  const ctxResults = [];
  for (const lv of levels) {
    const t = await testContext(baseUrl, apiKey, model, lv, Math.max(timeout, 60000));
    ctxResults.push(t);
    if (!t.ok) break; // 报错就别再加量了
  }

  const maxOk = ctxResults.filter((x) => x.ok && x.found).reduce((m, x) => Math.max(m, x.level), 0);
  const anyError = ctxResults.find((x) => !x.ok);
  result.context = {
    levels: ctxResults,
    needle: NEEDLE,
    maxVerified: maxOk,
    score: maxOk >= 32000 ? 100 : maxOk >= 8000 ? 70 : ctxResults.some((x) => x.ok) ? 30 : 0,
    note:
      maxOk >= 32000
        ? `32k 输入仍能准确捞出 ${NEEDLE}，上下文真实可用`
        : maxOk >= 8000
          ? `8k 可捞回，32k 失败${anyError ? "（" + (anyError.error || "报错") + "）" : ""}`
          : ctxResults.some((x) => x.ok)
            ? `能连上但捞不回 needle，疑似静默截断`
            : `请求失败：${(anyError && (anyError.error || anyError.status)) || "未知"}`
  };

  /* --- 5. 汇总 --- */
  const perfScore = result.perf ? result.perf.score : 0;
  const abilityScore = result.ability.rate;
  const ctxScore = result.context.score;
  result.score = round(perfScore * 0.2 + abilityScore * 0.6 + ctxScore * 0.2);
  result.parts = { perf: perfScore, ability: abilityScore, context: ctxScore };
  result.durationMs = Date.now() - started;

  /* --- 6. 成败判定：一次都没通就不算评测成功 --- */
  const firstError = result.errors[0] || "";
  const modelMissing = /model not found|model_not_found|does not exist|invalid model/i.test(firstError);
  if (!result.perf) {
    result.ok = false;
    result.error = modelMissing
      ? `模型名不被站点接受（${model}）：站点目录里没有这个 id，请改成 ${models.slice(0, 3).join(" / ")} 之一`
      : firstError || "三次性能请求全部失败";
  } else if (result.errors.length) {
    result.partial = true;
    result.warn = `部分请求失败 ${result.errors.length} 次：${firstError.slice(0, 80)}`;
  }

  return result;
}

module.exports = { evalModel, SUITE, chatRequest, listModels, NEEDLE };

/* ---------------- CLI ---------------- */
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const get = (k, d) => {
      const hit = args.find((a) => a.startsWith("--" + k + "="));
      return hit ? hit.split("=").slice(1).join("=") : d;
    };
    const baseUrl = get("url", "https://api.example.com");
    const apiKey = get("key", process.env.EVAL_API_KEY || "");
    const model = get("model", "");
    if (!apiKey) {
      console.error("用法: node eval-models.js --url=https://xxx --key=sk-xxx [--model=gpt-4o-mini]");
      process.exit(2);
    }
    const r = await evalModel({ url: baseUrl, domain: new URL(baseUrl).hostname }, { baseUrl, apiKey, model });
    console.log(JSON.stringify(r, null, 2));
  })();
}

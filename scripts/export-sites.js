#!/usr/bin/env node
/**
 * 从 RelayRank 榜单导出 SITES.md
 *
 * 数据源三选一：
 *   node scripts/export-sites.js                          # 默认打 http://127.0.0.1:8803/api/sites
 *   node scripts/export-sites.js --source=http://host/api/sites
 *   node scripts/export-sites.js --source=../data/db.json # 直接读库文件
 *
 * 可选人工介绍：--intro=sites-intro.json
 *   { "tinygate-top": "一段人工撰写的站点介绍" }
 *
 * 输出：--out=SITES.md（默认仓库根目录）
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const SOURCE = arg("source", "http://127.0.0.1:8803/api/sites");
const OUT = path.resolve(ROOT, arg("out", "SITES.md"));
const INTRO_FILE = arg("intro", "");

const DIM_ORDER = ["reach", "catalog", "chat", "stream", "concurrent"];
const DIM_LABELS = {
  reach: "连通",
  catalog: "目录",
  chat: "补全",
  stream: "流式",
  concurrent: "并发"
};
const KIND_LABELS = { public: "公益", commercial: "商业" };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(new Error(`返回不是合法 JSON：${e.message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

async function load() {
  if (/^https?:\/\//i.test(SOURCE)) {
    const data = await fetchJson(SOURCE);
    if (!data || !Array.isArray(data.sites)) throw new Error("接口返回缺少 sites 数组");
    return { sites: data.sites, updatedAt: data.updatedAt || new Date().toISOString() };
  }
  const raw = fs.readFileSync(path.resolve(ROOT, SOURCE), "utf8").replace(/^\uFEFF/, "");
  const db = JSON.parse(raw);
  const sites = (db.sites || []).filter((s) => s.status === "published");
  return { sites, updatedAt: db.updatedAt || new Date().toISOString() };
}

function loadIntro() {
  if (!INTRO_FILE) return {};
  try {
    return JSON.parse(fs.readFileSync(path.resolve(ROOT, INTRO_FILE), "utf8"));
  } catch {
    return {};
  }
}

const n1 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(1).replace(/\.0$/, ""));
const num = (v) => (v === null || v === undefined ? "—" : String(v));

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} UTC+8`;
}

function gradeBadge(grade) {
  return grade ? `**${grade}**` : "—";
}

function dimTable(dims) {
  const rows = DIM_ORDER.map((k) => {
    const v = dims && dims[k] !== undefined ? dims[k] : null;
    return `| ${DIM_LABELS[k]} | ${n1(v)}${v === null ? "" : "%"} |`;
  });
  return ["| 维度 | 成功率 |", "|:--|--:|", ...rows].join("\n");
}

function modelTable(evals) {
  if (!Array.isArray(evals) || !evals.length) return "";
  const rows = evals.map((e) => {
    return `| ${e.model || "—"} | ${n1(e.score)} | ${n1(e.ttft)} ms | ${n1(e.tps)} | ${e.passed ?? "—"}/${e.total ?? "—"} | ${e.ctx ? `${Math.round(e.ctx / 1000)}k` : "—"} |`;
  });
  return ["| 模型 | 模型分 | TTFT | tok/s | 通过 | 上下文 |", "|:--|--:|--:|--:|:--:|--:|", ...rows].join("\n");
}

function degradationLine(d) {
  if (!d || !d.verdict) return "";
  const v = d.verdict;
  const lv = d.levels
    ? Object.keys(d.levels)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => `${k}档 ${d.levels[k].passed}/${d.levels[k].total}`)
        .join(" · ")
    : "";
  return `**降级检测**：${v.label} — ${v.reason}${lv ? `（${lv}）` : ""}`;
}

function build(sites, meta, intro) {
  const sorted = [...sites].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const L = [];

  L.push("# 已通过审核的站点公示");
  L.push("");
  L.push("> 本页由 `scripts/export-sites.js` 自动生成，数据来自 RelayRank 榜单线上接口。");
  L.push(`> 生成时间：${fmtDate(new Date().toISOString())}　|　在榜站点：${sorted.length} 个`);
  L.push("> ");
  L.push("> 只收录状态为 `published` 的站点。待审、驳回、草稿不会出现在这里。");
  L.push("");

  // 汇总表
  L.push("## 总览");
  L.push("");
  L.push("| 站点 | 地址 | 类型 | 综合分 | 等级 | 模型分 | 最近实测 |");
  L.push("|:--|:--|:--:|--:|:--:|--:|:--|");
  for (const s of sorted) {
    const url = s.url || (s.domain ? `https://${s.domain}` : "");
    const probeAt = (s.probe && s.probe.at) || s.lastProbeAt || "";
    L.push(
      `| [${s.name}](#${anchor(s.name)}) | ${url ? `[${hostOf(url)}](${url})` : "—"} | ${KIND_LABELS[s.kind] || s.kind || "—"} | ${n1(s.score)} | ${gradeBadge(s.grade)} | ${n1(s.modelScore)} | ${fmtDate(probeAt)} |`
    );
  }
  L.push("");

  // 评分说明
  L.push("## 评分说明");
  L.push("");
  L.push("```");
  L.push("综合分 = 连通×10% + 目录×15% + 补全×25% + 流式×25% + 并发×25%");
  L.push("S ≥ 90   A ≥ 80   B ≥ 70   C ≥ 60   D < 60");
  L.push("```");
  L.push("");
  L.push("五维都是**真实请求的成功率**，探测引擎对每个站点发实际 HTTP 请求统计得出，缺测按 0 计入。模型分是另一套：性能 20% + 能力 60%（19 题）+ 上下文 20%。");
  L.push("");

  // 每个站点
  L.push("---");
  L.push("");
  L.push("## 站点详情");
  L.push("");

  for (const s of sorted) {
    const url = s.url || (s.domain ? `https://${s.domain}` : "");
    L.push(`### ${s.name}`);
    L.push("");
    if (url) L.push(`**地址**：[${url}](${url})`);
    L.push("");
    L.push("| 项目 | 值 |");
    L.push("|:--|:--|");
    L.push(`| 类型 | ${KIND_LABELS[s.kind] || s.kind || "—"} |`);
    L.push(`| 综合分 | ${n1(s.score)}（${s.grade || "—"}） |`);
    L.push(`| 模型分 | ${n1(s.modelScore)}${s.modelEval && s.modelEval.model ? `（评测模型：${s.modelEval.model}）` : ""} |`);
    L.push(`| 在列模型数 | ${num(s.models)} |`);
    L.push(`| 最近实测 | ${fmtDate((s.probe && s.probe.at) || "")} |`);
    L.push(`| 标签 | ${Array.isArray(s.tags) && s.tags.length ? s.tags.join(" · ") : "—"} |`);
    L.push("");

    const introText = (intro && intro[s.slug]) || s.note || "";
    L.push("**简介**");
    L.push("");
    L.push(introText ? introText : `${s.name} 目前的五维实测综合分为 ${n1(s.score)}，等级 ${s.grade || "—"}。`);
    L.push("");

    L.push("**五维实测**");
    L.push("");
    L.push(dimTable(s.dims));
    L.push("");

    const evals = s.modelEvals || [];
    if (evals.length) {
      L.push("**模型评测**");
      L.push("");
      L.push(modelTable(evals));
      L.push("");
    }

    const models = s.modelList || [];
    if (models.length) {
      const head = models.slice(0, 10);
      const more = models.length > head.length ? `，另有 ${models.length - head.length} 个` : "";
      L.push("**模型清单**");
      L.push("");
      L.push(head.map((m) => `\`${m}\``).join("、") + more);
      L.push("");
    }

    const dg = degradationLine(s.degradation);
    if (dg) {
      L.push(dg);
      L.push("");
    }

    if (s.probe && s.probe.metrics) {
      const m = s.probe.metrics;
      L.push(
        `**线路数据**：TTFB ${n1(m.ttfb)} ms · TCP ${n1(m.tcp)} ms · TLS ${n1(m.tls)} ms · ${m.protocol || "—"} · 证书剩余 ${num(m.certDays)} 天 · IP \`${m.ip || "—"}\``
      );
      L.push("");
    }

    L.push("---");
    L.push("");
  }

  L.push("## 如何上榜");
  L.push("");
  L.push("1. 在站点首页提交，填站点地址和 API Key");
  L.push("2. 系统自动排队实测，五维齐全、综合分 ≥ 75、单维 ≥ 60 即自动上线");
  L.push("3. 不达标的进入人工审核，可在后台补充说明后重新提交");
  L.push("");
  L.push("阈值以后台设置为准，本页只做结果公示。");
  L.push("");
  return L.join("\n");
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function anchor(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

(async () => {
  try {
    const { sites, updatedAt } = await load();
    const intro = loadIntro();
    const md = build(sites, { updatedAt }, intro);
    fs.writeFileSync(OUT, md, "utf8");
    console.log(`已生成 ${OUT}`);
    console.log(`站点 ${sites.length} 个，${(Buffer.byteLength(md, "utf8") / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.error("生成失败：" + e.message);
    process.exit(1);
  }
})();

/* RelayRank —— 前台榜单逻辑 */

const DIM_KEYS = ["reach", "catalog", "chat", "stream", "concurrent"];
const DIM_LABELS = {
  reach: "连通成功率",
  catalog: "目录成功率",
  chat: "补全成功率",
  stream: "流式成功率",
  concurrent: "并发成功率"
};
const DIM_DESC = {
  reach: "首页 / 连打 5 次，TTFB 在 1000ms 内才算达标。",
  catalog: "GET /v1/models 连打 5 次，能读出模型目录且 1500ms 内返回才算达标。",
  chat: "非流式 /v1/chat/completions 连打 8 次，回包含正文且 10000ms 内完成才算达标。",
  stream: "同接口带 stream=true 连打 8 次，第一个带正文的 token 在 10000ms 内到才算达标。",
  concurrent: "3 路 + 5 路并发各一轮共 8 次，整轮 30000ms 内成功才算达标。"
};
const WEIGHTS = { reach: 10, catalog: 15, chat: 25, stream: 25, concurrent: 25 };

const state = { tab: "all", sort: "score", desc: true, query: "", status: "all", grade: "all", sites: [], meta: null, rankMap: new Map() };

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const pad = (n) => String(n).padStart(2, "0");
const fmt = (n) => (Math.round(Number(n) * 10) / 10).toFixed(1);
const probeStamp = (iso) => {
  if (!iso) return "未实测";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未实测";
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const statusOf = (s) => (s.down > 0 ? "bad" : s.issues > 0 || s.score < 60 ? "warn" : "ok");

/* 五维短名 + 分数分档（雷达图与迷你柱共用） */
const DIM_SHORT = {
  reach: "连通",
  catalog: "目录",
  chat: "补全",
  stream: "流式",
  concurrent: "并发"
};

const dimRaw = (site, key) => {
  const v = site.dims ? site.dims[key] : null;
  return v === null || v === undefined || v === "" ? null : Math.max(0, Math.min(100, Number(v) || 0));
};
const dimValue = (site, key) => {
  const v = dimRaw(site, key);
  return v === null ? 0 : v;
};
const toneOf = (v) => (v >= 85 ? "hi" : v >= 70 ? "mid" : v >= 55 ? "low" : "bad");

/* 表格内：五根竖条 + 数字行，与后台表格同款 */
function dimsMini(site) {
  const values = DIM_KEYS.map((k) => dimRaw(site, k));
  const bars = DIM_KEYS.map((k, i) => {
    const v = values[i];
    const tone = v === null ? "mute" : v >= 88 ? "hi" : v >= 72 ? "mid" : "lo";
    const tip = v === null ? DIM_LABELS[k] + " 未测" : DIM_LABELS[k] + " " + Math.round(v) + "%";
    const pct = v === null ? 0 : Math.round(v);
    return `<i class="dbar ${tone}" style="--w:${WEIGHTS[k]};--p:${pct}%" title="${tip}" role="img" aria-label="${tip}"></i>`;
  }).join("");
  const nums = values.map((v) => (v === null ? "—" : Math.round(v))).join("·");
  return `<div class="dims-mini" title="连通 / 目录 / 补全 / 流式 / 并发 成功率">${bars}</div><small class="dims-num">${nums}</small>`;
}

/* 抽屉内：五边雷达 */
function ringBig(key, value) {
  const C = 2 * Math.PI * 26;
  const tone = value === null ? "mute" : toneOf(value);
  const tip = value === null ? DIM_LABELS[key] + " 未测" : DIM_LABELS[key] + " " + fmt(value) + "%";
  const arc =
    value === null
      ? ""
      : `<circle class="rg-fill" cx="32" cy="32" r="26" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - value / 100)).toFixed(2)}" transform="rotate(-90 32 32)"></circle>`;
  return `<div class="dim-ring ${tone}" title="${tip}">
    <div class="ring-wrap">
      <svg viewBox="0 0 64 64" class="rg" role="img" aria-label="${DIM_LABELS[key]}">
        <circle class="rg-track" cx="32" cy="32" r="26" fill="none" stroke-width="5"></circle>
        ${arc}
      </svg>
      <b>${value === null ? "—" : Math.round(value)}</b>
    </div>
    <span>${DIM_SHORT[key]}</span>
  </div>`;
}

function dimPanel(site) {
  const values = DIM_KEYS.map((k) => dimRaw(site, k));
  const measured = values.filter((v) => v !== null).length;
  const rings = DIM_KEYS.map((k, i) => ringBig(k, values[i])).join("");
  return `<div class="dim-panel">
    <div class="dim-panel-head"><span>请求成功率</span><em>${measured}/5 维已测</em></div>
    <div class="dim-rings">${rings}</div>
  </div>`;
}

function logoSrc(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^\/uploads\/[a-zA-Z0-9._/-]+$/.test(value) && !value.includes("..")) return value;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

document.addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (!img || img.tagName !== "IMG" || img.dataset.avatarFallback === undefined) return;
    const span = img.parentNode;
    if (span) span.textContent = img.dataset.avatarFallback;
  },
  true
);

function avatarTone(name) {
  let hash = 0;
  const text = String(name || "?");
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 6;
}

function avatar(site, cls = "site-avatar") {
  if (site.kind === "public") cls += " pub-avatar";
  const src = logoSrc(site.logo);
  const initial = ((site.name || "?").trim()[0] || "?").toUpperCase();
  const tone = `tone-${avatarTone(site.name)}`;
  if (src) {
    return `<span class="${cls} ${tone}"><img src="${escapeHtml(src)}" alt="" data-avatar-fallback="${escapeHtml(initial)}" /></span>`;
  }
  return `<span class="${cls} ${tone}">${escapeHtml(initial)}</span>`;
}

const PUB_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z"></path></svg>';

/* 公益站标识：表格 / 小卡 / 抽屉共用 */
function pubFlag(site, cls = "") {
  if (site.kind !== "public") return "";
  return `<span class="pub-flag${cls ? " " + cls : ""}" title="公益中转站 · 免费开放">${PUB_ICON}公益</span>`;
}

function valueOf(site, key) {
  if (key === "score") return site.score;
  if (key === "rank") return site.score;
  return site.dims?.[key] ?? 0;
}

/* ------------------------------------------------------------------ */
/* 排序机制                                                            */
/* ------------------------------------------------------------------ */

/* 可排序键：取值器 + 默认方向。null 表示这一维没测，永远沉底 */
const SORT_KEYS = {
  score: { get: (s) => s.score, desc: true, label: "综合评分" },
  modelScore: { get: (s) => s.modelScore, desc: true, label: "模型分" },
  models: { get: (s) => s.models, desc: true, label: "支持模型数" },
  views: { get: (s) => s.views, desc: true, label: "访问量" },
  reach: { get: (s) => s.dims?.reach ?? null, desc: true, label: "连通成功率" },
  catalog: { get: (s) => s.dims?.catalog ?? null, desc: true, label: "目录成功率" },
  chat: { get: (s) => s.dims?.chat ?? null, desc: true, label: "补全成功率" },
  stream: { get: (s) => s.dims?.stream ?? null, desc: true, label: "流式成功率" },
  concurrent: { get: (s) => s.dims?.concurrent ?? null, desc: true, label: "并发成功率" },
  probeAt: { get: (s) => s.probe?.at || null, desc: true, label: "实测时间" }
};

const isBlank = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

/* 并列三层兜底：综合评分 → 实测时间 → id，任何一次重排结果都一样 */
function tieBreak(a, b) {
  const av = isBlank(a.score) ? -Infinity : a.score;
  const bv = isBlank(b.score) ? -Infinity : b.score;
  if (bv !== av) return bv - av;
  const at = a.probe?.at ? Date.parse(a.probe.at) : 0;
  const bt = b.probe?.at ? Date.parse(b.probe.at) : 0;
  if (bt !== at) return bt - at;
  return String(a.id).localeCompare(String(b.id));
}

function comparator(key, desc) {
  const spec = SORT_KEYS[key] || SORT_KEYS.score;
  return (a, b) => {
    const av = spec.get(a);
    const bv = spec.get(b);
    const ae = isBlank(av);
    const be = isBlank(bv);
    if (ae !== be) return ae ? 1 : -1;
    if (!ae) {
      const d = typeof av === "string" ? av.localeCompare(bv, "zh-CN", { numeric: true }) : av - bv;
      if (d) return desc ? -d : d;
    }
    return tieBreak(a, b);
  };
}

/* 真实名次：恒按综合评分，跟当前排序无关 */
function buildRanks(sites) {
  const map = new Map();
  sites.slice().sort(comparator("score", true)).forEach((s, i) => map.set(s.id, i + 1));
  return map;
}

/* 排序偏好落在 localStorage，下次打开还是这套 */
const SORT_STORE = "relayrank:sort";

/* 优先级：URL 参数 > localStorage > 默认综合评分降序 */
function loadSort() {
  const q = new URLSearchParams(location.search);
  const fromUrl = q.get("sort");
  if (fromUrl && SORT_KEYS[fromUrl]) {
    state.sort = fromUrl;
    state.desc = q.get("dir") !== "asc";
    return;
  }
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORE) || "null");
    if (raw && SORT_KEYS[raw.sort]) {
      state.sort = raw.sort;
      state.desc = Boolean(raw.desc);
    }
  } catch (e) {
    /* 存储被清掉就走默认 */
  }
}

function persistSort() {
  try {
    localStorage.setItem(SORT_STORE, JSON.stringify({ sort: state.sort, desc: state.desc }));
  } catch (e) {
    /* 隐私模式写不进去，忽略 */
  }
  const q = new URLSearchParams(location.search);
  q.set("sort", state.sort);
  q.set("dir", state.desc ? "desc" : "asc");
  history.replaceState(null, "", location.pathname + "?" + q.toString() + location.hash);
}

loadSort();

function visibleSites() {
  const q = state.query.trim().toLowerCase();
  let list = state.sites.filter((s) => {
    if (q && !(`${s.name} ${s.domain}`.toLowerCase().includes(q))) return false;
    if (state.grade !== "all" && s.grade !== state.grade) return false;
    if (state.status === "risk") {
      if (statusOf(s) === "ok") return false;
    } else if (state.status !== "all" && statusOf(s) !== state.status) {
      return false;
    }
    if (state.tab === "public" && s.kind !== "public") return false;
    if (state.tab === "risk" && !(s.score < 60 || s.issues > 0 || s.down > 0)) return false;
    return true;
  });

  list.sort(comparator(state.sort, state.desc));
  return list;
}

const COLUMNS = [
  { key: "rank", label: "排名", sortable: false, render: (s, i) => {
      const r = state.rankMap.get(s.id) || i + 1;
      const tier = r <= 3 ? ` rk-${r}` : r <= 10 ? " rk-top" : "";
      return `<td class="rank"><span class="rk${tier}" title="综合评分第 ${r} 名">${pad(r)}</span></td>`;
    } },
  {
    key: "name",
    label: "中转站",
    sortable: false,
    render: (s) => {
      // 提交者勾选的优先（来自真实目录），否则回落到实测全量
      const full = Array.isArray(s.modelList) ? s.modelList : [];
      const picked = Array.isArray(s.selectedModels) ? s.selectedModels : [];
      const verified = picked.length ? picked : full;
      const shown = verified.slice(0, 4);
      const rest = verified.length - shown.length;
      let tagHtml;
      let moreHtml = "";
      if (verified.length) {
        tagHtml = shown.map((t) => `<span class="tag good" title="实测存在">${escapeHtml(t)}</span>`).join("");
        const preview = verified.slice(4, 24).join(" / ") + (rest > 20 ? ` 等 ${rest} 个` : "");
        moreHtml = rest > 0 ? `<span class="tag more" title="${escapeHtml(preview)}">+${rest}</span>` : "";
      } else if (s.modelListAt) {
        tagHtml = `<span class="tag unverified" title="该站未公开 /v1/models，无法确认模型清单">模型未公开</span>`;
      } else {
        tagHtml = `<span class="tag unverified" title="尚未实测该站的模型列表">待实测</span>`;
      }
      const probeAt = s.probe?.at;
      const probeTitle = probeAt
        ? `实测于 ${new Date(probeAt).toLocaleString("zh-CN", { hour12: false })}`
        : "还没有真实实测记录";
      const probeHtml = probeAt
        ? s.probe.reachable
          ? `<span class="tag probe" title="${escapeHtml(probeTitle)}">实测</span>`
          : `<span class="tag down" title="${escapeHtml(probeTitle)}">不可达</span>`
        : `<span class="tag manual" title="分数为人工录入">未实测</span>`;
      return `<td><div class="site-cell">${avatar(s)}<div class="site-main">
        <div class="site-row"><strong>${escapeHtml(s.name)}</strong>${pubFlag(s)}${probeHtml}</div>
        <div class="site-tags"><span class="domain">${escapeHtml(s.domain)}</span>${tagHtml}${moreHtml}</div>
      </div></div></td>`;
    }
  },
  {
    key: "score",
    label: "综合评分",
    render: (s) =>
      `<td class="score-cell"><b>${fmt(s.score)}</b><i class="grade grade-${s.grade.toLowerCase()}" title="等级 ${s.grade}">${s.grade}</i></td>`
  },
  {
    key: "modelScore",
    label: "模型分",
    render: (s) =>
      s.modelScore === null || s.modelScore === undefined
        ? `<td class="model-none" title="尚未做模型质量评测">—</td>`
        : `<td class="model-score" title="${escapeHtml(s.modelEval ? s.modelEval.model + " · 能力 " + s.modelEval.ability.rate + "% · 上下文 " + s.modelEval.context.maxVerified + " tokens" : "")}">${Math.round(s.modelScore)}</td>`
  },
  { key: "dims", label: "五维评分", sortable: false, render: (s) => `<td class="dims-cell">${dimsMini(s)}</td>` },
  {
    key: "probeAt",
    label: "实测时间",
    render: (s) => {
      const at = s.probe && s.probe.at ? s.probe.at : "";
      const title = at ? `实测于 ${new Date(at).toLocaleString("zh-CN", { hour12: false })}` : "还没有真实实测记录";
      return `<td class="probe-at ${at ? "" : "none"}" title="${escapeHtml(title)}">${probeStamp(at)}</td>`;
    }
  },
  {
    key: "models",
    label: "支持模型",
    render: (s) => {
      const picked = Array.isArray(s.selectedModels) ? s.selectedModels.length : 0;
      const full = Array.isArray(s.modelList) ? s.modelList.length : null;
      const n = picked || full;
      let title;
      if (picked) title = `提交者从真实目录中选了 ${picked} 个${full ? `（目录共 ${full} 个）` : ""}`;
      else if (full !== null) title = `实测 /v1/models 返回 ${full} 个模型`;
      else title = "尚未实测模型列表";
      return `<td class="num" title="${title}">${n === null ? "—" : n}</td>`;
    }
  },
  {
    key: "views",
    label: "访问量",
    render: (s) => {
      const v = Number(s.views) || 0;
      return `<td class="num views" title="从榜单跳到该站点的次数">${v}${v ? "" : ""}</td>`;
    }
  },
  {
    key: "op",
    label: "操作",
    sortable: false,
    render: (s) => `<td><a class="report" href="#" data-detail="${s.id}">详情 →</a></td>`
  }
];

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTable() {
  state.rankMap = buildRanks(state.sites);
  const rows = visibleSites();

  $("#ranking-head").innerHTML =
    "<tr>" +
    COLUMNS.map((c) => {
      const active = state.sort === c.key;
      const cls = [c.sortable === false ? "no-sort" : "", active ? "active" : ""].filter(Boolean).join(" ");
      return `<th class="${cls}" ${c.sortable === false ? "" : `data-sort-col="${c.key}" title="点一次按${c.label}排，再点反向，第三次复位到综合评分"`}>${c.label}${
        c.sortable === false ? "" : `<span class="arrow">${active ? (state.desc ? "▼" : "▲") : "↕"}</span>`
      }</th>`;
    }).join("") +
    "</tr>";

  $("#ranking-body").innerHTML = rows.length
    ? rows.map((s, i) => `<tr class="${s.kind === "public" ? "is-public" : ""}" data-site="${s.id}">` + COLUMNS.map((c) => c.render(s, i)).join("") + "</tr>").join("")
    : "";

  const total = state.sites.length;
  const filtering = Boolean((state.query || "").trim()) || state.status !== "all" || state.grade !== "all";

  $("#empty-state").hidden = rows.length > 0;
  if (!rows.length) {
    $("#empty-title").textContent = filtering
      ? "没有符合条件的站点"
      : state.tab === "risk"
        ? "目前没有风险站点"
        : state.tab === "public"
          ? "还没有公益中转站"
          : "还没有站点";
    $("#empty-sub").textContent = filtering
      ? "换个关键词，或把筛选条件重置一下。"
      : state.tab === "risk"
        ? "所有已收录站点都在警戒线以上。"
        : state.tab === "public"
          ? "把免费开放的公益站提交上来，审核通过后出现在这里。"
          : "提交第一个站点，这里就会有排名。";
    const emptyBtn = $("#empty-action");
    emptyBtn.textContent = filtering ? "重置筛选" : "提交站点";
    emptyBtn.dataset.mode = filtering ? "reset" : "submit";
  }

  $("#table-count").textContent =
    rows.length === total ? `显示 ${rows.length} 个站点，共 ${total} 个` : `筛选出 ${rows.length} 个站点，共 ${total} 个`;
  $("#ranking-name").textContent = state.tab === "risk" ? "风险站点" : state.tab === "public" ? "公益中转站" : "站点总览";
  $("#ranking-count").textContent = `共 ${total} 个中转站`;
  $("#ranking-kicker").textContent = state.tab === "risk" ? "风险榜" : state.tab === "public" ? "公益中转站榜" : "中转站综合榜";

  const probed = state.sites.filter((s) => s.probe && s.probe.at).length;
  $("#meta-sites").textContent = total;
  $("#meta-probed").textContent = probed;
  const updated = state.meta && state.meta.updatedAt ? new Date(state.meta.updatedAt) : null;
  const metaWhen = $("#meta-updated");
  if (updated && !Number.isNaN(updated.getTime())) {
    const mins = Math.round((Date.now() - updated.getTime()) / 60000);
    metaWhen.textContent =
      mins < 1 ? "刚刚" : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
    metaWhen.title = updated.toLocaleString("zh-CN", { hour12: false });
  } else {
    metaWhen.textContent = "—";
  }

  $$("thead th[data-sort-col]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sortCol;
      if (state.tab === "risk") return;
      const spec = SORT_KEYS[key];
      if (!spec) return;
      if (state.sort !== key) {
        state.sort = key;
        state.desc = spec.desc;
      } else if (state.desc === spec.desc) {
        state.desc = !spec.desc;
      } else {
        state.sort = "score";
        state.desc = true;
      }
      persistSort();
      syncDimensionTabs();
      renderTable();
    })
  );

  $$("[data-detail]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openDrawer(el.dataset.detail);
    })
  );

  if (state.tab === "risk") syncDimensionTabs();
}

function syncDimensionTabs() {
  const isRisk = state.tab === "risk";
  $("#dimension-tabs").style.visibility = isRisk ? "hidden" : "visible";
  $$("#dimension-tabs button").forEach((b) => b.classList.toggle("active", !isRisk && b.dataset.sort === state.sort));
}

function renderStats() {
  const stats = state.meta?.stats || { sites: 0, models: 0, issues: 0, down: 0 };
  $("#stat-sites").textContent = stats.sites;
  $("#stat-models").textContent = stats.models;
  $("#stat-issues").textContent = stats.issues;
  $("#stat-down").textContent = stats.down;
  const when = state.meta?.updatedAt ? new Date(state.meta.updatedAt) : null;
  const lastProbe = state.sites.reduce((max, s) => (s.probe?.at && s.probe.at > max ? s.probe.at : max), "");
  const footerParts = [];
  if (when) footerParts.push(`数据更新于 ${when.toLocaleString("zh-CN", { hour12: false })}`);
  if (lastProbe) footerParts.push(`最近实测 ${new Date(lastProbe).toLocaleString("zh-CN", { hour12: false })}`);
  $("#footer-updated").textContent = footerParts.join(" · ");
}

function renderMini() {
  const sorted = state.sites.slice().sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 3);
  const risk = sorted.slice().reverse().filter((s) => s.score < 60 || s.issues > 0).slice(0, 3);

  $("#top-list").innerHTML = top.length
    ? top
        .map(
          (s, i) => `<div>
      <b>${pad(i + 1)}</b>
      <a class="mini-site" data-detail="${s.id}">${avatar(s, "mini-avatar")}<span class="name">${escapeHtml(s.name)}</span>${pubFlag(s, "sm")}</a>
      <em>${fmt(s.score)}</em>
      <i class="grade grade-${s.grade.toLowerCase()}">${s.grade}</i>
      <span class="mini-note">${escapeHtml(s.note || "—")} · 实测 ${probeStamp(s.probe?.at)}</span>
    </div>`
        )
        .join("")
    : `<p class="mini-empty">暂无数据，等待第一个站点提交。</p>`;

  $("#risk-list").innerHTML = risk.length
    ? risk
        .map(
          (s, i) => `<div>
      <b>${pad(i + 1)}</b>
      <a class="mini-site" data-detail="${s.id}">${avatar(s, "mini-avatar")}<span class="name">${escapeHtml(s.name)}</span>${pubFlag(s, "sm")}</a>
      <em>${fmt(s.score)}</em>
      <i class="grade grade-${s.grade.toLowerCase()}">${s.grade}</i>
      <span class="mini-note">${escapeHtml(s.note || "低分站点")} · 实测 ${probeStamp(s.probe?.at)}</span>
    </div>`
        )
        .join("")
    : `<p class="mini-empty">当前没有风险站点。</p>`;

  $$("[data-detail]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openDrawer(el.dataset.detail);
    })
  );
}

function renderDimensions() {
  const icons = {
    reach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z"></path><path d="m9 12 2 2 4-5"></path></svg>',
    catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="6" rx="1"></rect><rect x="14" y="4" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="6" rx="1"></rect><rect x="14" y="14" width="6" height="6" rx="1"></rect></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"></path><path d="M8 11h8M8 15h5"></path></svg>',
    stream: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l2.5-7 4 14 2.5-7h6"></path></svg>',
    concurrent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"></path></svg>'
  };
  const colors = { reach: "green", catalog: "amber", chat: "blue", stream: "orange", concurrent: "red" };

  $("#dimension-grid").innerHTML = DIM_KEYS.map(
    (k) => `<article>
      <div class="dimension-icon ${colors[k]}">${icons[k]}</div>
      <h3>${DIM_LABELS[k]} <small>权重 ${WEIGHTS[k]}%</small></h3>
      <div class="weight">${WEIGHTS[k]}%</div>
      <p>${DIM_DESC[k]}</p>
    </article>`
  ).join("");
}

function openDrawer(id) {
  const site = state.sites.find((s) => s.id === id);
  if (!site) return;

  const logo = $("#drawer-logo");
  const logoSrcValue = logoSrc(site.logo);
  if (logoSrcValue) {
    logo.src = logoSrcValue;
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }

  $("#drawer-title").textContent = site.name;
  const kindEl = $("#drawer-kind");
  if (kindEl) kindEl.hidden = site.kind !== "public";
  const domainEl = $("#drawer-domain");
  domainEl.textContent = site.domain;
  const siteHref = logoSrc(site.url);
  domainEl.href = siteHref || `https://${site.domain}`;
  $("#drawer-score").textContent = fmt(site.score);
  const gradeEl = $("#drawer-grade");
  gradeEl.textContent = site.grade;
  gradeEl.className = `grade grade-${site.grade.toLowerCase()}`;
  const rank = state.rankMap.get(site.id) || state.sites.findIndex((s) => s.id === site.id) + 1;
  $("#drawer-rank").textContent = rank > 0 ? `#${pad(rank)}` : "#—";

  const probeAt = site.probe && site.probe.at ? site.probe.at : "";
  const probeBar = $("#drawer-probe-bar");
  probeBar.classList.toggle("none", !probeAt);
  $("#drawer-probe-source").textContent = probeAt ? "真实请求" : "未实测";

  $("#drawer-dims").innerHTML = dimPanel(site);

  $("#drawer-models").textContent = site.models;
  const viewsEl = $("#drawer-views");
  if (viewsEl) viewsEl.textContent = Number(site.views) || 0;
  $("#drawer-issues").textContent = site.issues;
  $("#drawer-down").textContent = site.down;
  $("#drawer-probe").textContent = probeAt
    ? new Date(probeAt).toLocaleString("zh-CN", { hour12: false })
    : "未实测";
  $("#drawer-probe").title = probeAt ? "最近一次真实请求实测时间" : "还没有真实实测记录";
  $("#drawer-updated").textContent = probeStamp(site.updatedAt);
  $("#drawer-updated").title = new Date(site.updatedAt).toLocaleString("zh-CN", { hour12: false });
  $("#drawer-note").textContent = site.note || "暂无备注。";
  $("#drawer-link").href = `/go/${site.id}`;

  const drawer = $("#drawer");
  drawer.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  $("#drawer").hidden = true;
  document.body.style.overflow = "";
}

function initTheme() {
  // 默认浅色；localStorage 存了 "dark" 才切深色
  const saved = localStorage.getItem("relayrank-theme");
  if (saved !== "dark") document.documentElement.setAttribute("data-theme", "light");
  $("#theme-toggle").addEventListener("click", () => {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    if (light) {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("relayrank-theme", "dark");
    } else {
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("relayrank-theme", "light");
    }
  });
}

function bindEvents() {
  $$("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      state.sort = "score";
      state.desc = state.tab !== "risk";
      persistSort();
      $$("[data-tab]").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      syncDimensionTabs();
      renderTable();
    })
  );

  $$("#dimension-tabs button").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (state.tab === "risk") return;
      state.sort = btn.dataset.sort;
      state.desc = SORT_KEYS[btn.dataset.sort]?.desc ?? true;
      persistSort();
      syncDimensionTabs();
      renderTable();
    })
  );

  $("#search-input").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderTable();
  });

  $("#status-filter").addEventListener("change", (e) => {
    state.status = e.target.value;
    renderTable();
  });

  $("#grade-filter").addEventListener("change", (e) => {
    state.grade = e.target.value;
    renderTable();
  });

  $("#reset-btn").addEventListener("click", () => {
    state.query = "";
    state.status = "all";
    state.grade = "all";
    state.sort = "score";
    state.desc = true;
    $("#search-input").value = "";
    $("#status-filter").value = "all";
    $("#grade-filter").value = "all";
    syncDimensionTabs();
    renderTable();
  });

  $("#empty-action").addEventListener("click", () => {
    if ($("#empty-action").dataset.mode === "reset") $("#reset-btn").click();
    else $("#submit-open").click();
  });

  $$("[data-jump]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (btn.dataset.jump === "risk") {
        state.status = "risk";
        $("#status-filter").value = "risk";
      } else {
        state.status = "all";
        state.grade = "all";
        state.query = "";
        $("#status-filter").value = "all";
        $("#grade-filter").value = "all";
        $("#search-input").value = "";
      }
      renderTable();
      $("#ranking").scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );

  $$("[data-close]").forEach((el) => el.addEventListener("click", closeDrawer));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDrawer(); const m = $("#submit-modal"); if (m) m.hidden = true; }
  });
}

async function load() {
  try {
    const res = await fetch("/api/sites", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.sites = data.sites || [];
    state.meta = data;
    renderStats();
    renderMini();
    renderDimensions();
    renderTable();
    syncDimensionTabs();
  } catch (err) {
    $("#ranking-body").innerHTML = `<tr><td class="empty" colspan="7">加载失败：${escapeHtml(err.message)}</td></tr>`;
    $("#table-count").textContent = "加载失败";
  }
}

/* ---------------- 提交站点 ---------------- */

function initSubmit() {
  const modal = $("#submit-modal");

  $("#submit-open").addEventListener("click", (e) => {
    e.preventDefault();
    $("#sub-error").hidden = true;
    $("#sub-note-ok").hidden = true;
    modal.hidden = false;
    setTimeout(() => $("#sub-name").focus(), 30);
  });

  $$("[data-submit-close]").forEach((el) =>
    el.addEventListener("click", () => {
      modal.hidden = true;
    })
  );

  /* ---- 模型目录：拉真实清单，让提交者勾 ---- */
  const modelListBox = $("#sub-model-list");
  const modelHint = $("#sub-model-hint");
  const fetchBtn = $("#sub-fetch-models");
  const countEl = $("#sub-model-count");
  let pickedModels = [];
  let catalogModels = [];

  function syncPicked() {
    pickedModels = Array.from(modelListBox.querySelectorAll('input[name="submodel"]:checked')).map((i) => i.value);
    $("#sub-models").value = pickedModels.length;
    countEl.hidden = !catalogModels.length;
    countEl.textContent = `已选 ${pickedModels.length} / 共 ${catalogModels.length}`;
  }

  let lastCatalogSig = "";

  async function loadCatalog(opts = {}) {
    /* 探测地址优先，没填才用访问地址 / 域名 */
    const raw = (($("#sub-evalbase")?.value || "").trim() || $("#sub-url").value || $("#sub-domain").value || "").trim();
    const apiKey = ($("#sub-apikey")?.value || "").trim();
    if (!raw) {
      modelHint.className = "picker-hint bad";
      modelHint.textContent = "请先填写访问地址或域名";
      return;
    }
    if (!apiKey) {
      modelHint.className = "picker-hint bad";
      modelHint.textContent = "填上 API Key 才能拉取该站真实模型";
      return;
    }
    const sig = raw + "|" + apiKey;
    if (opts.auto && sig === lastCatalogSig) return;
    lastCatalogSig = sig;
    fetchBtn.disabled = true;
    fetchBtn.textContent = "拉取中…";
    modelHint.className = "picker-hint";
    modelHint.textContent = "正在请求该站的 /v1/models …";
    try {
      const res = await fetch("/api/model-catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: raw, apiKey })
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        lastCatalogSig = "";
        modelHint.className = "picker-hint bad";
        modelHint.textContent = data.error || "没有拿到模型目录";
        modelListBox.hidden = true;
        catalogModels = [];
        pickedModels = [];
        syncPicked();
        return;
      }
      catalogModels = data.models || [];
      modelListBox.innerHTML = catalogModels
        .map(
          (m) =>
            `<label class="model-opt"><input type="checkbox" name="submodel" value="${escapeHtml(m)}" checked /><span>${escapeHtml(m)}</span></label>`
        )
        .join("");
      modelListBox.hidden = false;
      modelHint.className = "picker-hint ok";
      modelHint.textContent = data.total > catalogModels.length
        ? `该站共 ${data.total} 个模型，列表只展示前 ${catalogModels.length} 个，默认全选`
        : `拿到 ${data.total ?? catalogModels.length} 个模型，默认全选，取消不需要的即可`;
      syncPicked();
    } catch (error) {
      lastCatalogSig = "";
      modelHint.className = "picker-hint bad";
      modelHint.textContent = error.message;
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "获取模型目录";
    }
  }

  fetchBtn?.addEventListener("click", () => loadCatalog());

  /* 填了 Key 就自己去拉，不用再点按钮 */
  let autoTimer = null;
  function scheduleAuto() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => loadCatalog({ auto: true }), 700);
  }
  $("#sub-apikey")?.addEventListener("input", scheduleAuto);
  $("#sub-apikey")?.addEventListener("blur", () => loadCatalog({ auto: true }));
  $("#sub-url")?.addEventListener("change", () => loadCatalog({ auto: true }));
  $("#sub-evalbase")?.addEventListener("change", () => loadCatalog({ auto: true }));
  $("#sub-domain")?.addEventListener("change", () => loadCatalog({ auto: true }));

  modelListBox?.addEventListener("change", syncPicked);
  $("#submit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#sub-submit");
    const err = $("#sub-error");
    const ok = $("#sub-note-ok");
    err.hidden = true;
    ok.hidden = true;
    btn.disabled = true;
    btn.textContent = "提交中…";

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: $("#sub-name").value.trim(),
          domain: $("#sub-domain").value.trim(),
          url: $("#sub-url").value.trim(),
          evalBaseUrl: ($("#sub-evalbase")?.value || "").trim(),
          note: $("#sub-note").value.trim(),
          contact: $("#sub-contact").value.trim(),
          models: Number($("#sub-models").value) || 0,
          kind: document.querySelector('input[name="kind"]:checked')?.value || "commercial",
          selectedModels: pickedModels.slice(0, 60),
          apiKey: ($("#sub-apikey")?.value || "").trim(),
          honey: $("#sub-honey").value
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `提交失败（HTTP ${res.status}）`);

      ok.textContent = data.message || "提交成功，已进入审核队列；审核通过后才会出现在榜单。";
      ok.hidden = false;
      $("#submit-form").reset();
      $("#sub-models").value = 0;
      modelListBox.innerHTML = "";
      modelListBox.hidden = true;
      catalogModels = [];
      pickedModels = [];
      modelHint.className = "picker-hint";
      modelHint.textContent = "先填访问地址，再拉取该站公开的模型清单";
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "提交审核";
    }
  });
}

initSubmit();
initTheme();bindEvents();
renderDimensions();
load();


/* 访问量：每小时自动拉一次，只改数字，不动排序和滚动位置 */
async function refreshViews() {
  try {
    const res = await fetch("/api/sites", { headers: { accept: "application/json" }, cache: "no-store" });
    const data = await res.json();
    const map = new Map((data.sites || []).map((s) => [s.id, Number(s.views) || 0]));
    state.sites.forEach((s) => {
      if (map.has(s.id)) s.views = map.get(s.id);
    });
    document.querySelectorAll("#ranking-body tr[data-site]").forEach((tr) => {
      const v = map.get(tr.dataset.site);
      const cell = tr.querySelector("td.views");
      if (v !== undefined && cell) cell.textContent = String(v);
    });
  } catch {
    /* 下一轮再拉 */
  }
}
setInterval(refreshViews, 60 * 60 * 1000);

/* RelayRank 后台逻辑 */

const DIMS = [
  { key: "reach", label: "连通成功率", weight: 0.1 },
  { key: "catalog", label: "目录成功率", weight: 0.15 },
  { key: "chat", label: "补全成功率", weight: 0.25 },
  { key: "stream", label: "流式成功率", weight: 0.25 },
  { key: "concurrent", label: "并发成功率", weight: 0.25 }
];

const state = {
  csrf: "",
  sites: [],
  rankMap: new Map(),
  stats: { total: 0, pending: 0, published: 0, rejected: 0, draft: 0 },
  status: "all",
  query: "",
  sort: { key: "auto", dir: 1 },
  selected: new Set(),
  editing: null,
  importFormat: "json",
  bulkAction: "",
  rejectTargets: [],
  statusTimer: null,
  autoProbe: null
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (Math.round(Number(n) * 10) / 10).toFixed(1);
const gradeOf = (score) => (score >= 90 ? "S" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : "D");
const STATUS_TEXT = { pending: "待审核", published: "已通过", rejected: "已驳回", draft: "草稿" };
const ACTION_TEXT = {
  approve: "通过",
  reject: "驳回",
  reset: "重新排队",
  submit: "访客提交",
  create: "新建",
  probe: "实测",
  "auto-probe": "自动实测",
  "auto-review": "自动审核",
  eval: "模型评测",
  "eval-fail": "评测失败",
  edit: "编辑"
};

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " err" : "");
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && state.csrf) headers["x-csrf-token"] = state.csrf;

  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data?.error || data?.detail || `请求失败（HTTP ${res.status}）`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- 登录 ---------------- */

function showLogin() {
  $("#login-view").hidden = false;
  $("#admin-view").hidden = true;
}

function showAdmin() {
  $("#login-view").hidden = true;
  $("#admin-view").hidden = false;
  loadSites();
  loadReviews();
  loadSettings();
  loadGuard();
  clearInterval(state.statusTimer);
  state.statusTimer = setInterval(() => {
    if ($("#admin-view").hidden) return;
    loadAutoProbe();
    loadGuard();
  }, 30000);
}

async function boot() {
  /* 不做自动登录：直接打开 /admin 一律先显示登录页。
     只有刚提交过登录表单、被服务端 302 跳回来这一次，才验证会话并进后台。 */
  let justLoggedIn = false;
  try {
    justLoggedIn = sessionStorage.getItem("rr_just_logged_in") === "1";
    sessionStorage.removeItem("rr_just_logged_in");
  } catch (e) {
    justLoggedIn = false;
  }
  if (!justLoggedIn) return showLogin();

  try {
    const session = await api("/api/admin/session");
    state.csrf = session.csrf;
    $("#who").textContent = session.username;
    showAdmin();
  } catch {
    showLogin();
  }
}

/* 原生表单提交前打一个一次性标记，供 302 回到 /admin 时判断「刚登录过」 */
$("#login-form")?.addEventListener("submit", () => {
  try { sessionStorage.setItem("rr_just_logged_in", "1"); } catch (e) { /* 隐私模式忽略 */ }
});

async function showServerInfo() {
  const el = $("#diag");
  if (!el) return;
  const cookieOk = navigator.cookieEnabled ? "Cookie 可用" : "Cookie 被禁用";
  try {
    const health = await api("/api/health");
    el.textContent = `${el.textContent.replace("正在检测服务端…", "")}${health.service || "RelayRank"} · ${cookieOk}`;
  } catch {
    el.textContent = `${el.textContent.replace("正在检测服务端…", "")}无法连接服务端（${location.origin}）· ${cookieOk}`;
  }
}

// 登录：交给浏览器原生提交 POST /login-form，服务端写 HttpOnly Cookie 后 302 回 /admin
// 这样"点登录 → 页面跳转"是真实发生的，不依赖任何前端脚本。
$("#logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST" });
  } catch {
    /* 忽略 */
  }
  state.csrf = "";
  location.reload();
});

/* ---------------- 列表 ---------------- */

async function loadSites() {
  try {
    const data = await api("/api/admin/sites");
    state.sites = data.sites || [];
  state.probing = data.probing || 0;
  state.evaling = data.evaling || 0;
    state.stats = data.stats || state.stats;
    renderStats();
    renderTable();
  } catch (err) {
    if (err.status === 401) {
      toast("登录态无效：请重新登录", true);
      return showLogin();
    }
    toast(err.message, true);
  }
}

function renderStats() {
  const s = state.stats;
  $("#s-total").textContent = s.total;
  $("#s-pending").textContent = s.pending;
  $("#s-published").textContent = s.published;
  $("#s-rejected").textContent = s.rejected;
  $("#t-pending").textContent = s.pending;
  $("#t-all").textContent = s.published;
  $("#t-published").textContent = s.published;
  $("#t-rejected").textContent = s.rejected;
}

/* 与前端同一套排名：综合评分降序 → 实测时间倒序 → id */
function tieBreak(a, b) {
  const av = Number.isFinite(Number(a.score)) ? Number(a.score) : -Infinity;
  const bv = Number.isFinite(Number(b.score)) ? Number(b.score) : -Infinity;
  if (bv !== av) return bv - av;
  const at = a.probe && a.probe.at ? Date.parse(a.probe.at) : 0;
  const bt = b.probe && b.probe.at ? Date.parse(b.probe.at) : 0;
  if (bt !== at) return bt - at;
  return String(a.id).localeCompare(String(b.id));
}

function buildRanks(sites) {
  const map = new Map();
  sites.filter((s) => s.status === "published")
    .slice()
    .sort(tieBreak)
    .forEach((s, i) => map.set(s.id, i + 1));
  return map;
}

function visibleSites() {
  const q = state.query.trim().toLowerCase();
  const list = state.sites.filter((s) => {
    // 「全部」只列已经上线的站点；待审核、已驳回各看各的
    if (state.status === "all") {
      if (s.status !== "published") return false;
    } else if (s.status !== state.status) return false;
    if (q && !`${s.name} ${s.domain}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const rank = { pending: 0, published: 1, draft: 2, rejected: 3 };
  const key = state.sort.key;
  const dir = state.sort.dir;

  if (key === "auto") {
    return list.sort((a, b) => (rank[a.status] - rank[b.status]) || tieBreak(a, b));
  }

  return list.sort((a, b) => {
    let av;
    let bv;
    if (key === "rank") { av = state.rankMap.get(a.id) || 999; bv = state.rankMap.get(b.id) || 999; }
    else if (key === "views") { av = Number(a.views) || 0; bv = Number(b.views) || 0; }
    else if (key === "score") { av = Number(a.score) || 0; bv = Number(b.score) || 0; }
    else if (key === "name") { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
    else if (key === "status") { av = rank[a.status] ?? 9; bv = rank[b.status] ?? 9; }
    else if (key === "probeAt") { av = (a.probe && a.probe.at) || ""; bv = (b.probe && b.probe.at) || ""; }
    else { av = a.updatedAt || ""; bv = b.updatedAt || ""; }

    if (typeof av === "string") {
      const d = av.localeCompare(bv) * dir;
      return d || tieBreak(a, b);
    }
    const d = (av - bv) * dir;
    return d || tieBreak(a, b);
  });
}

function viewsOf(s) {
  return Number(s.views) || 0;
}

function viewTitle(s) {
  const v = viewsOf(s);
  if (!v) return "还没有人从榜单点进这个站";
  return "累计 " + v + " 次跳转" + (s.lastViewAt ? "，最近 " + relTime(s.lastViewAt) : "");
}

function rankCell(s) {
  if (s.status !== "published") return '<span class="rk-na">—</span>';
  const r = state.rankMap.get(s.id) || 0;
  if (!r) return "—";
  const tier = r <= 3 ? r : "n";
  return '<span class="rk rk-' + tier + '">' + String(r).padStart(2, "0") + "</span>";
}
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function probeShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function renderTable() {
  state.rankMap = buildRanks(state.sites);
  const rows = visibleSites();
  const tbody = $("#admin-body");

  if (!rows.length) {
    const q = state.query.trim();
    const msg = q
      ? `没有匹配「${esc(q)}」的站点。`
      : state.status === "pending"
        ? "没有待审核的站点，审核队列已清空。"
        : state.status === "all"
          ? "还没有已通过的站点，去「待审核」里审一批上架。"
          : `这个分类下暂无站点。`;
    tbody.innerHTML = `<tr><td colspan="12" class="empty">${msg}</td></tr>`;
  } else {
    tbody.innerHTML = rows
      .map((s) => {
        // 行内只留最高频操作，其余收进「⋯」菜单
        const ops = [];
        if (s.status !== "published") ops.push(`<button class="btn sm ok" data-act="approve" data-id="${s.id}">通过</button>`);
        if (s.status === "published") ops.push(`<button class="btn sm ghost" data-act="probe" data-id="${s.id}" title="对这个站点发真实请求实测">实测</button>`);
        ops.push(`<button class="btn sm ghost" data-act="edit" data-id="${s.id}">编辑</button>`);
        ops.push(`<button class="btn sm ghost row-more" data-more="${s.id}" aria-haspopup="menu" aria-expanded="false" title="更多操作">⋯</button>`);

        const rawDims = DIMS.map((d) => {
          const raw = s.dims ? s.dims[d.key] : null;
          return raw === null || raw === undefined || raw === "" ? null : Math.max(0, Math.min(100, Math.round(Number(raw))));
        });
        const bars = DIMS.map((d, i) => {
          const v = rawDims[i];
          const tone = v === null ? "mute" : v >= 88 ? "hi" : v >= 72 ? "mid" : "lo";
          const tip = v === null ? d.label + " 未测" : d.label + " " + v + "%";
          const pct = v === null ? 0 : v;
          return `<i class="dbar ${tone}" style="--w:${Math.round(d.weight * 100)};--p:${pct}%" title="${tip}" role="img" aria-label="${tip}"></i>`;
        }).join("");
        const nums = rawDims.map((v) => (v === null ? "—" : v)).join("·");

        return `<tr class="row-${s.status}" data-site="${s.id}">
          <td class="col-check"><input type="checkbox" data-check="${s.id}" ${state.selected.has(s.id) ? "checked" : ""} aria-label="选择 ${esc(s.name)}" /></td>
          <td class="num">${rankCell(s)}</td>
          <td><div class="site-cell">${avatar(s)}<div><strong>${esc(s.name)}</strong>${s.kind === "public" ? `<span class="tag public" title="公益中转站">公益</span>` : ""}<small>${esc(s.domain)}</small></div></div></td>
          <td class="num"><b class="score-${s.grade.toLowerCase()}">${fmt(s.score)}</b></td>
          <td class="num"><i class="grade grade-${s.grade.toLowerCase()}">${s.grade}</i></td>
          <td class="col-dims">
            <div class="dims-mini">${bars}</div>
            <small class="dims-num">${nums}</small>
          </td>
          <td class="num">${s.models} / ${s.issues} / ${s.down}</td>
          <td class="num views" title="${viewTitle(s)}">${viewsOf(s)}</td>
          <td>
            <span class="badge ${s.status}">${STATUS_TEXT[s.status] || s.status}</span>
            ${(() => {
              if (!s.probe || !s.probe.at) return `<div class="src-tag manual" title="分数为人工录入，未经实测">人工</div>`;
              const age = Date.now() - new Date(s.probe.at).getTime();
              const stale = age > 7 * 86400000;
              const tip = s.probe.reachable ? `实测于 ${new Date(s.probe.at).toLocaleString("zh-CN", { hour12: false })}` : `实测不可达：${s.probe.error || ""}`;
              return `<div class="src-tag ${s.probe.reachable ? (stale ? "stale" : "probe") : "down"}" title="${esc(tip)}">${s.probe.reachable ? "实测" : "不可达"} ${relTime(s.probe.at)}</div>`;
            })()}
          </td>
          <td>
            <span class="probe-time ${s.probe && s.probe.at ? "" : "none"}" title="${s.probe && s.probe.at ? esc("实测时间 " + fmtDateTime(s.probe.at)) : "还没有真实实测记录"}">${s.probe && s.probe.at ? probeShort(s.probe.at) : "未实测"}</span>
            <div class="src">更新 ${relTime(s.updatedAt)}</div>
          </td>
          <td><div class="ops">${ops.join("")}</div></td>
        </tr>`;
      })
      .join("");
  }

  $$("[data-check]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(cb.dataset.check);
      else state.selected.delete(cb.dataset.check);
      syncBulk();
    })
  );

  // 操作统一走事件委托，行内按钮和「⋯」菜单共用同一套动作
  tbody.onclick = (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      e.stopPropagation();
      openRowMenu(more);
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn || !tbody.contains(btn)) return;
    const site = state.sites.find((s) => s.id === btn.dataset.id);
    if (!site) return;
    runRowAction(btn.dataset.act, site);
  };

  updateListCount();

  syncBulk();
}

function adminLogoSrc(raw) {
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

function avatar(site) {
  const src = adminLogoSrc(site.logo);
  const initial = esc(((site.name || "?").trim()[0] || "?").toUpperCase());
  const tone = `tone-${avatarTone(site.name)}`;
  if (src) {
    return `<span class="site-avatar ${tone}"><img src="${esc(src)}" alt="" data-avatar-fallback="${initial}" /></span>`;
  }
  return `<span class="site-avatar ${tone}">${initial}</span>`;
}

function syncBulk() {
  const count = state.selected.size;
  $("#bulk-count").textContent = count;
  $("#bulk-bar").hidden = count === 0;
  $("#check-all").checked = count > 0 && count === visibleSites().length;
}

function updateListCount() {
  const el = $("#list-count");
  if (!el) return;
  // 「全部」口径已改成只含已通过，计数必须跟着走，否则会和表里的行数对不上
  const scope =
    state.status === "all"
      ? state.sites.filter((s) => s.status === "published")
      : state.sites.filter((s) => s.status === state.status);
  const shown = visibleSites().length;
  const total = scope.length;
  const q = state.query.trim();
  if (q) {
    el.textContent = `筛出 ${shown} / ${total}`;
    el.classList.add("filtered");
    return;
  }
  if (state.status === "all") {
    el.textContent = `共 ${total} 个站点`;
    el.classList.remove("filtered");
  } else {
    el.textContent = `${STATUS_TEXT[state.status] || ""} ${shown} 个`;
    el.classList.add("filtered");
  }
}

/* ------------------------------------------------------------------ */
/* 行操作：统一分发 + 「⋯」下拉菜单                                      */
/* ------------------------------------------------------------------ */

function runRowAction(act, site) {
  if (act === "edit") return openForm(site);
  if (act === "delete") {
    if (!confirm(`确认删除「${site.name}」？该操作不可撤销。`)) return;
    return removeSite(site);
  }
  if (act === "probe") return runProbe(site);
  if (act === "probe-detail") return openProbeDetail(site.id);
  if (act === "sync-models") return syncSiteModels(site);
  if (act === "approve") return review([site.id], "approve", "审核通过");
  if (act === "reset") return review([site.id], "reset", "重新进入待审核");
  if (act === "reject") return openReject([site.id], site.name);
}

function rowMenuItems(site) {
  const hasKey = Boolean(site.apiKey);
  const items = [
    { act: "probe", label: "实测", hint: "发真实请求，重算五维" },
    { act: "probe-detail", label: "实测详情", hint: site.probe && site.probe.at ? relTime(site.probe.at) + " · 逐次请求明细" : "还没有实测记录", disabled: !(site.probe && site.probe.at) },
    { act: "sync-models", label: "同步模型目录", hint: hasKey ? "用已存 Key 重拉模型清单" : "先在编辑里填 API Key", disabled: !hasKey }
  ];
  if (site.status !== "published") items.push({ act: "approve", label: "通过", hint: "上线到前台榜单", sep: true, tone: "ok" });
  if (site.status !== "rejected") items.push({ act: "reject", label: "驳回并删除", hint: "记录驳回原因后从列表移除", sep: site.status === "published", tone: "bad" });
  if (site.status === "published" || site.status === "rejected") items.push({ act: "reset", label: "回待审", hint: "重新进入审核队列" });
  items.push({ act: "delete", label: "删除", hint: "不可撤销", sep: true, tone: "danger" });
  return items;
}


async function syncSiteModels(site) {
  try {
    toast(`正在用已存 Key 拉取 ${site.domain} 的模型目录…`);
    const data = await api(`/api/admin/sites/${site.id}/model-catalog`, { method: "POST", body: {} });
    if (!data.ok) return toast(data.error || "没拿到模型目录", true);
    await loadSites();
    toast(`${site.name} 同步到 ${data.modelsCount} 个模型`);
  } catch (e) {
    toast(e.message, true);
  }
}

let menuOwner = null;

function closeRowMenu() {
  const menu = document.getElementById("row-menu");
  if (menu) menu.remove();
  if (menuOwner) menuOwner.setAttribute("aria-expanded", "false");
  menuOwner = null;
}

/* ---------------- 实时检测窗口 ---------------- */

const DIM_ZH = { reach: "连通", catalog: "目录", chat: "补全", stream: "流式", concurrent: "并发" };

function renderProbeLive(p, t0) {
  const total = p.total || 28;
  const pct = Math.min(100, Math.round((p.done / total) * 100));
  const fill = $("#pl-fill");
  if (fill) fill.style.width = pct + "%";
  const count = $("#pl-count");
  if (count) count.textContent = `${p.done} / ${total}`;
  const dim = $("#pl-dim");
  if (dim) dim.textContent = p.state === "queued" ? "排队中…" : DIM_ZH[p.dim] || "启动中";
  const time = $("#pl-time");
  if (time) time.textContent = ((Date.now() - (p.startedAt || t0)) / 1000).toFixed(1) + "s";

  const log = (p.log || []).slice(-14).reverse();
  const box = $("#pl-log");
  if (!box) return;
  box.innerHTML = log.length
    ? log
        .map(
          (x) => `<div class="pl-row ${x.ok ? "ok" : "bad"}">
            <span class="pl-d">${DIM_ZH[x.dim] || x.dim}</span>
            <span class="pl-n">#${x.n}</span>
            <span class="pl-ms">${x.ms === null || x.ms === undefined ? "—" : Math.round(x.ms) + "ms"}</span>
            <span class="pl-r">${x.ok ? "达标" : "未达标"}</span>
            <span class="pl-note">${esc(x.note || "")}</span>
          </div>`
        )
        .join("")
    : `<p class="pl-idle">${p.state === "queued" ? "队列里还有别的检测，马上开始…" : "正在发第一个请求…"}</p>`;
}

function ensureProbeModal() {
  if ($("#probe-modal")) return;
  const box = document.createElement("div");
  box.className = "modal";
  box.id = "probe-modal";
  box.hidden = true;
  box.innerHTML =
    '<div class="modal-mask" data-close="1"></div>' +
    '<div class="modal-card wide">' +
    '<header class="modal-head"><h2 id="probe-title">实测详情</h2><button class="icon-btn" type="button" data-close="1" aria-label="关闭">✕</button></header>' +
    '<div class="modal-body" id="probe-body"></div>' +
    '<footer class="modal-foot"><button class="btn ghost" type="button" data-close="1">关闭</button><button class="btn primary" type="button" id="probe-rerun">再测一次</button></footer>' +
    "</div>";
  document.body.appendChild(box);
  box.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeAllModals));
  box.querySelector("#probe-rerun").addEventListener("click", () => {
    const site = state.sites.find((s) => s.id === state.probeSite);
    closeAllModals();
    if (site) runProbe(site);
  });
}

function openProbeLive(site) {
  ensureProbeModal();
  state.probeSite = site.id;
  $("#probe-title").textContent = "正在检测 · " + site.name;
  $("#probe-body").innerHTML = `<div class="pl-head">
      <div class="pl-bar"><i id="pl-fill"></i></div>
      <div class="pl-stat">
        <span id="pl-count">0 / 28</span>
        <span id="pl-dim">排队中…</span>
        <span id="pl-time">0.0s</span>
      </div>
    </div>
    <div class="pl-log" id="pl-log"><p class="pl-idle">正在连接…</p></div>`;
  $("#probe-modal").hidden = false;
  $("#probe-rerun").disabled = true;
}

async function watchProbe(site, before, t0) {
  let finished = false;
  const tick = async () => {
    if (finished) return true;
    let probe = null;
    try {
      const data = await api("/api/admin/probes");
      probe = (data.probes || []).find((x) => x.siteId === site.id) || null;
    } catch {
      /* 单次失败下一轮再试 */
    }
    if (probe) {
      renderProbeLive(probe, t0);
      return false;
    }
    if (Date.now() - t0 < 4000) {
      renderProbeLive({ done: 0, total: 28, state: "queued", log: [] }, t0);
      return false;
    }
    await loadSites();
    const fresh = state.sites.find((x) => x.id === site.id);
    if (fresh && fresh.probe && fresh.probe.at !== before) {
      finished = true;
      $("#probe-rerun").disabled = false;
      openProbeDetail(site.id);
      toast(`${site.name} 检测完成：${fmt(fresh.score)} 分 ${fresh.grade}`);
      return true;
    }
    if (Date.now() - t0 > 300000) {
      finished = true;
      $("#probe-rerun").disabled = false;
      toast("检测超时，刷新页面看结果", true);
      return true;
    }
    return false;
  };

  await tick();
  const timer = setInterval(async () => {
    if (await tick()) clearInterval(timer);
  }, 900);
}
/* ---------------- 实测详情 ---------------- */

function evidenceRows(list, kind) {
  if (!list || !list.length) return `<tr><td colspan="4" class="pe-empty">没有采样记录</td></tr>`;
  return list
    .map((s) => {
      const ms = s.ms === null || s.ms === undefined ? "—" : Math.round(s.ms) + "ms";
      const label = kind === "concurrent" ? `${s.width} 路` : `#${s.n}`;
      const note = s.note || (kind === "concurrent" ? `${s.passed}/${s.width} 成功` : "—");
      return `<tr class="${s.ok ? "ok" : "bad"}">
        <td class="pe-n">${label}</td>
        <td class="num">${ms}</td>
        <td class="pe-flag">${s.ok ? "达标" : "未达标"}</td>
        <td class="pe-note-cell">${esc(note)}</td>
      </tr>`;
    })
    .join("");
}

function renderProbeDetail(site) {
  const p = site.probe;
  const ev = p.evidence || {};
  const sla = p.sla || {};
  const details = p.details || {};
  const total = Object.keys(ev).reduce((a, k) => a + (Array.isArray(ev[k]) ? ev[k].length : 0), 0);

  const meta = [
    ["实测时间", new Date(p.at).toLocaleString("zh-CN", { hour12: false })],
    ["总耗时", (p.durationMs / 1000).toFixed(1) + "s"],
    ["目标地址", p.base || "—"],
    ["实测模型", details.model || "—"],
    ["采样总数", String(total)],
    ["综合评分", fmt(site.score) + " · " + site.grade]
  ]
    .map(([k, v]) => `<div><span>${k}</span><b>${esc(String(v))}</b></div>`)
    .join("");

  if (!total) {
    return `<div class="pe-meta">${meta}</div><p class="pe-tip">这次实测发生在旧版本，只存了汇总数字，没有逐次请求记录。点下方「再测一次」重新采样即可看到每一次的耗时与判定。</p>`;
  }

  const dims = DIMS.map((d) => {
    const list = Array.isArray(ev[d.key]) ? ev[d.key] : [];
    const ok = list.filter((x) => x.ok).length;
    const score = site.dims ? site.dims[d.key] : null;
    const line = details[d.key] || "";
    const slaText = sla[d.key] ? `SLA ${sla[d.key]}ms` : "无阈值";
    return `<section class="pe-dim">
      <header>
        <b>${d.label}</b>
        <span class="pe-score">${score === null || score === undefined ? "未测" : score + "%"}</span>
        <em>达标 ${ok}/${list.length} · ${slaText}</em>
      </header>
      <p class="pe-line">${esc(line)}</p>
      <table class="pe-table">
        <thead><tr><th>样本</th><th>耗时</th><th>判定</th><th>说明</th></tr></thead>
        <tbody>${evidenceRows(list, d.key)}</tbody>
      </table>
    </section>`;
  }).join("");

  const raw = `<details class="pe-raw"><summary>原始数据（JSON）</summary><pre>${esc(
    JSON.stringify(
      { dims: site.dims, probe: { at: p.at, durationMs: p.durationMs, base: p.base, sla: p.sla, details: p.details, metrics: p.metrics } },
      null,
      2
    )
  )}</pre></details>`;

  return `<div class="pe-meta">${meta}</div><div class="pe-dims">${dims}</div>${raw}`;
}

function openProbeDetail(id) {
  ensureProbeModal();
  const site = state.sites.find((s) => s.id === id);
  if (!site || !site.probe) {
    toast("这个站点还没有实测记录", true);
    return;
  }
  state.probeSite = id;
  $("#probe-title").textContent = "实测详情 · " + site.name;
  $("#probe-body").innerHTML = renderProbeDetail(site);
  $("#probe-modal").hidden = false;
}
function openRowMenu(btn) {
  const sameBtn = menuOwner === btn;
  closeRowMenu();
  if (sameBtn) return;

  const site = state.sites.find((s) => s.id === btn.dataset.more);
  if (!site) return;

  const menu = document.createElement("div");
  menu.className = "row-menu";
  menu.id = "row-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML =
    `<div class="row-menu-head"><strong>${esc(site.name)}</strong><small>${esc(site.domain)}</small></div>` +
    rowMenuItems(site)
      .map(
        (it) =>
          `<button type="button" role="menuitem" class="row-menu-item${it.sep ? " sep" : ""}${it.tone ? " " + it.tone : ""}" data-menu-act="${it.act}" data-id="${site.id}"${it.disabled ? " disabled" : ""}>` +
          `<span>${it.label}</span><small>${it.hint}</small></button>`
      )
      .join("");
  document.body.appendChild(menu);

  // fixed 定位：表格容器有 overflow，绝对定位会被裁掉
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = r.right - mw;
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-menu-act]");
    if (!item || item.disabled) return;
    const target = state.sites.find((s) => s.id === item.dataset.id);
    closeRowMenu();
    if (target) runRowAction(item.dataset.menuAct, target);
  });

  btn.setAttribute("aria-expanded", "true");
  menuOwner = btn;
}

document.addEventListener("click", (e) => {
  if (!menuOwner) return;
  if (e.target.closest("#row-menu") || e.target.closest("[data-more]")) return;
  closeRowMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeRowMenu();
});
window.addEventListener("resize", closeRowMenu);
document.querySelector(".table-scroll")?.addEventListener("scroll", closeRowMenu, { passive: true });

async function runProbe(site) {
  const before = site.probe && site.probe.at;
  try {
    openProbeLive(site);
    await api(`/api/admin/sites/${site.id}/probe`, { method: "POST", body: {} });
    watchProbe(site, before, Date.now());
  } catch (e) {
    toast(e.message, true);
    $("#probe-rerun").disabled = false;
  }
}

async function runEval(site) {
  if (!site.apiKey) {
    toast("先在编辑弹窗填 API Key，再跑模型评测", true);
    return openForm(site);
  }
  try {
    await api(`/api/admin/sites/${site.id}/eval`, { method: "POST", body: {} });
    toast(`正在评测 ${site.model || site.domain}，约 30-90 秒`);
    const timer = setInterval(async () => {
      await loadSites();
      if (!state.evaling) {
        clearInterval(timer);
        const fresh = state.sites.find((x) => x.id === site.id);
        if (fresh && fresh.modelScore !== null && fresh.modelScore !== undefined) {
          toast(`评测完成：${fresh.modelScore} 分`);
          showEvalDetail(fresh);
        }
      }
    }, 5000);
  } catch (e) {
    toast(e.message, true);
  }
}

function showEvalDetail(site) {
  const ev = site.modelEval;
  const box = $("#eval-body");
  $("#eval-title").textContent = `模型评测 · ${site.name}`;
  const rawEvals = site.modelEvals;
  const multi = (
    Array.isArray(rawEvals)
      ? rawEvals
      : rawEvals && typeof rawEvals === "object"
        ? Object.values(rawEvals)
            .filter((r) => r && r.ok)
            .map((r) => ({
              model: r.model,
              score: r.score,
              ttft: r.perf ? r.perf.ttft : null,
              tps: r.perf ? r.perf.tps : null,
              passed: r.ability ? r.ability.pass : null,
              total: r.ability ? r.ability.total : null,
              ctx: r.context ? r.context.maxVerified : null,
              thinking: r.thinking ? r.thinking.share : 0
            }))
        : []
  ).slice().sort((a, b) => b.score - a.score);
  const multiTable = multi.length > 1
    ? `<h4 class="eval-h">全部模型（按总分） · ${multi.length} 个</h4>
      <table class="eval-table"><thead><tr>
        <th>模型</th><th class="num">总分</th><th class="num">TTFT</th><th class="num">tok/s</th>
        <th class="num">能力</th><th class="num">上下文</th><th class="num">思考占比</th>
      </tr></thead><tbody>
      ${multi.map((m) => `<tr class="${m.score >= 90 ? "ok" : m.score >= 75 ? "" : "bad"}">
        <td>${esc(m.model)}</td>
        <td class="num"><b>${m.score}</b></td>
        <td class="num">${m.ttft ?? "-"}ms</td>
        <td class="num">${m.tps ?? "-"}</td>
        <td class="num">${m.passed ?? "-"}/${m.total ?? "-"}</td>
        <td class="num">${m.ctx ? (m.ctx / 1000).toFixed(0) + "k" : "-"}</td>
        <td class="num">${m.thinking ?? 0}%</td>
      </tr>`).join("")}
      </tbody></table>`
    : "";
  if (!ev) {
    box.innerHTML = `<p class="empty">这个站点还没有评测数据。填好 API Key 后点「评测」。</p>`;
  } else {
    const p = ev.perf || {};
    const ab = ev.ability || {};
    const ctx = ev.context || {};
    const parts = ev.parts || {};
    const catRows = (ab.byCat || [])
      .map((c) => `<tr><td>${esc(c.cat)}</td><td class="num">${c.pass}/${c.total}</td><td class="num">${c.rate}%</td></tr>`)
      .join("");
    const lvRows = (ctx.levels || [])
      .map(
        (l) =>
          `<tr><td class="num">${l.level}</td><td>${l.ok ? (l.found ? "✅ 捞出 needle" : "❌ 捞不回") : "⚠️ " + esc(String(l.error || l.status || "").slice(0, 40))}</td><td class="num">${l.got ? esc(String(l.got).slice(0, 20)) : "—"}</td></tr>`
      )
      .join("");
    box.innerHTML = multiTable + `
      <div class="eval-head">
        <div><span class="eval-k">模型</span><b>${esc(ev.model || "")}</b></div>
        <div><span class="eval-k">总分</span><b class="eval-total">${ev.score}</b></div>
        <div><span class="eval-k">评测时间</span><span>${new Date(ev.at).toLocaleString("zh-CN", { hour12: false })}</span></div>
        <div><span class="eval-k">耗时</span><span>${Math.round((ev.durationMs || 0) / 1000)} 秒</span></div>
      </div>
      <div class="eval-parts">
        <div class="eval-part"><span>性能 20%</span><b>${parts.perf ?? "-"}</b><small>TTFT ${p.ttft ?? "-"}ms · ${p.tps ?? "-"} tok/s · 抖动 ${p.jitter ?? "-"}</small></div>
        <div class="eval-part"><span>能力 60%</span><b>${parts.ability ?? "-"}</b><small>${ab.pass ?? 0}/${ab.total ?? 0} 题通过</small></div>
        <div class="eval-part"><span>上下文 20%</span><b>${parts.context ?? "-"}</b><small>已验证 ${ctx.maxVerified ?? 0} tokens</small></div>
      </div>
      ${ev.thinking && ev.thinking.total ? `<p class="eval-note warn">推理开销：思考 ${ev.thinking.total} / 输出 ${ev.thinking.completion} tokens，占 ${ev.thinking.share}%。这部分用户看不见，但照样计费。</p>` : ""}
      <h4 class="eval-h">分类正确率</h4>
      <table class="eval-table"><thead><tr><th>类别</th><th class="num">通过</th><th class="num">正确率</th></tr></thead><tbody>${catRows}</tbody></table>
      <h4 class="eval-h">上下文真实性</h4>
      <p class="eval-note">${esc(ctx.note || "")}</p>
      <table class="eval-table"><thead><tr><th class="num">输入 tokens</th><th>结果</th><th class="num">回答</th></tr></thead><tbody>${lvRows || `<tr><td colspan="3" class="empty">无数据</td></tr>`}</tbody></table>
      <h4 class="eval-h">逐题明细</h4>
      <table class="eval-table"><thead><tr><th>题目</th><th>结果</th><th>回答</th><th class="num">耗时</th></tr></thead><tbody>
        ${(ev.items || [])
          .map(
            (it) =>
              `<tr class="${it.pass ? "ok" : "bad"}"><td>${esc(it.id)}</td><td>${it.pass ? "✅" : "❌"}</td><td class="eval-got">${esc(String(it.got || "").slice(0, 60))}</td><td class="num">${Math.round(it.ms || 0)}ms</td></tr>`
          )
          .join("")}
      </tbody></table>`;
  }
  $("#eval-modal").hidden = false;
}

async function runProbeAll() {
  try {
    const r = await api("/api/admin/probe-all", { method: "POST", body: {} });
    toast(`已排入 ${r.queued} 个站点，串行实测中`);
    const timer = setInterval(async () => {
      await loadSites();
      const left = state.probing || 0;
      if (left <= 0) {
        clearInterval(timer);
        toast("全部实测完成");
      }
    }, 4000);
  } catch (e) {
    toast(e.message, true);
  }
}

function reviewBulk(action) {
  const ids = Array.from(state.selected);
  if (!ids.length) return toast("先勾选记录", true);
  if (action === "reject") return openReject(ids, `${ids.length} 个站点`, true);
  return review(ids, "approve", "批量审核通过");
}

async function review(ids, action, reason) {
  try {
    if (ids.length === 1) {
      await api(`/api/admin/sites/${ids[0]}/review`, { method: "POST", body: { action, reason } });
    } else {
      await api("/api/admin/reviews/bulk", { method: "POST", body: { ids, action, reason } });
    }
    state.selected.clear();
    toast(`已${ACTION_TEXT[action]} ${ids.length} 条`);
    await loadSites();
    await loadReviews();
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(err.message, true);
  }
}

async function removeSite(site) {
  try {
    await api(`/api/admin/sites/${site.id}`, { method: "DELETE" });
    state.selected.delete(site.id);
    toast(`已删除「${site.name}」`);
    await loadSites();
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(err.message, true);
  }
}

/* 驳回即删除：先写一条驳回记录留在审核流水里，再把站点从库里摘掉 */
async function rejectAndRemove(ids, reason) {
  let done = 0;
  for (const id of ids) {
    try {
      await api(`/api/admin/sites/${id}/review`, { method: "POST", body: { action: "reject", reason } });
    } catch (err) {
      if (err.status === 401) return showLogin();
    }
    try {
      await api(`/api/admin/sites/${id}`, { method: "DELETE" });
      done += 1;
    } catch (err) {
      if (err.status === 401) return showLogin();
    }
  }
  state.selected.clear();
  toast(done ? `已驳回并删除 ${done} 条` : "驳回失败，站点仍保留", !done);
  await loadSites();
  await loadReviews();
}

/* ---------------- 表单 ---------------- */

/* ---------------- 支持模型多选 ---------------- */

const MODEL_PRESETS = [
  "gpt-4o", "gpt-4o-mini", "gpt-4.1", "o1", "o3-mini",
  "claude-3.7-sonnet", "claude-3.5-sonnet", "claude-3-opus",
  "gemini-2.5-pro", "gemini-2.0-flash",
  "deepseek-v3", "deepseek-v3.1", "deepseek-r1",
  "qwen-max", "qwen2.5-72b",
  "glm-4.5", "glm-4-plus",
  "kimi-k2", "moonshot-v1-128k",
  "doubao-pro-32k", "grok-3", "grok-2",
  "llama-3.3-70b", "mistral-large"
];

let selectedModels = [];
let catalogModels = [];

function renderModelChips(tags = []) {
  selectedModels = (tags || []).map((t) => String(t).trim()).filter(Boolean);
  drawModelChips();
}

function drawModelChips() {
  const box = $("#model-chips");
  /* 只显示真实拉到的目录，没有目录就空着 */
  const all = Array.from(new Set(catalogModels));
  box.innerHTML = all
    .map((m) => `<button type="button" class="chip${selectedModels.includes(m) ? " on" : ""}" data-model="${esc(m)}">${esc(m)}</button>`)
    .join("");
  $("#f-tags").value = selectedModels.join(", ");
  $("#model-count").textContent = `已选 ${selectedModels.length} 个`;
}

$("#model-chips").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  const m = btn.dataset.model;
  const i = selectedModels.indexOf(m);
  if (i >= 0) selectedModels.splice(i, 1);
  else selectedModels.push(m);
  drawModelChips();
});


/* 用访问地址 + API Key 拉该站真实模型，填完 Key 自动触发 */
let catalogTimer = null;
let lastCatalogSig = "";

async function fetchAdminCatalog(opts = {}) {
  const hint = $("#f-model-hint");
  /* 探测地址优先，没填才用访问地址 */
  const url = (($("#f-evalbase")?.value || "").trim() || ($("#f-url").value || "").trim());
  const typed = ($("#f-apikey")?.value || "").trim();
  if (!url) {
    hint.className = "picker-hint bad";
    hint.textContent = "先填访问地址或探测地址";
    return;
  }
  if (!typed && !state.editing) {
    hint.className = "picker-hint bad";
    hint.textContent = "填上 API Key 才能拉取该站真实模型";
    return;
  }
  const sig = url + "|" + (typed || "stored:" + state.editing);
  if (opts.auto && sig === lastCatalogSig) return;
  lastCatalogSig = sig;
  const btn = $("#f-fetch-models");
  btn.disabled = true;
  btn.textContent = "拉取中…";
  hint.className = "picker-hint";
  hint.textContent = "正在请求该站的 /v1/models …";
  try {
    const data = typed
      ? await api("/api/admin/model-catalog", { method: "POST", body: { url, apiKey: typed } })
      : await api(`/api/admin/sites/${state.editing}/model-catalog`, { method: "POST", body: {} });
    if (!data.ok) {
      lastCatalogSig = "";
      hint.className = "picker-hint bad";
      hint.textContent = data.error || "没有拿到模型目录";
      return;
    }
    catalogModels = data.models || [];
    selectedModels = catalogModels.slice();
    drawModelChips();
    hint.className = "picker-hint ok";
    hint.textContent = typed
      ? (data.total > catalogModels.length
        ? `该站共 ${data.total} 个模型，展示前 ${catalogModels.length} 个，已全部勾选`
        : `拿到 ${data.total ?? catalogModels.length} 个模型，已全部勾选，点一下可取消`)
      : `用已存 Key 拿到 ${data.total ?? catalogModels.length} 个模型，已全部勾选，保存后写入`;
  } catch (e) {
    lastCatalogSig = "";
    hint.className = "picker-hint bad";
    hint.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "获取模型目录";
  }
}

$("#f-fetch-models").addEventListener("click", () => fetchAdminCatalog());

function scheduleCatalog() {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(() => fetchAdminCatalog({ auto: true }), 700);
}

$("#f-apikey").addEventListener("input", scheduleCatalog);
$("#f-apikey").addEventListener("blur", () => fetchAdminCatalog({ auto: true }));
$("#f-url").addEventListener("change", () => fetchAdminCatalog({ auto: true }));
$("#f-evalbase")?.addEventListener("change", () => fetchAdminCatalog({ auto: true }));

$("#model-custom").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const v = e.target.value.trim();
  if (!v) return;
  if (!catalogModels.includes(v)) catalogModels.push(v);
  if (!selectedModels.includes(v)) selectedModels.push(v);
  e.target.value = "";
  drawModelChips();
});

function openForm(site = null) {
  state.editing = site ? site.id : null;
  $("#site-modal-title").textContent = site ? `编辑：${site.name}` : "新增站点";
  $("#site-error").hidden = true;

  $("#f-name").value = site?.name || "";
  $("#f-url").value = site?.url || "";
  const evalEl = $("#f-evalbase");
  if (evalEl) evalEl.value = site?.evalBaseUrl || "";
  $("#f-note").value = site?.note || "";
  const keyEl = $("#f-apikey");
  if (keyEl) {
    keyEl.value = "";
    keyEl.placeholder = site?.apiKey ? "已配置，留空则保持不变" : "sk-…";
  }
  const kindValue = site?.kind === "public" ? "public" : "commercial";
  const kindRadio = document.querySelector(`#f-kind-pick input[value="${kindValue}"]`);
  if (kindRadio) kindRadio.checked = true;
  catalogModels = [];
  lastCatalogSig = "";
  clearTimeout(catalogTimer);
  renderModelChips(site?.tags || []);
  const hint = $("#f-model-hint");
  hint.className = "picker-hint";
  hint.textContent = site?.apiKey ? "已存过 Key，填一个新 Key 会自动拉取真实模型" : "填上 API Key 后自动拉取该站真实模型";

  $("#site-modal").hidden = false;
  if (site && site.apiKey) {
    setTimeout(() => fetchAdminCatalog({ auto: true }), 60);
  }
  setTimeout(() => $("#f-name").focus(), 30);
}

$("#new-btn").addEventListener("click", () => openForm(null));

$("#site-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#site-submit");
  const errBox = $("#site-error");
  errBox.hidden = true;

  const payload = {
    name: $("#f-name").value.trim(),
    url: $("#f-url").value.trim(),
    evalBaseUrl: ($("#f-evalbase")?.value || "").trim(),
    note: $("#f-note").value.trim(),
    tags: $("#f-tags").value.trim(),
    models: selectedModels.length,
    kind: document.querySelector('#f-kind-pick input[name="kind"]:checked')?.value || "commercial"
  };

  const keyInput = ($("#f-apikey")?.value || "").trim();
  if (keyInput) payload.apiKey = keyInput;

  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    let created = null;
    if (state.editing) await api(`/api/admin/sites/${state.editing}`, { method: "PUT", body: payload });
    else created = await api("/api/admin/sites", { method: "POST", body: payload });

    $("#site-modal").hidden = true;
    toast(state.editing ? "已保存修改" : `已创建「${payload.name}」，正在实测五维…`);
    await loadSites();
    await loadReviews();

    if (created && created.site && created.site.id) probeAndWait(created.site.id);
  } catch (err) {
    if (err.status === 401) return showLogin();
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
});

/* 新建后等待服务端自动实测出分 */
async function probeAndWait(id, tries = 24) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    await loadSites();
    const site = state.sites.find((s) => s.id === id);
    if (site && site.probe && site.probe.at) {
      const d = site.dims || {};
      toast(
        `实测完成：连通 ${Math.round(d.reach)}% · 目录 ${Math.round(d.catalog)}% · 补全 ${Math.round(d.chat)}% · 流式 ${Math.round(d.stream)}% · 并发 ${Math.round(d.concurrent)}%（均为 SLA 内达标率）`
      );
      return;
    }
  }
  toast("实测超时，稍后刷新查看结果", true);
}



/* ---------------- 驳回 ---------------- */

function openReject(ids, label, isBulk = false) {
  state.rejectTargets = ids;
  state.bulkAction = isBulk ? "reject" : "";
  $("#reject-target").textContent = `目标：${label}`;
  $("#reject-reason").value = "";
  $("#reject-modal").hidden = false;
  setTimeout(() => $("#reject-reason").focus(), 30);
}

$("#reject-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const reason = $("#reject-reason").value.trim() || "审核驳回";
  const ids = state.rejectTargets;
  $("#reject-modal").hidden = true;
  state.bulkAction = "";
  await rejectAndRemove(ids, reason);
});

/* ---------------- 批量导入 ---------------- */

$("#import-btn").addEventListener("click", () => {
  $("#import-note").hidden = true;
  $("#import-text").value = "";
  $("#import-modal").hidden = false;
});

$$("#import-format .seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.importFormat = btn.dataset.format;
    $$("#import-format .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("#import-hint").textContent =
      state.importFormat === "json"
        ? "粘贴 JSON 数组，字段：name, domain, url, note, tags, models, issues, down, dims{reach, catalog, chat, stream, concurrent}（五维都是成功率 %）"
        : "首行表头，逗号分隔：name,domain,url,note,tags,models,issues,down,reach,catalog,chat,stream,concurrent（tags 用 | 分隔）";
  })
);

$("#import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = $("#import-note");
  note.hidden = true;

  try {
    const data = await api("/api/admin/import", {
      method: "POST",
      body: {
        format: state.importFormat,
        text: $("#import-text").value,
        publish: $("#import-publish").checked
      }
    });

    note.textContent = `导入完成：成功 ${data.created} 条，跳过 ${data.skipped.length} 条${data.skipped.length ? "（" + data.skipped.slice(0, 3).map((s) => s.reason).join("；") + "）" : ""}`;
    note.className = "form-note ok";
    note.hidden = false;
    await loadSites();
    await loadReviews();
  } catch (err) {
    note.textContent = err.message;
    note.className = "form-note";
    note.hidden = false;
  }
});

$("#export-btn").addEventListener("click", () => {
  window.location.href = "/api/admin/export";
});

/* ---------------- 日志 ---------------- */

async function loadReviews() {
  try {
    const data = await api("/api/admin/reviews");
    const list = $("#log-list");
    if (!data.reviews.length) {
      list.innerHTML = `<li class="empty">暂无记录</li>`;
      return;
    }
    list.innerHTML = data.reviews
      .slice(0, 60)
      .map(
        (r) => `<li>
          <span class="log-act ${r.action}">${ACTION_TEXT[r.action] || r.action}</span>
          <strong>${esc(r.siteName)}</strong>
          <span class="log-reason">${esc(r.reason || "—")}</span>
          <span class="log-time">${new Date(r.at).toLocaleString("zh-CN", { hour12: false })}</span>
        </li>`
      )
      .join("");
  } catch (err) {
    if (err.status === 401) return showLogin();
  }
}

$("#refresh-reviews").addEventListener("click", loadReviews);

/* ---------------- 自动实测 ---------------- */

function fmtDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function renderAutoProbe(status, review) {
  if (!status) return;
  state.autoProbe = status;
  $("#auto-enabled").checked = Boolean(status.enabled);
  const interval = String(status.intervalMinutes || 60);
  if (!$("#auto-interval").querySelector(`option[value="${interval}"]`)) {
    $("#auto-interval").insertAdjacentHTML("beforeend", `<option value="${interval}">每 ${interval} 分钟</option>`);
  }
  $("#auto-interval").value = interval;
  $("#auto-scope").value = status.scope === "all" ? "all" : "published";
  $("#auto-key-only").checked = status.requireApiKey !== false;

  const rev = review || status.autoReview || {};
  if ($("#review-enabled")) $("#review-enabled").checked = rev.enabled !== false;
  if ($("#review-min-score")) $("#review-min-score").value = rev.minScore ?? 75;
  if ($("#review-min-dim")) $("#review-min-dim").value = rev.minDim ?? 60;
  if ($("#review-min-dims")) $("#review-min-dims").value = String(rev.minDims ?? 5);

  const stateText = status.running
    ? `正在实测 ${status.progress?.length ? status.progress.map((p) => p.name).join("、") : "队列中"}`
    : status.enabled
      ? status.targets
        ? "自动实测已开启"
        : "自动实测已开启（暂无可测站点）"
      : "自动实测已关闭";
  const el = $("#auto-status");
  el.textContent = stateText;
  el.className = "auto-status" + (status.running ? " running" : status.enabled ? " on" : " off");

  const parts = [];
  parts.push(`上次实测：${status.lastRunAt ? fmtDateTime(status.lastRunAt) : "还没有执行"}`);
  parts.push(`下次执行：${status.enabled ? fmtDateTime(status.nextRunAt) : "—"}`);
  parts.push(`可测站点：${status.targets} 个`);
  if (status.skipped) parts.push(`跳过未配置 Key：${status.skipped} 个`);
  if (!status.targets && status.skipped && status.requireApiKey !== false) {
    parts.push("提示：先在站点编辑里填 API Key，或取消勾选「只测有 API Key 的站点」");
  }
  if (status.lastFinishedAt && status.lastSummary) {
    const sum = status.lastSummary;
    parts.push(
      `上次完成：${fmtDateTime(status.lastFinishedAt)}（${sum.total} 个站点，成功 ${sum.ok} 个，耗时 ${Math.round((sum.durationMs || 0) / 1000)} 秒）`
    );
  }
  $("#auto-meta").textContent = parts.join(" · ");
  $("#auto-run").disabled = !status.targets || status.running;
}

async function loadAutoProbe() {
  try {
    const data = await api("/api/admin/settings");
    renderAutoProbe(data.autoProbe, data.autoReview);
  } catch (err) {
    if (err.status === 401) return showLogin();
  }
}

async function loadSettings() {
  await loadAutoProbe();
}

$("#auto-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/admin/settings/auto-probe", {
      method: "POST",
      body: {
        enabled: $("#auto-enabled").checked,
        intervalMinutes: Number($("#auto-interval").value),
        scope: $("#auto-scope").value,
        requireApiKey: $("#auto-key-only").checked,
        reviewEnabled: $("#review-enabled").checked,
        reviewMinScore: Number($("#review-min-score").value),
        reviewMinDim: Number($("#review-min-dim").value),
        reviewMinDims: Number($("#review-min-dims").value)
      }
    });
    renderAutoProbe(data.autoProbe, data.autoReview);
    toast("自动实测与自动审核设置已保存");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#auto-run").addEventListener("click", async () => {
  if (!confirm("立即对当前范围内所有站点发起真实请求实测？")) return;
  try {
    const data = await api("/api/admin/auto-probe/run", { method: "POST" });
    toast(data.message || "已开始实测");
    loadAutoProbe();
    loadSites();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 登录防护 ---------------- */

function renderGuard(data) {
  const body = $("#guard-body");
  if (!body) return;
  const entries = data?.entries || [];
  if (!entries.length) {
    body.innerHTML = `<p class="empty">当前没有被锁定的账号或 IP。连续失败 5 次会自动锁定 15 分钟。</p>`;
    return;
  }
  body.innerHTML = entries
    .map((item) => {
      const kind = item.kind === "ip" ? "IP" : "账号";
      const until = item.locked ? new Date(item.lockedUntil).toLocaleString("zh-CN", { hour12: false }) : "";
      return `<div class="guard-row">
        <div class="guard-main">
          <b>${esc(item.label || "unknown")}</b>
          <span class="guard-kind">${kind}</span>
          <small>${item.locked ? `已锁定至 ${until}（约 ${Math.ceil(item.retryAfterSec / 60)} 分钟）` : `最近失败 ${item.fails} 次`} · 累计触发 ${item.strikes} 次</small>
        </div>
        <button class="btn ghost sm" data-guard-unlock="${esc(item.id)}" type="button">解锁</button>
      </div>`;
    })
    .join("");
}

async function loadGuard() {
  try {
    const data = await api("/api/admin/security/login-guard");
    renderGuard(data);
  } catch (err) {
    if (err.status === 401) return showLogin();
  }
}

$("#guard-refresh").addEventListener("click", loadGuard);
$("#guard-unlock-all").addEventListener("click", async () => {
  if (!confirm("解除全部登录锁定？")) return;
  try {
    await api("/api/admin/security/login-guard/unlock", { method: "POST", body: { all: true } });
    toast("已全部解锁");
    loadGuard();
  } catch (err) {
    toast(err.message, true);
  }
});
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-guard-unlock]");
  if (!btn) return;
  try {
    await api("/api/admin/security/login-guard/unlock", { method: "POST", body: { id: btn.dataset.guardUnlock } });
    toast("已解锁");
    loadGuard();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 密码 ---------------- */

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = $("#pw-note");
  try {
    await api("/api/admin/password", {
      method: "POST",
      body: { current: $("#pw-current").value, password: $("#pw-next").value }
    });
    note.textContent = "密码已更新，其他会话已失效。";
    note.className = "form-note ok";
    note.hidden = false;
    $("#pw-current").value = "";
    $("#pw-next").value = "";
  } catch (err) {
    note.textContent = err.message;
    note.className = "form-note";
    note.hidden = false;
  }
});

/* ---------------- 通用交互 ---------------- */

// 统一关闭所有弹窗：新增弹窗自动生效，不用再逐个补 id
function closeAllModals() {
  $$(".modal").forEach((m) => {
    m.hidden = true;
  });
  closeRowMenu();
}

$$("[data-close]").forEach((el) => el.addEventListener("click", closeAllModals));

$("#probe-rerun")?.addEventListener("click", () => {
  const site = state.sites.find((s) => s.id === state.probeSite);
  closeAllModals();
  if (site) runProbe(site);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllModals();
});

function activateTab(key) {
  state.status = key;
  state.selected.clear();
  $$("#status-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.status === key));
  $$("[data-jump]").forEach((c) => c.classList.toggle("active", c.dataset.jump === key));
  renderTable();
  syncBulk();
}

$("#status-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-status]");
  if (!btn) return;
  activateTab(btn.dataset.status);
});

$("#admin-search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderTable();
});

$("#check-all").addEventListener("change", (e) => {
  const rows = visibleSites();
  if (e.target.checked) rows.forEach((s) => state.selected.add(s.id));
  else state.selected.clear();
  renderTable();
});

$("#bulk-bar").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-bulk]");
  if (!btn) return;
  const action = btn.dataset.bulk;
  if (action === "clear") {
    state.selected.clear();
    renderTable();
    return;
  }
  if (action === "probeAll") return runProbeAll();
  reviewBulk(action);
});

function paintSortMarks() {
  $$("th.sortable").forEach((th) => {
    const key = th.dataset.sort;
    const active = state.sort.key === key;
    let mark = th.querySelector(".sort-mark");
    if (!mark) {
      mark = document.createElement("span");
      mark.className = "sort-mark";
      th.appendChild(mark);
    }
    mark.textContent = active ? (state.sort.dir === 1 ? "▲" : "▼") : "↕";
    th.classList.toggle("sorted", active);
    if (active) th.setAttribute("aria-sort", state.sort.dir === 1 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

function bindSort() {
  $$("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      /* 一次降序、再一次升序、第三次回到默认：按状态分组，组内按名次 */
      if (state.sort.key === key) {
        if (state.sort.dir === -1) state.sort.dir = 1;
        else state.sort = { key: "auto", dir: 1 };
      } else {
        state.sort = { key, dir: key === "score" || key === "updatedAt" || key === "views" ? -1 : 1 };
      }
      renderTable();
      paintSortMarks();
    });
  });
  paintSortMarks();
}

$$("[data-jump]").forEach((card) => {
  card.addEventListener("click", () => activateTab(card.dataset.jump));
});

window.__adminReady = true;
bindSort();

showServerInfo();
boot();


/* 访问量：每小时自动刷新一次，只改数字，不重排表格 */
async function refreshViews() {
  try {
    const data = await api("/api/admin/sites");
    const map = new Map((data.sites || []).map((s) => [s.id, Number(s.views) || 0]));
    state.sites.forEach((s) => {
      if (map.has(s.id)) s.views = map.get(s.id);
    });
    document.querySelectorAll("#admin-body tr[data-site]").forEach((tr) => {
      const v = map.get(tr.dataset.site);
      const cell = tr.querySelector("td.views");
      if (v !== undefined && cell) cell.textContent = String(v);
    });
  } catch {
    /* 下一轮再拉 */
  }
}
setInterval(refreshViews, 60 * 60 * 1000);

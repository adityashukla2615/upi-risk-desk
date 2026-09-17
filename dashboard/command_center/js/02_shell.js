/* =====================================================================================
   02 · app shell — theme, chart tokens, router, global filters, toasts, palette, cases
   ===================================================================================== */
const VIEWS = {};              // name -> { render(sl, s), onLeave?() }
const dirty = new Set();
let activeView = "overview";
let SL = FULL_SLICE, S = FULL; // current slice + its summary

/* ------------------------------------------------------------------ theme + chart tokens */
let theme = document.documentElement.dataset.theme || "dark";
function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
let TK = {};
function readTokens() {
  TK = {
    ink: css("--ink"), ink2: css("--ink-2"), ink3: css("--ink-3"), line: css("--line"), line2: css("--line-2"), grid: css("--grid"),
    panel: css("--panel-solid"), panel3: css("--panel-3"), accent: css("--accent"), accent2: css("--accent-2"),
    s: [1, 2, 3, 4, 5, 6, 7, 8].map(k => css("--s" + k)),
    good: css("--good"), warn: css("--warn"), serious: css("--serious"), crit: css("--crit"),
    seq: [0, 1, 2, 3, 4, 5].map(k => css("--seq-" + k)),
    font: css("--f-body"), mono: css("--f-mono"),
  };
}
readTokens();
function setTheme(t) {
  theme = t;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("upi-cc-theme", t); } catch (e) { /* storage blocked */ }
  readTokens();
  Object.keys(VIEWS).forEach(v => dirty.add(v));
  disposeCharts();
  renderActive();
  if (typeof Copilot !== "undefined") Copilot.rethemeCharts();
}
$("theme-btn").addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));

/* ------------------------------------------------------------------ echarts helpers */
const charts = new Map();
function chart(id) {
  const el = typeof id === "string" ? $(id) : id;
  let c = echarts.getInstanceByDom(el);
  if (!c) { c = echarts.init(el, null, { renderer: "canvas" }); charts.set(el, c); }
  return c;
}
function disposeCharts() { for (const [el, c] of charts) { c.dispose(); charts.delete(el); } }
// resize on the next frame: resizing inside the observer callback triggers "ResizeObserver loop" warnings
const ro = new ResizeObserver(entries => requestAnimationFrame(() => { for (const e of entries) { const c = echarts.getInstanceByDom(e.target); if (c) c.resize(); } }));
function observe(el) { ro.observe(el); }
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
function base(extra = {}) {
  return {
    animationDuration: reduceMotion ? 0 : 600, animationDurationUpdate: reduceMotion ? 0 : 400,
    textStyle: { fontFamily: TK.font, color: TK.ink2 },
    tooltip: {
      backgroundColor: TK.panel, borderColor: TK.line2, borderWidth: 1, padding: [8, 11],
      textStyle: { color: TK.ink, fontSize: 12, fontFamily: TK.font }, extraCssText: "border-radius:10px;box-shadow:0 12px 30px -10px rgba(0,0,0,.45);",
    },
    grid: { left: 8, right: 14, top: 22, bottom: 8, containLabel: true },
    ...extra,
  };
}
const axisCat = (data, extra = {}) => ({ type: "category", data, axisLine: { lineStyle: { color: TK.line2 } }, axisTick: { show: false }, axisLabel: { color: TK.ink3, fontSize: 11 }, ...extra });
const axisVal = (extra = {}) => ({ type: "value", splitLine: { lineStyle: { color: TK.grid } }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: TK.ink3, fontSize: 11 }, ...extra });
const tipRow = (color, label, value) => `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;min-width:160px"><span style="display:inline-flex;gap:6px;align-items:center"><i style="width:8px;height:8px;border-radius:2px;background:${color};display:inline-block"></i>${esc(label)}</span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;
const tipHead = t => `<div style="font-weight:600;margin-bottom:5px">${esc(t)}</div>`;
function fade(hex, a) {
  if (!hex || hex[0] !== "#") return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
const tierColor = t => t === TIER_HIGH ? TK.crit : t === TIER_MED ? TK.warn : TK.good;

/* ------------------------------------------------------------------ pills */
const tierPill = t => t === TIER_HIGH ? `<span class="pill crit"><span class="ic">▲</span>High</span>` : t === TIER_MED ? `<span class="pill warn"><span class="ic">◆</span>Medium</span>` : `<span class="pill good"><span class="ic">●</span>Low</span>`;
const kycPill = k => { const s = D.kyc[k]; return s === "VERIFIED" ? `<span class="pill good">✓ Verified</span>` : s === "REJECTED" ? `<span class="pill crit">✕ Rejected</span>` : s === "NO_KYC_RECORD" ? `<span class="pill serious">? No KYC</span>` : s ? `<span class="pill warn">… ${esc(title(s))}</span>` : `<span class="dim">—</span>`; };
const statusPill = s => s === ST_OK ? `<span class="pill good">Success</span>` : s === ST_FAIL ? `<span class="pill crit">Failed</span>` : `<span class="pill warn">Pending</span>`;
const idLink = (type, i, label) => `<button class="idl" data-open="${type}:${i}">${esc(label)}</button>`;
const mLink = m => idLink("m", m, M.id[m]);
const uLink = u => idLink("u", u, U.id[u]);
const tLink = i => idLink("t", i, txnId(i));
const cLink = j => idLink("c", j, cbId(j));
const kLink = ci => idLink("k", ci, CL[ci].id);
function scoreBar(score, tier) {
  return `<span class="scorebar"><span class="track"><span class="fill" style="width:${clamp(score, 0, 100)}%;background:${tierColor(tier)}"></span></span><b>${score}</b></span>`;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-open]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const [type, i] = b.dataset.open.split(":");
  openEntity({ type, i: +i });
}, true);

/* ------------------------------------------------------------------ router */
function go(view, opts = {}) {
  if (!VIEWS[view]) return;
  if (activeView !== view && VIEWS[activeView]?.onLeave) VIEWS[activeView].onLeave();
  activeView = view;
  $$(".view").forEach(v => v.classList.toggle("active", v.dataset.view === view));
  $$("#nav .rail-btn").forEach(b => { if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  const sec = document.querySelector(`.view[data-view="${view}"]`);
  $("view-title").innerHTML = sec.dataset.title;
  document.title = sec.dataset.title.replace(/&amp;/g, "&") + " · UPI Risk Command Center";
  if (!opts.keepScroll) $("views").scrollTop = 0;
  renderActive();
  writeHash();
}
$("nav").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (b) go(b.dataset.view); });
document.addEventListener("click", e => {
  const g = e.target.closest("[data-goto]");
  if (g) { go(g.dataset.goto); return; }
  const a = e.target.closest("[data-ask]");
  if (a) Copilot.ask(a.dataset.ask, { agent: a.dataset.agent });
});

function renderActive() {
  if (!dirty.has(activeView)) return;
  dirty.delete(activeView);
  try { VIEWS[activeView].render(SL, S); } catch (err) { console.error(err); toast("⚠️", "Render error", String(err.message || err)); }
}

/* ------------------------------------------------------------------ global filters */
const opt = (v, label) => `<option value="${v}">${esc(label)}</option>`;
$("f-period").innerHTML = opt("q", "Whole quarter") + MONTHS.map(ym => opt(ym, monthName(ym) + " " + ym.slice(0, 4))).join("") + opt("l30", "Last 30 days") + opt("l7", "Last 7 days") + opt("custom", "Custom range");
$("f-cat").innerHTML = opt(-1, "All categories") + D.cat.map((c, i) => [c, i]).sort((a, b) => a[0].localeCompare(b[0])).map(([c, i]) => opt(i, c)).join("");
$("f-kyc").innerHTML = opt(-1, "Any KYC") + KYC_ORDER.map(s => D.kyc.indexOf(s)).filter(i => i >= 0).map(i => opt(i, title(D.kyc[i]))).join("");
$("f-st").innerHTML = opt(-1, "Any status") + ["SUCCESS", "FAILED", "PENDING"].map(s => opt(D.status.indexOf(s), title(s))).join("");
function periodOf(f) {
  if (f.from === 0 && f.to === DAYS - 1) return "q";
  const ym = MONTHS.find(m => { const r = monthRange(m); return r[0] === f.from && r[1] === f.to; });
  if (ym) return ym;
  if (f.to === DAYS - 1 && f.from === DAYS - 30) return "l30";
  if (f.to === DAYS - 1 && f.from === DAYS - 7) return "l7";
  return "custom";
}
$("f-period").addEventListener("change", e => {
  const v = e.target.value;
  if (v === "q") setF({ from: 0, to: DAYS - 1 });
  else if (v === "l30") setF({ from: DAYS - 30, to: DAYS - 1 });
  else if (v === "l7") setF({ from: DAYS - 7, to: DAYS - 1 });
  else if (v !== "custom") { const r = monthRange(v); setF({ from: r[0], to: r[1] }); }
  else syncControls();
});
for (const [id, k] of [["f-cat", "cat"], ["f-kyc", "kyc"], ["f-st", "st"]]) $(id).addEventListener("change", e => setF({ [k]: +e.target.value }));
$("f-disp").addEventListener("change", e => setF({ disp: e.target.checked ? 1 : 0 }));
$("f-reset").addEventListener("click", () => setF({ ...F0 }, true));

function setF(patch, replace = false) {
  F = replace ? { ...F0, ...patch } : { ...F, ...patch };
  for (const k of ["from", "to"]) F[k] = clampDay(F[k]);
  if (F.from > F.to) [F.from, F.to] = [F.to, F.from];
  SL = isFiltered(F) ? slice(F) : FULL_SLICE;
  S = isFiltered(F) ? summarize(SL) : FULL;
  Object.keys(VIEWS).forEach(v => dirty.add(v));
  syncControls();
  renderChips();
  renderActive();
  writeHash();
}
function syncControls() {
  $("f-period").value = periodOf(F);
  $("f-cat").value = String(F.cat); $("f-kyc").value = String(F.kyc); $("f-st").value = String(F.st);
  $("f-disp").checked = !!F.disp;
  $("f-period").classList.toggle("on", F.from !== 0 || F.to !== DAYS - 1);
  for (const [id, k] of [["f-cat", "cat"], ["f-kyc", "kyc"], ["f-st", "st"]]) $(id).classList.toggle("on", F[k] >= 0);
}
const CHIPS = [
  ["Dates", f => f.from !== 0 || f.to !== DAYS - 1, f => f.from === f.to ? dayFmt(f.from) : `${dayFmt(f.from)} – ${dayFmt(f.to)}`, { from: 0, to: DAYS - 1 }],
  ["Category", f => f.cat >= 0, f => D.cat[f.cat], { cat: -1 }],
  ["KYC", f => f.kyc >= 0, f => title(D.kyc[f.kyc]), { kyc: -1 }],
  ["Status", f => f.st >= 0, f => title(D.status[f.st]), { st: -1 }],
  ["Only", f => !!f.disp, () => "Disputed payments", { disp: 0 }],
  ["Reason", f => f.rs >= 0, f => title(D.reason[f.rs]), { rs: -1 }],
  ["Severity", f => f.sv >= 0, f => title(D.sev[f.sv]), { sv: -1 }],
  ["Hour", f => f.hr >= 0, f => `${hh(f.hr)}:00–${hh(f.hr)}:59`, { hr: -1 }],
  ["Weekday", f => f.dow >= 0, f => DOW[f.dow], { dow: -1 }],
  ["Merchant", f => f.mch >= 0, f => M.id[f.mch], { mch: -1 }],
  ["Customer", f => f.usr >= 0, f => U.id[f.usr], { usr: -1 }],
];
function renderChips() {
  const on = CHIPS.map((c, i) => [c, i]).filter(([c]) => c[1](F));
  $("chipbar").innerHTML = on.length ? `<span class="slice-note"><b>${int(S.n)}</b> of ${int(FULL.n)} payments · <b>${int(S.cbs)}</b> of ${int(FULL.cbs)} complaints</span>` +
    on.map(([[k, , lbl], i]) => `<span class="fchip"><span class="k">${k}</span>${esc(lbl(F))}<button data-clear="${i}" aria-label="Remove ${k} filter">×</button></span>`).join("") : "";
}
$("chipbar").addEventListener("click", e => { const b = e.target.closest("[data-clear]"); if (b) setF(CHIPS[+b.dataset.clear][3]); });

/* ------------------------------------------------------------------ url hash (shareable views) */
function writeHash() {
  const p = new URLSearchParams();
  if (activeView !== "overview") p.set("view", activeView);
  for (const k in F0) if (F[k] !== F0[k]) p.set(k, k === "from" || k === "to" ? dayIso(F[k]) : String(F[k]));
  const h = p.toString();
  try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch (e) { /* file:// */ }
}
function readHash() {
  const f = { ...F0 };
  let view = "overview";
  try {
    for (const [k, v] of new URLSearchParams(location.hash.slice(1))) {
      if (k === "view" && VIEWS[v]) view = v;
      else if (k === "from" || k === "to") { const d = isoDay(v); if (!isNaN(d)) f[k] = clampDay(d); }
      else if (k in F0) { const n = parseInt(v, 10); if (isFinite(n) && n >= -1) f[k] = n; }
    }
  } catch (e) { /* malformed hash */ }
  return { f, view };
}

/* ------------------------------------------------------------------ toasts */
function toast(icon, head, text, ms = 4200) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="i">${icon}</span><b>${esc(head)}</b><span>${text}</span>`;
  $("toasts").appendChild(el);
  while ($("toasts").children.length > 4) $("toasts").firstChild.remove();
  setTimeout(() => { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 320); }, ms);
}

/* ------------------------------------------------------------------ case queue */
const Cases = {
  key: "upi-cc-cases",
  all() { return store.get(this.key, []); },
  save(list) { store.set(this.key, list); this.badge(); dirty.add("cases"); if (activeView === "cases") renderActive(); },
  has(ref) { return this.all().some(c => c.ref === ref); },
  add({ ref, reason, priority = "HIGH", by = "Analyst" }) {
    const list = this.all();
    if (list.some(c => c.ref === ref)) return false;
    list.unshift({ ref, reason: reason || "", priority, by, status: "OPEN", at: new Date().toISOString() });
    this.save(list);
    toast("📌", `${refLabel(ref)} added to cases`, esc(reason || "Pinned for investigation"));
    return true;
  },
  update(ref, patch) { this.save(this.all().map(c => c.ref === ref ? { ...c, ...patch } : c)); },
  remove(ref) { this.save(this.all().filter(c => c.ref !== ref)); },
  badge() { const n = this.all().filter(c => c.status !== "CLOSED").length; $("case-badge").hidden = !n; $("case-badge").textContent = n; },
};
function refLabel(ref) {
  const [t, i] = ref.split(":"), n = +i;
  return t === "m" ? M.id[n] : t === "u" ? U.id[n] : t === "t" ? txnId(n) : t === "c" ? cbId(n) : t === "k" ? CL[n].id : ref;
}
Cases.badge();

/* ------------------------------------------------------------------ command palette */
const Palette = (() => {
  const wrap = $("palette"), input = $("pal-input"), list = $("pal-list");
  let items = [], sel = 0;
  const views = $$(".view").map(v => ({ kind: "view", label: v.dataset.title.replace(/&amp;/g, "&"), view: v.dataset.view }));
  function build(q) {
    const s = q.trim(), out = [];
    const r = resolveId(s);
    if (r) out.push({ kind: "open", label: `Open ${r.id}`, ref: r, hint: "Entity 360" });
    else if (/^(USR|MCH|TXN|CBK|CL)/i.test(s)) {
      const up = s.toUpperCase().replace(/[\s_-]/g, "");
      const pool = up.startsWith("USR") ? U.id : up.startsWith("MCH") ? M.id : up.startsWith("CL") ? CL.map(c => c.id) : [];
      pool.filter(x => x.startsWith(up)).slice(0, 6).forEach(x => out.push({ kind: "open", label: `Open ${x}`, ref: resolveId(x), hint: "Entity 360" }));
    }
    const ql = s.toLowerCase();
    views.filter(v => !ql || v.label.toLowerCase().includes(ql)).forEach(v => out.push({ ...v, hint: "Go to view" }));
    if (ql) {
      D.cat.forEach((c, i) => { if (c.toLowerCase().includes(ql)) out.push({ kind: "filter", label: `Filter to ${c}`, patch: { cat: i }, hint: "Filter" }); });
      MONTHS.forEach(ym => { if (monthName(ym).toLowerCase().includes(ql)) { const r = monthRange(ym); out.push({ kind: "filter", label: `Filter to ${monthName(ym)}`, patch: { from: r[0], to: r[1] }, hint: "Filter" }); } });
      out.push({ kind: "ask", label: `Ask the agents: “${s}”`, q: s, hint: "AI" });
    }
    return out.slice(0, 12);
  }
  function draw() {
    list.innerHTML = items.map((it, k) => `<li role="option" aria-selected="${k === sel}" data-k="${k}"><span class="t">${it.kind === "ask" ? "✦ ask" : it.kind}</span>${esc(it.label)}<span class="h">${esc(it.hint || "")}</span></li>`).join("") || `<li class="dim">No matches</li>`;
  }
  function run(it) {
    close();
    if (!it) return;
    if (it.kind === "view") go(it.view);
    else if (it.kind === "open") openEntity(it.ref);
    else if (it.kind === "filter") setF(it.patch);
    else if (it.kind === "ask") Copilot.ask(it.q);
  }
  function open() { wrap.hidden = false; input.value = ""; items = build(""); sel = 0; draw(); setTimeout(() => input.focus(), 10); }
  function close() { wrap.hidden = true; }
  input.addEventListener("input", () => { items = build(input.value); sel = 0; draw(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") run(items[sel]);
    else if (e.key === "Escape") close();
  });
  list.addEventListener("click", e => { const li = e.target.closest("[data-k]"); if (li) run(items[+li.dataset.k]); });
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
  $("palette-btn").addEventListener("click", open);
  return { open, close, isOpen: () => !wrap.hidden };
})();

/* ------------------------------------------------------------------ keyboard */
const SHORTCUTS = [["Ctrl K  or  /", "Search, jump or ask"], ["Ctrl J", "Open / close the AI agents"], ["1 – 9", "Switch view"], ["R", "Reset filters"], ["T", "Toggle theme"], ["Space", "Play / pause live replay"], ["Esc", "Close panels"], ["?", "This help"]];
$("keys-list").innerHTML = SHORTCUTS.map(([k, v]) => `<div><span>${esc(v)}</span><b>${esc(k)}</b></div>`).join("");
$("keys-btn").addEventListener("click", () => { $("keys").hidden = false; });
$("keys").addEventListener("click", e => { if (e.target === $("keys")) $("keys").hidden = true; });
document.addEventListener("keydown", e => {
  const typing = e.target.closest("input, textarea, select, [contenteditable]");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); Palette.isOpen() ? Palette.close() : Palette.open(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") { e.preventDefault(); Copilot.toggle(); return; }
  if (e.key === "Escape") {
    if (!$("keys").hidden) { $("keys").hidden = true; return; }
    if (Palette.isOpen()) { Palette.close(); return; }
    if (!$("drawer").hidden) { closeDrawer(); return; }
    if (Copilot.isOpen() && !typing) { Copilot.toggle(false); return; }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); Palette.open(); }
  else if (e.key === "?") $("keys").hidden = !$("keys").hidden;
  else if (e.key.toLowerCase() === "r") setF({ ...F0 }, true);
  else if (e.key.toLowerCase() === "t") setTheme(theme === "dark" ? "light" : "dark");
  else if (/^[1-9]$/.test(e.key)) { const b = $$("#nav .rail-btn")[+e.key - 1]; if (b) go(b.dataset.view); }
  else if (e.key === " " && activeView === "stream") { e.preventDefault(); Stream.toggle(); }
});

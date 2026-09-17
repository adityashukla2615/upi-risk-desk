"use strict";
/* =====================================================================================
   01 · data model, formatting, filter slice and aggregation engine
   Everything the views and the agents' tools compute comes from these embedded rows.
   ===================================================================================== */
const DATA = /*__DATA__*/null;
const QUALITY = /*__QUALITY__*/null;
const R = /*__ROWS__*/null;
const K = DATA.kpi, CNT = DATA.counts, D = R.dict;
const T = R.t, CB = R.c, U = R.users, M = R.merchants, CL = R.clusters;
const NT = T.id.length, NC = CB.id.length, NU = U.id.length, NM = M.id.length, DAYS = R.days;
const $ = id => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ formatting (Indian numbering) */
const nf = new Intl.NumberFormat("en-IN");
const inr = v => {
  if (v == null || isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return "₹" + (v / 1e7).toFixed(2) + " Cr";
  if (a >= 1e5) return "₹" + (v / 1e5).toFixed(2) + " L";
  return "₹" + nf.format(Math.round(v));
};
const inrFull = v => v == null || isNaN(v) ? "—" : "₹" + nf.format(Math.round(v));
const pct = (v, d = 1) => v == null || isNaN(v) ? "—" : (v * 100).toFixed(d) + "%";
const int = v => v == null || isNaN(v) ? "—" : nf.format(Math.round(v));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const title = s => String(s ?? "").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\b(Kyc|Utr|Upi|Ivr|Txn)\b/g, w => w.toUpperCase());
const sum = (a, f = x => x) => a.reduce((s, x) => s + (f(x) || 0), 0);
const byKey = (arr, k) => Object.fromEntries(arr.map(r => [r[k], r]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ calendar */
const [SY, SM, SD] = R.start.split("-").map(Number);
const START = Date.UTC(SY, SM - 1, SD);
const dayDate = d => new Date(START + d * 864e5);
const dayIso = d => dayDate(d).toISOString().slice(0, 10);
const isoDay = s => Math.round((Date.parse(String(s).slice(0, 10) + "T00:00:00Z") - START) / 864e5);
const dayFmt = d => d == null ? "—" : dayDate(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const clampDay = d => clamp(d, 0, DAYS - 1);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const START_DOW = dayDate(0).getUTCDay();
const dowOf = d => ((START_DOW + d) % 7 + 7) % 7;
const hourOf = i => T.mi[i] < 0 ? -1 : Math.floor(T.mi[i] / 60);
const hh = h => String(h).padStart(2, "0");
const timeFmt = i => T.mi[i] < 0 ? "—:—" : `${hh(Math.floor(T.mi[i] / 60))}:${hh(T.mi[i] % 60)}`;
const monthOf = d => dayIso(d).slice(0, 7);
const MONTHS = [...new Set(Array.from({ length: DAYS }, (_, d) => monthOf(d)))];
const monthRange = ym => { const days = Array.from({ length: DAYS }, (_, d) => d).filter(d => monthOf(d) === ym); return [days[0], days[days.length - 1]]; };
const monthName = ym => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" });

/* ------------------------------------------------------------------ ids and dictionaries */
const txnId = i => "TXN" + String(T.id[i]).padStart(8, "0");
const cbId = j => "CBK" + String(CB.id[j]).padStart(7, "0");
const catName = c => c >= 0 ? D.cat[c] : "Unknown";
const ST_OK = D.status.indexOf("SUCCESS"), ST_FAIL = D.status.indexOf("FAILED"), ST_PEND = D.status.indexOf("PENDING");
const TIER_LOW = D.tier.indexOf("LOW"), TIER_MED = D.tier.indexOf("MEDIUM"), TIER_HIGH = D.tier.indexOf("HIGH");
const KYC_VER = D.kyc.indexOf("VERIFIED"), KYC_REJ = D.kyc.indexOf("REJECTED"), KYC_NONE = D.kyc.indexOf("NO_KYC_RECORD");
const KYC_ORDER = ["VERIFIED", "PENDING", "IN_REVIEW", "REJECTED", "NO_KYC_RECORD"];
const SEV_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const FRAUD_REASONS = new Set(["ACCOUNT_TAKEOVER", "UNAUTHORIZED_TXN", "FRAUD_SUSPECTED"]);
const NOT_ACTIVE = new Set(["INACTIVE", "CLOSED", "SUSPENDED", "BLOCKED"]);
const MST_NONE = D.mstatus.indexOf("NOT_IN_MASTER");
const sigNames = (mask, dict) => D[dict].filter((_, b) => mask & (1 << b));
const sigPoints = (mask, dict) => D[dict].map((n, b) => [n, R.sigw[dict][b]]).filter((_, b) => mask & (1 << b)).sort((a, b) => b[1] - a[1]);
const prettySignal = s => s.replace(/_/g, " ").replace(/\(≥/g, " (≥").replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ indexes */
const txByU = Array.from({ length: NU }, () => []), txByM = Array.from({ length: NM }, () => []);
for (let i = 0; i < NT; i++) { txByU[T.u[i]].push(i); txByM[T.m[i]].push(i); }
const cbByT = new Map();
for (let j = 0; j < NC; j++) if (CB.t[j] >= 0) { const a = cbByT.get(CB.t[j]); a ? a.push(j) : cbByT.set(CB.t[j], [j]); }
const uCl = new Int16Array(NU).fill(-1), mCl = new Int16Array(NM).fill(-1);
CL.forEach((c, ci) => { c.u.forEach(u => uCl[u] = ci); c.m.forEach(m => mCl[m] = ci); });
const uIndex = new Map(U.id.map((v, i) => [v, i])), mIndex = new Map(M.id.map((v, i) => [v, i]));
const clIndex = new Map(CL.map((c, i) => [c.id, i]));
const txIndex = new Map(Array.from({ length: NT }, (_, i) => [txnId(i), i]));
const cbIndex = new Map(Array.from({ length: NC }, (_, j) => [cbId(j), j]));
const userKyc = u => txByU[u].length ? T.k[txByU[u][0]] : -1;
const userSeg = u => txByU[u].length ? T.g[txByU[u][0]] : -1;
const cbCat = j => CB.t[j] >= 0 ? T.c[CB.t[j]] : CB.c[j];

// amount percentiles (for the streaming engine and profile context)
const AMT_SORTED = Float64Array.from(T.a.filter(a => a != null)).sort();
const amountPctl = p => AMT_SORTED[Math.min(AMT_SORTED.length - 1, Math.floor(p * AMT_SORTED.length))];
const AMT_P95 = amountPctl(0.95);

/* ------------------------------------------------------------------ id resolution (tolerant of the messy formats the pipeline fixed) */
function resolveId(raw) {
  const s = String(raw || "").trim().toUpperCase().replace(/[\s_-]/g, "");
  let m;
  if ((m = s.match(/^USR(\d{5})$/))) return uIndex.has("USR" + m[1]) ? { type: "u", i: uIndex.get("USR" + m[1]), id: "USR" + m[1] } : null;
  if ((m = s.match(/^MCH(\d{4})$/))) return mIndex.has("MCH" + m[1]) ? { type: "m", i: mIndex.get("MCH" + m[1]), id: "MCH" + m[1] } : null;
  if ((m = s.match(/^TXN(\d{1,8})$/))) { const id = "TXN" + m[1].padStart(8, "0"); return txIndex.has(id) ? { type: "t", i: txIndex.get(id), id } : null; }
  if ((m = s.match(/^CBK(\d{1,7})$/))) { const id = "CBK" + m[1].padStart(7, "0"); return cbIndex.has(id) ? { type: "c", i: cbIndex.get(id), id } : null; }
  if ((m = s.match(/^CL(\d{1,3})$/))) { const id = "CL" + m[1].padStart(3, "0"); return clIndex.has(id) ? { type: "k", i: clIndex.get(id), id } : null; }
  return null;
}
const ID_RE = /\b(?:USR[\s_-]?\d{5}|MCH[\s_-]?\d{4}|TXN[\s_-]?\d{5,8}|CBK[\s_-]?\d{4,7}|CL[\s_-]?\d{3})\b/gi;

/* =====================================================================================
   filter model
   ===================================================================================== */
const F0 = { from: 0, to: DAYS - 1, cat: -1, st: -1, kyc: -1, disp: 0, rs: -1, sv: -1, hr: -1, dow: -1, mch: -1, usr: -1 };
let F = { ...F0 };
const TXN_KEYS = ["from", "to", "cat", "st", "kyc", "disp", "hr", "dow", "mch", "usr"];
const isFiltered = f => Object.keys(F0).some(k => f[k] !== F0[k]);

/** Rows in a slice: tm[i]=1 for transactions, cm[j]=1 for complaints, hit[i]=1 when the txn has a matching complaint. */
function slice(f = F) {
  const on = k => f[k] !== F0[k];
  const rsOn = on("rs"), svOn = on("sv");
  const cbOk = j => (!rsOn || CB.r[j] === f.rs) && (!svOn || CB.sv[j] === f.sv);
  const hit = new Uint8Array(NT);
  for (let j = 0; j < NC; j++) if (CB.t[j] >= 0 && cbOk(j)) hit[CB.t[j]] = 1;
  const dOn = on("from") || on("to"), cOn = on("cat"), sOn = on("st"), kOn = on("kyc"), pOn = on("disp") || rsOn || svOn;
  const hOn = on("hr"), wOn = on("dow"), mOn = on("mch"), uOn = on("usr");
  const tm = new Uint8Array(NT);
  for (let i = 0; i < NT; i++) {
    const d = T.d[i];
    if (dOn && (d < f.from || d > f.to)) continue;
    if (mOn && T.m[i] !== f.mch) continue;
    if (uOn && T.u[i] !== f.usr) continue;
    if (cOn && T.c[i] !== f.cat) continue;
    if (sOn && T.s[i] !== f.st) continue;
    if (kOn && T.k[i] !== f.kyc) continue;
    if (hOn && hourOf(i) !== f.hr) continue;
    if (wOn && (T.mi[i] < 0 || dowOf(d) !== f.dow)) continue;
    if (pOn && !hit[i]) continue;
    tm[i] = 1;
  }
  // complaints without a usable txn_id have no date/category/user: they count only while no transaction filter is set
  const unlinkedOk = TXN_KEYS.every(k => !on(k));
  const cm = new Uint8Array(NC);
  for (let j = 0; j < NC; j++) {
    const t = CB.t[j];
    if (t >= 0 ? !tm[t] : !unlinkedOk) continue;
    if (cbOk(j)) cm[j] = 1;
  }
  return { tm, cm, hit, f };
}

function summarize(sl) {
  let n = 0, amt = 0, an = 0, succAmt = 0, failed = 0, pending = 0, disp = 0;
  for (let i = 0; i < NT; i++) {
    if (!sl.tm[i]) continue;
    n++;
    const a = T.a[i];
    if (a != null) { amt += a; an++; if (T.s[i] === ST_OK) succAmt += a; }
    if (T.s[i] === ST_FAIL) failed++; else if (T.s[i] === ST_PEND) pending++;
    if (sl.hit[i]) disp++;
  }
  let cbs = 0, cbAmt = 0, linkedAmt = 0, fraud = 0, open = 0, openAmt = 0, fraudAmt = 0;
  const delays = [];
  for (let j = 0; j < NC; j++) {
    if (!sl.cm[j]) continue;
    cbs++;
    const a = CB.a[j] || 0;
    cbAmt += a;
    if (CB.t[j] >= 0) linkedAmt += a;
    fraud += CB.fr[j]; open += CB.op[j];
    if (CB.fr[j]) fraudAmt += a;
    if (CB.op[j]) openAmt += a;
    if (CB.dl[j] != null) delays.push(CB.dl[j]);
  }
  delays.sort((a, b) => a - b);
  const mid = delays.length >> 1;
  return {
    n, amt, avg: an ? amt / an : null, succAmt, failRate: n ? failed / n : 0, pendRate: n ? pending / n : 0, failed, pending,
    disp, ratio: n ? disp / n : 0, cbs, cbAmt, linkedAmt, amtRatio: amt ? linkedAmt / amt : 0, fraud, open, openAmt, fraudAmt,
    fraudShare: cbs ? fraud / cbs : 0, openShare: cbs ? open / cbs : 0,
    delayMean: delays.length ? sum(delays) / delays.length : null,
    delayMedian: delays.length ? (delays.length % 2 ? delays[mid] : (delays[mid - 1] + delays[mid]) / 2) : null,
    late: delays.filter(v => v > 7).length,
  };
}
const FULL_SLICE = slice(F0);
const FULL = summarize(FULL_SLICE);

/* ------------------------------------------------------------------ prior period (for KPI deltas) */
function priorRange(f) {
  if (f.from === 0 && f.to === DAYS - 1) return null;
  const p = MONTHS.find(ym => { const r = monthRange(ym); return r[0] === f.from && r[1] === f.to; });
  if (p) { const k = MONTHS.indexOf(p); return k > 0 ? monthRange(MONTHS[k - 1]) : null; }
  const len = f.to - f.from + 1;
  return f.from - len >= 0 ? [f.from - len, f.from - 1] : null;
}

/* =====================================================================================
   generic aggregation — shared by the views and the agents' query tool
   ===================================================================================== */
const TXN_DIMS = {
  category: { key: i => T.c[i], label: v => catName(v) },
  kyc_status: { key: i => T.k[i], label: v => D.kyc[v] },
  status: { key: i => T.s[i], label: v => D.status[v] },
  risk_segment: { key: i => T.g[i], label: v => D.seg[v] },
  utr_status: { key: i => T.x[i], label: v => D.utr[v] },
  hour: { key: i => hourOf(i), label: v => v < 0 ? "no time" : hh(v) + ":00", skip: v => v < 0 },
  weekday: { key: i => T.mi[i] < 0 ? -1 : dowOf(T.d[i]), label: v => DOW[v], skip: v => v < 0, order: [1, 2, 3, 4, 5, 6, 0] },
  day: { key: i => T.d[i], label: v => dayIso(v) },
  week: { key: i => Math.floor(T.d[i] / 7), label: v => "wk of " + dayIso(v * 7) },
  month: { key: i => monthOf(T.d[i]), label: v => v },
  merchant: { key: i => T.m[i], label: v => M.id[v] },
  user: { key: i => T.u[i], label: v => U.id[v] },
  merchant_city: { key: i => M.city[T.m[i]] || "Unknown", label: v => v },
};
const CB_DIMS = {
  reason: { key: j => CB.r[j], label: v => D.reason[v] },
  severity: { key: j => CB.sv[j], label: v => D.sev[v], order: SEV_ORDER.map(s => D.sev.indexOf(s)) },
  resolution: { key: j => CB.rs[j], label: v => D.res[v] },
  channel: { key: j => CB.ch[j], label: v => D.ch[v] },
  delay_bucket: {
    key: j => { const d = CB.dl[j]; return d == null ? -1 : d <= 1 ? 0 : d <= 3 ? 1 : d <= 7 ? 2 : d <= 15 ? 3 : d <= 30 ? 4 : 5; },
    label: v => ["≤1 day", "1–3 days", "3–7 days", "7–15 days", "15–30 days", ">30 days"][v], skip: v => v < 0, order: [0, 1, 2, 3, 4, 5],
  },
};
const TXN_METRICS = ["txns", "amount", "avg_value", "failed_rate", "pending_rate", "success_rate", "disputed_txns", "dispute_rate", "chargebacks", "disputed_amount", "fraud_chargebacks", "fraud_share"];
const CB_METRICS = ["chargebacks", "disputed_amount", "fraud_chargebacks", "fraud_share", "open_share", "mean_delay_days", "late_over_7d", "late_share"];

function aggregate(sl, dim) {
  const out = new Map();
  if (TXN_DIMS[dim]) {
    const d = TXN_DIMS[dim];
    for (let i = 0; i < NT; i++) {
      if (!sl.tm[i]) continue;
      const k = d.key(i);
      if (d.skip && d.skip(k)) continue;
      let r = out.get(k);
      if (!r) out.set(k, r = { key: k, label: d.label(k), txns: 0, amount: 0, an: 0, failed: 0, pending: 0, success: 0, disputed_txns: 0, chargebacks: 0, disputed_amount: 0, fraud_chargebacks: 0 });
      r.txns++;
      if (T.a[i] != null) { r.amount += T.a[i]; r.an++; }
      if (T.s[i] === ST_FAIL) r.failed++; else if (T.s[i] === ST_PEND) r.pending++; else r.success++;
      if (sl.hit[i]) r.disputed_txns++;
      const js = cbByT.get(i);
      if (js) for (const j of js) if (sl.cm[j]) { r.chargebacks++; r.disputed_amount += CB.a[j] || 0; r.fraud_chargebacks += CB.fr[j]; }
    }
    for (const r of out.values()) {
      r.avg_value = r.an ? r.amount / r.an : null; r.failed_rate = r.failed / r.txns; r.pending_rate = r.pending / r.txns; r.success_rate = r.success / r.txns;
      r.dispute_rate = r.disputed_txns / r.txns; r.fraud_share = r.chargebacks ? r.fraud_chargebacks / r.chargebacks : 0;
      delete r.an;
    }
    const rows = [...out.values()];
    if (d.order) rows.sort((a, b) => d.order.indexOf(a.key) - d.order.indexOf(b.key));
    else if (["day", "week", "month", "hour"].includes(dim)) rows.sort((a, b) => a.key < b.key ? -1 : 1);
    return rows;
  }
  if (CB_DIMS[dim]) {
    const d = CB_DIMS[dim];
    for (let j = 0; j < NC; j++) {
      if (!sl.cm[j]) continue;
      const k = d.key(j);
      if (d.skip && d.skip(k)) continue;
      let r = out.get(k);
      if (!r) out.set(k, r = { key: k, label: d.label(k), chargebacks: 0, disputed_amount: 0, fraud_chargebacks: 0, open: 0, dsum: 0, dn: 0, late_over_7d: 0 });
      r.chargebacks++; r.disputed_amount += CB.a[j] || 0; r.fraud_chargebacks += CB.fr[j]; r.open += CB.op[j];
      if (CB.dl[j] != null) { r.dsum += CB.dl[j]; r.dn++; if (CB.dl[j] > 7) r.late_over_7d++; }
    }
    for (const r of out.values()) {
      r.fraud_share = r.fraud_chargebacks / r.chargebacks; r.open_share = r.open / r.chargebacks;
      r.mean_delay_days = r.dn ? r.dsum / r.dn : null; r.late_share = r.dn ? r.late_over_7d / r.dn : 0;
      delete r.dsum; delete r.dn; delete r.open;
    }
    const rows = [...out.values()];
    if (d.order) rows.sort((a, b) => d.order.indexOf(a.key) - d.order.indexOf(b.key));
    return rows;
  }
  throw new Error(`unknown dimension "${dim}"`);
}

/* ------------------------------------------------------------------ entity stats within a slice */
function merchantStats(m, sl = FULL_SLICE) {
  let txns = 0, amount = 0, disputed = 0, cbs = 0, damt = 0, fraud = 0, failed = 0;
  const users = new Set();
  for (const i of txByM[m]) {
    if (!sl.tm[i]) continue;
    txns++; amount += T.a[i] || 0; if (T.s[i] === ST_FAIL) failed++; users.add(T.u[i]);
    if (sl.hit[i]) disputed++;
    const js = cbByT.get(i);
    if (js) for (const j of js) if (sl.cm[j]) { cbs++; damt += CB.a[j] || 0; fraud += CB.fr[j]; }
  }
  return { txns, amount, disputed, cbs, damt, fraud, failed, users: users.size, ratio: txns ? disputed / txns : 0 };
}
function userStats(u, sl = FULL_SLICE) {
  let txns = 0, amount = 0, disputed = 0, cbs = 0, damt = 0, fraud = 0, failed = 0;
  const merchants = new Set();
  for (const i of txByU[u]) {
    if (!sl.tm[i]) continue;
    txns++; amount += T.a[i] || 0; if (T.s[i] === ST_FAIL) failed++; merchants.add(T.m[i]);
    if (sl.hit[i]) disputed++;
    const js = cbByT.get(i);
    if (js) for (const j of js) if (sl.cm[j]) { cbs++; damt += CB.a[j] || 0; fraud += CB.fr[j]; }
  }
  return { txns, amount, disputed, cbs, damt, fraud, failed, merchants: merchants.size, ratio: txns ? disputed / txns : 0 };
}
const tierName = t => D.tier[t] || "LOW";
const merchantStatus = m => D.mstatus[M.st[m]];
const inMaster = m => M.st[m] !== MST_NONE;

/* ------------------------------------------------------------------ cluster edges */
function clusterEdges(ci) {
  const c = CL[ci], ms = new Set(c.m), edges = new Map();
  for (const u of c.u) for (const i of txByU[u]) {
    if (!ms.has(T.m[i])) continue;
    const k = u + ":" + T.m[i];
    const e = edges.get(k) || { u, m: T.m[i], txns: 0, cbs: 0, amount: 0, fraud: 0 };
    e.txns++; e.amount += T.a[i] || 0;
    const js = cbByT.get(i);
    if (js) { e.cbs += js.length; e.fraud += sum(js, j => CB.fr[j]); }
    edges.set(k, e);
  }
  return [...edges.values()];
}
function clusterStats(ci) {
  const c = CL[ci], edges = clusterEdges(ci);
  return {
    id: c.id, score: c.score, users: c.u.length, merchants: c.m.length, txns: sum(edges, e => e.txns), amount: sum(edges, e => e.amount),
    chargebacks: sum(edges, e => e.cbs), fraud: sum(edges, e => e.fraud), unverified: c.unv, hub: c.hub.replace(/^[UM]:/, ""), hub_degree: c.hd,
  };
}

/* ------------------------------------------------------------------ persistence helpers */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
};
function downloadCsv(name, header, rows) {
  const q = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const body = [header.map(q).join(","), ...rows.map(r => r.map(q).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

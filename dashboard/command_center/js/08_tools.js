/* =====================================================================================
   08 · Agent tools — one registry used by both the local reasoning engine and Claude.
   Data tools read the embedded model; UI tools let an agent drive the desk.
   ===================================================================================== */
const CAT_SYNONYMS = { restaurant: "Restaurants", food: "Restaurants", hotel: "Hotels & Lodging", lodging: "Hotels & Lodging", transport: "Transportation", travel: "Transportation", taxi: "Transportation", pharma: "Pharmacy", medic: "Pharmacy", grocer: "Grocery", kirana: "Grocery", apparel: "Apparel", cloth: "Apparel", book: "Books & Stationery", station: "Books & Stationery", telecom: "Telecom", mobile: "Telecom", department: "Department Stores", retail: "Misc Retail" };
function matchCategory(v) {
  if (v == null || v === "") return -1;
  const s = String(v).toLowerCase().trim();
  let k = D.cat.findIndex(c => c.toLowerCase() === s);
  if (k >= 0) return k;
  k = D.cat.findIndex(c => c.toLowerCase().startsWith(s) || s.startsWith(c.toLowerCase()));
  if (k >= 0) return k;
  for (const [syn, name] of Object.entries(CAT_SYNONYMS)) if (s.includes(syn)) return D.cat.indexOf(name);
  return null;
}
const matchCode = (dict, v) => {
  if (v == null || v === "") return -1;
  const s = String(v).toUpperCase().trim().replace(/[\s-]+/g, "_");
  const k = D[dict].indexOf(s);
  return k >= 0 ? k : D[dict].findIndex(x => x.includes(s) || s.includes(x));
};

/** Agent-facing filter object -> desk filter state. Throws with the valid options on bad input. */
function toF(fl = {}) {
  const f = { ...F0 };
  if (!fl || typeof fl !== "object") return f;
  const bad = (k, v, opts) => { throw new Error(`Unknown ${k} "${v}". Valid: ${opts.join(", ")}`); };
  if (fl.month) { const ym = MONTHS.find(m => m === fl.month || monthName(m).toLowerCase().startsWith(String(fl.month).toLowerCase().slice(0, 3))); if (!ym) bad("month", fl.month, MONTHS); [f.from, f.to] = monthRange(ym); }
  if (fl.from) { const d = isoDay(fl.from); if (isNaN(d)) bad("from", fl.from, ["YYYY-MM-DD"]); f.from = clampDay(d); }
  if (fl.to) { const d = isoDay(fl.to); if (isNaN(d)) bad("to", fl.to, ["YYYY-MM-DD"]); f.to = clampDay(d); }
  if (fl.category != null && fl.category !== "") { const k = matchCategory(fl.category); if (k == null || k < 0) bad("category", fl.category, D.cat); f.cat = k; }
  if (fl.kyc_status) { const k = matchCode("kyc", fl.kyc_status); if (k < 0) bad("kyc_status", fl.kyc_status, D.kyc); f.kyc = k; }
  if (fl.status) { const k = matchCode("status", fl.status); if (k < 0) bad("status", fl.status, D.status); f.st = k; }
  if (fl.reason) { const k = matchCode("reason", fl.reason); if (k < 0) bad("reason", fl.reason, D.reason); f.rs = k; }
  if (fl.severity) { const k = matchCode("sev", fl.severity); if (k < 0) bad("severity", fl.severity, D.sev); f.sv = k; }
  if (fl.disputed_only) f.disp = 1;
  if (fl.hour != null && fl.hour !== "") f.hr = clamp(+fl.hour, 0, 23);
  if (fl.weekday) { const k = DOW.findIndex(d => String(fl.weekday).toLowerCase().startsWith(d.toLowerCase())); if (k < 0) bad("weekday", fl.weekday, DOW); f.dow = k; }
  if (fl.merchant_id) { const r = resolveId(fl.merchant_id); if (!r || r.type !== "m") throw new Error(`Unknown merchant_id "${fl.merchant_id}"`); f.mch = r.i; }
  if (fl.user_id) { const r = resolveId(fl.user_id); if (!r || r.type !== "u") throw new Error(`Unknown user_id "${fl.user_id}"`); f.usr = r.i; }
  if (f.from > f.to) [f.from, f.to] = [f.to, f.from];
  return f;
}
function describeF(f) {
  const parts = [];
  if (f.from !== 0 || f.to !== DAYS - 1) parts.push(`${dayIso(f.from)} → ${dayIso(f.to)}`);
  if (f.cat >= 0) parts.push(D.cat[f.cat]);
  if (f.kyc >= 0) parts.push("KYC " + D.kyc[f.kyc]);
  if (f.st >= 0) parts.push(D.status[f.st]);
  if (f.rs >= 0) parts.push("reason " + D.reason[f.rs]);
  if (f.sv >= 0) parts.push("severity " + D.sev[f.sv]);
  if (f.disp) parts.push("disputed only");
  if (f.hr >= 0) parts.push(`hour ${f.hr}`);
  if (f.dow >= 0) parts.push(DOW[f.dow]);
  if (f.mch >= 0) parts.push(M.id[f.mch]);
  if (f.usr >= 0) parts.push(U.id[f.usr]);
  return parts.length ? parts.join(" · ") : "whole quarter, no filters";
}
const r2 = v => v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
const r4 = v => v == null || isNaN(v) ? null : Math.round(v * 10000) / 10000;
const sliceFor = fl => { const f = toF(fl); return isFiltered(f) ? slice(f) : FULL_SLICE; };

const FILTER_SCHEMA = {
  type: "object", description: "Optional slice. Omit for the whole quarter (2026-01-01 → 2026-03-31).",
  properties: {
    month: { type: "string", description: "Calendar month, e.g. 2026-02 or February" },
    from: { type: "string", description: "Start date YYYY-MM-DD" }, to: { type: "string", description: "End date YYYY-MM-DD" },
    category: { type: "string", description: `Merchant category: ${D.cat.join(", ")}` },
    kyc_status: { type: "string", enum: D.kyc }, status: { type: "string", enum: D.status },
    reason: { type: "string", enum: D.reason, description: "Chargeback reason (restricts to payments with such a complaint)" },
    severity: { type: "string", enum: D.sev }, disputed_only: { type: "boolean" },
    hour: { type: "integer", minimum: 0, maximum: 23 }, weekday: { type: "string", enum: DOW },
    merchant_id: { type: "string" }, user_id: { type: "string" },
  },
};

function kpiObject(s) {
  return {
    payments: s.n, payment_value_inr: r2(s.amt), avg_payment_inr: r2(s.avg), failed_rate: r4(s.failRate), pending_rate: r4(s.pendRate),
    disputed_payments: s.disp, dispute_rate: r4(s.ratio), complaints: s.cbs, disputed_value_inr: r2(s.cbAmt), disputed_share_of_value: r4(s.amtRatio),
    fraud_type_complaints: s.fraud, fraud_type_share: r4(s.fraudShare), unresolved_complaints: s.open, unresolved_share: r4(s.openShare),
    mean_reporting_delay_days: r2(s.delayMean), median_reporting_delay_days: r2(s.delayMedian), reported_after_7_days: s.late,
  };
}
function entityRow(kind, i, sl = FULL_SLICE) {
  const E = kind === "m" ? M : U, st = kind === "m" ? merchantStats(i, sl) : userStats(i, sl);
  const base_ = { id: E.id[i], name: E.name[i] || null, risk_score: E.score[i], risk_tier: tierName(E.tier[i]), payments: st.txns, payment_value_inr: r2(st.amount), chargebacks: st.cbs, disputed_inr: r2(st.damt), fraud_type_chargebacks: st.fraud, chargeback_to_txn_ratio: r4(st.ratio), signals: sigNames(E.sig[i], kind === "m" ? "msig" : "usig") };
  return kind === "m" ? { ...base_, category: catName(M.cat[i]), status: merchantStatus(i), city: M.city[i] || null, distinct_payers: st.users, ring: mCl[i] >= 0 ? CL[mCl[i]].id : null }
    : { ...base_, kyc_status: D.kyc[userKyc(i)] || null, city: U.city[i] || null, monthly_income_inr: U.inc[i], kyc_records_sharing_id: U.idc[i], distinct_merchants: st.merchants, ring: uCl[i] >= 0 ? CL[uCl[i]].id : null };
}

const TOOLS = [
  {
    name: "get_kpis", kind: "data",
    description: "Headline risk KPIs (payments, value, dispute rate, fraud-type share, unresolved share, reporting delay…) for a slice. Rates are fractions 0–1; money in INR. Call twice with different filters to compare periods.",
    input_schema: { type: "object", properties: { filters: FILTER_SCHEMA } },
    run({ filters } = {}) { const sl = sliceFor(filters); return { slice: describeF(sl.f), ...kpiObject(summarize(sl)) }; },
  },
  {
    name: "query_breakdown", kind: "data",
    description: `Group a slice by one dimension and return metrics per group. Payment dimensions: ${Object.keys(TXN_DIMS).join(", ")} (metrics: ${TXN_METRICS.join(", ")}). Complaint dimensions: ${Object.keys(CB_DIMS).join(", ")} (metrics: ${CB_METRICS.join(", ")}). Use day/week/month for trends.`,
    input_schema: {
      type: "object", required: ["group_by"],
      properties: {
        group_by: { type: "string", enum: [...Object.keys(TXN_DIMS), ...Object.keys(CB_DIMS)] },
        filters: FILTER_SCHEMA, sort_by: { type: "string", description: "A metric name to sort by (default: natural order for time/hour, else the first metric)" },
        order: { type: "string", enum: ["desc", "asc"] }, limit: { type: "integer", minimum: 1, maximum: 100 },
        min_payments: { type: "integer", description: "Drop groups with fewer payments (payment dimensions only)" },
      },
    },
    run({ group_by, filters, sort_by, order = "desc", limit = 40, min_payments = 0 }) {
      const sl = sliceFor(filters);
      let rows = aggregate(sl, group_by);
      if (min_payments && TXN_DIMS[group_by]) rows = rows.filter(r => r.txns >= min_payments);
      if (sort_by) { if (!(sort_by in (rows[0] || {}))) throw new Error(`Unknown sort_by "${sort_by}" for ${group_by}`); rows = rows.slice().sort((a, b) => ((a[sort_by] ?? -1) - (b[sort_by] ?? -1)) * (order === "asc" ? 1 : -1)); }
      const total = rows.length;
      rows = rows.slice(0, limit).map(r => { const o = { group: r.label }; for (const [k, v] of Object.entries(r)) if (k !== "key" && k !== "label") o[k] = typeof v === "number" ? (Number.isInteger(v) ? v : r4(v)) : v; return o; });
      return { slice: describeF(sl.f), group_by, groups_total: total, rows };
    },
  },
  {
    name: "rank_entities", kind: "data",
    description: "Rank merchants or customers (users). sort_by: risk_score, chargebacks, disputed_inr, chargeback_to_txn_ratio, payments, payment_value_inr, fraud_type_chargebacks. Activity metrics respect the filters; risk_score is quarter-level and explainable (see get_entity).",
    input_schema: {
      type: "object", required: ["entity"],
      properties: {
        entity: { type: "string", enum: ["merchant", "user"] },
        sort_by: { type: "string", enum: ["risk_score", "chargebacks", "disputed_inr", "chargeback_to_txn_ratio", "payments", "payment_value_inr", "fraud_type_chargebacks"] },
        tier: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] }, min_payments: { type: "integer", description: "Minimum payments in the slice (use ≥3 for ratios)" },
        kyc_status: { type: "string", enum: D.kyc, description: "Users only" }, merchant_status: { type: "string", description: "Merchants only, e.g. INACTIVE, CLOSED, NOT_IN_MASTER" },
        limit: { type: "integer", minimum: 1, maximum: 50 }, filters: FILTER_SCHEMA,
      },
    },
    run({ entity, sort_by = "risk_score", tier, min_payments = 1, kyc_status, merchant_status, limit = 10, filters }) {
      const sl = sliceFor(filters), kind = entity === "merchant" ? "m" : "u", N = kind === "m" ? NM : NU, E = kind === "m" ? M : U;
      const tierCode = tier ? D.tier.indexOf(tier) : -1, kycCode = kyc_status ? D.kyc.indexOf(kyc_status) : -1;
      const out = [];
      for (let i = 0; i < N; i++) {
        if (tierCode >= 0 && E.tier[i] !== tierCode) continue;
        if (kind === "u" && kycCode >= 0 && userKyc(i) !== kycCode) continue;
        if (kind === "m" && merchant_status && !merchantStatus(i).includes(String(merchant_status).toUpperCase())) continue;
        const list = kind === "m" ? txByM[i] : txByU[i];
        let n = 0; for (const t of list) if (sl.tm[t]) n++;
        if (n < Math.max(1, min_payments)) continue;
        out.push(entityRow(kind, i, sl));
      }
      out.sort((a, b) => (b[sort_by] ?? 0) - (a[sort_by] ?? 0) || b.disputed_inr - a.disputed_inr);
      return { slice: describeF(sl.f), entity, sort_by, matching: out.length, rows: out.slice(0, limit) };
    },
  },
  {
    name: "get_entity", kind: "data",
    description: "Full profile for one id: merchant MCH####, customer USR#####, payment TXN########, complaint CBK#######, or ring CL###. Includes the risk score broken down signal by signal with the points each adds, counterparties, complaints and ring membership.",
    input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run({ id }) {
      const r = resolveId(id);
      if (!r) throw new Error(`No merchant/customer/payment/complaint/ring with id "${id}"`);
      if (r.type === "m" || r.type === "u") {
        const kind = r.type, E = kind === "m" ? M : U, dict = kind === "m" ? "msig" : "usig";
        const list = kind === "m" ? txByM[r.i] : txByU[r.i];
        const partners = new Map();
        for (const t of list) { const p = kind === "m" ? T.u[t] : T.m[t]; const o = partners.get(p) || { id: kind === "m" ? U.id[p] : M.id[p], payments: 0, chargebacks: 0, risk_score: (kind === "m" ? U : M).score[p] }; o.payments++; o.chargebacks += cbByT.get(t)?.length || 0; partners.set(p, o); }
        const complaints = list.flatMap(t => (cbByT.get(t) || []).map(j => ({ id: cbId(j), payment: txnId(t), reason: D.reason[CB.r[j]], fraud_type: !!CB.fr[j], severity: D.sev[CB.sv[j]], disputed_inr: CB.a[j], delay_days: CB.dl[j], resolution: D.res[CB.rs[j]] })));
        return {
          type: kind === "m" ? "merchant" : "customer", ...entityRow(kind, r.i),
          score_breakdown: sigPoints(E.sig[r.i], dict).map(([signal, points]) => ({ signal, points })),
          scoring_note: "Additive: each fired signal adds fixed points; tiers HIGH ≥ 50, MEDIUM 30–49.",
          settlement_account: kind === "m" ? D.settle[M.se[r.i]] : undefined,
          counterparties: [...partners.values()].sort((a, b) => b.chargebacks - a.chargebacks || b.payments - a.payments).slice(0, 15),
          counterparties_total: partners.size, complaints: complaints.slice(0, 15), complaints_total: complaints.length,
          first_payment: list.length ? dayIso(Math.min(...list.map(t => T.d[t]))) : null, last_payment: list.length ? dayIso(Math.max(...list.map(t => T.d[t]))) : null,
        };
      }
      if (r.type === "t") {
        const i = r.i;
        return { type: "payment", id: txnId(i), date: dayIso(T.d[i]), time: timeFmt(i), amount_inr: T.a[i], status: D.status[T.s[i]], utr_status: D.utr[T.x[i]], category: catName(T.c[i]), kyc_status: D.kyc[T.k[i]], customer: entityRow("u", T.u[i]), merchant: entityRow("m", T.m[i]), complaints: (cbByT.get(i) || []).map(j => ({ id: cbId(j), reason: D.reason[CB.r[j]], disputed_inr: CB.a[j], delay_days: CB.dl[j], resolution: D.res[CB.rs[j]] })) };
      }
      if (r.type === "c") {
        const j = r.i, t = CB.t[j];
        return { type: "complaint", id: cbId(j), reason: D.reason[CB.r[j]], fraud_type: !!CB.fr[j], severity: D.sev[CB.sv[j]], resolution: D.res[CB.rs[j]], channel: D.ch[CB.ch[j]], disputed_inr: CB.a[j], reported: CB.rd[j] == null ? null : dayIso(CB.rd[j]), reporting_delay_days: CB.dl[j], linked_payment: t >= 0 ? txnId(t) : null, customer_via_payment: t >= 0 ? U.id[T.u[t]] : null, merchant_via_payment: t >= 0 ? M.id[T.m[t]] : null, attribution_note: "Attributed through txn_id; the complaint's own user/merchant ids never match the payment." };
      }
      const s = clusterStats(r.i), c = CL[r.i];
      return { type: "ring", ...s, scoring: "2×chargebacks + 3×fraud-type + unverified users + disputed ₹/10k", members: [...c.m.map(m => entityRow("m", m)), ...c.u.map(u => entityRow("u", u))], links: clusterEdges(r.i).map(e => ({ customer: U.id[e.u], merchant: M.id[e.m], payments: e.txns, chargebacks: e.cbs })) };
    },
  },
  {
    name: "get_network", kind: "data",
    description: "Graph neighbourhood of a merchant or customer: direct counterparties, and second-degree entities that share those counterparties (possible collusion). Also reports ring membership.",
    input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, max_neighbors: { type: "integer", minimum: 1, maximum: 40 } } },
    run({ id, max_neighbors = 15 }) {
      const r = resolveId(id);
      if (!r || (r.type !== "m" && r.type !== "u")) throw new Error(`get_network needs a merchant or customer id, got "${id}"`);
      const kind = r.type, other = kind === "m" ? "u" : "m";
      const own = kind === "m" ? txByM[r.i] : txByU[r.i];
      const first = new Map();
      for (const t of own) { const p = kind === "m" ? T.u[t] : T.m[t]; const o = first.get(p) || { payments: 0, chargebacks: 0 }; o.payments++; o.chargebacks += cbByT.get(t)?.length || 0; first.set(p, o); }
      const second = new Map();
      for (const p of first.keys()) for (const t of (other === "u" ? txByU[p] : txByM[p])) {
        const q = kind === "m" ? T.m[t] : T.u[t];
        if (q === r.i) continue;
        const o = second.get(q) || { shared: new Set(), chargebacks: 0 }; o.shared.add(p); o.chargebacks += cbByT.get(t)?.length || 0; second.set(q, o);
      }
      const E1 = other === "u" ? U : M, E2 = kind === "m" ? M : U;
      return {
        center: entityRow(kind, r.i), ring: (kind === "m" ? mCl : uCl)[r.i] >= 0 ? CL[(kind === "m" ? mCl : uCl)[r.i]].id : null,
        direct: [...first].sort((a, b) => b[1].chargebacks - a[1].chargebacks).slice(0, max_neighbors).map(([p, o]) => ({ id: E1.id[p], ...o, risk_score: E1.score[p], risk_tier: tierName(E1.tier[p]) })),
        direct_total: first.size,
        shared_counterparty_entities: [...second].sort((a, b) => b[1].shared.size - a[1].shared.size || b[1].chargebacks - a[1].chargebacks).slice(0, max_neighbors).map(([q, o]) => ({ id: E2.id[q], shared_counterparties: o.shared.size, chargebacks_on_those_links: o.chargebacks, risk_score: E2.score[q], risk_tier: tierName(E2.tier[q]) })),
      };
    },
  },
  {
    name: "list_rings", kind: "data",
    description: "Suspicious dispute rings (connected components of dispute-touched customers and merchants, ≥4 members) ranked by ring score. Also returns the circular money-loop engine result.",
    input_schema: { type: "object", properties: { min_score: { type: "number" }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
    run({ min_score = 0, limit = 10 } = {}) {
      const rows = CL.map((c, ci) => ({ ci, c })).filter(x => x.c.score >= min_score).slice(0, limit).map(x => clusterStats(x.ci));
      return { rings_total: CL.length, matching: CL.filter(c => c.score >= min_score).length, score_formula: "2×chargebacks + 3×fraud-type + unverified users + disputed ₹/10k", rows, circular_laundering_engine: DATA.circular_rings.stats };
    },
  },
  {
    name: "find_disputes", kind: "data",
    description: "List complaints (chargebacks) matching conditions, e.g. reported after N days, unresolved fraud-type. Returns totals and the top rows.",
    input_schema: {
      type: "object",
      properties: {
        min_delay_days: { type: "number" }, open_only: { type: "boolean" }, fraud_only: { type: "boolean" },
        reason: { type: "string", enum: D.reason }, severity: { type: "string", enum: D.sev },
        sort_by: { type: "string", enum: ["delay", "amount"] }, limit: { type: "integer", minimum: 1, maximum: 50 }, filters: FILTER_SCHEMA,
      },
    },
    run({ min_delay_days, open_only, fraud_only, reason, severity, sort_by = "delay", limit = 12, filters } = {}) {
      const sl = sliceFor(filters), rs = reason ? D.reason.indexOf(reason) : -1, sv = severity ? D.sev.indexOf(severity) : -1;
      const js = [];
      for (let j = 0; j < NC; j++) {
        if (!sl.cm[j]) continue;
        if (min_delay_days != null && !(CB.dl[j] != null && CB.dl[j] > min_delay_days)) continue;
        if (open_only && !CB.op[j]) continue;
        if (fraud_only && !CB.fr[j]) continue;
        if (rs >= 0 && CB.r[j] !== rs) continue;
        if (sv >= 0 && CB.sv[j] !== sv) continue;
        js.push(j);
      }
      js.sort((a, b) => sort_by === "amount" ? (CB.a[b] || 0) - (CB.a[a] || 0) : (CB.dl[b] ?? -1) - (CB.dl[a] ?? -1));
      const byReason = {};
      js.forEach(j => { const k = D.reason[CB.r[j]]; byReason[k] = (byReason[k] || 0) + 1; });
      return {
        slice: describeF(sl.f), matching: js.length, disputed_inr: r2(sum(js, j => CB.a[j])), by_reason: byReason,
        rows: js.slice(0, limit).map(j => ({ id: cbId(j), payment: CB.t[j] >= 0 ? txnId(CB.t[j]) : null, merchant: CB.t[j] >= 0 ? M.id[T.m[CB.t[j]]] : null, customer: CB.t[j] >= 0 ? U.id[T.u[CB.t[j]]] : null, reason: D.reason[CB.r[j]], severity: D.sev[CB.sv[j]], disputed_inr: CB.a[j], delay_days: CB.dl[j], resolution: D.res[CB.rs[j]] })),
      };
    },
  },
  {
    name: "sentinel_alerts", kind: "data",
    description: "Run the Sentinel detectors (identity gap, rejected-KYC activity, fraud backlog, top ring, category outliers, inactive merchants, late fraud reports, daily spikes, repeat unverified disputers) on a slice. Returns prioritised alerts.",
    input_schema: { type: "object", properties: { filters: FILTER_SCHEMA } },
    run({ filters } = {}) { const sl = sliceFor(filters); return { slice: describeF(sl.f), alerts: Sentinel.scan(sl, summarize(sl)).map(a => ({ severity: a.sev, title: a.title, detail: a.text })) }; },
  },
  {
    name: "model_health", kind: "data",
    description: "Out-of-time backtest of the risk scores (AUC, tier lift/recall, per-signal lift) and the pipeline run history.",
    input_schema: { type: "object", properties: {} },
    run() { const BT = DATA.backtest; return { cutoff: BT.cutoff, train_window: BT.train_window, test_window: BT.test_window, merchant: BT.merchant, user: BT.user, tiers: BT.tiers, signals: BT.signals, history: DATA.history }; },
  },
  {
    name: "data_quality", kind: "data",
    description: "The cleaning ledger: every data-quality check, rows affected and the action taken, plus raw vs clean row counts.",
    input_schema: { type: "object", properties: { search: { type: "string" }, source: { type: "string" } } },
    run({ search, source } = {}) {
      const q = (search || "").toLowerCase();
      const rows = QUALITY.filter(r => (!source || r.table === source) && (!q || `${r.table} ${r.check} ${r.action}`.toLowerCase().includes(q)));
      return { raw_rows: R.raw, clean: { payments: K.txn_count, complaints: K.chargeback_count, kyc_customers: K.users }, duplicates_removed: K.duplicate_txns_removed, duplicate_value_removed_inr: K.duplicate_amount_removed, checks_total: QUALITY.length, matching: rows.length, rows: rows.slice(0, 40) };
    },
  },
  {
    name: "get_case_queue", kind: "data",
    description: "The analyst's current investigation case queue.",
    input_schema: { type: "object", properties: {} },
    run() { return { cases: Cases.all().map(c => ({ entity: refLabel(c.ref), type: c.ref[0], priority: c.priority, status: c.status, reason: c.reason, filed_by: c.by })) }; },
  },
  /* ---------------------------------------------------------------- UI tools */
  {
    name: "show_chart", kind: "ui",
    description: "Render a chart inside your answer. Use after fetching data. type: bar (vertical), hbar (ranked horizontal), line (time series), pie (≤6 parts of a whole). Keep ≤ 3 series and never mix units on one chart.",
    input_schema: {
      type: "object", required: ["type", "title", "labels", "series"],
      properties: {
        type: { type: "string", enum: ["bar", "hbar", "line", "pie"] }, title: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        series: { type: "array", items: { type: "object", required: ["name", "values"], properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } } } },
        value_format: { type: "string", enum: ["number", "inr", "percent"] },
      },
    },
    run(input, ctx) { ctx.emit({ kind: "chart", spec: input }); return { rendered: true }; },
  },
  {
    name: "apply_filters", kind: "ui",
    description: "Set the dashboard's global filters (and optionally switch view) so the analyst sees the slice you are talking about. Replaces current filters.",
    input_schema: { type: "object", required: ["filters"], properties: { filters: FILTER_SCHEMA, view: { type: "string", enum: Object.keys(VIEWS) } } },
    run({ filters, view }, ctx) { const f = toF(filters); ctx.emit({ kind: "action", label: `Filter: ${describeF(f)}`, run: () => { setF(f, true); if (view) go(view); } }, true); return { applied: describeF(f), view: view || activeView }; },
  },
  {
    name: "navigate", kind: "ui",
    description: "Switch the dashboard to a view: overview, stream (live replay), network (rings), entities, disputes, identity (KYC), model, pipeline, cases.",
    input_schema: { type: "object", required: ["view"], properties: { view: { type: "string", enum: Object.keys(VIEWS) } } },
    run({ view }, ctx) { ctx.emit({ kind: "action", label: `Open ${view} view`, run: () => go(view) }, true); return { view }; },
  },
  {
    name: "open_entity", kind: "ui",
    description: "Open the Entity 360 panel for an id (merchant, customer, payment, complaint or ring).",
    input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run({ id }, ctx) { const r = resolveId(id); if (!r) throw new Error(`Unknown id "${id}"`); ctx.emit({ kind: "action", label: `Open ${r.id}`, run: () => openEntity(r) }); return { opened: r.id }; },
  },
  {
    name: "add_to_cases", kind: "ui",
    description: "File one or more entities into the analyst's case queue with a priority and a one-line reason.",
    input_schema: { type: "object", required: ["ids", "reason"], properties: { ids: { type: "array", items: { type: "string" } }, priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] }, reason: { type: "string" } } },
    run({ ids, priority = "HIGH", reason }, ctx) {
      const added = [], skipped = [];
      for (const id of ids || []) { const r = resolveId(id); if (!r) { skipped.push(id); continue; } (Cases.add({ ref: `${r.type}:${r.i}`, reason, priority, by: `AI · ${ctx.agent}` }) ? added : skipped).push(r.id); }
      if (added.length) ctx.emit({ kind: "action", label: `Open case queue (${added.length} added)`, run: () => go("cases") });
      return { added, skipped };
    },
  },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

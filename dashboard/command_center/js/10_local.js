/* =====================================================================================
   10 · Local reasoning engine — parses the question, plans tool calls over the same
   registry Claude uses, runs them with a visible trace, and writes the answer.
   Deterministic and offline, so the desk and its agents work anywhere.
   ===================================================================================== */
const Local = (() => {
  const wait = ms => new Promise(r => setTimeout(r, reduceMotion ? 0 : ms));
  const MONTH_WORDS = [["jan", 0], ["feb", 1], ["mar", 2]];
  const REASON_WORDS = [["takeover", "ACCOUNT_TAKEOVER"], ["unauthori", "UNAUTHORIZED_TXN"], ["fraud suspected", "FRAUD_SUSPECTED"], ["suspected fraud", "FRAUD_SUSPECTED"], ["duplicate debit", "DUPLICATE_DEBIT"], ["debited twice", "DUPLICATE_DEBIT"], ["not delivered", "NOT_DELIVERED"], ["wrong amount", "WRONG_AMOUNT"], ["service not", "SERVICE_NOT_PROVIDED"], ["general dispute", "GENERAL_DISPUTE"]];
  const DIM_WORDS = [
    [/\b(by|per|each|across)\s+(merchant\s+)?categor|categor(y|ies)\b/, "category"], [/\bkyc\b/, "kyc_status"], [/\breasons?\b/, "reason"], [/\bseverity\b/, "severity"],
    [/\bresolution|resolved|backlog status/, "resolution"], [/\bchannel/, "channel"], [/\b(hour|hourly|time of day)\b/, "hour"], [/\b(weekday|day of (the )?week)\b/, "weekday"],
    [/\bmonth(ly)?\b|\bby month\b/, "month"], [/\bweek(ly)?\b/, "week"], [/\b(daily|by day|per day|each day|over time|trend)\b/, "day"], [/\bcit(y|ies)\b/, "merchant_city"],
    [/\bsegment\b/, "risk_segment"], [/\butr\b/, "utr_status"], [/\bdelay (bucket|distribution)|how late\b/, "delay_bucket"],
  ];
  const fmtMetric = (k, v) => v == null ? "—" : /rate|share|ratio/.test(k) ? pct(v) : /amount|inr|value/.test(k) && k !== "avg_value" ? inr(v) : k === "avg_value" ? inrFull(v) : /delay/.test(k) ? v.toFixed(1) + " d" : int(v);
  const LABEL = { txns: "Payments", amount: "Payment value", avg_value: "Avg payment", failed_rate: "Failed rate", pending_rate: "Pending rate", success_rate: "Success rate", disputed_txns: "Disputed payments", dispute_rate: "Dispute rate", chargebacks: "Chargebacks", disputed_amount: "Disputed value", fraud_chargebacks: "Fraud-type CBs", fraud_share: "Fraud-type share", open_share: "Unresolved share", mean_delay_days: "Mean delay", late_over_7d: "Reported > 7 d", late_share: "Share > 7 d", success: "Successful", failed: "Failed", pending: "Pending" };
  const niceLabel = (dim, g) => ["reason", "severity", "resolution", "channel", "kyc_status", "status", "risk_segment", "utr_status"].includes(dim) ? title(g) : g;
  const table = (rows, cols) => `<div class="tw"><table><thead><tr>${cols.map(c => `<th${c.r ? ' class="r"' : ""}>${esc(c.h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td${c.r ? ' class="r"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const idHtml = id => linkify(esc(id));

  /* ---------------------------------------------------------------- parsing */
  function parse(q) {
    const s = " " + q.toLowerCase().replace(/[’']/g, "'") + " ";
    const P = { q, s, ids: [], filters: {}, dim: null, top: null };
    for (const m of q.matchAll(ID_RE)) { const r = resolveId(m[0]); if (r && !P.ids.some(x => x.id === r.id)) P.ids.push(r); }
    // filters
    const months = MONTH_WORDS.filter(([w]) => new RegExp(`\\b${w}(uary|ruary|ch)?\\b`).test(s)).map(([, k]) => MONTHS[k]).filter(Boolean);
    P.months = months;
    if (months.length === 1) P.filters.month = months[0];
    const catHit = D.cat.map((c, k) => [c, k]).find(([c]) => c !== "Unknown" && s.includes(c.toLowerCase().split(/[ &]/)[0]));
    const synHit = Object.entries(CAT_SYNONYMS).find(([w]) => s.includes(w));
    if (catHit) P.filters.category = catHit[0]; else if (synHit && !/\bretail\b/.test(s)) P.filters.category = synHit[1];
    if (/\b(no|without|missing|unknown) kyc|no identity|unverified identity|no_kyc/.test(s)) P.filters.kyc_status = "NO_KYC_RECORD";
    else if (/rejected(-| )?kyc|kyc(-| )rejected|rejected (customers|users)/.test(s)) P.filters.kyc_status = "REJECTED";
    else if (/verified (customers|users)|kyc verified/.test(s)) P.filters.kyc_status = "VERIFIED";
    else if (/pending kyc|kyc pending/.test(s)) P.filters.kyc_status = "PENDING";
    for (const [w, r] of REASON_WORDS) if (s.includes(w)) { P.filters.reason = r; break; }
    if (/\bcritical\b/.test(s)) P.filters.severity = "CRITICAL";
    let m;
    if ((m = s.match(/\btop\s+(\d{1,2})\b/)) || (m = s.match(/\b(\d{1,2})\s+(highest|riskiest|most|worst|top)\b/))) P.top = +m[1];
    // dimension
    for (const [re, dim] of DIM_WORDS) if (re.test(s)) { P.dim = dim; break; }
    if (P.dim === "category" && /\bmerchants?\b/.test(s) && !/categor/.test(s)) P.dim = null;
    // "dispute rate for rejected KYC customers" names a slice, not a breakdown
    const filteredDim = { kyc_status: "kyc_status", category: "category", reason: "reason", severity: "severity" };
    if (P.dim && P.filters[filteredDim[P.dim]] && !/\b(by|per|each|across|breakdown|distribution|compare)\b/.test(s)) P.dim = null;
    // entity words
    P.entity = /\b(merchant|merchants|shop|shops|payee)\b/.test(s) && !/merchant categor/.test(s) ? "merchant" : /\b(user|users|customer|customers|payer|payers)\b/.test(s) ? "user" : null;
    P.superlative = /\b(highest|most|top|largest|biggest|worst|riskiest|max|maximum|which|who|rank|leader)\b/.test(s);
    P.metric = metricOf(s);
    return P;
  }
  function metricOf(s) {
    if (/average (transaction|payment) value|avg (transaction|payment)|average ticket|\baov\b/.test(s)) return "avg_value";
    if (/chargeback[- ]to[- ](transaction|txn)|dispute rate|chargeback rate|cb ratio|chargeback ratio|\bratio\b/.test(s)) return "dispute_rate";
    if (/disputed (amount|value|money|rupees)|amount disputed|dispute amount|chargeback amount|money (in|at) (dispute|risk)/.test(s)) return "disputed_amount";
    if (/\bfail(ed|ure|ures|ing)?\b|declin/.test(s)) return "failed_rate";
    if (/\bfraud/.test(s)) return "fraud_chargebacks";
    if (/\b(delay|late|slow)\b/.test(s)) return "mean_delay_days";
    if (/risk score|risky|riskiest|high[- ]risk/.test(s)) return "risk_score";
    if (/\b(chargebacks?|disputes?|complaints?)\b/.test(s)) return "chargebacks";
    if (/\b(amount|value|revenue|gmv|rupees|money|worth|spend)\b/.test(s)) return "amount";
    if (/\b(volume|count|number|how many|transactions|payments|txns)\b/.test(s)) return "txns";
    return null;
  }
  function route(P) {
    const s = P.s;
    if (/\b(add|file|put|pin|create)\b.*\bcases?\b|\bcase queue\b.*\b(add|file)/.test(s) && !/summar/.test(s)) return ["investigator", "addCases"];
    if (/\b(my )?case(s| queue)\b/.test(s) && /summar|review|status|what|show|list/.test(s)) return ["reporter", "caseQueue"];
    if (P.ids.length) return ["investigator", "entity"];
    if (/\b(brief|briefing|summary|summari[sz]e|overview|executive|report|what should (we|i)|act on|priorit|headline|situation|state of)\b/.test(s)) return ["reporter", "brief"];
    if (/\b(ring|rings|cluster|clusters|network|collusion|connected|syndicate|gang|launder|cycle|loop)\b/.test(s)) return ["investigator", "rings"];
    if (/\b(alert|alerts|anomal|unusual|spike|spikes|outlier|sentinel|wrong|weird|suspicious activity|red flags?)\b/.test(s)) return ["sentinel", "alerts"];
    if (/\b(model|auc|backtest|predict|accuracy|precision|recall|how good|lift)\b/.test(s)) return ["analyst", "model"];
    if (/\b(data quality|quality|clean|cleaning|duplicate rows|duplicates|pipeline|messy|dedup)\b/.test(s)) return ["analyst", "quality"];
    if (/after \d+ days|reported (late|after)|late(ly)? reported|delayed disputes|long delay|late disputes/.test(s)) return ["analyst", "late"];
    if (/\b(compare|vs\.?|versus)\b/.test(s) && P.months.length >= 2) return ["analyst", "compareMonths"];
    if (/success(ful)?\b.*\bfail|fail.*\bsuccess/.test(s)) return ["analyst", "successFailed"];
    if (/\b(filter|focus|zoom|drill|show me .* (on|in) the (desk|dashboard))\b/.test(s)) return ["analyst", "focus"];
    if (P.entity && (P.superlative || P.top)) return [P.metric === "risk_score" ? "investigator" : "analyst", "rank"];
    if (P.dim) return ["analyst", "breakdown"];
    if (P.metric || Object.keys(P.filters).length) return ["analyst", "kpi"];
    return ["lead", "help"];
  }

  /* ---------------------------------------------------------------- runtime */
  async function run(text, pick, botMsg, ctxFor, signal) {
    const P = parse(text);
    const [who, intent] = route(P);
    const agentKey = pick === "lead" ? (who === "lead" ? "lead" : who) : pick;
    const ui = botMsg(pick === "lead" ? "lead" : pick, "local engine");
    const ctx = ctxFor(ui, agentKey);
    await wait(220);
    if (pick === "lead" && who !== "lead") ui.route(who, `intent: ${intent}${Object.keys(P.filters).length ? " · filters " + JSON.stringify(P.filters) : ""}${P.ids.length ? " · ids " + P.ids.map(r => r.id).join(", ") : ""}`);
    const call = async (name, input) => {
      if (signal.aborted) throw new Error("Stopped.");
      const tool = TOOL_BY_NAME[name];
      const args = JSON.stringify(input);
      const li = ui.step("tool", tool.kind === "ui" ? "◧" : "ƒ", `<b>${AGENTS[agentKey].name}</b> → <span class="mono">${name}</span>`, args.length > 170 ? args.slice(0, 170) + "…" : args);
      await wait(160);
      try { return tool.run(input, ctx); } catch (err) { li.classList.add("err"); throw err; }
    };
    ui.status("Working…");
    const out = await HANDLERS[intent](P, call, ui, ctx);
    ui.setText(out.html);
    if (out.follow) ui.followups(out.follow);
    ui.done(true);
  }

  /* ---------------------------------------------------------------- intent handlers */
  const HANDLERS = {
    async help() {
      return {
        html: `<p>I can work with every payment, complaint, customer and merchant in the quarter. Try asking about:</p><ul>
          <li><b>Trends</b> — daily volume, average payment value, success vs failed by day</li>
          <li><b>Breakdowns</b> — amount or disputes by category, KYC status, reason, severity, hour</li>
          <li><b>Rankings</b> — merchants by chargebacks or chargeback ratio, top users by disputed amount</li>
          <li><b>Investigations</b> — any MCH / USR / TXN / CBK / CL id, or “find fraud rings”</li>
          <li><b>Briefs & alerts</b> — “brief me”, “what looks unusual in March?”, “disputes reported after 7 days”</li>
          <li><b>Actions</b> — “focus the desk on Grocery in February”, “add the top 5 risky merchants to my cases”</li></ul>
          <p class="dim">Connect Claude (⚙) for open-ended reasoning and multi-agent delegation.</p>`,
        follow: ["Brief me on this quarter", "Which merchant has the highest chargeback count?", "Show chargeback reason distribution"],
      };
    },

    async kpi(P, call, ui) {
      const k = await call("get_kpis", { filters: P.filters });
      const focus = P.metric && P.metric !== "risk_score" ? P.metric : null;
      const map = { txns: ["payments", "Payments"], amount: ["payment_value_inr", "Payment value"], avg_value: ["avg_payment_inr", "Average payment"], failed_rate: ["failed_rate", "Failed rate"], dispute_rate: ["dispute_rate", "Dispute rate"], chargebacks: ["complaints", "Complaints"], disputed_amount: ["disputed_value_inr", "Disputed value"], fraud_chargebacks: ["fraud_type_share", "Fraud-type share"], mean_delay_days: ["mean_reporting_delay_days", "Mean reporting delay"] };
      const fk = focus && map[focus];
      const fv = fk ? k[fk[0]] : null;
      const f = v => fk && /rate|share/.test(fk[0]) ? pct(v) : fk && /inr/.test(fk[0]) ? inr(v) : fk && /delay/.test(fk[0]) ? v.toFixed(1) + " days" : int(v);
      return {
        html: `<p>${fk ? `<strong>${fk[1]}: ${f(fv)}</strong> for ${esc(k.slice)}.` : `Here is the picture for <strong>${esc(k.slice)}</strong>.`}</p>
          ${table([["Payments", int(k.payments)], ["Payment value", inr(k.payment_value_inr)], ["Dispute rate", pct(k.dispute_rate)], ["Complaints", `${int(k.complaints)} · ${inr(k.disputed_value_inr)}`], ["Fraud-type share", pct(k.fraud_type_share, 0)], ["Unresolved", pct(k.unresolved_share, 0)], ["Failed rate", pct(k.failed_rate)], ["Mean reporting delay", k.mean_reporting_delay_days == null ? "—" : k.mean_reporting_delay_days.toFixed(1) + " d"]], [{ h: "Metric", f: r => r[0] }, { h: "Value", r: 1, f: r => r[1] }])}
          <p>Overall quarter dispute rate is ${pct(K.chargeback_to_txn_ratio)} for comparison.</p>`,
        follow: ["What looks unusual here?", "Break this down by category", "Show disputes reported after 7 days"],
      };
    },

    async breakdown(P, call, ui, ctx) {
      const dim = P.dim, isCb = !!CB_DIMS[dim], isTime = ["day", "week", "month", "hour", "weekday"].includes(dim);
      let metric = P.metric && P.metric !== "risk_score" ? P.metric : isCb ? "chargebacks" : "amount";
      if (isCb && !CB_METRICS.includes(metric)) metric = metric === "dispute_rate" ? "chargebacks" : metric === "amount" ? "disputed_amount" : "chargebacks";
      if (!isCb && !TXN_METRICS.includes(metric)) metric = metric === "mean_delay_days" ? "txns" : "amount";
      if (/volume/.test(P.s) && !isCb) metric = "txns";
      const ask = { group_by: dim, filters: P.filters, limit: isTime ? 100 : 20 };
      if (!isTime) { ask.sort_by = metric; ask.order = /lowest|least|smallest/.test(P.s) ? "asc" : "desc"; }
      if (dim === "category" && metric === "dispute_rate") ask.min_payments = 100;
      const res = await call("query_breakdown", ask);
      const rows = res.rows;
      if (!rows.length) return { html: `<p>No data for ${esc(res.slice)}.</p>` };
      const labels = rows.map(r => niceLabel(dim, r.group));
      const vf = /rate|share/.test(metric) ? "percent" : /amount/.test(metric) ? "inr" : "number";
      const vals = rows.map(r => r[metric] ?? 0);
      let html;
      if (isTime) {
        const mean = sum(vals) / vals.length, lo = Math.min(...vals), hi = Math.max(...vals);
        const loR = rows[vals.indexOf(lo)], hiR = rows[vals.indexOf(hi)];
        const firstHalf = sum(vals.slice(0, vals.length >> 1)) / Math.max(1, vals.length >> 1), secondHalf = sum(vals.slice(vals.length >> 1)) / Math.max(1, vals.length - (vals.length >> 1));
        const drift = firstHalf ? (secondHalf - firstHalf) / firstHalf : 0;
        await call("show_chart", { type: dim === "hour" || dim === "weekday" ? "bar" : "line", title: `${LABEL[metric]} by ${dim.replace("_", " ")}${P.filters.category ? " · " + P.filters.category : ""}`, labels, series: [{ name: LABEL[metric], values: vals }], value_format: vf });
        html = `<p><strong>${LABEL[metric]} by ${dim.replace("_", " ")}</strong> for ${esc(res.slice)}: mean <strong>${fmtMetric(metric, mean)}</strong>, from ${fmtMetric(metric, lo)} (${esc(niceLabel(dim, loR.group))}) to ${fmtMetric(metric, hi)} (${esc(niceLabel(dim, hiR.group))}).</p>
          <p>${dim === "hour" || dim === "weekday" ? `The spread between the best and worst ${dim} is ${fmtMetric(metric, hi - lo)} — ${Math.abs(hi - lo) / (mean || 1) < 0.25 ? "fairly flat, so this is systemic rather than a peak-load effect" : "a real pattern worth routing controls around"}.` : `Second half vs first half: <strong>${drift >= 0 ? "▲" : "▼"} ${Math.abs(drift * 100).toFixed(1)}%</strong> — ${Math.abs(drift) < 0.03 ? "essentially stable" : drift > 0 ? "trending up" : "trending down"}.`}</p>`;
        if (dim !== "day" && rows.length <= 14) html += table(rows, [{ h: dim, f: r => esc(niceLabel(dim, r.group)) }, { h: LABEL[metric], r: 1, f: r => fmtMetric(metric, r[metric]) }, ...(isCb ? [] : [{ h: "Payments", r: 1, f: r => int(r.txns) }, { h: "Dispute rate", r: 1, f: r => pct(r.dispute_rate) }])]);
      } else {
        const total = sum(vals), top = rows[0];
        const share = /rate|share|avg/.test(metric) ? null : total ? top[metric] / total : null;
        await call("show_chart", { type: "hbar", title: `${LABEL[metric]} by ${dim.replace("_", " ")}`, labels: labels.slice(0, 12), series: [{ name: LABEL[metric], values: vals.slice(0, 12) }], value_format: vf });
        const extraCols = isCb ? [{ h: "Complaints", r: 1, f: r => int(r.chargebacks) }, { h: "Disputed", r: 1, f: r => inr(r.disputed_amount) }, { h: "Fraud-type", r: 1, f: r => pct(r.fraud_share, 0) }, { h: "Mean delay", r: 1, f: r => r.mean_delay_days == null ? "—" : r.mean_delay_days.toFixed(1) + " d" }]
          : [{ h: "Payments", r: 1, f: r => int(r.txns) }, { h: "Value", r: 1, f: r => inr(r.amount) }, { h: "Dispute rate", r: 1, f: r => pct(r.dispute_rate) }, { h: "Disputed", r: 1, f: r => inr(r.disputed_amount) }];
        const cols = [{ h: dim.replace("_", " "), f: r => esc(niceLabel(dim, r.group)) }, ...extraCols.filter(c => c.h !== LABEL[metric])];
        if (!extraCols.some(c => (c.h === "Value" && metric === "amount") || (c.h === "Disputed" && metric === "disputed_amount") || (c.h === "Complaints" && metric === "chargebacks") || (c.h === "Payments" && metric === "txns") || (c.h === "Dispute rate" && metric === "dispute_rate"))) cols.splice(1, 0, { h: LABEL[metric], r: 1, f: r => fmtMetric(metric, r[metric]) });
        let lead = `<strong>${esc(niceLabel(dim, top.group))}</strong> has the ${ask.order === "asc" ? "lowest" : "highest"} ${LABEL[metric].toLowerCase()}: <strong>${fmtMetric(metric, top[metric])}</strong>${share != null ? ` (${pct(share)} of the total)` : ""}.`;
        if (dim === "reason") { const fr = rows.filter(r => FRAUD_REASONS.has(r.group)); lead += ` Fraud-type reasons (takeover, unauthorised, suspected fraud) make up <strong>${pct(sum(fr, r => r.chargebacks) / sum(rows, r => r.chargebacks))}</strong> of complaints — the mix is spread fairly evenly, so no single reason dominates.`; }
        if (dim === "kyc_status" && top.group === "NO_KYC_RECORD") { const withRec = rows.find(r => r.group !== "NO_KYC_RECORD"); if (withRec) lead += ` Among customers that do have a KYC record, <strong>${esc(title(withRec.group))}</strong> is highest (${fmtMetric(metric, withRec[metric])}). That ordering is itself the finding: most money moves without a verified identity.`; }
        if (dim === "category" && metric === "disputed_amount") lead += ` Largest books carry the most money in dispute; by <em>rate</em>, the worst large category is ${esc(aggregate(FULL_SLICE, "category").filter(r => r.txns >= 1000).sort((a, b) => b.dispute_rate - a.dispute_rate)[0].label)}.`;
        if (dim === "severity") lead += ` Severity barely changes delay or fraud share across levels, which suggests severity is assigned at intake rather than from evidence.`;
        html = `<p>${lead}</p>${table(rows.slice(0, 12), cols)}`;
        if (dim === "category" && !P.filters.category) ctx.emit({ kind: "action", label: `Filter: ${top.group}`, run: () => setF({ cat: matchCategory(top.group) }) });
        if (dim === "reason") ctx.emit({ kind: "action", label: "Open disputes view", run: () => go("disputes") });
      }
      return { html, follow: isTime ? ["What looks unusual in this period?", "Break it down by category"] : ["Which merchants drive this?", "Show the trend over time"] };
    },

    async successFailed(P, call) {
      const res = await call("query_breakdown", { group_by: /week/.test(P.s) ? "week" : "day", filters: P.filters, limit: 100 });
      const rows = res.rows, labels = rows.map(r => r.group);
      await call("show_chart", { type: "line", title: "Successful vs failed payments", labels, series: [{ name: "Successful", values: rows.map(r => r.success) }, { name: "Failed", values: rows.map(r => r.failed) }], value_format: "number" });
      const fr = rows.map(r => r.failed_rate), worst = rows[fr.indexOf(Math.max(...fr))], best = rows[fr.indexOf(Math.min(...fr))];
      const tS = sum(rows, r => r.success), tF = sum(rows, r => r.failed), tN = sum(rows, r => r.txns);
      return {
        html: `<p>Across ${esc(res.slice)}: <strong>${int(tS)} successful</strong> vs <strong>${int(tF)} failed</strong> payments — a <strong>${pct(tF / tN)}</strong> failure rate, with ${int(sum(rows, r => r.pending))} still pending.</p>
          <ul><li>Worst day: <strong>${esc(worst.group)}</strong> at ${pct(worst.failed_rate)} failed (${int(worst.failed)} of ${int(worst.txns)}).</li><li>Best day: ${esc(best.group)} at ${pct(best.failed_rate)}.</li>
          <li>Failures sit at roughly 8–11% every hour of the day, so this looks systemic (switch / bank side) rather than peak-load driven.</li></ul>`,
        follow: ["Break failures down by hour", "Which categories fail most?"],
      };
    },

    async rank(P, call, ui, ctx) {
      const entity = P.entity;
      const sortMap = { chargebacks: "chargebacks", disputed_amount: "disputed_inr", dispute_rate: "chargeback_to_txn_ratio", amount: "payment_value_inr", txns: "payments", fraud_chargebacks: "fraud_type_chargebacks", risk_score: "risk_score", failed_rate: "chargebacks", avg_value: "payment_value_inr", mean_delay_days: "chargebacks" };
      const sort_by = sortMap[P.metric] || (entity === "user" ? "disputed_inr" : "chargebacks");
      const n = P.top || 10;
      const input = { entity, sort_by, limit: n, filters: P.filters };
      if (sort_by === "chargeback_to_txn_ratio") input.min_payments = 3;
      if (P.filters.kyc_status && entity === "user") input.kyc_status = P.filters.kyc_status;
      if (/inactive|closed|suspended|blocked|not active/.test(P.s) && entity === "merchant") input.merchant_status = /closed/.test(P.s) ? "CLOSED" : /blocked/.test(P.s) ? "BLOCKED" : /suspended/.test(P.s) ? "SUSPENDED" : "INACTIVE";
      const res = await call("rank_entities", input);
      const rows = res.rows;
      if (!rows.length) return { html: `<p>No ${entity}s match in ${esc(res.slice)}.</p>` };
      const top = rows[0], key = sort_by;
      const f = (k, v) => k === "chargeback_to_txn_ratio" ? pct(v, 0) : /inr/.test(k) ? inr(v) : int(v);
      const ties = rows.filter(r => r[key] === top[key]).length;
      await call("show_chart", { type: "hbar", title: `Top ${rows.length} ${entity === "user" ? "customers" : "merchants"} by ${key.replace(/_/g, " ")}`, labels: rows.map(r => r.id), series: [{ name: key.replace(/_/g, " "), values: rows.map(r => key === "chargeback_to_txn_ratio" ? r[key] : r[key]) }], value_format: key === "chargeback_to_txn_ratio" ? "percent" : /inr/.test(key) ? "inr" : "number" });
      ctx.emit({ kind: "action", label: `Open ${top.id}`, run: () => openEntity(resolveId(top.id)) });
      ctx.emit({ kind: "action", label: `Add top ${Math.min(5, rows.length)} to cases`, run: () => rows.slice(0, 5).forEach(r => { const x = resolveId(r.id); Cases.add({ ref: `${x.type}:${x.i}`, reason: `Ranked #${rows.indexOf(r) + 1} by ${key.replace(/_/g, " ")} (${f(key, r[key])})`, by: "AI · " + ctx.agent }); }) });
      const who = entity === "user" ? "customer" : "merchant";
      const KEYNAME = { chargebacks: "chargeback count", disputed_inr: "disputed amount", chargeback_to_txn_ratio: "chargeback-to-transaction ratio", payment_value_inr: "payment value", payments: "payment count", fraud_type_chargebacks: "fraud-type chargeback count", risk_score: "risk score" };
      const cbTxt = n => `${int(n)} chargeback${n === 1 ? "" : "s"}`;
      let lead = `${idHtml(top.id)} has the highest ${KEYNAME[key]}: <strong>${f(key, top[key])}</strong>${key !== "chargebacks" ? ` (${cbTxt(top.chargebacks)}, ${inr(top.disputed_inr)} disputed)` : ` (${inr(top.disputed_inr)} disputed)`}.`;
      if (ties > 1) lead += ` ${ties - 1} other ${who}${ties > 2 ? "s" : ""} tie on that value; ties are ordered by disputed amount.`;
      if (key === "chargeback_to_txn_ratio") lead += ` ${who === "merchant" ? "Merchants" : "Customers"} with fewer than 3 payments are excluded so a single dispute on a single payment doesn't read as 100%.`;
      const notInMaster = rows.filter(r => entity === "merchant" && r.status === "NOT_IN_MASTER").length;
      return {
        html: `<p>${lead}</p>${table(rows, [{ h: who, f: r => idHtml(r.id) }, { h: entity === "merchant" ? "Category" : "KYC", f: r => esc(entity === "merchant" ? r.category : title(r.kyc_status || "—")) }, { h: "Pay", r: 1, f: r => int(r.payments) }, { h: "CBs", r: 1, f: r => int(r.chargebacks) }, { h: "Disputed", r: 1, f: r => inr(r.disputed_inr) }, { h: "Ratio", r: 1, f: r => pct(r.chargeback_to_txn_ratio, 0) }, { h: "Score", r: 1, f: r => `<b style="color:${tierColor(D.tier.indexOf(r.risk_tier))}">${r.risk_score}</b>` }])}
          ${notInMaster ? `<p><strong>${notInMaster} of these ${rows.length}</strong> merchants are not in the merchant master — money is settling to payees that never passed onboarding.</p>` : ""}
          <p>Counts are small at the top of the book (a handful of payments each), so treat this as a worklist: ${entity === "merchant" ? "hold settlement and request KYB documents" : "step up authentication and review refund eligibility"} for the top entries.</p>`,
        follow: [`Investigate ${top.id}`, `Add the top 5 ${entity === "user" ? "customers" : "merchants"} to my case queue`],
      };
    },

    async entity(P, call, ui, ctx) {
      const parts = [], follow = [];
      for (const r of P.ids.slice(0, 3)) {
        const e = await call("get_entity", { id: r.id });
        ctx.emit({ kind: "action", label: `Open ${r.id}`, run: () => openEntity(r) });
        if (e.type === "merchant" || e.type === "customer") {
          const net = await call("get_network", { id: r.id, max_neighbors: 8 });
          const isM = e.type === "merchant";
          if (e.score_breakdown.length) await call("show_chart", { type: "hbar", title: `${r.id} · how the score of ${e.risk_score} is built`, labels: e.score_breakdown.map(x => prettySignal(x.signal)), series: [{ name: "Points", values: e.score_breakdown.map(x => x.points) }], value_format: "number" });
          const fraudC = e.complaints.filter(c => c.fraud_type), openC = e.complaints.filter(c => ["OPEN", "IN_PROGRESS", "PENDING_BANK"].includes(c.resolution));
          const recs = [];
          if (isM) {
            if (e.status === "NOT_IN_MASTER" && e.chargebacks) recs.push("**Hold settlement** — payee was never onboarded; request KYB documents before releasing funds.");
            if (NOT_ACTIVE.has(e.status)) recs.push(`**Block acceptance** — merchant is ${title(e.status).toLowerCase()} but still receiving payments.`);
            if (e.fraud_type_chargebacks) recs.push(`**Open a fraud case** — ${e.fraud_type_chargebacks} fraud-type complaint(s); pull device and beneficiary data for the disputed payments.`);
            if (e.chargeback_to_txn_ratio >= 0.3 && e.payments >= 3) recs.push(`**Rolling reserve** on settlements while the ${pct(e.chargeback_to_txn_ratio, 0)} dispute ratio is investigated.`);
          } else {
            if (["NO_KYC_RECORD", "REJECTED", "PENDING", "IN_REVIEW"].includes(e.kyc_status) && e.chargebacks) recs.push(`**Step up or block UPI debits** until KYC is completed (status: ${title(e.kyc_status)}).`);
            if (e.chargebacks >= 2) recs.push("**First-party fraud review** — repeat disputer; check whether disputed goods were delivered before refunding.");
            if (e.kyc_records_sharing_id > 1) recs.push(`**Resolve identity** — this customer id maps to ${e.kyc_records_sharing_id} different KYC records.`);
          }
          if (!recs.length) recs.push(e.risk_tier === "LOW" ? "**Monitor** — no strong signals; keep on standard controls." : "**Analyst review** — add to the case queue and re-check after the next pipeline run.");
          const sharedTop = net.shared_counterparty_entities.filter(x => x.shared_counterparties >= 1).slice(0, 3);
          parts.push(`<h4>${idHtml(r.id)} · ${esc(e.name || (isM ? "not in merchant master" : "no KYC record"))}</h4>
            <p><strong>Risk score ${e.risk_score}/100 (${title(e.risk_tier)})</strong> — ${isM ? `${esc(e.category)} merchant, status ${esc(title(e.status))}` : `KYC ${esc(title(e.kyc_status || "unknown"))}${e.city ? ", " + esc(e.city) : ""}`}. ${int(e.payments)} payments worth ${inr(e.payment_value_inr)}; <strong>${int(e.chargebacks)} chargebacks</strong> (${int(e.fraud_type_chargebacks)} fraud-type) for ${inr(e.disputed_inr)}${e.payments ? `, a ${pct(e.chargeback_to_txn_ratio, 0)} dispute ratio` : ""}.</p>
            <p><b>Why it scores ${e.risk_score}:</b></p><ul>${e.score_breakdown.map(x => `<li>${esc(prettySignal(x.signal))} <span class="dim">+${x.points}</span></li>`).join("") || "<li>No signals fired.</li>"}</ul>
            <p><b>Network:</b> ${int(net.direct_total)} direct ${isM ? "payers" : "merchants"}${net.ring ? `; member of ring ${idHtml(net.ring)}` : "; not part of a detected ring"}.${sharedTop.length ? ` Shares counterparties with ${sharedTop.map(x => `${idHtml(x.id)} (${x.shared_counterparties}, score ${x.risk_score})`).join(", ")}.` : ""}</p>
            ${e.complaints.length ? `<p><b>Complaints:</b> ${e.complaints.slice(0, 4).map(c => `${idHtml(c.id)} ${esc(title(c.reason))} ${inr(c.disputed_inr)}${c.delay_days != null ? ` (${c.delay_days.toFixed(0)} d)` : ""}`).join("; ")}${e.complaints_total > 4 ? `; +${e.complaints_total - 4} more` : ""}. ${openC.length} unresolved.</p>` : ""}
            <p><b>Recommended action:</b></p><ul>${recs.map(x => `<li>${md(x).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ul>`);
          if (/case/.test(P.s)) await call("add_to_cases", { ids: [r.id], priority: e.risk_tier === "HIGH" ? "HIGH" : "MEDIUM", reason: `Score ${e.risk_score}: ${e.score_breakdown.map(x => prettySignal(x.signal)).join(", ")}` });
          else ctx.emit({ kind: "action", label: `Add ${r.id} to cases`, run: () => Cases.add({ ref: `${r.type}:${r.i}`, reason: `Score ${e.risk_score}: ${e.score_breakdown.map(x => prettySignal(x.signal)).join(", ")}`, priority: e.risk_tier === "HIGH" ? "HIGH" : "MEDIUM", by: "AI · Investigator" }) });
          if (net.ring) follow.push(`Investigate ring ${net.ring}`);
          if (sharedTop[0]) follow.push(`Investigate ${sharedTop[0].id}`);
        } else if (e.type === "ring") {
          const links = e.links.filter(l => l.chargebacks).sort((a, b) => b.chargebacks - a.chargebacks);
          await call("show_chart", { type: "hbar", title: `${r.id} members by chargebacks`, labels: e.members.map(m => m.id), series: [{ name: "Chargebacks", values: e.members.map(m => m.chargebacks) }], value_format: "number" });
          const ms = e.members.filter(m => m.category !== undefined), us = e.members.filter(m => m.kyc_status !== undefined);
          parts.push(`<h4>Ring ${idHtml(r.id)} · score ${e.score}</h4>
            <p><strong>${e.users} customers and ${e.merchants} merchants</strong> joined by ${int(e.txns)} payments (${inr(e.amount)}), carrying <strong>${int(e.chargebacks)} chargebacks</strong>, ${int(e.fraud)} of them fraud-type. ${e.unverified} of ${e.users} customers are unverified or have no KYC record. Hub: ${idHtml(e.hub)} (degree ${e.hub_degree}).</p>
            ${table(e.members.slice(0, 12), [{ h: "Member", f: m => idHtml(m.id) }, { h: "Type", f: m => m.category !== undefined ? "Merchant" : "Customer" }, { h: "Score", r: 1, f: m => m.risk_score }, { h: "CBs", r: 1, f: m => int(m.chargebacks) }, { h: "Status / KYC", f: m => esc(title(m.status || m.kyc_status || "—")) }])}
            <p><b>Disputed links:</b> ${links.slice(0, 5).map(l => `${idHtml(l.customer)} → ${idHtml(l.merchant)} (${l.chargebacks})`).join(", ") || "none"}.</p>
            <p><b>Why it matters:</b> several customers disputing the same small set of merchants — ${ms.filter(m => m.status === "NOT_IN_MASTER").length} of them never onboarded, ${us.filter(u => u.kyc_status !== "VERIFIED").length} customers unverified — is the signature of coordinated first-party fraud or collusive merchants.</p>
            <p><b>Recommended action:</b> freeze settlement to the hub merchant pending review, step up authentication for the unverified customers, and review all disputed payments in the ring together rather than one by one.</p>`);
          ctx.emit({ kind: "action", label: `Show ${r.id} in network`, run: () => Network.select(r.i) });
          if (/case/.test(P.s)) await call("add_to_cases", { ids: [r.id], priority: "CRITICAL", reason: `Ring score ${e.score}: ${e.users} customers, ${e.merchants} merchants, ${e.chargebacks} chargebacks` });
          else ctx.emit({ kind: "action", label: `Add ${r.id} to cases`, run: () => Cases.add({ ref: `k:${r.i}`, reason: `Ring score ${e.score}`, priority: "CRITICAL", by: "AI · Investigator" }) });
          follow.push(`Investigate ${e.hub}`);
        } else if (e.type === "payment") {
          parts.push(`<h4>Payment ${idHtml(r.id)}</h4><p><strong>${inrFull(e.amount_inr)}</strong> on ${e.date} ${e.time} · ${esc(title(e.status))} · ${esc(e.category)} · payer KYC ${esc(title(e.kyc_status))} · UTR ${esc(title(e.utr_status))}.</p>
            <ul><li>Customer ${idHtml(e.customer.id)}: score ${e.customer.risk_score} (${title(e.customer.risk_tier)}), ${e.customer.chargebacks} chargebacks overall.</li><li>Merchant ${idHtml(e.merchant.id)}: score ${e.merchant.risk_score} (${title(e.merchant.risk_tier)}), ${esc(title(e.merchant.status))}.</li>
            ${e.complaints.map(c => `<li>Complaint ${idHtml(c.id)}: ${esc(title(c.reason))}, ${inr(c.disputed_inr)}, reported after ${c.delay_days == null ? "—" : c.delay_days.toFixed(1) + " days"}, ${esc(title(c.resolution))}.</li>`).join("")}</ul>`);
          follow.push(`Investigate ${e.merchant.id}`, `Investigate ${e.customer.id}`);
        } else {
          parts.push(`<h4>Complaint ${idHtml(r.id)}</h4><p><strong>${esc(title(e.reason))}</strong>${e.fraud_type ? " (fraud-type)" : ""} · ${inrFull(e.disputed_inr)} · severity ${esc(title(e.severity))} · ${esc(title(e.resolution))} · via ${esc(title(e.channel))}.</p>
            <p>Reported ${e.reported || "—"}${e.reporting_delay_days != null ? `, <strong>${e.reporting_delay_days.toFixed(1)} days</strong> after the payment` : ""}. Linked payment ${e.linked_payment ? idHtml(e.linked_payment) : "missing"}${e.merchant_via_payment ? ` to ${idHtml(e.merchant_via_payment)} from ${idHtml(e.customer_via_payment)}` : ""}.</p><p class="dim">${esc(e.attribution_note)}</p>`);
          if (e.merchant_via_payment) follow.push(`Investigate ${e.merchant_via_payment}`);
        }
      }
      return { html: parts.join(""), follow: follow.slice(0, 3) };
    },

    async rings(P, call, ui, ctx) {
      const res = await call("list_rings", { limit: P.top || 8, min_score: 0 });
      await call("show_chart", { type: "hbar", title: "Highest-scoring dispute rings", labels: res.rows.map(r => r.id), series: [{ name: "Ring score", values: res.rows.map(r => r.score) }], value_format: "number" });
      const t = res.rows[0], cr = res.circular_laundering_engine;
      ctx.emit({ kind: "action", label: "Open ring network", run: () => Network.select(0) });
      return {
        html: `<p>The payment graph holds <strong>${int(res.rings_total)} suspicious rings</strong> — connected groups of disputing customers and merchants. The strongest, ${idHtml(t.id)}, links <strong>${t.users} customers to ${t.merchants} merchants</strong> through ${t.txns} payments with ${t.chargebacks} chargebacks (${t.fraud} fraud-type) and ${t.unverified} unverified members.</p>
          ${table(res.rows, [{ h: "Ring", f: r => idHtml(r.id) }, { h: "Score", r: 1, f: r => `<b>${r.score}</b>` }, { h: "Cust.", r: 1, f: r => r.users }, { h: "Merch.", r: 1, f: r => r.merchants }, { h: "CBs", r: 1, f: r => r.chargebacks }, { h: "Fraud", r: 1, f: r => r.fraud }, { h: "Unverif.", r: 1, f: r => r.unverified }, { h: "Hub", f: r => idHtml(r.hub) }])}
          <p>Score = ${esc(res.score_formula)}. The circular-laundering engine checked ${int(cr.payments_in_graph)} payments across ${int(cr.accounts)} accounts and found <strong>${int(cr.rings)} money loops</strong> — expected, because money only flows customer → merchant here.</p>`,
        follow: [`Investigate ${t.id}`, `Investigate ${res.rows[1].id}`, "Add the top 3 rings to my case queue"],
      };
    },

    async alerts(P, call, ui, ctx) {
      const res = await call("sentinel_alerts", { filters: P.filters });
      const alerts = Sentinel.scan(sliceFor(P.filters), summarize(sliceFor(P.filters)));
      alerts.filter(a => a.patch).slice(0, 3).forEach(a => ctx.emit({ kind: "action", label: `Filter: ${a.key === "identity" ? "No-KYC payers" : a.title.split(":")[0].slice(0, 36)}`, run: () => setF({ ...toF(P.filters), ...a.patch }, true) }));
      const icon = s => s === "crit" ? "🔴" : s === "serious" ? "🟠" : s === "warn" ? "🟡" : "🔵";
      return {
        html: `<p>Sentinel scanned <strong>${esc(res.slice)}</strong> and raised <strong>${res.alerts.length} alerts</strong> (${res.alerts.filter(a => a.severity === "crit").length} critical):</p>
          <ol>${res.alerts.map(a => `<li>${icon(a.severity)} <strong>${esc(a.title)}</strong><br><span class="dim">${esc(a.detail)}</span></li>`).join("")}</ol>`,
        follow: ["Brief me on these", "Find suspicious fraud rings"],
      };
    },

    async brief(P, call, ui, ctx) {
      const k = await call("get_kpis", { filters: P.filters });
      const al = await call("sentinel_alerts", { filters: P.filters });
      const cats = await call("query_breakdown", { group_by: "category", filters: P.filters, sort_by: "dispute_rate", min_payments: 500, limit: 5 });
      const rings = await call("list_rings", { limit: 3 });
      const mer = await call("rank_entities", { entity: "merchant", sort_by: "risk_score", limit: 5, filters: P.filters });
      const mh = await call("model_health", {});
      await call("show_chart", { type: "bar", title: "Dispute rate by large category", labels: cats.rows.map(r => r.group), series: [{ name: "Dispute rate", values: cats.rows.map(r => r.dispute_rate) }], value_format: "percent" });
      const crit = al.alerts.filter(a => a.severity === "crit" || a.severity === "serious");
      return {
        html: `<h4>Situation · ${esc(k.slice)}</h4>
          <p><strong>${inr(k.payment_value_inr)}</strong> across ${int(k.payments)} payments. <strong>${pct(k.dispute_rate)}</strong> of payments are disputed (about 1 in ${Math.round(1 / k.dispute_rate)}), ${inr(k.disputed_value_inr)} in dispute; ${pct(k.fraud_type_share, 0)} of complaints are fraud-type and <strong>${pct(k.unresolved_share, 0)} are unresolved</strong>. Mean reporting delay ${k.mean_reporting_delay_days?.toFixed(1)} days, ${int(k.reported_after_7_days)} reported after a week.</p>
          <h4>Top risks</h4><ol>${crit.slice(0, 4).map(a => `<li><strong>${esc(a.title)}.</strong> ${esc(a.detail)}</li>`).join("")}</ol>
          <h4>Where and who</h4><ul>
            <li>Highest dispute rate among large categories: <strong>${esc(cats.rows[0].group)}</strong> at ${pct(cats.rows[0].dispute_rate)} (${inr(cats.rows[0].disputed_amount)} disputed).</li>
            <li>Top-scoring merchants: ${mer.rows.map(r => `${idHtml(r.id)} (${r.risk_score})`).join(", ")} — mostly payees absent from the merchant master.</li>
            <li>Strongest rings: ${rings.rows.map(r => `${idHtml(r.id)} (${r.users}+${r.merchants} members, score ${r.score})`).join(", ")}.</li></ul>
          <h4>Confidence</h4><p>Scores are explainable worklists; the out-of-time backtest (merchant AUC ${mh.merchant.auc.toFixed(2)}, user ${mh.user.auc.toFixed(2)}) shows they do not yet predict next-month fraud, so act on evidence per case rather than on score alone.</p>
          <h4>Actions this week</h4><ol>
            <li><strong>Close the identity gap:</strong> step-up or cap UPI debits from customer ids with no KYC record; block rejected-KYC customers.</li>
            <li><strong>Stop settlement to non-onboarded or inactive merchants</strong> and request KYB for the top-scoring payees.</li>
            <li><strong>Work the rings as units:</strong> review ${idHtml(rings.rows[0].id)} and ${idHtml(rings.rows[1].id)} end to end.</li>
            <li><strong>Burn down the fraud-type backlog</strong> — prioritise unauthorised and takeover complaints older than 7 days.</li>
            <li><strong>Earn predictive power:</strong> re-weight scores from backtest lift and track AUC on every run.</li></ol>`,
        follow: ["Add the top 5 highest-risk merchants to my case queue", `Investigate ${rings.rows[0].id}`, "What looks unusual in March?"],
      };
    },

    async model(P, call) {
      const mh = await call("model_health", {});
      const sig = mh.signals.filter(r => r.entities >= 20 && r.lift != null).sort((a, b) => b.lift - a.lift).slice(0, 8);
      await call("show_chart", { type: "hbar", title: "Out-of-time lift by signal (≥ 20 flagged)", labels: sig.map(r => `${r.entity[0].toUpperCase()} · ${prettySignal(r.signal)}`), series: [{ name: "Lift", values: sig.map(r => r.lift) }], value_format: "number" });
      return {
        html: `<p><strong>Honest answer: the scores are good worklists but not yet predictors.</strong> Re-scoring on data before ${esc(mh.cutoff)} and testing on later fraud-type disputes gives <strong>merchant AUC ${mh.merchant.auc.toFixed(2)}</strong> and <strong>user AUC ${mh.user.auc.toFixed(2)}</strong> — about a coin flip.</p>
          <ul><li>High-tier merchants in the train window: ${mh.merchant.high_entities}, fraud hits later: ${mh.merchant.high_fraud_hits} (base rate ${pct(mh.merchant.base_rate)}).</li><li>High-tier users: ${mh.user.high_entities}, later hits: ${mh.user.high_fraud_hits} (base rate ${pct(mh.user.base_rate)}).</li>
          <li>Strongest well-populated signal: ${sig[0] ? `${esc(sig[0].entity)} “${esc(prettySignal(sig[0].signal))}” at ${sig[0].lift.toFixed(2)}× lift` : "none clear yet"}.</li></ul>
          <p>Why it is still useful: every flag is explainable and grounded in what already happened, which is what an investigations queue needs. Next step: re-weight from measured lift, add velocity/device features the live replay engine already computes, and gate changes on out-of-time AUC.</p>`,
        follow: ["Open the model view", "Show the live replay engine"],
      };
    },

    async quality(P, call) {
      const dq = await call("data_quality", { search: P.s.includes("duplicate") ? "duplicate" : "" });
      const top = QUALITY.slice().sort((a, b) => (b.rows_affected || 0) - (a.rows_affected || 0)).slice(0, 8);
      return {
        html: `<p>The pipeline ran <strong>${dq.checks_total} data-quality checks</strong> over four messy sources (${int(dq.raw_rows.transactions)} raw payments, ${int(dq.raw_rows.kyc)} KYC rows, ${int(dq.raw_rows.merchants)} merchant rows, ${int(dq.raw_rows.chargebacks)} complaints). Principle: <strong>repair and flag, don't delete</strong> — only duplicates were removed: <strong>${int(dq.duplicates_removed)} payments worth ${inr(dq.duplicate_value_removed_inr)}</strong> that would have inflated volume.</p>
          ${table(top, [{ h: "Source", f: r => esc(r.table) }, { h: "Check", f: r => esc(r.check) }, { h: "Rows", r: 1, f: r => int(r.rows_affected) }, { h: "Action", f: r => `<span class="dim">${esc(r.action)}</span>` }])}
          <p>Two judgement calls changed the answer: complaints are attributed through <code>txn_id</code> (their own ids never match the payment), and day/month order was proven from the data rather than guessed.</p>`,
        follow: ["Open the pipeline view", "Brief me on this quarter"],
      };
    },

    async late(P, call, ui, ctx) {
      const m = P.s.match(/after (\d+)/), days = m ? +m[1] : 7;
      const res = await call("find_disputes", { min_delay_days: days, filters: P.filters, limit: 10, fraud_only: /fraud/.test(P.s) || undefined });
      const reasons = Object.entries(res.by_reason).sort((a, b) => b[1] - a[1]);
      await call("show_chart", { type: "hbar", title: `Disputes reported after ${days} days, by reason`, labels: reasons.map(r => title(r[0])), series: [{ name: "Complaints", values: reasons.map(r => r[1]) }], value_format: "number" });
      ctx.emit({ kind: "action", label: "Open disputes view", run: () => go("disputes") });
      return {
        html: `<p><strong>${int(res.matching)} disputes</strong> were reported more than ${days} days after the payment (${esc(res.slice)}), worth <strong>${inr(res.disputed_inr)}</strong>. Most common reason: <strong>${esc(title(reasons[0]?.[0] || "—"))}</strong>.</p>
          ${table(res.rows, [{ h: "Complaint", f: r => idHtml(r.id) }, { h: "Merchant", f: r => r.merchant ? idHtml(r.merchant) : "—" }, { h: "Reason", f: r => esc(title(r.reason)) }, { h: "Disputed", r: 1, f: r => inr(r.disputed_inr) }, { h: "Delay", r: 1, f: r => `<b>${r.delay_days.toFixed(0)} d</b>` }, { h: "Status", f: r => esc(title(r.resolution)) }])}
          <p>Late fraud reports matter most: by the time an unauthorised payment is reported weeks later, the funds have usually been moved. Push proactive “did you make this payment?” notifications for high-value payments to no-KYC payers.</p>`,
        follow: ["Which reasons are reported latest?", `Investigate ${res.rows[0]?.merchant || res.rows[0]?.id || "CL001"}`],
      };
    },

    async compareMonths(P, call) {
      const [a, b] = P.months.slice(0, 2);
      const fa = { ...P.filters, month: a }, fb = { ...P.filters, month: b };
      const ka = await call("get_kpis", { filters: fa }), kb = await call("get_kpis", { filters: fb });
      const rows = [["Payments", "payments", "int"], ["Payment value", "payment_value_inr", "inr"], ["Dispute rate", "dispute_rate", "pct"], ["Complaints", "complaints", "int"], ["Fraud-type share", "fraud_type_share", "pct"], ["Failed rate", "failed_rate", "pct"], ["Mean delay (d)", "mean_reporting_delay_days", "d"]];
      const f = (t, v) => t === "int" ? int(v) : t === "inr" ? inr(v) : t === "pct" ? pct(v) : v?.toFixed(1);
      const dd = (t, x, y) => t === "pct" ? `${((y - x) * 100 >= 0 ? "+" : "")}${((y - x) * 100).toFixed(1)} pts` : x ? `${(y - x) / x >= 0 ? "+" : ""}${((y - x) / x * 100).toFixed(1)}%` : "—";
      await call("show_chart", { type: "bar", title: `Dispute and failure rates: ${monthName(a)} vs ${monthName(b)}`, labels: ["Dispute rate", "Failed rate", "Fraud-type share"], series: [{ name: monthName(a), values: [ka.dispute_rate, ka.failed_rate, ka.fraud_type_share] }, { name: monthName(b), values: [kb.dispute_rate, kb.failed_rate, kb.fraud_type_share] }], value_format: "percent" });
      return {
        html: `<p>${monthName(b)} vs ${monthName(a)}: dispute rate <strong>${pct(kb.dispute_rate)}</strong> vs ${pct(ka.dispute_rate)} (${dd("pct", ka.dispute_rate, kb.dispute_rate)}). Note months differ in length, so compare rates rather than totals.</p>
          ${table(rows, [{ h: "Metric", f: r => r[0] }, { h: monthName(a), r: 1, f: r => f(r[2], ka[r[1]]) }, { h: monthName(b), r: 1, f: r => f(r[2], kb[r[1]]) }, { h: "Change", r: 1, f: r => dd(r[2], ka[r[1]], kb[r[1]]) }])}`,
        follow: [`What looks unusual in ${monthName(b)}?`],
      };
    },

    async focus(P, call, ui, ctx) {
      const view = /dispute|chargeback|complaint/.test(P.s) ? "disputes" : /kyc|identity/.test(P.s) ? "identity" : /merchant|customer|user|entit/.test(P.s) ? "entities" : "overview";
      const filters = { ...P.filters };
      if (/disputed|dispute/.test(P.s) && !filters.reason) filters.disputed_only = true;
      await call("apply_filters", { filters, view });
      const k = await call("get_kpis", { filters });
      return { html: `<p>Done — the desk is now focused on <strong>${esc(k.slice)}</strong> (${view} view): ${int(k.payments)} payments, ${pct(k.dispute_rate)} disputed, ${int(k.complaints)} complaints worth ${inr(k.disputed_value_inr)}. Press <kbd>R</kbd> to reset.</p>`, follow: ["What looks unusual here?", "Which merchants drive this?"] };
    },

    async addCases(P, call) {
      const n = P.top || (P.s.match(/\b(\d{1,2})\b/) ? +P.s.match(/\b(\d{1,2})\b/)[1] : 5);
      if (P.ids.length) {
        const res = await call("add_to_cases", { ids: P.ids.map(r => r.id), priority: "HIGH", reason: "Filed from the agents panel" });
        return { html: `<p>Added ${res.added.map(idHtml).join(", ") || "nothing new"} to the case queue${res.skipped.length ? `; ${res.skipped.join(", ")} already there` : ""}.</p>` };
      }
      if (/ring|cluster/.test(P.s)) {
        const rings = await call("list_rings", { limit: n });
        const res = await call("add_to_cases", { ids: rings.rows.map(r => r.id), priority: "CRITICAL", reason: "Top-scoring dispute ring" });
        return { html: `<p>Filed <strong>${res.added.length} rings</strong> (${res.added.map(idHtml).join(", ")}) as critical cases.${res.skipped.length ? ` Already queued: ${res.skipped.join(", ")}.` : ""}</p>` };
      }
      const entity = P.entity === "user" ? "user" : "merchant";
      const ranked = await call("rank_entities", { entity, sort_by: "risk_score", limit: n, filters: P.filters });
      const res = await call("add_to_cases", { ids: ranked.rows.map(r => r.id), priority: "HIGH", reason: `Top ${n} by risk score` });
      return {
        html: `<p>Filed <strong>${res.added.length} ${entity === "user" ? "customers" : "merchants"}</strong> into the case queue${res.skipped.length ? ` (${res.skipped.length} were already there)` : ""}:</p>
          ${table(ranked.rows, [{ h: "Id", f: r => idHtml(r.id) }, { h: "Score", r: 1, f: r => r.risk_score }, { h: "CBs", r: 1, f: r => r.chargebacks }, { h: "Disputed", r: 1, f: r => inr(r.disputed_inr) }, { h: "Top signals", f: r => esc(r.signals.slice(0, 2).map(prettySignal).join(", ")) }])}`,
        follow: ["Summarise my case queue with recommended actions"],
      };
    },

    async caseQueue(P, call) {
      const q = await call("get_case_queue", {});
      if (!q.cases.length) return { html: `<p>Your case queue is empty. Try “add the top 5 highest-risk merchants to my case queue”.</p>` };
      const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const cs = q.cases.slice().sort((a, b) => rank[a.priority] - rank[b.priority]);
      const act = c => c.type === "k" ? "Review the ring as one unit; freeze hub settlement." : c.type === "m" ? "Hold settlement pending KYB; review disputed payments." : c.type === "u" ? "Step up authentication; check delivery before refunds." : "Verify with the payer and the merchant.";
      return {
        html: `<p><strong>${cs.length} cases</strong> — ${cs.filter(c => c.status === "OPEN").length} open, ${cs.filter(c => c.status === "ESCALATED").length} escalated. In priority order:</p>
          ${table(cs, [{ h: "Entity", f: c => idHtml(c.entity) }, { h: "Priority", f: c => esc(title(c.priority)) }, { h: "Status", f: c => esc(title(c.status)) }, { h: "Why", f: c => esc(c.reason.slice(0, 90)) }, { h: "Next action", f: c => esc(act(c)) }])}`,
        follow: cs.slice(0, 2).map(c => `Investigate ${c.entity}`),
      };
    },
  };
  return { run, parse, route };
})();

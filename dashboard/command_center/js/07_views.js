/* =====================================================================================
   07 · Disputes, Identity/KYC, Model health, Pipeline & quality, Case queue
   ===================================================================================== */
function kpiTiles(el, tiles) {
  $(el).innerHTML = tiles.map(([l, v, foot]) => `<div class="kpi" style="cursor:default"><span class="lbl">${l}</span><span class="val">${v}</span><span class="foot">${foot}</span></div>`).join("");
}

/* ------------------------------------------------------------------ Disputes */
VIEWS.disputes = {
  render(sl, s) {
    kpiTiles("d-kpis", [
      ["Complaints", int(s.cbs), `${int(s.disp)} payments disputed`], ["Disputed value", inr(s.cbAmt), `${pct(s.amtRatio, 2)} of payment value`],
      ["Fraud-type", pct(s.fraudShare, 0), `${int(s.fraud)} complaints · ${inr(s.fraudAmt)}`], ["Unresolved", pct(s.openShare, 0), `${int(s.open)} · ${inr(s.openAmt)}`],
      ["Mean delay", s.delayMean == null ? "—" : s.delayMean.toFixed(1) + " d", `median ${s.delayMedian == null ? "—" : s.delayMedian.toFixed(1)} d`], ["Reported > 7 days", int(s.late), s.cbs ? pct(s.late / s.cbs, 0) + " of complaints" : ""],
    ]);
    // reason × severity heatmap
    const reasons = aggregate(sl, "reason").sort((a, b) => b.chargebacks - a.chargebacks);
    const sevs = SEV_ORDER.map(x => D.sev.indexOf(x));
    const grid = new Map();
    for (let j = 0; j < NC; j++) if (sl.cm[j]) { const k = CB.r[j] + ":" + CB.sv[j]; grid.set(k, (grid.get(k) || 0) + 1); }
    const data = [];
    reasons.forEach((r, y) => sevs.forEach((sv, x) => data.push([x, y, grid.get(r.key + ":" + sv) || 0, r.key])));
    const c1 = chart("c-reason-sev"); observe($("c-reason-sev"));
    const vmax = Math.max(1, ...data.map(d => d[2]));
    // the ramp runs dark→light in dark theme and light→dark in light theme: flip the label ink on the far end
    data.forEach((d, k) => { const far = d[2] / vmax > .7; data[k] = { value: d, label: { color: far ? (theme === "dark" ? "#0b1020" : "#ffffff") : TK.ink } }; });
    c1.setOption(base({
      grid: { left: 8, right: 10, top: 26, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, formatter: p => { const r = reasons[p.value[1]]; return tipHead(`${title(r.label)} · ${title(SEV_ORDER[p.value[0]])}`) + tipRow(TK.seq[3], "Complaints", int(p.value[2])) + tipRow(TK.crit, "Reason fraud-type", FRAUD_REASONS.has(r.label) ? "yes" : "no"); } },
      xAxis: axisCat(SEV_ORDER.map(title), { position: "top", axisLine: { show: false }, axisLabel: { color: TK.ink2, fontSize: 11 } }),
      yAxis: axisCat(reasons.map(r => (FRAUD_REASONS.has(r.label) ? "⚑ " : "") + title(r.label)), { inverse: true, axisLine: { show: false }, axisLabel: { color: TK.ink2, fontSize: 11 } }),
      visualMap: { show: false, dimension: 2, min: 0, max: vmax, inRange: { color: [TK.seq[0], TK.seq[2], TK.seq[3], TK.seq[5]] } },
      series: [
        { type: "heatmap", data, label: { show: true, color: TK.ink, fontSize: 11, formatter: p => p.value[2] || "" }, itemStyle: { borderColor: TK.panel, borderWidth: 3, borderRadius: 5 } },
      ],
    }), true);
    c1.off("click"); c1.on("click", p => { const k = p.value[3]; setF({ rs: F.rs === k ? -1 : k }); });

    // delay histogram
    const buckets = aggregate(sl, "delay_bucket");
    const c2 = chart("c-delay"); observe($("c-delay"));
    c2.setOption(base({
      grid: { left: 8, right: 14, top: 20, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => { const b = buckets[ps[0].dataIndex]; return tipHead(b.label) + tipRow(ps[0].color, "Complaints", int(b.chargebacks)) + tipRow(TK.ink3, "Fraud-type share", pct(b.fraud_share, 0)) + tipRow(TK.ink3, "Disputed", inr(b.disputed_amount)); } },
      xAxis: axisCat(buckets.map(b => b.label), { axisLabel: { color: TK.ink3, fontSize: 10.5, interval: 0 } }), yAxis: axisVal({ splitNumber: 4 }),
      series: [{ type: "bar", data: buckets.map(b => ({ value: b.chargebacks, itemStyle: { color: b.key >= 3 ? TK.serious : TK.s[0], borderRadius: [4, 4, 0, 0] } })), barMaxWidth: 42,
        label: { show: true, position: "top", color: TK.ink2, fontSize: 10.5, formatter: p => int(p.value) },
        markArea: { silent: true, itemStyle: { color: fade(TK.serious, .08) }, label: { show: true, color: TK.serious, fontSize: 10.5, position: "insideTop", formatter: "after 7 days" }, data: [[{ xAxis: buckets.findIndex(b => b.key === 3) }, { xAxis: buckets.length - 1 }]] } }],
    }), true);

    // resolution
    const res = aggregate(sl, "resolution").sort((a, b) => b.chargebacks - a.chargebacks);
    const openSet = new Set(["OPEN", "IN_PROGRESS", "PENDING_BANK"]);
    const c3 = chart("c-resolution"); observe($("c-resolution"));
    c3.setOption(base({
      grid: { left: 8, right: 40, top: 4, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: axisVal({ show: false }), yAxis: axisCat(res.map(r => title(r.label)), { inverse: true, axisLine: { show: false }, axisLabel: { color: TK.ink2, fontSize: 11 } }),
      series: [{ type: "bar", name: "Complaints", data: res.map(r => ({ value: r.chargebacks, itemStyle: { color: openSet.has(r.label) ? TK.warn : fade(TK.s[0], .7), borderRadius: [0, 4, 4, 0] } })), barMaxWidth: 16, label: { show: true, position: "right", color: TK.ink2, fontSize: 10.5 } }],
    }), true);

    // late share by reason
    const late = aggregate(sl, "reason").sort((a, b) => b.late_share - a.late_share);
    const c4 = chart("c-late-reason"); observe($("c-late-reason"));
    c4.setOption(base({
      grid: { left: 8, right: 44, top: 4, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => { const r = late[ps[0].dataIndex]; return tipHead(title(r.label)) + tipRow(ps[0].color, "Reported after 7 days", pct(r.late_share, 0)) + tipRow(TK.ink3, "Mean delay", r.mean_delay_days == null ? "—" : r.mean_delay_days.toFixed(1) + " d"); } },
      xAxis: axisVal({ show: false, max: v => Math.max(.35, v.max) }), yAxis: axisCat(late.map(r => (FRAUD_REASONS.has(r.label) ? "⚑ " : "") + title(r.label)), { inverse: true, axisLine: { show: false }, axisLabel: { color: TK.ink2, fontSize: 10.5 } }),
      series: [{ type: "bar", data: late.map(r => ({ value: r.late_share, itemStyle: { color: FRAUD_REASONS.has(r.label) ? TK.crit : fade(TK.s[0], .7), borderRadius: [0, 4, 4, 0] } })), barMaxWidth: 14, label: { show: true, position: "right", color: TK.ink2, fontSize: 10.5, formatter: p => pct(p.value, 0) } }],
    }), true);

    // channel
    const chs = aggregate(sl, "channel").sort((a, b) => b.chargebacks - a.chargebacks);
    const c5 = chart("c-channel"); observe($("c-channel"));
    c5.setOption(base({
      tooltip: { ...base().tooltip, trigger: "item", formatter: p => tipHead(p.name) + tipRow(p.color, "Complaints", `${int(p.value)} (${p.percent}%)`) },
      legend: { orient: "vertical", right: 0, top: "middle", itemWidth: 9, itemHeight: 9, textStyle: { color: TK.ink2, fontSize: 11 } },
      series: [{ type: "pie", radius: ["48%", "78%"], center: ["36%", "50%"], padAngle: 2, itemStyle: { borderRadius: 5 }, label: { show: false },
        data: chs.slice(0, 6).map((r, k) => ({ name: title(r.label), value: r.chargebacks, itemStyle: { color: TK.s[k] } })) }],
    }), true);

    // late table
    const rows = [];
    for (let j = 0; j < NC; j++) if (sl.cm[j] && CB.dl[j] != null && CB.dl[j] > 7) rows.push(j);
    rows.sort((a, b) => CB.dl[b] - CB.dl[a]);
    $("t-late").innerHTML = `<table><thead><tr><th>Complaint</th><th>Payment</th><th>Merchant</th><th>Reason</th><th>Severity</th><th class="r">Disputed</th><th class="r">Delay</th><th>Status</th></tr></thead><tbody>${rows.slice(0, 80).map(j => {
      const t = CB.t[j];
      return `<tr><td>${cLink(j)}</td><td>${t >= 0 ? tLink(t) : "—"}</td><td>${t >= 0 ? mLink(T.m[t]) : "—"}</td><td>${FRAUD_REASONS.has(D.reason[CB.r[j]]) ? "⚑ " : ""}${esc(title(D.reason[CB.r[j]]))}</td><td>${esc(title(D.sev[CB.sv[j]]))}</td><td class="r">${inrFull(CB.a[j])}</td><td class="r"><b>${CB.dl[j].toFixed(0)} d</b></td><td>${CB.op[j] ? `<span class="pill warn">${esc(title(D.res[CB.rs[j]]))}</span>` : `<span class="pill plain">${esc(title(D.res[CB.rs[j]]))}</span>`}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="empty">No late disputes in this slice.</td></tr>`}</tbody></table>`;
  },
};

/* ------------------------------------------------------------------ Identity */
VIEWS.identity = {
  render(sl, s) {
    const kyc = aggregate(sl, "kyc_status");
    const col = l => l === "VERIFIED" ? TK.s[0] : l === "REJECTED" ? TK.crit : l === "NO_KYC_RECORD" ? TK.serious : l === "PENDING" ? TK.s[6] : TK.s[4];
    const c1 = chart("c-kyc-tree"); observe($("c-kyc-tree"));
    c1.setOption(base({
      tooltip: { ...base().tooltip, formatter: p => { const r = kyc.find(x => title(x.label) === p.name); return r ? tipHead(p.name) + tipRow(p.color, "Payment value", inr(r.amount)) + tipRow(TK.ink3, "Share", pct(r.amount / s.amt)) + tipRow(TK.ink3, "Payments", int(r.txns)) : ""; } },
      series: [{ type: "treemap", roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0,
        itemStyle: { borderColor: TK.panel, borderWidth: 3, gapWidth: 3, borderRadius: 8 },
        label: { show: true, formatter: p => { const r = kyc.find(x => title(x.label) === p.name); return `{n|${p.name}}\n{v|${inr(p.value)}}\n{s|${pct(r.amount / s.amt, 0)} of value}`; }, rich: { n: { fontSize: 12, color: "#fff", fontWeight: 600 }, v: { fontSize: 18, color: "#fff", fontWeight: 600, padding: [4, 0] }, s: { fontSize: 11, color: "rgba(255,255,255,.85)" } } },
        data: kyc.map(r => ({ name: title(r.label), value: r.amount, itemStyle: { color: col(r.label) } })) }],
    }), true);
    c1.off("click"); c1.on("click", p => { const r = kyc.find(x => title(x.label) === p.name); if (r) setF({ kyc: F.kyc === r.key ? -1 : r.key }); });

    const ord = KYC_ORDER.map(l => kyc.find(r => r.label === l)).filter(Boolean);
    const c2 = chart("c-kyc-rate"); observe($("c-kyc-rate"));
    c2.setOption(base({
      grid: { left: 8, right: 20, top: 20, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => { const r = ord[ps[0].dataIndex]; return tipHead(title(r.label)) + tipRow(col(r.label), "Dispute rate", pct(r.dispute_rate)) + tipRow(TK.ink3, "Failed rate", pct(r.failed_rate)) + tipRow(TK.ink3, "Fraud-type share", pct(r.fraud_share, 0)) + tipRow(TK.ink3, "Payments", int(r.txns)); } },
      xAxis: axisCat(ord.map(r => title(r.label)), { axisLabel: { color: TK.ink2, fontSize: 11 } }), yAxis: axisVal({ axisLabel: { color: TK.ink3, fontSize: 10.5, formatter: v => (v * 100).toFixed(0) + "%" } }),
      series: [{ type: "bar", barMaxWidth: 54, data: ord.map(r => ({ value: r.dispute_rate, itemStyle: { color: col(r.label), borderRadius: [5, 5, 0, 0] } })),
        label: { show: true, position: "top", color: TK.ink, fontSize: 11.5, fontWeight: 600, formatter: p => pct(p.value) },
        markLine: { silent: true, symbol: "none", lineStyle: { color: TK.ink3, type: [4, 4] }, label: { color: TK.ink3, formatter: `slice ${pct(s.ratio)}`, fontSize: 10 }, data: [{ yAxis: s.ratio }] } }],
    }), true);
    c2.off("click"); c2.on("click", p => { const r = ord[p.dataIndex]; setF({ kyc: F.kyc === r.key ? -1 : r.key }); });

    const by = byKey(kyc, "label"), rej = by.REJECTED, none = by.NO_KYC_RECORD, ver = by.VERIFIED;
    const multi = U.idc.filter(x => x > 1).length;
    $("kyc-callouts").innerHTML = [
      none && ["🪪", `${pct(none.amount / s.amt, 0)} of value has no identity`, `${int(none.txns)} payments worth ${inr(none.amount)} came from customer IDs absent from KYC. Block or step-up unknown payers above a threshold.`],
      rej && ver && ["⛔", `Rejected KYC still transacts: ${int(rej.txns)} payments`, `Rejected customers dispute ${pct(rej.dispute_rate)} of payments vs ${pct(ver.dispute_rate)} for verified. A rejection should stop UPI debits.`],
      ["👥", `6,288 KYC customer IDs map to several people`, `ID collisions in the KYC master: the pipeline keeps every record and flags ${int(multi)} paying customers whose ID is shared.`],
      ["📉", `KYC completion ${pct(K.kyc_completion_rate, 1)} · rejection ${pct(K.kyc_rejection_rate, 1)}`, `Across ${int(K.users)} KYC customers. Pending and in-review customers are allowed to pay while unverified.`],
    ].filter(Boolean).map(([i, h, p]) => `<div class="callout"><h4>${i} ${esc(h)}</h4><p>${esc(p)}</p></div>`).join("");

    const base_ = DATA.kyc_dist;
    const c3 = chart("c-kyc-base"); observe($("c-kyc-base"));
    c3.setOption(base({
      tooltip: { ...base().tooltip, trigger: "item", formatter: p => tipHead(p.name) + tipRow(p.color, "Customers", `${int(p.value)} (${p.percent}%)`) },
      legend: { orient: "vertical", right: 10, top: "middle", itemWidth: 9, itemHeight: 9, textStyle: { color: TK.ink2, fontSize: 11 } },
      series: [{ type: "pie", radius: ["50%", "80%"], center: ["38%", "50%"], padAngle: 2, itemStyle: { borderRadius: 5 }, label: { show: false },
        data: base_.map(r => ({ name: title(r.kyc_status), value: r.users, itemStyle: { color: col(r.kyc_status) } })) }],
    }), true);

    const seg = aggregate(sl, "risk_segment").sort((a, b) => ["LOW", "MEDIUM", "HIGH", "NO_KYC_RECORD"].indexOf(a.label) - ["LOW", "MEDIUM", "HIGH", "NO_KYC_RECORD"].indexOf(b.label));
    const c4 = chart("c-segment"); observe($("c-segment"));
    c4.setOption(base({
      grid: { left: 8, right: 20, top: 20, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => { const r = seg[ps[0].dataIndex]; return tipHead(title(r.label)) + tipRow(ps[0].color, "Dispute rate", pct(r.dispute_rate)) + tipRow(TK.ink3, "Payments", int(r.txns)); } },
      xAxis: axisCat(seg.map(r => title(r.label))), yAxis: axisVal({ axisLabel: { color: TK.ink3, fontSize: 10.5, formatter: v => (v * 100).toFixed(0) + "%" } }),
      series: [{ type: "bar", barMaxWidth: 46, data: seg.map(r => ({ value: r.dispute_rate, itemStyle: { color: r.label === "HIGH" ? TK.serious : fade(TK.s[0], .75), borderRadius: [5, 5, 0, 0] } })), label: { show: true, position: "top", color: TK.ink2, fontSize: 11, formatter: p => pct(p.value) } }],
    }), true);
  },
};

/* ------------------------------------------------------------------ Model health */
VIEWS.model = {
  render() {
    const BT = DATA.backtest;
    const range = w => `${dayFmt(isoDay(w[0]))} – ${dayFmt(isoDay(w[1]))}`;
    $("bt-window").textContent = `Scored on ${range(BT.train_window)} · tested on ${range(BT.test_window)}`;
    $("bt-verdict").innerHTML = `<b>Honest verdict:</b> merchant AUC ${BT.merchant.auc.toFixed(2)} and user AUC ${BT.user.auc.toFixed(2)} on an out-of-time split — the current additive scores are <b>explainable worklists, not yet predictors</b> of next-month fraud. We show this on purpose: the scores rank what already happened; the live engine and the backtest are how we will earn predictive power.`;
    const gauge = (id, v, label) => {
      const c = chart(id); observe($(id));
      c.setOption(base({
        series: [{ type: "gauge", min: 0, max: 1, startAngle: 200, endAngle: -20, radius: "92%", center: ["50%", "62%"], splitNumber: 4,
          axisLine: { lineStyle: { width: 12, color: [[.5, fade(TK.crit, .7)], [.7, fade(TK.warn, .7)], [1, fade(TK.good, .7)]] } },
          pointer: { width: 4, length: "62%", itemStyle: { color: TK.ink } }, anchor: { show: true, size: 10, itemStyle: { color: TK.ink } },
          axisTick: { show: false }, splitLine: { length: 10, lineStyle: { color: TK.panel, width: 2 } }, axisLabel: { color: TK.ink3, fontSize: 9.5, distance: 16, formatter: v => v.toFixed(2) },
          title: { offsetCenter: [0, "34%"], color: TK.ink2, fontSize: 12 }, detail: { offsetCenter: [0, "8%"], valueAnimation: true, formatter: v => v.toFixed(2), color: TK.ink, fontSize: 24, fontWeight: 600, fontFamily: "Space Grotesk" },
          data: [{ value: v, name: label }] }],
      }), true);
    };
    gauge("c-auc-m", BT.merchant.auc, "Merchant AUC");
    gauge("c-auc-u", BT.user.auc, "Customer AUC");
    const sig = BT.signals.filter(r => r.lift != null).sort((a, b) => b.lift - a.lift);
    const c = chart("c-lift"); observe($("c-lift"));
    c.setOption(base({
      grid: { left: 8, right: 40, top: 8, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => { const r = sig[ps[0].dataIndex]; return tipHead(`${title(r.entity)} · ${prettySignal(r.signal)}`) + tipRow(ps[0].color, "Lift", r.lift.toFixed(2) + "×") + tipRow(TK.ink3, "Flagged", int(r.entities)) + tipRow(TK.ink3, "Hit rate", pct(r.hit_rate)); } },
      xAxis: axisVal({ splitNumber: 4 }), yAxis: axisCat(sig.map(r => `${r.entity === "merchant" ? "M" : "U"} · ${prettySignal(r.signal)}`), { inverse: true, axisLabel: { color: TK.ink2, fontSize: 10 } }),
      series: [{ type: "bar", barMaxWidth: 12, data: sig.map(r => ({ value: r.lift, itemStyle: { color: fade(r.lift >= 1.5 ? TK.good : r.lift >= 1 ? TK.warn : TK.crit, r.entities >= 20 ? 1 : .35), borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: "right", color: TK.ink3, fontSize: 10, formatter: p => p.value.toFixed(1) + "×" },
        markLine: { silent: true, symbol: "none", lineStyle: { color: TK.ink3, type: [4, 4] }, label: { formatter: "no lift", color: TK.ink3, fontSize: 10 }, data: [{ xAxis: 1 }] } }],
    }), true);
    const lift = v => v == null ? "—" : v.toFixed(2) + "×";
    $("t-tiers").innerHTML = `<table><thead><tr><th>Entity</th><th>Tier</th><th class="r">Entities</th><th class="r">Fraud hits</th><th class="r">Hit rate</th><th class="r">Lift</th><th class="r">Recall</th></tr></thead><tbody>${BT.tiers.map(r =>
      `<tr><td>${esc(title(r.entity))}</td><td>${r.group === "ALL" ? "<b>All</b>" : tierPill(D.tier.indexOf(r.group))}</td><td class="r">${int(r.entities)}</td><td class="r">${int(r.fraud_hits)}</td><td class="r">${pct(r.hit_rate)}</td><td class="r">${r.group === "ALL" ? `<span class="dim">base</span>` : lift(r.lift)}</td><td class="r">${pct(r.recall, 0)}</td></tr>`).join("")}</tbody></table>`;
    $("t-history").innerHTML = `<table><thead><tr><th>Run</th><th class="r">Payments</th><th class="r">CB ratio</th><th class="r">High M / U</th><th class="r">Rings</th><th class="r">AUC M / U</th></tr></thead><tbody>${[...(DATA.history || [])].reverse().map(r =>
      `<tr><td class="mono">${esc(r.run_at)}</td><td class="r">${int(r.txn_count)}</td><td class="r">${pct(r.chargeback_to_txn_ratio)}</td><td class="r">${int(r.high_risk_merchants)} / ${int(r.high_risk_users)}</td><td class="r">${int(r.suspicious_clusters)}</td><td class="r">${r.bt_merchant_auc?.toFixed(2) ?? "—"} / ${r.bt_user_auc?.toFixed(2) ?? "—"}</td></tr>`).join("")}</tbody></table>`;
    const best = sig.find(r => r.entities >= 20);
    $("bt-next").textContent = `Re-weight the score from the backtest (the strongest well-populated signal is ${best ? `${best.entity} “${prettySignal(best.signal)}” at ${best.lift.toFixed(2)}×` : "not yet clear"}), add velocity and device features the live engine already computes, and promote only signals whose out-of-time lift holds across two consecutive runs.`;
  },
};

/* ------------------------------------------------------------------ Pipeline */
VIEWS.pipeline = {
  render() {
    const RAW = R.raw;
    const bySrc = {};
    QUALITY.forEach(q => { bySrc[q.table] = (bySrc[q.table] || 0) + (q.rows_affected || 0); });
    $("flow").innerHTML = [
      ["01 · Ingest", "4 messy sources", int(RAW.transactions + RAW.kyc + RAW.merchants + RAW.chargebacks) + " rows", [`${int(RAW.transactions)} UPI payments`, `${int(RAW.kyc)} KYC records`, `${int(RAW.merchants)} merchant rows`, `${int(RAW.chargebacks)} JSON complaints`]],
      ["02 · Clean", "Repair & flag", `${QUALITY.length} checks`, ["IDs, amounts, 6 date formats", "status / UTR / PAN / Aadhaar", `${int(K.duplicate_txns_removed)} duplicate payments removed`, "day/month order proven from data"]],
      ["03 · Model", "Star schema + SQLite", "2 facts · 2 dims", ["fact_transactions / chargebacks", "dim_users / dim_merchants", "complaints joined via txn_id", "indexed views for risk"]],
      ["04 · Analyse", "Risk & graph", `${int(CNT.high_risk_merchants + CNT.high_risk_users)} high-risk`, ["explainable additive scores", `${int(CNT.suspicious_clusters)} rings from a 72K-node graph`, "circular-laundering engine", "out-of-time backtest"]],
      ["05 · Act", "Desk + AI agents", "9 views · 5 agents", ["live streaming rule engine", "Entity 360 investigations", "Claude tool-using agents", "case queue & exports"]],
    ].map(([k, h, v, li]) => `<div class="stage"><span class="k">${k}</span><h4>${h}</h4><div class="v">${v}</div><ul>${li.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("");
    const srcs = Object.entries(bySrc).sort((a, b) => b[1] - a[1]);
    const c = chart("c-dq"); observe($("c-dq"));
    c.setOption(base({
      grid: { left: 8, right: 50, top: 4, bottom: 4, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: axisVal({ show: false }), yAxis: axisCat(srcs.map(s => title(s[0])), { inverse: true, axisLine: { show: false }, axisLabel: { color: TK.ink2, fontSize: 11.5 } }),
      series: [{ type: "bar", name: "Rows repaired", data: srcs.map((s, k) => ({ value: s[1], itemStyle: { color: TK.s[k], borderRadius: [0, 5, 5, 0] } })), barMaxWidth: 22, label: { show: true, position: "right", color: TK.ink2, fontSize: 11, formatter: p => int(p.value) } }],
    }), true);
    $("dq-callouts").innerHTML = [
      ["Chargebacks attributed through txn_id", `All ${int(K.chargeback_linked)} linked complaints carry a user and merchant ID that differ from the payment they dispute. Using the complaint's own IDs would blame the wrong merchants.`],
      ["Duplicates would have faked ₹51.9 L of volume", `${int(K.duplicate_txns_removed)} duplicate payments and 84 duplicate complaints removed — the only rows ever deleted.`],
      ["Date order proven, not guessed", "No slash-date ever has a value > 12 in position 2 and no dash-date in position 1 — so slash = DD/MM and dash = MM-DD across all four files."],
      ["Reporting delay from the complaint's own date", `Measured from the linked payment, 1,057 complaints would precede their payment; from the complaint's transaction date only ${int(CNT.reported_before_txn)} do — those are nulled and flagged.`],
    ].map(([h, p]) => `<div class="callout"><h4>${esc(h)}</h4><p>${esc(p)}</p></div>`).join("");
    const draw = () => {
      const q = $("dq-q").value.trim().toLowerCase(), src = $("dq-src").value;
      const rows = QUALITY.filter(r => (src === "all" || r.table === src) && (!q || `${r.table} ${r.check} ${r.action}`.toLowerCase().includes(q)));
      $("dq-count").textContent = `${rows.length} checks`;
      const max = Math.max(1, ...QUALITY.map(r => r.rows_affected || 0));
      $("t-dq").innerHTML = `<table><thead><tr><th>Source</th><th>Check</th><th class="r">Rows</th><th></th><th>Action</th></tr></thead><tbody>${rows.map(r =>
        `<tr><td><span class="chip">${esc(r.table)}</span></td><td>${esc(r.check)}</td><td class="r">${r.rows_affected ? int(r.rows_affected) : `<span class="dim">0</span>`}</td><td style="width:90px"><div style="height:6px;border-radius:3px;background:var(--accent);opacity:.7;width:${Math.max(r.rows_affected ? 2 : 0, (r.rows_affected || 0) / max * 100)}%"></div></td><td class="dim">${esc(r.action)}</td></tr>`).join("")}</tbody></table>`;
    };
    if (!$("dq-src").options.length) {
      $("dq-src").innerHTML = opt("all", "All sources") + [...new Set(QUALITY.map(q => q.table))].map(s => opt(s, title(s))).join("");
      $("dq-q").addEventListener("input", draw); $("dq-src").addEventListener("change", draw);
    }
    draw();
  },
};

/* ------------------------------------------------------------------ Cases */
VIEWS.cases = {
  render() {
    const list = Cases.all();
    const pr = p => p === "CRITICAL" ? `<span class="pill crit">Critical</span>` : p === "HIGH" ? `<span class="pill serious">High</span>` : p === "MEDIUM" ? `<span class="pill warn">Medium</span>` : `<span class="pill plain">${esc(title(p))}</span>`;
    $("t-cases").innerHTML = list.length ? `<table><thead><tr><th>Entity</th><th>Type</th><th>Priority</th><th>Why</th><th>Filed by</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody>${list.map(c => {
      const [t, i] = c.ref.split(":");
      return `<tr data-ref="${c.ref}"><td>${idLink(t, i, refLabel(c.ref))}</td><td>${{ m: "Merchant", u: "Customer", t: "Payment", c: "Complaint", k: "Ring" }[t]}</td><td>${pr(c.priority)}</td><td style="max-width:360px">${esc(c.reason)}</td><td>${c.by.startsWith("AI") ? `<span class="ai-tag">${esc(c.by.replace(/^AI\s*·?\s*/, ""))}</span>` : esc(c.by)}</td>
        <td><select class="sel" data-status style="padding:4px 24px 4px 8px">${["OPEN", "ESCALATED", "CLOSED"].map(s => `<option ${s === c.status ? "selected" : ""} value="${s}">${title(s)}</option>`).join("")}</select></td><td class="dim mono">${esc(c.at.slice(0, 16).replace("T", " "))}</td>
        <td><div class="acts-row"><button class="btn xs" data-ask="Investigate ${refLabel(c.ref)} and write a case note with a recommended action." data-agent="investigator">✦ Case note</button><button class="btn xs danger" data-del>✕</button></div></td></tr>`;
    }).join("")}</tbody></table>` : `<div class="empty"><div style="font-size:28px">📂</div>No cases yet. Pin merchants, customers or rings with 📌, or ask an agent to “add the top 5 risky merchants to my case queue”.</div>`;
  },
};
$("t-cases").addEventListener("change", e => { const s = e.target.closest("[data-status]"); if (s) Cases.update(s.closest("tr").dataset.ref, { status: s.value }); });
$("t-cases").addEventListener("click", e => { if (e.target.closest("[data-del]")) Cases.remove(e.target.closest("tr").dataset.ref); });
$("case-clear").addEventListener("click", () => { if (Cases.all().length) { Cases.save([]); toast("🗑️", "Case queue cleared", ""); } });
$("case-csv").addEventListener("click", () => downloadCsv("case_queue.csv", ["entity", "type", "priority", "reason", "filed_by", "status", "added"], Cases.all().map(c => [refLabel(c.ref), c.ref.split(":")[0], c.priority, c.reason, c.by, c.status, c.at])));

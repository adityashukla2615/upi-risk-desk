/* =====================================================================================
   03 · Overview (Command Center) + the Sentinel agent's detectors
   ===================================================================================== */
function dailyRows(sl, from = sl.f.from, to = sl.f.to) {
  const rows = Array.from({ length: to - from + 1 }, (_, x) => ({ d: from + x, n: 0, amt: 0, fail: 0, disp: 0, cbs: 0, fraud: 0, dsum: 0, dn: 0, hi: 0 }));
  for (let i = 0; i < NT; i++) {
    if (!sl.tm[i]) continue;
    const r = rows[T.d[i] - from];
    if (!r) continue;
    r.n++; r.amt += T.a[i] || 0;
    if (T.s[i] === ST_FAIL) r.fail++;
    if (sl.hit[i]) r.disp++;
    if (M.tier[T.m[i]] === TIER_HIGH) r.hi++;
    const js = cbByT.get(i);
    if (js) for (const j of js) if (sl.cm[j]) { r.cbs++; r.fraud += CB.fr[j]; if (CB.dl[j] != null) { r.dsum += CB.dl[j]; r.dn++; } }
  }
  return rows;
}
const weekRoll = rows => {
  const out = [];
  for (let k = 0; k < rows.length; k += 7) {
    const g = rows.slice(k, k + 7), r = { d: g[0].d, n: 0, amt: 0, fail: 0, disp: 0, cbs: 0, fraud: 0, dsum: 0, dn: 0, hi: 0, days: g.length };
    for (const x of g) for (const f of ["n", "amt", "fail", "disp", "cbs", "fraud", "dsum", "dn", "hi"]) r[f] += x[f];
    out.push(r);
  }
  return out;
};

/* =====================================================================================
   Sentinel — rule-based detectors that run on whatever slice is selected
   ===================================================================================== */
const SEV_RANK = { crit: 0, serious: 1, warn: 2, info: 3 };
const Sentinel = {
  scan(sl = SL, s = S) {
    const A = [];
    if (!s.n) return A;
    const kyc = byKey(aggregate(sl, "kyc_status"), "label");
    const none = kyc.NO_KYC_RECORD;
    if (none && none.amount / s.amt > 0.4) A.push({
      sev: "crit", key: "identity", title: `${pct(none.amount / s.amt, 0)} of payment value has no KYC identity behind it`,
      text: `${inr(none.amount)} across ${int(none.txns)} payments came from customer IDs with no KYC record; they raised ${int(none.chargebacks)} chargebacks.`,
      metric: none.amount / s.amt, patch: { kyc: KYC_NONE }, ask: "Why is the missing-KYC population a risk, and what should we do about it?",
    });
    const rej = kyc.REJECTED, ver = kyc.VERIFIED;
    if (rej && ver && rej.txns >= 30 && rej.dispute_rate > ver.dispute_rate) A.push({
      sev: "serious", key: "rejected", title: `Rejected-KYC customers are still paying — and dispute ${pct(rej.dispute_rate)} of the time`,
      text: `${int(rej.txns)} payments (${inr(rej.amount)}) went through for customers whose KYC was rejected, vs a ${pct(ver.dispute_rate)} dispute rate for verified customers.`,
      metric: rej.dispute_rate - ver.dispute_rate, patch: { kyc: KYC_REJ }, ask: "Which rejected-KYC customers are still transacting and disputing? List the worst ones.",
    });
    const openFraud = { n: 0, amt: 0 };
    for (let j = 0; j < NC; j++) if (sl.cm[j] && CB.fr[j] && CB.op[j]) { openFraud.n++; openFraud.amt += CB.a[j] || 0; }
    if (openFraud.n >= 10) A.push({
      sev: "crit", key: "backlog", title: `${int(openFraud.n)} fraud-type disputes are still unresolved`,
      text: `${inr(openFraud.amt)} in account-takeover, unauthorised or suspected-fraud complaints is open, in progress or pending with the bank.`,
      metric: openFraud.amt, goto: "disputes", ask: "Summarise the unresolved fraud-type dispute backlog by reason and severity.",
    });
    if (!sl.f || sl.f.mch < 0) {
      const top = CL[0];
      if (top) A.push({
        sev: "crit", key: "ring", title: `Ring ${top.id}: ${top.u.length} disputing customers wired to ${top.m.length} merchants`,
        text: `Highest-scoring cluster (score ${top.score}) with ${top.unv} unverified or no-KYC members; hub ${top.hub.replace(/^[UM]:/, "")}.`,
        metric: top.score, ref: { type: "k", i: 0 }, ask: `Investigate fraud ring ${top.id} and recommend actions.`, agent: "investigator",
      });
    }
    const cats = aggregate(sl, "category").filter(c => c.label !== "Unknown" && c.txns >= Math.max(100, s.n * 0.05));
    const worst = cats.sort((a, b) => b.dispute_rate - a.dispute_rate)[0];
    if (worst && worst.dispute_rate > s.ratio + 0.005) A.push({
      sev: "warn", key: "category", title: `${worst.label} disputes run ${((worst.dispute_rate - s.ratio) * 100).toFixed(1)} pts above the book`,
      text: `${pct(worst.dispute_rate)} of ${int(worst.txns)} ${worst.label} payments are disputed vs ${pct(s.ratio)} overall; ${inr(worst.disputed_amount)} at stake.`,
      metric: worst.dispute_rate, patch: { cat: worst.key }, ask: `Why is ${worst.label} running a higher dispute rate? Break it down.`,
    });
    let inactive = 0, inactiveCb = 0;
    const seenM = new Set();
    for (let i = 0; i < NT; i++) {
      if (!sl.tm[i] || seenM.has(T.m[i])) continue;
      const m = T.m[i];
      seenM.add(m);
      if (NOT_ACTIVE.has(merchantStatus(m))) { inactive++; inactiveCb += merchantStats(m, sl).cbs; }
    }
    if (inactive >= 5) A.push({
      sev: "serious", key: "inactive", title: `${int(inactive)} closed, suspended or blocked merchants are still receiving money`,
      text: `Their payments carried ${int(inactiveCb)} chargebacks. A non-active merchant should not settle UPI payments.`,
      metric: inactive, goto: "entities", ask: "Which merchants are transacting while inactive, closed, suspended or blocked, and how risky are they?",
    });
    const reasons = aggregate(sl, "reason").filter(r => FRAUD_REASONS.has(r.label) && r.chargebacks >= 20).sort((a, b) => b.late_share - a.late_share);
    if (reasons[0] && reasons[0].late_share >= 0.2) A.push({
      sev: "warn", key: "late", title: `${pct(reasons[0].late_share, 0)} of ${title(reasons[0].label).toLowerCase()} complaints arrive after 7 days`,
      text: `Mean delay ${reasons[0].mean_delay_days?.toFixed(1)} days — late fraud reports mean funds have usually left the account.`,
      metric: reasons[0].late_share, patch: { rs: reasons[0].key }, ask: "Show disputes reported after 7 days and what they have in common.",
    });
    const days = dailyRows(sl);
    if (days.length >= 14) {
      const rates = days.filter(r => r.n >= 20).map(r => ({ d: r.d, v: r.disp / r.n, f: r.fail / r.n, n: r.n }));
      const zs = (arr, k) => { const mu = sum(arr, x => x[k]) / arr.length, sd = Math.sqrt(sum(arr, x => (x[k] - mu) ** 2) / arr.length) || 1; return arr.map(x => ({ ...x, z: (x[k] - mu) / sd, mu })); };
      const dz = zs(rates, "v").sort((a, b) => b.z - a.z)[0], fz = zs(rates, "f").sort((a, b) => b.z - a.z)[0];
      if (dz && dz.z > 2.2) A.push({
        sev: "warn", key: "dayd", title: `Dispute spike on ${dayFmt(dz.d)}: ${pct(dz.v)} of payments`,
        text: `${dz.z.toFixed(1)}σ above the ${pct(dz.mu)} daily norm across ${int(dz.n)} payments that day.`,
        metric: dz.z, patch: { from: dz.d, to: dz.d }, ask: `What happened on ${dayIso(dz.d)}? Which merchants and categories drove the disputes?`,
      });
      if (fz && fz.z > 2.2) A.push({
        sev: "info", key: "dayf", title: `Failure spike on ${dayFmt(fz.d)}: ${pct(fz.f)} failed`,
        text: `${fz.z.toFixed(1)}σ above the ${pct(fz.mu)} daily norm — worth checking with the PSP / bank switch logs.`,
        metric: fz.z, patch: { from: fz.d, to: fz.d }, ask: `Break down the failed payments on ${dayIso(fz.d)} by hour and category.`,
      });
    }
    let repeat = 0;
    for (let u = 0; u < NU; u++) { if (U.tier[u] !== TIER_HIGH) continue; const st = userStats(u, sl); if (st.cbs >= 2 && userKyc(u) !== KYC_VER) repeat++; }
    if (repeat) A.push({
      sev: "serious", key: "repeat", title: `${int(repeat)} unverified customers filed repeat disputes`,
      text: `High-risk tier, ≥2 chargebacks in this slice and no verified KYC — prime first-party-fraud candidates.`,
      metric: repeat, goto: "entities", entKind: "u", ask: "List high-risk unverified customers with repeat disputes and explain each score.", agent: "investigator",
    });
    return A.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]);
  },
};

/* =====================================================================================
   Overview view
   ===================================================================================== */
let trendGrain = "day", heatMetric = "fail";
VIEWS.overview = {
  render(sl, s) {
    const f = sl.f;
    const rangeTxt = f.from === 0 && f.to === DAYS - 1 ? `${dayFmt(0)} – ${dayFmt(DAYS - 1)} ${SY}` : `${dayFmt(f.from)} – ${dayFmt(f.to)}`;
    $("hero-window").textContent = rangeTxt;
    const oneIn = s.ratio ? Math.round(1 / s.ratio) : null;
    $("hero-title").innerHTML = s.n ? `${inr(s.amt)} processed · <em>1 in ${oneIn}</em> payments disputed` : "No payments in this slice";
    const alerts = Sentinel.scan(sl, s);
    this.alerts = alerts;
    const crit = alerts.filter(a => a.sev === "crit").length;
    $("hero-text").innerHTML = s.n ? `${int(s.n)} payments and ${int(s.cbs)} complaints in view. Sentinel raised <b>${alerts.length}</b> alerts (${crit} critical): ${alerts.slice(0, 2).map(a => esc(a.title.charAt(0).toLowerCase() + a.title.slice(1))).join("; ")}.` : "Widen the filters to see activity.";

    // exposure stack
    const ex = { fo: 0, fc: 0, no: 0, nc: 0 };
    for (let j = 0; j < NC; j++) { if (!sl.cm[j]) continue; const a = CB.a[j] || 0; if (CB.fr[j]) CB.op[j] ? ex.fo += a : ex.fc += a; else CB.op[j] ? ex.no += a : ex.nc += a; }
    const tot = ex.fo + ex.fc + ex.no + ex.nc || 1;
    const parts = [["Fraud-type · open", ex.fo, TK.crit], ["Fraud-type · closed", ex.fc, fade(TK.crit, .45)], ["Other · open", ex.no, TK.warn], ["Other · closed", ex.nc, fade(TK.warn, .4)]];
    $("exp-big").textContent = inr(s.cbAmt);
    $("exp-bar").innerHTML = parts.map(([l, v, c]) => `<i title="${l}: ${inr(v)}" style="width:${v / tot * 100}%;background:${c}"></i>`).join("");
    $("exp-legend").innerHTML = parts.map(([l, v, c]) => `<span><i style="background:${c}"></i>${l} <b>${inr(v)}</b></span>`).join("");
    $("exp-note").textContent = `${pct(s.amtRatio, 2)} of payment value · ${pct(s.openShare, 0)} of complaints unresolved`;

    this.kpis(sl, s);
    this.trend(sl);
    this.alertList(alerts);
    this.sankey(sl);
    this.bubble(sl, s);
    this.heat(sl);
    this.topMerchants(sl);
    this.insights();
  },

  kpis(sl, s) {
    const pr = priorRange(sl.f);
    const prior = pr ? summarize(slice({ ...sl.f, from: pr[0], to: pr[1] })) : null;
    const len = r => r[1] - r[0] + 1, cur = [sl.f.from, sl.f.to];
    const delta = (c, p, kind, badUp) => {
      if (!prior || c == null || p == null) return "";
      let d, txt;
      if (kind === "pts") { d = (c - p) * 100; txt = Math.abs(d).toFixed(1) + " pts"; }
      else if (kind === "d") { d = c - p; txt = Math.abs(d).toFixed(1) + " d"; }
      else { if (!p) return ""; d = (c - p) / p * 100; txt = Math.abs(d).toFixed(0) + "%"; }
      const flat = Math.abs(d) < (kind === "rel" ? 1 : .1);
      const cls = flat || badUp == null ? "flat" : (d > 0) === badUp ? "bad" : "good";
      return `<span class="delta ${cls}" title="vs ${dayFmt(pr[0])} – ${dayFmt(pr[1])}">${flat ? "≈" : d > 0 ? "▲ " + txt : "▼ " + txt}</span>`;
    };
    const days = dailyRows(sl);
    const hiM = new Set(); for (let i = 0; i < NT; i++) if (sl.tm[i] && M.tier[T.m[i]] === TIER_HIGH) hiM.add(T.m[i]);
    const tiles = [
      { k: "value", l: "Payment value", v: inr(s.amt), foot: `${int(s.n)} payments`, d: prior && delta(s.amt / len(cur), prior.amt / len(pr), "rel", null), spark: days.map(r => r.amt), color: TK.s[0], go: "overview" },
      { k: "ratio", l: "Dispute rate", v: pct(s.ratio), foot: `${int(s.disp)} disputed`, d: delta(s.ratio, prior?.ratio, "pts", true), spark: days.map(r => r.n ? r.disp / r.n : 0), color: TK.crit, go: "disputes" },
      { k: "fraud", l: "Fraud-type share", v: pct(s.fraudShare, 0), foot: `${int(s.fraud)} complaints`, d: delta(s.fraudShare, prior?.fraudShare, "pts", true), spark: days.map(r => r.cbs ? r.fraud / r.cbs : 0), color: TK.serious, go: "disputes" },
      { k: "fail", l: "Failed rate", v: pct(s.failRate), foot: `pending ${pct(s.pendRate)}`, d: delta(s.failRate, prior?.failRate, "pts", true), spark: days.map(r => r.n ? r.fail / r.n : 0), color: TK.warn, go: "overview" },
      { k: "delay", l: "Reporting delay", v: s.delayMean == null ? "—" : s.delayMean.toFixed(1) + " d", foot: `median ${s.delayMedian == null ? "—" : s.delayMedian.toFixed(1)} d · ${int(s.late)} > 7 d`, d: delta(s.delayMean, prior?.delayMean, "d", true), spark: days.map(r => r.dn ? r.dsum / r.dn : null), color: TK.s[6], go: "disputes" },
      { k: "hi", l: "High-risk merchants", v: int(hiM.size), foot: `${int(sum(days, r => r.hi))} payments to them`, d: "", spark: days.map(r => r.hi), color: TK.s[1], go: "entities" },
    ];
    $("kpis").innerHTML = tiles.map(t => `<button class="kpi" data-goto="${t.go}"><span class="lbl">${t.l}${t.d || ""}</span><span class="val">${t.v}</span><span class="foot">${t.foot}</span><div class="spark" id="sp-${t.k}"></div></button>`).join("");
    for (const t of tiles) {
      const el = $("sp-" + t.k), c = chart(el); observe(el);
      c.setOption({
        animation: false, grid: { left: 0, right: 0, top: 4, bottom: 0 }, xAxis: { type: "category", show: false, data: t.spark.map((_, i) => i) }, yAxis: { type: "value", show: false, scale: true },
        series: [{ type: "line", data: t.spark, symbol: "none", smooth: .35, lineStyle: { width: 1.6, color: t.color }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: fade(t.color, .28) }, { offset: 1, color: fade(t.color, 0) }]) } }],
      }, true);
    }
  },

  trend(sl) {
    let rows = dailyRows(sl);
    if (trendGrain === "week") rows = weekRoll(rows);
    const labels = rows.map(r => trendGrain === "week" ? "wk " + dayFmt(r.d) : dayFmt(r.d));
    const days = rows.map(r => r.d);
    const roll = rows.map((_, i) => i < 6 || trendGrain === "week" ? null : sum(rows.slice(i - 6, i + 1), r => r.amt) / 7);
    const el = $("c-trend"), c = chart(el); observe(el);
    c.setOption(base({
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      tooltip: { ...base().tooltip, trigger: "axis", formatter: ps => { const i = ps[0].dataIndex, r = rows[i]; return tipHead(trendGrain === "week" ? `Week of ${dayFmt(r.d)}` : dayFmt(r.d)) + tipRow(TK.s[0], "Payment value", inr(r.amt)) + tipRow(TK.ink3, "Payments", int(r.n)) + tipRow(TK.crit, "Dispute rate", pct(r.n ? r.disp / r.n : 0)) + tipRow(TK.warn, "Failed rate", pct(r.n ? r.fail / r.n : 0)); } },
      grid: [{ left: 8, right: 14, top: 26, height: "46%", containLabel: true }, { left: 8, right: 14, top: "64%", bottom: 6, containLabel: true }],
      legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: TK.ink2, fontSize: 11 }, data: ["Payment value", "7-day avg", "Dispute rate", "Failed rate"] },
      xAxis: [axisCat(labels, { gridIndex: 0, axisLabel: { show: false } }), axisCat(labels, { gridIndex: 1, axisLabel: { color: TK.ink3, fontSize: 10.5, hideOverlap: true } })],
      yAxis: [axisVal({ gridIndex: 0, splitNumber: 3, axisLabel: { color: TK.ink3, fontSize: 10.5, formatter: v => inr(v).replace("₹", "₹") } }), axisVal({ gridIndex: 1, splitNumber: 2, axisLabel: { color: TK.ink3, fontSize: 10.5, formatter: v => (v * 100).toFixed(0) + "%" } })],
      brush: { xAxisIndex: "all", brushLink: "all", brushType: "lineX", brushMode: "single", transformable: false, throttleType: "debounce", throttleDelay: 300, brushStyle: { color: fade(TK.accent, .15), borderColor: TK.accent, borderWidth: 1 }, outOfBrush: { colorAlpha: .35 } },
      toolbox: { show: false },
      series: [
        { name: "Payment value", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => r.amt), symbol: "none", smooth: .25, lineStyle: { width: 2, color: TK.s[0] }, itemStyle: { color: TK.s[0] }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: fade(TK.s[0], .3) }, { offset: 1, color: fade(TK.s[0], 0) }]) } },
        { name: "7-day avg", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: roll, symbol: "none", smooth: .3, lineStyle: { width: 1.5, color: TK.ink3, type: [4, 4] }, itemStyle: { color: TK.ink3 } },
        { name: "Dispute rate", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: rows.map(r => r.n ? r.disp / r.n : 0), symbol: "none", smooth: .25, lineStyle: { width: 2, color: TK.crit }, itemStyle: { color: TK.crit } },
        { name: "Failed rate", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: rows.map(r => r.n ? r.fail / r.n : 0), symbol: "none", smooth: .25, lineStyle: { width: 1.6, color: TK.warn }, itemStyle: { color: TK.warn } },
      ],
    }), true);
    c.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "lineX", brushMode: "single" } });
    c.off("brushEnd");
    c.on("brushEnd", p => {
      const area = p.areas && p.areas[0];
      if (!area || !area.coordRange) return;
      const [a, b] = area.coordRange;
      const r0 = rows[clamp(a, 0, rows.length - 1)], r1 = rows[clamp(b, 0, rows.length - 1)];
      if (!r0 || !r1) return;
      const to = trendGrain === "week" ? Math.min(DAYS - 1, r1.d + r1.days - 1) : r1.d;
      c.dispatchAction({ type: "brush", areas: [] });
      if (r0.d === sl.f.from && to === sl.f.to) return;
      setF({ from: r0.d, to });
      toast("🔎", "Zoomed the desk", `${dayFmt(r0.d)} – ${dayFmt(to)} · press R to reset`);
    });
  },

  alertList(alerts) {
    $("alert-count").textContent = `${alerts.length} active`;
    $("alerts").innerHTML = alerts.length ? alerts.map((a, k) => `
      <div class="alert ${a.sev}" data-k="${k}" tabindex="0">
        <span class="bar"></span>
        <div>
          <div class="meta"><span class="pill ${a.sev === "info" ? "info" : a.sev}">${a.sev === "crit" ? "Critical" : a.sev === "serious" ? "Serious" : a.sev === "warn" ? "Warning" : "Notice"}</span></div>
          <h4>${esc(a.title)}</h4><p>${esc(a.text)}</p>
          <div class="acts">
            <button class="btn xs" data-act="ask" data-k="${k}">✦ Investigate</button>
            ${a.patch ? `<button class="btn xs" data-act="filter" data-k="${k}"><svg><use href="#i-filter"/></svg>Focus desk</button>` : ""}
            ${a.ref ? `<button class="btn xs" data-act="open" data-k="${k}">Open ${esc(refLabel(a.ref.type + ":" + a.ref.i))}</button>` : ""}
            ${a.goto && !a.patch ? `<button class="btn xs" data-act="goto" data-k="${k}">View</button>` : ""}
          </div>
        </div>
      </div>`).join("") : `<div class="empty">No alerts in this slice.</div>`;
    $("alerts").onclick = e => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const a = alerts[+b.dataset.k];
      if (b.dataset.act === "ask") Copilot.ask(a.ask, { agent: a.agent || "analyst" });
      else if (b.dataset.act === "filter") setF(a.patch);
      else if (b.dataset.act === "open") openEntity(a.ref);
      else if (b.dataset.act === "goto") { if (a.entKind) Entities.setKind(a.entKind); go(a.goto); }
    };
  },

  sankey(sl) {
    const flows = new Map(), add = (a, b, v) => flows.set(a + "|" + b, (flows.get(a + "|" + b) || 0) + v);
    const KYC_LBL = { VERIFIED: "Verified", PENDING: "KYC pending", IN_REVIEW: "KYC in review", REJECTED: "KYC rejected", NO_KYC_RECORD: "No KYC record" };
    for (let j = 0; j < NC; j++) {
      const i = CB.t[j];
      if (!sl.cm[j] || i < 0) continue;
      const a = CB.a[j] || 0;
      const outcome = (CB.fr[j] ? "Fraud-type" : "Other dispute") + (CB.op[j] ? " · open" : " · closed");
      const k = "K:" + KYC_LBL[D.kyc[T.k[i]]], c = "C:" + catName(T.c[i]);
      add(k, c, a); add(c, "O:" + outcome, a);
    }
    const nodes = new Set();
    const links = [...flows].map(([k, v]) => { const [s, t] = k.split("|"); nodes.add(s); nodes.add(t); return { source: s, target: t, value: v }; });
    const color = n => n.startsWith("O:") ? (n.includes("Fraud") ? (n.includes("open") ? TK.crit : fade(TK.crit, .55)) : (n.includes("open") ? TK.warn : fade(TK.warn, .5))) : n.startsWith("K:") ? (n.includes("Verified") ? TK.s[0] : n.includes("rejected") ? TK.crit : n.includes("No KYC") ? TK.serious : TK.s[6]) : TK.ink3;
    const el = $("c-sankey"), c = chart(el); observe(el);
    c.setOption(base({
      tooltip: { ...base().tooltip, trigger: "item", formatter: p => p.dataType === "edge" ? tipHead(`${p.data.source.slice(2)} → ${p.data.target.slice(2)}`) + tipRow(TK.accent, "Disputed", inr(p.data.value)) : tipHead(p.name.slice(2)) + tipRow(color(p.name), "Disputed", inr(p.value)) },
      series: [{
        type: "sankey", left: 4, right: 120, top: 8, bottom: 8, nodeWidth: 12, nodeGap: 7, layoutIterations: 48, draggable: false,
        emphasis: { focus: "adjacency" },
        data: [...nodes].map(n => ({ name: n, itemStyle: { color: color(n), borderWidth: 0 } })),
        links, lineStyle: { color: "gradient", opacity: .32, curveness: .5 },
        label: { color: TK.ink2, fontSize: 11, formatter: p => p.name.slice(2) },
      }],
    }), true);
    c.off("click");
    c.on("click", p => {
      if (p.dataType !== "node") return;
      const n = p.name, v = n.slice(2);
      if (n.startsWith("K:")) { const k = D.kyc.indexOf(Object.keys(KYC_LBL).find(x => KYC_LBL[x] === v)); if (k >= 0) setF({ kyc: F.kyc === k ? -1 : k }); }
      else if (n.startsWith("C:")) { const k = D.cat.indexOf(v); if (k >= 0) setF({ cat: F.cat === k ? -1 : k }); }
      else if (n.startsWith("O:")) go("disputes");
    });
  },

  bubble(sl, s) {
    const rows = aggregate(sl, "category").filter(r => r.txns >= 20);
    const maxD = Math.max(1, ...rows.map(r => r.disputed_amount));
    const el = $("c-bubble"), c = chart(el); observe(el);
    c.setOption(base({
      grid: { left: 8, right: 22, top: 20, bottom: 26, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "item", formatter: p => { const r = rows[p.dataIndex]; return tipHead(r.label) + tipRow(TK.s[0], "Payments", int(r.txns)) + tipRow(TK.crit, "Dispute rate", pct(r.dispute_rate)) + tipRow(TK.serious, "Disputed", inr(r.disputed_amount)) + tipRow(TK.ink3, "Fraud-type share", pct(r.fraud_share, 0)); } },
      xAxis: axisVal({ type: "log", name: "payments (log)", nameLocation: "middle", nameGap: 24, nameTextStyle: { color: TK.ink3, fontSize: 10.5 }, splitLine: { show: false } }),
      yAxis: axisVal({ scale: true, axisLabel: { color: TK.ink3, fontSize: 10.5, formatter: v => (v * 100).toFixed(0) + "%" } }),
      series: [{
        type: "scatter", data: rows.map(r => [r.txns, r.dispute_rate, r.disputed_amount]),
        symbolSize: d => 10 + 38 * Math.sqrt(d[2] / maxD),
        itemStyle: { color: p => { const r = rows[p.dataIndex]; return fade(r.dispute_rate > s.ratio ? TK.crit : TK.s[0], F.cat >= 0 && F.cat !== r.key ? .25 : .75); }, borderColor: TK.panel, borderWidth: 2 },
        label: { show: true, position: "right", color: TK.ink2, fontSize: 10.5, formatter: p => rows[p.dataIndex].label },
        labelLayout: { hideOverlap: true },
        markLine: { silent: true, symbol: "none", lineStyle: { color: TK.ink3, type: [4, 4] }, label: { color: TK.ink3, fontSize: 10, position: "insideStartTop", formatter: `overall ${pct(s.ratio)}` }, data: [{ yAxis: s.ratio }] },
      }],
    }), true);
    c.off("click");
    c.on("click", p => { const r = rows[p.dataIndex]; if (r && r.label !== "Unknown") setF({ cat: F.cat === r.key ? -1 : r.key }); });
  },

  heat(sl) {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, fail: 0, disp: 0 })));
    for (let i = 0; i < NT; i++) {
      if (!sl.tm[i] || T.mi[i] < 0) continue;
      const x = cells[dowOf(T.d[i])][hourOf(i)];
      x.n++; if (T.s[i] === ST_FAIL) x.fail++; if (sl.hit[i]) x.disp++;
    }
    const order = [1, 2, 3, 4, 5, 6, 0];
    const data = [];
    order.forEach((dw, yi) => cells[dw].forEach((x, h) => data.push([h, yi, x.n < 5 && heatMetric !== "n" ? null : heatMetric === "n" ? x.n : heatMetric === "fail" ? x.fail / x.n : x.disp / x.n, x.n, dw])));
    const vals = data.map(d => d[2]).filter(v => v != null);
    const el = $("c-heat"), c = chart(el); observe(el);
    const fmt = v => heatMetric === "n" ? int(v) : pct(v);
    c.setOption(base({
      grid: { left: 8, right: 8, top: 8, bottom: 40, containLabel: true },
      tooltip: { ...base().tooltip, formatter: p => tipHead(`${DOW[p.data[4]]} ${hh(p.data[0])}:00`) + tipRow(TK.seq[3], heatMetric === "n" ? "Payments" : heatMetric === "fail" ? "Failure rate" : "Dispute rate", p.data[2] == null ? "too few" : fmt(p.data[2])) + tipRow(TK.ink3, "Payments", int(p.data[3])) },
      xAxis: axisCat(Array.from({ length: 24 }, (_, h) => hh(h)), { splitArea: { show: false }, axisLabel: { color: TK.ink3, fontSize: 10, interval: 1 } }),
      yAxis: axisCat(order.map(d => DOW[d]), { axisLine: { show: false } }),
      visualMap: { dimension: 2, min: Math.min(...vals), max: Math.max(...vals), calculable: false, orient: "horizontal", left: "center", bottom: 0, itemHeight: 140, itemWidth: 10, text: [fmt(Math.max(...vals)), fmt(Math.min(...vals))], textStyle: { color: TK.ink3, fontSize: 10 }, inRange: { color: [TK.seq[0], TK.seq[2], TK.seq[3], TK.seq[5]] } },
      series: [{ type: "heatmap", data, itemStyle: { borderColor: TK.panel, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: TK.ink, borderWidth: 1 } } }],
    }), true);
    c.off("click");
    c.on("click", p => setF(F.hr === p.data[0] && F.dow === p.data[4] ? { hr: -1, dow: -1 } : { hr: p.data[0], dow: p.data[4] }));
  },

  topMerchants(sl) {
    const seen = new Set();
    for (let i = 0; i < NT; i++) if (sl.tm[i]) seen.add(T.m[i]);
    const rows = [...seen].filter(m => M.score[m] >= 30).map(m => ({ m, st: merchantStats(m, sl) }))
      .sort((a, b) => M.score[b.m] - M.score[a.m] || b.st.damt - a.st.damt).slice(0, 14);
    $("t-topm").innerHTML = rows.length ? `<table><thead><tr><th>Merchant</th><th>Category</th><th>Score</th><th class="r">CBs</th><th class="r">Disputed</th><th>Why</th></tr></thead><tbody>${rows.map(({ m, st }) =>
      `<tr class="click" data-m="${m}"><td>${mLink(m)}<div class="dim" style="font-size:11px;margin-top:2px">${esc(M.name[m] || "not in merchant master")}</div></td><td>${esc(catName(M.cat[m]))}</td><td>${scoreBar(M.score[m], M.tier[m])}</td><td class="r">${int(st.cbs)}</td><td class="r">${inr(st.damt)}</td><td><div class="chips">${sigNames(M.sig[m], "msig").slice(0, 2).map(x => `<span class="chip">${esc(prettySignal(x))}</span>`).join("")}</div></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No medium or high-risk merchants in this slice.</div>`;
    $("t-topm").onclick = e => { const tr = e.target.closest("tr[data-m]"); if (tr) openEntity({ type: "m", i: +tr.dataset.m }); };
  },

  insights() {
    if ($("insights").childElementCount) return;
    const noKyc = byKey(DATA.kyc_txn, "kyc_status").NO_KYC_RECORD;
    const hm = M.tier.filter(t => t === TIER_HIGH).length;
    let hmCb = 0, allCb = 0;
    for (let m = 0; m < NM; m++) { const c = merchantStats(m).cbs; allCb += c; if (M.tier[m] === TIER_HIGH) hmCb += c; }
    const BT = DATA.backtest;
    const cards = [
      [pct(noKyc.amount / K.txn_amount, 1), "Identity is the biggest control gap", `${inr(noKyc.amount)} of payments came from customer IDs with no KYC record, and 6,288 KYC IDs resolve to more than one person.`],
      [pct(hmCb / allCb, 0), "Risk is concentrated", `${int(hm)} high-risk merchants (${pct(hm / NM, 1)} of those scored) carry ${pct(hmCb / allCb, 0)} of all linked chargebacks — a short, actionable worklist.`],
      [int(CNT.suspicious_clusters), "Disputes form networks", `Graph analysis joins disputing customers and merchants into ${int(CNT.suspicious_clusters)} connected rings; the top one links ${CL[0].u.length} customers to ${CL[0].m.length} merchants.`],
      [inr(K.duplicate_amount_removed), "Cleaning changed the answer", `${int(K.duplicate_txns_removed)} duplicate payments would have inflated volume, and every complaint carries IDs that differ from the payment it disputes.`],
      [pct(K.open_dispute_share, 0), "The dispute backlog is the operational risk", `${int(K.chargeback_count)} complaints, ${pct(K.fraud_reason_share, 0)} fraud-type, and more than half still open, in progress or pending with the bank.`],
      [BT.merchant.auc.toFixed(2), "We measured our own detection honestly", `An out-of-time backtest gives merchant AUC ${BT.merchant.auc.toFixed(2)} / user ${BT.user.auc.toFixed(2)}: today's scores are strong worklists, not yet predictors — tracked on every run.`],
    ];
    $("insights").innerHTML = cards.map(([n, h, p]) => `<div class="insight"><div class="n">${n}</div><h4>${esc(h)}</h4><p>${esc(p)}</p></div>`).join("");
  },
};
$("trend-grain").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; trendGrain = b.dataset.v; $$("#trend-grain button").forEach(x => x.setAttribute("aria-pressed", x === b)); VIEWS.overview.trend(SL); });
$("heat-metric").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; heatMetric = b.dataset.v; $$("#heat-metric button").forEach(x => x.setAttribute("aria-pressed", x === b)); VIEWS.overview.heat(SL); });

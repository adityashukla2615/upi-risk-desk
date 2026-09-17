/* =====================================================================================
   04 · Live Transaction Monitor — replays the quarter through a leak-free streaming rule engine
   A decision may only use what was known at that simulated minute: chargebacks become
   visible when they were *reported*, never when the payment happened.
   ===================================================================================== */
const Stream = (() => {
  const MIN = i => T.d[i] * 1440 + (T.mi[i] < 0 ? 720 : T.mi[i]);
  const order = Array.from({ length: NT }, (_, i) => i).sort((a, b) => MIN(a) - MIN(b) || a - b);
  // A complaint becomes known `reporting delay` after the payment it disputes. The raw report date can't be used:
  // it is anchored to the complaint's own transaction date, which often precedes the linked payment and would leak
  // a payment's own dispute into its score.
  const DL_MED = FULL.delayMedian ?? 3;
  const REVEAL = j => MIN(CB.t[j]) + Math.max(0, CB.dl[j] ?? DL_MED) * 1440 + 1;
  const cbOrder = Array.from({ length: NC }, (_, j) => j).filter(j => CB.t[j] >= 0).sort((a, b) => REVEAL(a) - REVEAL(b));
  const T0 = MIN(order[0]), T1 = DAYS * 1440;
  const RULES = [
    ["kyc_rejected", "KYC rejected", 30], ["merchant_not_active", "Merchant not active", 25], ["user_prior_dispute", "Payer disputed before", 20],
    ["merchant_repeat_disputes", "Merchant has ≥2 reported disputes", 20], ["merchant_not_in_master", "Merchant not onboarded", 15], ["merchant_fraud_report", "Merchant has a fraud report", 15],
    ["velocity", "Payer paid again within 30 min", 15], ["no_kyc", "No KYC record", 10], ["kyc_unverified", "KYC pending / in review", 10],
    ["high_amount", `Amount ≥ p95 (${inr(AMT_P95)})`, 10], ["high_segment", "High declared risk segment", 10], ["user_repeat_disputes", "Payer disputed ≥2 times", 10],
  ];
  const RULE_IDX = Object.fromEntries(RULES.map((r, k) => [r[0], k]));
  const SEG_HIGH = D.seg.indexOf("HIGH"), KYC_PEND = D.kyc.indexOf("PENDING"), KYC_REV = D.kyc.indexOf("IN_REVIEW");
  const NOT_ACTIVE_CODES = new Set(D.mstatus.map((s, k) => NOT_ACTIVE.has(s) ? k : -1).filter(k => k >= 0));

  let st, playing = false, speed = 3600, last = 0, raf = 0, lastToast = 0, lastDraw = 0;
  function reset() {
    st = {
      now: T0, p: 0, q: 0, mCb: new Uint16Array(NM), mFr: new Uint16Array(NM), uCb: new Uint16Array(NU), uLast: new Float64Array(NU).fill(-1e9),
      decision: new Int8Array(NT).fill(-1), score: new Uint8Array(NT), revealed: new Uint8Array(NT),
      n: 0, amt: 0, hold: 0, review: 0, holdAmt: 0, fired: new Uint32Array(RULES.length),
      flaggedHit: 0, allowedHit: 0, hourly: new Map(), feed: [],
    };
  }
  function scoreTxn(i) {
    const m = T.m[i], u = T.u[i], hits = [];
    const k = T.k[i];
    if (k === KYC_REJ) hits.push("kyc_rejected"); else if (k === KYC_NONE) hits.push("no_kyc"); else if (k === KYC_PEND || k === KYC_REV) hits.push("kyc_unverified");
    if (M.st[m] === MST_NONE) hits.push("merchant_not_in_master"); else if (NOT_ACTIVE_CODES.has(M.st[m])) hits.push("merchant_not_active");
    if (st.mCb[m] >= 2) hits.push("merchant_repeat_disputes");
    if (st.mFr[m] >= 1) hits.push("merchant_fraud_report");
    if (st.uCb[u] >= 1) hits.push("user_prior_dispute");
    if (st.uCb[u] >= 2) hits.push("user_repeat_disputes");
    if (T.a[i] != null && T.a[i] >= AMT_P95) hits.push("high_amount");
    if (T.mi[i] >= 0 && MIN(i) - st.uLast[u] <= 30) hits.push("velocity");
    if (T.g[i] === SEG_HIGH) hits.push("high_segment");
    const score = Math.min(100, sum(hits, h => RULES[RULE_IDX[h]][2]));
    return { score, hits };
  }
  // move the simulation clock forward, processing payments and revealing complaints in time order
  function advance(to, render) {
    const fresh = [];
    for (;;) {
      const nextP = st.p < order.length ? MIN(order[st.p]) : Infinity, nextC = st.q < cbOrder.length ? REVEAL(cbOrder[st.q]) : Infinity;
      if (Math.min(nextP, nextC) > to) break;
      if (nextC < nextP) {
        const j = cbOrder[st.q++], i = CB.t[j];
        st.mCb[T.m[i]]++; st.uCb[T.u[i]]++; if (CB.fr[j]) st.mFr[T.m[i]]++;
        if (!st.revealed[i]) {
          st.revealed[i] = 1;
          if (st.decision[i] > 0) st.flaggedHit++; else if (st.decision[i] === 0) st.allowedHit++;
        }
        continue;
      }
      const i = order[st.p++];
      const { score, hits } = scoreTxn(i);
      const dec = score >= 60 ? 2 : score >= 30 ? 1 : 0;
      st.decision[i] = dec; st.score[i] = score;
      if (T.mi[i] >= 0) st.uLast[T.u[i]] = MIN(i);
      st.n++; st.amt += T.a[i] || 0;
      if (dec === 2) { st.hold++; st.holdAmt += T.a[i] || 0; } else if (dec === 1) st.review++;
      hits.forEach(h => st.fired[RULE_IDX[h]]++);
      const hk = Math.floor(MIN(i) / 60), hb = st.hourly.get(hk) || { n: 0, hold: 0, review: 0 };
      hb.n++; if (dec === 2) hb.hold++; else if (dec === 1) hb.review++;
      st.hourly.set(hk, hb);
      if (render) fresh.push({ i, score, hits, dec });
    }
    st.now = to;
    return fresh;
  }
  const decLabel = d => d === 2 ? `<span class="pill crit">✋ Hold</span>` : d === 1 ? `<span class="pill warn">👁 Review</span>` : `<span class="pill plain">Allow</span>`;
  function clockTxt(t) {
    const d = Math.floor(t / 1440), mi = Math.floor(t % 1440);
    return `${dayFmt(clampDay(d))} ${hh(Math.floor(mi / 60))}:${hh(mi % 60)}`;
  }
  function drawFeed(fresh) {
    const feed = $("s-feed");
    const show = fresh.slice(-10);
    for (const r of show) {
      const el = document.createElement("div");
      el.className = "frow" + (r.dec === 2 ? " block" : r.dec === 1 ? " flag" : "");
      el.dataset.i = r.i;
      const why = r.hits.length ? r.hits.map(h => RULES[RULE_IDX[h]][1]).join(" · ") : "no rules fired";
      el.innerHTML = `<span class="mono dim">${timeFmt(r.i)}</span><span class="mono">${esc(M.id[T.m[r.i]])}</span><span class="why" title="${esc(why)}">${esc(why)}</span><span class="r mono hide-sm" style="text-align:right">${inrFull(T.a[r.i])}</span><span>${decLabel(r.dec)}</span>`;
      feed.prepend(el);
    }
    while (feed.childElementCount > 40) feed.lastChild.remove();
    const big = fresh.filter(r => r.dec === 2).sort((a, b) => b.score - a.score)[0];
    const nowMs = performance.now();
    if (big && nowMs - lastToast > 2200 && activeView === "stream") {
      lastToast = nowMs;
      toast("✋", `Held ${txnId(big.i)} · score ${big.score}`, `${inrFull(T.a[big.i])} to ${esc(M.id[T.m[big.i]])} — ${esc(big.hits.slice(0, 2).map(h => RULES[RULE_IDX[h]][1]).join(", "))}`, 3000);
    }
  }
  function drawStats() {
    $("s-clock").textContent = clockTxt(st.now);
    $("s-scrub").value = Math.round((st.now - T0) / (T1 - T0) * 1000);
    const flagged = st.hold + st.review, fRate = flagged ? st.flaggedHit / flagged : 0, aRate = (st.n - flagged) ? st.allowedHit / (st.n - flagged) : 0;
    $("s-counters").innerHTML = [
      ["Processed", int(st.n), inr(st.amt)],
      ["Held", int(st.hold), `${pct(st.n ? st.hold / st.n : 0)} · ${inr(st.holdAmt)}`],
      ["Sent to review", int(st.review), pct(st.n ? st.review / st.n : 0)],
      ["Complaints surfaced", int(st.q), `of ${int(cbOrder.length)} linked`],
      ["Flagged → disputed", pct(fRate), `${int(st.flaggedHit)} confirmed so far`],
      ["Lift vs allowed", aRate && st.flaggedHit + st.allowedHit >= 50 ? (fRate / aRate).toFixed(2) + "×" : "—", st.flaggedHit + st.allowedHit >= 50 ? `allowed disputed ${pct(aRate)}${st.flaggedHit + st.allowedHit >= 300 && Math.abs(fRate / aRate - 1) < .25 ? " · ≈ no lift, same verdict as the backtest" : ""}` : "waiting for disputes to surface"],
    ].map(([l, v, s]) => `<div class="counter"><div class="lbl">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
    const ranked = RULES.map((r, k) => [r, st.fired[k]]).sort((a, b) => b[1] - a[1]);
    $("s-rules").innerHTML = ranked.map(([r, n]) => `<div><span>${esc(r[1])} <span class="dim">+${r[2]}</span></span><b>${int(n)}</b></div>`).join("");
    const nowH = Math.floor(st.now / 60), hours = Array.from({ length: 96 }, (_, k) => nowH - 95 + k);
    const el = $("c-stream"), c = chart(el); observe(el);
    c.setOption(base({
      animation: false,
      legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: TK.ink2, fontSize: 11 } },
      grid: { left: 8, right: 14, top: 26, bottom: 6, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis" },
      xAxis: axisCat(hours.map(h => { const d = Math.floor(h / 24); return `${dayFmt(clampDay(d))} ${hh(((h % 24) + 24) % 24)}h`; }), { axisLabel: { color: TK.ink3, fontSize: 10, hideOverlap: true } }),
      yAxis: axisVal({ splitNumber: 3 }),
      series: [
        { name: "Allowed", type: "bar", stack: "a", data: hours.map(h => { const b = st.hourly.get(h); return b ? b.n - b.hold - b.review : 0; }), itemStyle: { color: fade(TK.s[0], .55), borderRadius: [0, 0, 0, 0] }, barCategoryGap: "20%" },
        { name: "Review", type: "bar", stack: "a", data: hours.map(h => st.hourly.get(h)?.review || 0), itemStyle: { color: TK.warn } },
        { name: "Hold", type: "bar", stack: "a", data: hours.map(h => st.hourly.get(h)?.hold || 0), itemStyle: { color: TK.crit, borderRadius: [3, 3, 0, 0] } },
      ],
    }), true);
  }
  function tick(ts) {
    if (!playing) return;
    const dt = last ? Math.min(250, ts - last) : 16;
    last = ts;
    const to = Math.min(T1, st.now + speed / 60 * dt / 1000);
    const fresh = advance(to, true);
    if (fresh.length) drawFeed(fresh);
    if (ts - lastDraw > 400) { lastDraw = ts; drawStats(); }
    if (to >= T1) { pause(); toast("🏁", "Replay complete", `${int(st.n)} payments scored · ${int(st.hold)} held`); return; }
    raf = requestAnimationFrame(tick);
  }
  function play() {
    if (st.now >= T1) { reset(); $("s-feed").innerHTML = ""; }
    playing = true; last = 0;
    $("s-play").innerHTML = `<svg><use href="#i-pause"/></svg><span>Pause</span>`;
    raf = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false; cancelAnimationFrame(raf);
    $("s-play").innerHTML = `<svg><use href="#i-play"/></svg><span>${st.n ? "Resume" : "Start replay"}</span>`;
    drawStats();
  }
  function seek(frac) {
    const was = playing;
    pause();
    reset();
    advance(T0 + frac * (T1 - T0), false);
    $("s-feed").innerHTML = "";
    const recent = [];
    for (let k = st.p - 1; k >= 0 && recent.length < 30; k--) { const i = order[k]; const s2 = scoreTxn(i); recent.push({ i, score: st.score[i], hits: s2.hits, dec: st.decision[i] }); }
    drawFeed(recent.reverse());
    drawStats();
    if (was) play();
  }
  reset();
  $("s-play").addEventListener("click", () => playing ? pause() : play());
  $("s-reset").addEventListener("click", () => { pause(); reset(); $("s-feed").innerHTML = ""; drawStats(); });
  $("s-scrub").addEventListener("change", e => seek(+e.target.value / 1000));
  $("s-speed").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; speed = +b.dataset.v; $$("#s-speed button").forEach(x => x.setAttribute("aria-pressed", x === b)); });
  $("s-feed").addEventListener("click", e => { const r = e.target.closest("[data-i]"); if (r) openEntity({ type: "t", i: +r.dataset.i }); });
  VIEWS.stream = { render() { drawStats(); }, onLeave() { if (playing) pause(); } };
  return { toggle: () => playing ? pause() : play(), play, pause, rules: RULES, scoreAt: i => st.decision[i] >= 0 ? { score: st.score[i], decision: st.decision[i] } : null };
})();

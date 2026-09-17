/* =====================================================================================
   06 · Entity leaderboard + Entity 360 drawer (merchant, customer, payment, complaint, ring)
   ===================================================================================== */
function caseReason(ref) {
  const [t, s] = ref.split(":"), i = +s;
  if (t === "m") return `Merchant score ${M.score[i]} (${title(tierName(M.tier[i]))}): ${sigNames(M.sig[i], "msig").map(prettySignal).join(", ") || "no signals"}`;
  if (t === "u") return `Customer score ${U.score[i]} (${title(tierName(U.tier[i]))}): ${sigNames(U.sig[i], "usig").map(prettySignal).join(", ") || "no signals"}`;
  if (t === "k") return `Suspicious ring, score ${CL[i].score}: ${CL[i].u.length} customers, ${CL[i].m.length} merchants`;
  if (t === "t") return `Payment ${inrFull(T.a[i])} to ${M.id[T.m[i]]}`;
  if (t === "c") return `${title(D.reason[CB.r[i]])} complaint, ${inrFull(CB.a[i])}`;
  return "";
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-case]");
  if (!b) return;
  if (!Cases.add({ ref: b.dataset.case, reason: caseReason(b.dataset.case) })) toast("📌", "Already in the case queue", esc(refLabel(b.dataset.case)));
});

/* ------------------------------------------------------------------ leaderboard */
const Entities = (() => {
  let kind = "m", tier = TIER_HIGH, q = "", page = 0, sortK = "score", dir = -1;
  const PS = 14;
  function rows() {
    const N = kind === "m" ? NM : NU, E = kind === "m" ? M : U, dict = kind === "m" ? "msig" : "usig";
    const out = [];
    for (let i = 0; i < N; i++) {
      if (tier >= 0 && E.tier[i] !== tier) continue;
      const active = (kind === "m" ? txByM[i] : txByU[i]).some(t => SL.tm[t]);
      if (!active) continue;
      const st = kind === "m" ? merchantStats(i, SL) : userStats(i, SL);
      const sigs = sigNames(E.sig[i], dict);
      const r = { i, score: E.score[i], tier: E.tier[i], st, sigs, name: E.name[i] || "", city: E.city[i] || "", id: E.id[i] };
      if (q && !`${r.id} ${r.name} ${r.city} ${sigs.join(" ")} ${kind === "m" ? catName(M.cat[i]) + " " + merchantStatus(i) : D.kyc[userKyc(i)] || ""}`.toLowerCase().includes(q)) continue;
      out.push(r);
    }
    const val = r => sortK === "score" ? r.score : sortK === "id" ? r.id : r.st[sortK];
    return out.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || b.st.damt - a.st.damt; });
  }
  function charts(all) {
    const E = kind === "m" ? M : U, N = kind === "m" ? NM : NU, dict = kind === "m" ? "msig" : "usig";
    const counts = [0, 0, 0], fired = new Array(D[dict].length).fill(0);
    for (let i = 0; i < N; i++) {
      if (!(kind === "m" ? txByM[i] : txByU[i]).some(t => SL.tm[t])) continue;
      counts[E.tier[i]]++;
      if (E.tier[i] !== TIER_LOW) for (let b = 0; b < fired.length; b++) if (E.sig[i] & (1 << b)) fired[b]++;
    }
    const c1 = chart("c-ent-tiers"); observe($("c-ent-tiers"));
    const tiers = [TIER_HIGH, TIER_MED, TIER_LOW];
    c1.setOption(base({
      tooltip: { ...base().tooltip, trigger: "item", formatter: p => tipHead(p.name) + tipRow(p.color, kind === "m" ? "Merchants" : "Customers", `${int(p.value)} (${p.percent}%)`) },
      series: [{ type: "pie", radius: ["58%", "82%"], center: ["50%", "54%"], padAngle: 2, itemStyle: { borderRadius: 5, borderColor: TK.panel, borderWidth: 0 },
        label: { show: true, position: "center", formatter: () => `{a|${int(counts[TIER_HIGH])}}\n{b|high risk}`, rich: { a: { fontSize: 24, fontWeight: 600, color: TK.ink, fontFamily: "Space Grotesk" }, b: { fontSize: 11, color: TK.ink3, padding: [4, 0, 0, 0] } } },
        data: tiers.map(t => ({ name: title(D.tier[t]), value: counts[t], itemStyle: { color: t === TIER_HIGH ? TK.crit : t === TIER_MED ? TK.warn : fade(TK.ink3, .3) } })) }],
    }), true);
    const sig = D[dict].map((n, b) => ({ n: prettySignal(n), v: fired[b], p: R.sigw[dict][b] })).filter(x => x.v).sort((a, b) => a.v - b.v);
    const c2 = chart("c-ent-signals"); observe($("c-ent-signals"));
    c2.setOption(base({
      title: { text: "Signals firing on medium + high tier", textStyle: { color: TK.ink2, fontSize: 12, fontWeight: 500 }, left: 0, top: 0 },
      grid: { left: 20, right: 40, top: 26, bottom: 0, containLabel: true },
      tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => { const x = sig[ps[0].dataIndex]; return tipHead(x.n) + tipRow(TK.s[0], "Entities", int(x.v)) + tipRow(TK.ink3, "Points added", "+" + x.p); } },
      xAxis: axisVal({ splitNumber: 3 }), yAxis: axisCat(sig.map(x => `${x.n}  +${x.p}`), { axisLabel: { color: TK.ink2, fontSize: 10.5 } }),
      series: [{ type: "bar", data: sig.map(x => x.v), barMaxWidth: 12, itemStyle: { color: TK.s[0], borderRadius: [0, 4, 4, 0] }, label: { show: true, position: "right", color: TK.ink3, fontSize: 10, formatter: p => int(p.value) } }],
    }), true);
  }
  function draw() {
    const all = rows();
    const pages = Math.max(1, Math.ceil(all.length / PS));
    page = Math.min(page, pages - 1);
    const view = all.slice(page * PS, (page + 1) * PS);
    const isM = kind === "m";
    $("ent-title").textContent = isM ? "Merchant risk leaderboard" : "Customer risk leaderboard";
    $("ent-sub").textContent = `Scores are additive and explainable — each signal adds fixed points (hover a signal bar). Tier: High ≥ 50, Medium 30–49. Activity columns follow the global filters.`;
    $("ent-count").textContent = `${int(all.length)} ${isM ? "merchants" : "customers"}`;
    const th = (k, l, r) => `<th class="sortable ${r ? "r" : ""}" data-sort="${k}">${l}${sortK === k ? `<span class="ar">${dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;
    $("t-ent").innerHTML = `<table><thead><tr>${th("id", isM ? "Merchant" : "Customer")}${isM ? "<th>Category</th><th>Status</th>" : "<th>KYC</th><th>City</th>"}${th("score", "Score")}<th>Tier</th>${th("txns", "Payments", 1)}${th("cbs", "CBs", 1)}${th("damt", "Disputed", 1)}${th("ratio", "CB ratio", 1)}<th>Signals</th><th></th></tr></thead><tbody>${view.map(r =>
      `<tr class="click" data-i="${r.i}"><td>${isM ? mLink(r.i) : uLink(r.i)}<div class="dim" style="font-size:11px;margin-top:2px">${esc(r.name || (isM ? "not in master" : "no KYC record"))}</div></td>${isM ? `<td>${esc(catName(M.cat[r.i]))}</td><td>${inMaster(r.i) ? esc(title(merchantStatus(r.i))) : `<span class="pill serious">Not onboarded</span>`}</td>` : `<td>${kycPill(userKyc(r.i))}</td><td>${esc(r.city || "—")}</td>`}<td>${scoreBar(r.score, r.tier)}</td><td>${tierPill(r.tier)}</td><td class="r">${int(r.st.txns)}</td><td class="r">${int(r.st.cbs)}</td><td class="r">${inr(r.st.damt)}</td><td class="r">${pct(r.st.ratio, 0)}</td><td><div class="chips">${r.sigs.slice(0, 3).map(s => `<span class="chip">${esc(prettySignal(s))}</span>`).join("")}${r.sigs.length > 3 ? `<span class="chip">+${r.sigs.length - 3}</span>` : ""}</div></td><td><button class="btn xs" data-case="${kind}:${r.i}" title="Add to cases">📌</button></td></tr>`).join("") || `<tr><td colspan="11" class="empty">Nothing matches.</td></tr>`}</tbody></table>`;
    $("ent-pager").innerHTML = pages > 1 ? `<button class="btn xs" data-pg="-1" ${page ? "" : "disabled"}>← Prev</button><span>Page ${page + 1} of ${int(pages)}</span><button class="btn xs" data-pg="1" ${page < pages - 1 ? "" : "disabled"}>Next →</button>` : "";
    charts(all);
    return all;
  }
  $("t-ent").addEventListener("click", e => {
    const s = e.target.closest("[data-sort]");
    if (s) { const k = s.dataset.sort; if (k === sortK) dir *= -1; else { sortK = k; dir = k === "id" ? 1 : -1; } page = 0; draw(); return; }
    if (e.target.closest("[data-case]")) return;
    const tr = e.target.closest("tr[data-i]"); if (tr) openEntity({ type: kind, i: +tr.dataset.i });
  });
  $("ent-pager").addEventListener("click", e => { const b = e.target.closest("[data-pg]"); if (b) { page += +b.dataset.pg; draw(); } });
  $("ent-q").addEventListener("input", e => { q = e.target.value.trim().toLowerCase(); page = 0; draw(); });
  const setSeg = (id, v) => $$(`#${id} button`).forEach(x => x.setAttribute("aria-pressed", x.dataset.v === String(v)));
  $("ent-kind").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setKind(b.dataset.v); });
  $("ent-tier").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; tier = +b.dataset.v; setSeg("ent-tier", tier); page = 0; draw(); });
  $("ent-csv").addEventListener("click", () => {
    const all = rows(), isM = kind === "m";
    downloadCsv(isM ? "merchant_risk.csv" : "customer_risk.csv", ["id", "name", isM ? "category" : "kyc_status", "score", "tier", "payments", "chargebacks", "disputed_amount", "signals"],
      all.map(r => [r.id, r.name, isM ? catName(M.cat[r.i]) : D.kyc[userKyc(r.i)], r.score, tierName(r.tier), r.st.txns, r.st.cbs, r.st.damt.toFixed(2), r.sigs.join("; ")]));
  });
  function setKind(k) { kind = k; setSeg("ent-kind", k); page = 0; if (activeView === "entities") draw(); else dirty.add("entities"); }
  VIEWS.entities = { render() { draw(); } };
  return { setKind, setTier: t => { tier = t; setSeg("ent-tier", t); }, rows };
})();

/* =====================================================================================
   Entity 360 drawer
   ===================================================================================== */
const drawerStack = [];
function openEntity(ref, push = true) {
  if (!ref || ref.i == null || isNaN(ref.i)) return;
  if (push) drawerStack.push(ref);
  $("scrim").hidden = false; $("drawer").hidden = false;
  $("dr-back").disabled = drawerStack.length < 2;
  const body = $("dr-body");
  body.scrollTop = 0;
  body.innerHTML = ref.type === "m" ? drawMerchant(ref.i) : ref.type === "u" ? drawUser(ref.i) : ref.type === "t" ? drawTxn(ref.i) : ref.type === "c" ? drawComplaint(ref.i) : drawCluster(ref.i);
  $("dr-crumbs").textContent = "Entity 360 · " + drawerStack.map(r => refLabel(r.type + ":" + r.i)).slice(-4).join(" › ");
  requestAnimationFrame(() => drawerCharts(ref));
}
function closeDrawer() {
  $("scrim").hidden = true; $("drawer").hidden = true; drawerStack.length = 0;
  $$("#dr-body .chart").forEach(el => { const c = echarts.getInstanceByDom(el); if (c) { c.dispose(); charts.delete(el); } });
}
$("dr-close").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
$("dr-back").addEventListener("click", () => { if (drawerStack.length > 1) { drawerStack.pop(); openEntity(drawerStack[drawerStack.length - 1], false); } });

function ring(score, tier) {
  const r = 46, c = 2 * Math.PI * r, col = tierColor(tier);
  return `<div class="ring"><svg viewBox="0 0 108 108"><circle cx="54" cy="54" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="9"/><circle cx="54" cy="54" r="${r}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c * clamp(score, 0, 100) / 100} ${c}"/></svg><div><div class="rv">${score}</div><div class="rl">risk score</div></div></div>`;
}
const tile = (l, v) => `<div class="stat"><div class="lbl">${l}</div><div class="v">${v}</div></div>`;
const kv = pairs => `<div class="statgrid" style="grid-template-columns:repeat(2,minmax(0,1fr))">${pairs.map(([k, v]) => `<div class="stat"><div class="lbl">${esc(k)}</div><div style="margin-top:4px;font-size:13px">${v}</div></div>`).join("")}</div>`;
function payTable(list, partner) {
  const rows = list.slice().sort((a, b) => T.d[b] - T.d[a] || T.mi[b] - T.mi[a]).slice(0, 60);
  return `<div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Date</th><th>Payment</th><th>${partner === "u" ? "Customer" : "Merchant"}</th><th class="r">Amount</th><th>Status</th><th class="r">CBs</th></tr></thead><tbody>${rows.map(i =>
    `<tr><td class="mono dim">${dayIso(T.d[i])} ${timeFmt(i)}</td><td>${tLink(i)}</td><td>${partner === "u" ? uLink(T.u[i]) : mLink(T.m[i])}</td><td class="r">${inrFull(T.a[i])}</td><td>${statusPill(T.s[i])}</td><td class="r">${cbByT.get(i)?.length ? `<b style="color:var(--crit-ink)">${cbByT.get(i).length}</b>` : `<span class="dim">0</span>`}</td></tr>`).join("")}</tbody></table></div>${list.length > 60 ? `<div class="chart-note">Showing latest 60 of ${int(list.length)}.</div>` : ""}`;
}
function cbTable(js) {
  if (!js.length) return `<div class="empty">No complaints.</div>`;
  return `<div class="table-wrap" style="max-height:300px"><table><thead><tr><th>Complaint</th><th>Reason</th><th>Severity</th><th class="r">Disputed</th><th class="r">Delay</th><th>Status</th></tr></thead><tbody>${js.map(j =>
    `<tr><td>${cLink(j)}</td><td>${FRAUD_REASONS.has(D.reason[CB.r[j]]) ? "⚑ " : ""}${esc(title(D.reason[CB.r[j]]))}</td><td>${esc(title(D.sev[CB.sv[j]]))}</td><td class="r">${inrFull(CB.a[j])}</td><td class="r">${CB.dl[j] == null ? "—" : CB.dl[j].toFixed(1) + " d"}</td><td>${CB.op[j] ? `<span class="pill warn">${esc(title(D.res[CB.rs[j]]))}</span>` : `<span class="pill plain">${esc(title(D.res[CB.rs[j]]))}</span>`}</td></tr>`).join("")}</tbody></table></div>`;
}
const actions = (ref, id, extra = "") => `<div class="e-actions">
  <button class="btn primary sm" data-ask="Investigate ${id}: explain its risk score signal by signal, map its network, and recommend an action." data-agent="investigator"><svg><use href="#i-spark"/></svg>Investigate with AI</button>
  <button class="btn sm" data-case="${ref}"><svg><use href="#i-plus"/></svg>${Cases.has(ref) ? "In case queue" : "Add to cases"}</button>${extra}</div>`;
function whyBlock(id) { return `<div class="card" style="padding:14px"><div class="card-head"><div><h3>Why this score</h3><div class="sub">Each fired signal adds fixed points; the total is capped at 100.</div></div></div><div class="chart h220" id="${id}"></div></div>`; }

function drawMerchant(m) {
  const st = merchantStats(m), js = txByM[m].flatMap(i => cbByT.get(i) || []);
  const cl = mCl[m];
  return `<div class="e-head"><div><div class="eyebrow">Merchant · ${esc(catName(M.cat[m]))}${M.city[m] ? " · " + esc(M.city[m]) : ""}</div><h2 id="e-title">${esc(M.id[m])}</h2><div class="name">${esc(M.name[m] || "Not in the merchant master — never onboarded")}</div>
    <div class="pills">${tierPill(M.tier[m])}${inMaster(m) ? `<span class="pill ${NOT_ACTIVE.has(merchantStatus(m)) ? "crit" : "plain"}">${esc(title(merchantStatus(m)))}</span>` : `<span class="pill serious">Not onboarded</span>`}<span class="pill plain">Settlement: ${esc(title(D.settle[M.se[m]]))}</span>${cl >= 0 ? `<button class="pill crit" data-open="k:${cl}" style="border:0;cursor:pointer">In ring ${CL[cl].id}</button>` : ""}</div></div>${ring(M.score[m], M.tier[m])}</div>
    ${actions("m:" + m, M.id[m], `<button class="btn sm" id="dr-filter" data-patch='{"mch":${m}}'><svg><use href="#i-filter"/></svg>Filter desk to merchant</button>`)}
    <div class="tiles">${tile("Payments", int(st.txns))}${tile("Value", inr(st.amount))}${tile("Chargebacks", int(st.cbs))}${tile("Disputed", inr(st.damt))}${tile("Fraud-type", int(st.fraud))}${tile("CB ratio", pct(st.ratio, 0))}</div>
    ${whyBlock("dr-why")}
    <div class="card" style="padding:14px"><div class="card-head"><div><h3>Activity timeline</h3><div class="sub">Payments (● disputed in red) and when complaints were reported (▲).</div></div></div><div class="chart h220" id="dr-timeline"></div></div>
    <div class="card" style="padding:14px"><div class="card-head"><div><h3>Network neighbourhood</h3><div class="sub">Its payers, and the other merchants those payers also paid. Click a node to open it.</div></div></div><div class="chart h340" id="dr-ego"></div></div>
    <h3>Payments</h3>${payTable(txByM[m], "u")}<h3>Complaints</h3>${cbTable(js)}`;
}
function drawUser(u) {
  const st = userStats(u), js = txByU[u].flatMap(i => cbByT.get(i) || []), cl = uCl[u];
  return `<div class="e-head"><div><div class="eyebrow">Customer${U.city[u] ? " · " + esc(U.city[u]) : ""}${U.inc[u] ? " · income " + inr(U.inc[u]) + "/mo" : ""}</div><h2 id="e-title">${esc(U.id[u])}</h2><div class="name">${esc(U.name[u] || "No KYC record — identity unknown")}</div>
    <div class="pills">${tierPill(U.tier[u])}${kycPill(userKyc(u))}${userSeg(u) >= 0 ? `<span class="pill plain">Segment: ${esc(title(D.seg[userSeg(u)]))}</span>` : ""}${U.idc[u] > 1 ? `<span class="pill serious" title="This customer ID maps to several different KYC records">ID shared by ${U.idc[u]} people</span>` : ""}${cl >= 0 ? `<button class="pill crit" data-open="k:${cl}" style="border:0;cursor:pointer">In ring ${CL[cl].id}</button>` : ""}</div></div>${ring(U.score[u], U.tier[u])}</div>
    ${actions("u:" + u, U.id[u], `<button class="btn sm" id="dr-filter" data-patch='{"usr":${u}}'><svg><use href="#i-filter"/></svg>Filter desk to customer</button>`)}
    <div class="tiles">${tile("Payments", int(st.txns))}${tile("Value", inr(st.amount))}${tile("Chargebacks", int(st.cbs))}${tile("Disputed", inr(st.damt))}${tile("Fraud-type", int(st.fraud))}${tile("Merchants", int(st.merchants))}</div>
    ${whyBlock("dr-why")}
    <div class="card" style="padding:14px"><div class="card-head"><div><h3>Activity timeline</h3><div class="sub">Payments (● disputed in red) and when complaints were reported (▲).</div></div></div><div class="chart h220" id="dr-timeline"></div></div>
    <div class="card" style="padding:14px"><div class="card-head"><div><h3>Network neighbourhood</h3><div class="sub">Merchants paid, and the other customers who paid them.</div></div></div><div class="chart h340" id="dr-ego"></div></div>
    <h3>Payments</h3>${payTable(txByU[u], "m")}<h3>Complaints</h3>${cbTable(js)}`;
}
function drawTxn(i) {
  const js = cbByT.get(i) || [], dec = Stream.scoreAt(i);
  return `<div class="e-head"><div><div class="eyebrow">Payment · ${esc(catName(T.c[i]))}</div><h2 id="e-title">${txnId(i)}</h2><div class="name">${inrFull(T.a[i])} on ${dayIso(T.d[i])} at ${timeFmt(i)}</div>
    <div class="pills">${statusPill(T.s[i])}${kycPill(T.k[i])}<span class="pill ${D.utr[T.x[i]] === "VALID" ? "plain" : "warn"}">UTR ${esc(title(D.utr[T.x[i]]))}</span>${js.length ? `<span class="pill crit">${js.length} complaint${js.length > 1 ? "s" : ""}</span>` : ""}${dec ? `<span class="pill ${dec.decision === 2 ? "crit" : dec.decision === 1 ? "warn" : "plain"}">Live engine: ${dec.decision === 2 ? "Hold" : dec.decision === 1 ? "Review" : "Allow"} (${dec.score})</span>` : ""}</div></div></div>
    ${actions("t:" + i, txnId(i))}
    ${kv([["Customer", `${uLink(T.u[i])} ${esc(U.name[T.u[i]] || "")}`], ["Merchant", `${mLink(T.m[i])} ${esc(M.name[T.m[i]] || "")}`], ["Customer score", scoreBar(U.score[T.u[i]], U.tier[T.u[i]])], ["Merchant score", scoreBar(M.score[T.m[i]], M.tier[T.m[i]])]])}
    <h3>Complaints on this payment</h3>${cbTable(js)}`;
}
function drawComplaint(j) {
  const t = CB.t[j];
  return `<div class="e-head"><div><div class="eyebrow">Complaint · ${esc(title(D.ch[CB.ch[j]]))}</div><h2 id="e-title">${cbId(j)}</h2><div class="name">${FRAUD_REASONS.has(D.reason[CB.r[j]]) ? "⚑ Fraud-type · " : ""}${esc(title(D.reason[CB.r[j]]))} · ${inrFull(CB.a[j])} disputed</div>
    <div class="pills"><span class="pill ${SEV_ORDER.indexOf(D.sev[CB.sv[j]]) < 2 ? "crit" : "warn"}">${esc(title(D.sev[CB.sv[j]]))}</span><span class="pill ${CB.op[j] ? "warn" : "plain"}">${esc(title(D.res[CB.rs[j]]))}</span>${CB.dl[j] != null && CB.dl[j] > 7 ? `<span class="pill serious">Reported ${CB.dl[j].toFixed(0)} days late</span>` : ""}</div></div></div>
    ${actions("c:" + j, cbId(j))}
    ${kv([["Linked payment", t >= 0 ? `${tLink(t)} ${inrFull(T.a[t])}` : `<span class="dim">txn_id missing or unknown</span>`], ["Reported", CB.rd[j] == null ? "—" : dayIso(CB.rd[j])], ["Customer (via payment)", t >= 0 ? uLink(T.u[t]) : "—"], ["Merchant (via payment)", t >= 0 ? mLink(T.m[t]) : "—"], ["Reporting delay", CB.dl[j] == null ? "—" : CB.dl[j].toFixed(1) + " days"], ["Payment amount on complaint", inrFull(CB.ta[j])]])}
    <div class="chart-note">Attribution goes through <span class="mono">txn_id</span>: the complaint's own user and merchant IDs never match the payment it disputes.</div>`;
}
function drawCluster(ci) {
  const c = CL[ci], s = clusterStats(ci);
  return `<div class="e-head"><div><div class="eyebrow">Suspicious ring</div><h2 id="e-title">${c.id}</h2><div class="name">${s.users} customers · ${s.merchants} merchants · hub <span class="mono">${esc(s.hub)}</span></div>
    <div class="pills"><span class="pill crit">Score ${c.score}</span><span class="pill serious">${s.unverified} unverified</span></div></div></div>
    ${actions("k:" + ci, c.id, `<button class="btn sm" data-goto="network" id="dr-net">Show in network</button>`)}
    <div class="tiles">${tile("Payments", int(s.txns))}${tile("Value", inr(s.amount))}${tile("Chargebacks", int(s.chargebacks))}${tile("Fraud-type", int(s.fraud))}${tile("Customers", s.users)}${tile("Merchants", s.merchants)}</div>
    <div class="card" style="padding:14px"><div class="card-head"><h3>Ring structure</h3></div><div class="chart h340" id="dr-ego"></div></div>
    <h3>Members</h3><div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Score</th><th class="r">CBs</th><th>Signals</th></tr></thead><tbody>
    ${c.m.map(m => `<tr><td>${mLink(m)}</td><td>${esc(M.name[m] || "not in master")}</td><td>${scoreBar(M.score[m], M.tier[m])}</td><td class="r">${merchantStats(m).cbs}</td><td><div class="chips">${sigNames(M.sig[m], "msig").slice(0, 3).map(x => `<span class="chip">${esc(prettySignal(x))}</span>`).join("")}</div></td></tr>`).join("")}
    ${c.u.map(u => `<tr><td>${uLink(u)}</td><td>${esc(U.name[u] || "no KYC record")}</td><td>${scoreBar(U.score[u], U.tier[u])}</td><td class="r">${userStats(u).cbs}</td><td><div class="chips">${sigNames(U.sig[u], "usig").slice(0, 3).map(x => `<span class="chip">${esc(prettySignal(x))}</span>`).join("")}</div></td></tr>`).join("")}</tbody></table></div>`;
}
$("dr-body").addEventListener("click", e => {
  const f = e.target.closest("#dr-filter");
  if (f) { setF(JSON.parse(f.dataset.patch)); closeDrawer(); toast("🔎", "Desk filtered", "Every view now shows only this entity's activity"); }
  const n = e.target.closest("#dr-net");
  if (n) { const ci = drawerStack[drawerStack.length - 1].i; closeDrawer(); Network.select(ci); }
  if (e.target.closest("[data-ask]")) closeDrawer();
});

function drawerCharts(ref) {
  const { type, i } = ref;
  if (type === "m" || type === "u") {
    const E = type === "m" ? M : U, dict = type === "m" ? "msig" : "usig";
    const parts = sigPoints(E.sig[i], dict);
    const el = $("dr-why");
    if (el) {
      const c = chart(el);
      let run = 0;
      const rows = parts.map(([n, p]) => { const r = { n: prettySignal(n), base: run, p }; run += p; return r; });
      c.setOption(base({
        grid: { left: 20, right: 40, top: 8, bottom: 4, containLabel: true },
        tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => { const r = rows[ps[0].dataIndex]; return r ? tipHead(r.n) + tipRow(TK.crit, "Adds", "+" + r.p) + tipRow(TK.ink3, "Running total", r.base + r.p) : ""; } },
        xAxis: axisVal({ max: Math.max(100, run), splitNumber: 4 }), yAxis: axisCat(rows.map(r => r.n), { inverse: true, axisLabel: { color: TK.ink2, fontSize: 10.5 } }),
        series: [
          { type: "bar", stack: "w", data: rows.map(r => r.base), itemStyle: { color: "transparent" }, silent: true },
          { type: "bar", stack: "w", data: rows.map(r => r.p), barMaxWidth: 16, itemStyle: { color: p => fade(tierColor(E.tier[i]), .55 + .45 * (p.dataIndex + 1) / rows.length), borderRadius: 4 }, label: { show: true, position: "right", color: TK.ink2, fontSize: 10.5, formatter: p => "+" + p.value } },
        ],
        graphic: rows.length ? [] : [{ type: "text", left: "center", top: "middle", style: { text: "No risk signals fired", fill: TK.ink3, fontSize: 12 } }],
      }), true);
    }
    const list = type === "m" ? txByM[i] : txByU[i];
    const tl = $("dr-timeline");
    if (tl) {
      const c = chart(tl);
      const pts = list.map(t => [T.d[t] + (T.mi[t] < 0 ? .5 : T.mi[t] / 1440), T.a[t] || 0, t, cbByT.has(t) ? 1 : 0]);
      const reps = list.flatMap(t => (cbByT.get(t) || []).filter(j => CB.rd[j] != null).map(j => [CB.rd[j] + .5, CB.a[j] || 0, j]));
      c.setOption(base({
        grid: { left: 8, right: 14, top: 26, bottom: 4, containLabel: true },
        legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: TK.ink2, fontSize: 11 } },
        tooltip: { ...base().tooltip, trigger: "item", formatter: p => p.seriesIndex === 2 ? tipHead(cbId(p.data[2])) + tipRow(TK.crit, "Reported", dayIso(Math.floor(p.data[0]))) + tipRow(TK.crit, "Disputed", inrFull(p.data[1])) : tipHead(txnId(p.data[2])) + tipRow(TK.s[0], dayIso(Math.floor(p.data[0])), inrFull(p.data[1])) },
        xAxis: axisVal({ min: 0, max: Math.max(DAYS, ...reps.map(r => Math.ceil(r[0]))), splitNumber: 6, axisLabel: { color: TK.ink3, fontSize: 10, formatter: v => dayFmt(Math.round(v)) } }),
        yAxis: axisVal({ splitNumber: 3, axisLabel: { color: TK.ink3, fontSize: 10, formatter: v => inr(v) } }),
        series: [
          { name: "Payment", type: "scatter", data: pts.filter(p => !p[3]), symbolSize: 9, itemStyle: { color: TK.s[0], borderColor: TK.panel, borderWidth: 2 } },
          { name: "Disputed payment", type: "scatter", data: pts.filter(p => p[3]), symbolSize: 11, itemStyle: { color: TK.crit, borderColor: TK.panel, borderWidth: 2 } },
          { name: "Complaint reported", type: "scatter", data: reps, symbol: "triangle", symbolSize: 11, itemStyle: { color: TK.warn, borderColor: TK.panel, borderWidth: 1.5 } },
        ],
      }), true);
      c.off("click");
      c.on("click", p => openEntity(p.seriesIndex === 2 ? { type: "c", i: p.data[2] } : { type: "t", i: p.data[2] }));
    }
  }
  const ego = $("dr-ego");
  if (ego) {
    const nodes = new Map(), links = [];
    const addN = (kind, i, role) => { const id = kind + i; if (!nodes.has(id)) nodes.set(id, { id, kind, i, role }); return id; };
    const addL = (a, b, cbs) => links.push({ source: a, target: b, lineStyle: { color: cbs ? TK.crit : TK.line2, width: cbs ? 2 : 1, opacity: cbs ? .8 : .6 } });
    if (type === "m" || type === "u") {
      const center = addN(type, i, "center");
      const own = type === "m" ? txByM[i] : txByU[i];
      const partners = new Map();
      for (const t of own) { const p = type === "m" ? T.u[t] : T.m[t]; partners.set(p, (partners.get(p) || 0) + (cbByT.get(t)?.length || 0)); }
      [...partners].slice(0, 18).forEach(([p, cbs]) => {
        const pid = addN(type === "m" ? "u" : "m", p, "partner"); addL(center, pid, cbs);
        const second = type === "m" ? txByU[p] : txByM[p];
        second.filter(t => (type === "m" ? T.m[t] : T.u[t]) !== i).slice(0, 4).forEach(t => { const q = type === "m" ? T.m[t] : T.u[t]; const qid = addN(type, q, "second"); addL(pid, qid, cbByT.get(t)?.length || 0); });
      });
    } else if (type === "k") {
      for (const e of clusterEdges(i)) { addL(addN("u", e.u, "partner"), addN("m", e.m, "partner"), e.cbs); }
      const hub = CL[i].hub, hk = hub.startsWith("M:") ? "m" + mIndex.get(hub.slice(2)) : "u" + uIndex.get(hub.slice(2));
      if (nodes.has(hk)) nodes.get(hk).role = "center";
    }
    const c = chart(ego);
    c.setOption(base({
      tooltip: { ...base().tooltip, formatter: p => p.dataType === "node" ? tipHead(p.data.name) + tipRow(tierColor(p.data.kind === "m" ? M.tier[p.data.i] : U.tier[p.data.i]), "Risk score", p.data.kind === "m" ? M.score[p.data.i] : U.score[p.data.i]) : "" },
      series: [{
        type: "graph", layout: "force", roam: true, draggable: true, force: { repulsion: 140, edgeLength: [30, 70], gravity: .1 },
        data: [...nodes.values()].map(n => {
          const tier = n.kind === "m" ? M.tier[n.i] : U.tier[n.i];
          return { ...n, name: n.kind === "m" ? M.id[n.i] : U.id[n.i], symbol: n.kind === "m" ? "roundRect" : "circle", symbolSize: n.role === "center" ? 30 : n.role === "partner" ? 16 : 10,
            itemStyle: { color: n.role === "center" ? TK.accent : n.kind === "m" ? TK.s[1] : TK.s[0], borderColor: tier === TIER_HIGH ? TK.crit : TK.panel, borderWidth: tier === TIER_HIGH ? 3 : 1.5, opacity: n.role === "second" ? .6 : 1 },
            label: { show: n.role !== "second", color: TK.ink2, fontSize: 9.5, fontFamily: TK.mono, position: "bottom" } };
        }),
        links, emphasis: { focus: "adjacency" },
      }],
    }), true);
    c.off("click");
    c.on("click", p => { if (p.dataType === "node" && p.data.role !== "center") openEntity({ type: p.data.kind, i: p.data.i }); });
  }
}

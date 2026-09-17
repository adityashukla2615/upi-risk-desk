/* =====================================================================================
   05 · Fraud ring intelligence — force-directed dispute network + ring leaderboard
   ===================================================================================== */
const Network = (() => {
  let minScore = 8, selected = -1, nodesIdx = new Map(), graphNodes = [];
  function build() {
    const nodes = [], links = [], seenU = new Map(), seenM = new Map();
    nodesIdx = new Map();
    // constellation layout: every ring gets its own cell (highest score top-left); merchants on an inner
    // circle, customers on an outer one — rings stay readable instead of collapsing into one hairball
    const shown = CL.map((c, ci) => ci).filter(ci => CL[ci].score >= minScore);
    const cols = Math.max(1, Math.ceil(Math.sqrt(shown.length * 1.7))), CELL = 100;
    const ring = (k, n, r, cx, cy, phase = 0) => [cx + r * Math.cos(phase + 2 * Math.PI * k / Math.max(1, n)), cy + r * Math.sin(phase + 2 * Math.PI * k / Math.max(1, n))];
    shown.forEach((ci, pos) => {
      const c = CL[ci], cx = (pos % cols) * CELL, cy = Math.floor(pos / cols) * CELL;
      c.m.forEach((m, k) => { if (seenM.has(m)) return; const [x, y] = c.m.length === 1 ? [cx, cy] : ring(k, c.m.length, 13, cx, cy); seenM.set(m, nodes.length); nodes.push({ id: "m" + m, name: M.id[m], ci, kind: "m", i: m, value: merchantStats(m).cbs, category: 1, x, y, fixed: true }); });
      c.u.forEach((u, k) => { if (seenU.has(u)) return; const [x, y] = ring(k, c.u.length, 34, cx, cy, .4); seenU.set(u, nodes.length); nodes.push({ id: "u" + u, name: U.id[u], ci, kind: "u", i: u, value: userStats(u).cbs, category: 0, x, y, fixed: true }); });
      for (const e of clusterEdges(ci)) links.push({ source: "u" + e.u, target: "m" + e.m, value: e.txns, cbs: e.cbs, lineStyle: { color: e.cbs ? TK.crit : TK.line2, width: e.cbs ? 1.2 + e.cbs * .6 : 1, opacity: e.cbs ? .75 : .5 } });
    });
    nodes.forEach((n, k) => { const a = nodesIdx.get(n.ci) || []; a.push(k); nodesIdx.set(n.ci, a); });
    // ring id captions under each cell
    shown.forEach((ci, pos) => nodes.push({ id: "lbl" + ci, name: CL[ci].id, ci, kind: "label", x: (pos % cols) * CELL, y: Math.floor(pos / cols) * CELL + 46, symbolSize: 0, fixed: true, label: { show: true, position: "inside", color: TK.ink3, fontSize: 9, fontFamily: TK.mono, formatter: `${CL[ci].id} · ${CL[ci].score}` }, tooltip: { show: false } }));
    graphNodes = nodes;
    return { nodes, links };
  }
  function draw() {
    const { nodes, links } = build();
    const el = $("c-network"), c = chart(el); observe(el);
    c.setOption(base({
      tooltip: { ...base().tooltip, formatter: p => {
        if (p.dataType === "edge") return tipHead(`${p.data.source.startsWith("u") ? U.id[+p.data.source.slice(1)] : ""} → ${M.id[+p.data.target.slice(1)]}`) + tipRow(TK.s[0], "Payments", int(p.data.value)) + tipRow(TK.crit, "Chargebacks", int(p.data.cbs));
        const n = p.data;
        if (n.kind === "label") return tipHead(`${CL[n.ci].id} · score ${CL[n.ci].score}`) + tipRow(TK.ink3, "Click to inspect", "");
        const tier = n.kind === "u" ? U.tier[n.i] : M.tier[n.i];
        return tipHead(`${n.name} · ${CL[n.ci].id}`) + tipRow(n.kind === "u" ? TK.s[0] : TK.s[1], n.kind === "u" ? (U.name[n.i] || "no KYC record") : (M.name[n.i] || "not in master"), "") + tipRow(tierColor(tier), "Risk score", `${n.kind === "u" ? U.score[n.i] : M.score[n.i]} · ${title(tierName(tier))}`) + tipRow(TK.crit, "Chargebacks", int(n.value));
      } },
      legend: { top: 0, left: 0, textStyle: { color: TK.ink2, fontSize: 11 }, itemWidth: 10, itemHeight: 10, data: ["Customer", "Merchant"] },
      series: [{
        type: "graph", layout: "none", roam: true, draggable: false, top: 36, bottom: 10, left: 10, right: 10,
        categories: [{ name: "Customer", itemStyle: { color: TK.s[0] }, symbol: "circle" }, { name: "Merchant", itemStyle: { color: TK.s[1] }, symbol: "roundRect" }],
        data: nodes.map(n => ({ ...n, symbolSize: 6 + Math.min(12, n.value * 2.4), itemStyle: { borderColor: TK.panel, borderWidth: 1 } })),
        links, lineStyle: { curveness: 0 },
        emphasis: { focus: "adjacency", lineStyle: { width: 3 } },
        selectedMode: "multiple", select: { itemStyle: { borderColor: TK.ink, borderWidth: 2.5, shadowBlur: 14, shadowColor: TK.accent } },
        scaleLimit: { min: .3, max: 6 },
      }],
    }), true);
    c.off("click"); c.off("dblclick");
    c.on("click", p => { if (p.dataType === "node") selectCluster(p.data.ci, false); });
    c.on("dblclick", p => { if (p.dataType === "node" && p.data.kind !== "label") openEntity({ type: p.data.kind, i: p.data.i }); });
    if (selected >= 0) highlight(selected);
  }
  function highlight(ci) {
    const c = echarts.getInstanceByDom($("c-network"));
    if (!c) return;
    c.dispatchAction({ type: "unselect", seriesIndex: 0, dataIndex: graphNodes.map((_, k) => k) });
    const idx = nodesIdx.get(ci);
    if (idx) c.dispatchAction({ type: "select", seriesIndex: 0, dataIndex: idx });
  }
  function selectCluster(ci, fromTable = true) {
    selected = ci;
    if (CL[ci].score < minScore) { minScore = Math.floor(CL[ci].score); $("n-min").value = minScore; $("n-min-v").textContent = minScore; draw(); }
    highlight(ci);
    side();
    $$("#t-rings tr[data-ci]").forEach(tr => tr.style.background = +tr.dataset.ci === ci ? "var(--accent-soft)" : "");
    if (fromTable) $("c-network").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function side() {
    const el = $("n-side");
    if (selected < 0) {
      const shown = CL.filter(c => c.score >= minScore);
      el.innerHTML = `<div class="card"><div class="card-head"><h3>Network at a glance</h3></div>
        <div class="statgrid">${[["Rings", int(CL.length)], ["Shown", int(shown.length)], ["Customers", int(sum(CL, c => c.u.length))], ["Merchants", int(sum(CL, c => c.m.length))], ["Top score", CL[0].score], ["Graph nodes", "72K"]].map(([l, v]) => `<div class="stat"><div class="lbl">${l}</div><div class="v">${v}</div></div>`).join("")}</div>
        <p class="chart-note" style="margin:0">Built from the property graph (User → Transaction → Merchant, Transaction → Chargeback). Clusters are connected components of dispute-touched customers and merchants with at least four members.</p>
        <button class="btn primary" data-ask="Find the most suspicious fraud rings in the payment graph and explain what makes each one risky." data-agent="investigator"><svg><use href="#i-spark"/></svg>Ask the Investigator</button></div>
        <div class="card"><div class="card-head"><h3>Top rings</h3></div>${CL.slice(0, 6).map((c, ci) => `<div class="alert ${ci < 2 ? "crit" : "serious"}" data-sel="${ci}" style="grid-template-columns:4px 1fr"><span class="bar"></span><div><h4 style="margin-top:0">${c.id} · score ${c.score}</h4><p>${c.u.length} customers · ${c.m.length} merchants · ${c.unv} unverified</p></div></div>`).join("")}</div>`;
    } else {
      const c = CL[selected], s = clusterStats(selected);
      el.innerHTML = `<div class="card"><div class="card-head"><div><div class="dim mono" style="font-size:10px;letter-spacing:.12em">SELECTED RING</div><h3 style="font-size:22px;font-family:var(--f-mono)">${c.id}</h3></div><span class="pill ${c.score >= 20 ? "crit" : c.score >= 12 ? "serious" : "warn"}">Score ${c.score}</span></div>
        <div class="statgrid">${[["Customers", s.users], ["Merchants", s.merchants], ["Payments", s.txns], ["Chargebacks", s.chargebacks], ["Fraud-type", s.fraud], ["Unverified", s.unverified]].map(([l, v]) => `<div class="stat"><div class="lbl">${l}</div><div class="v">${int(v)}</div></div>`).join("")}</div>
        <div class="chart-note">Hub <b class="mono">${esc(s.hub)}</b> (degree ${s.hub_degree}) · ${inr(s.amount)} paid inside the ring</div>
        <div class="e-actions"><button class="btn primary sm" data-ask="Investigate fraud ring ${c.id}: who is in it, how the members are connected, and what we should do." data-agent="investigator"><svg><use href="#i-spark"/></svg>Investigate</button><button class="btn sm" data-case="k:${selected}"><svg><use href="#i-plus"/></svg>Add to cases</button><button class="btn sm" data-open="k:${selected}">Ring 360</button><button class="btn ghost sm" id="n-clear">Clear</button></div></div>
        <div class="card"><div class="card-head"><h3>Members</h3></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>KYC / status</th><th>Score</th><th class="r">CBs</th></tr></thead><tbody>
        ${c.m.map(m => `<tr><td>${mLink(m)}</td><td>${esc(title(merchantStatus(m)))}</td><td>${scoreBar(M.score[m], M.tier[m])}</td><td class="r">${int(merchantStats(m).cbs)}</td></tr>`).join("")}
        ${c.u.map(u => `<tr><td>${uLink(u)}</td><td>${kycPill(userKyc(u))}</td><td>${scoreBar(U.score[u], U.tier[u])}</td><td class="r">${int(userStats(u).cbs)}</td></tr>`).join("")}</tbody></table></div></div>`;
    }
    el.onclick = e => {
      const s = e.target.closest("[data-sel]"); if (s) { selectCluster(+s.dataset.sel, false); return; }
      if (e.target.closest("#n-clear")) { selected = -1; highlight(-1); side(); }
    };
  }
  function table() {
    const stats = CL.map((_, ci) => clusterStats(ci));
    $("t-rings").innerHTML = `<table><thead><tr><th>Ring</th><th class="r">Score</th><th class="r">Customers</th><th class="r">Merchants</th><th class="r">Payments</th><th class="r">CBs</th><th class="r">Fraud</th><th class="r">Unverified</th><th>Hub</th></tr></thead><tbody>${stats.map((s, ci) =>
      `<tr class="click" data-ci="${ci}"><td class="mono">${s.id}</td><td class="r"><b>${s.score}</b></td><td class="r">${s.users}</td><td class="r">${s.merchants}</td><td class="r">${s.txns}</td><td class="r">${s.chargebacks}</td><td class="r">${s.fraud}</td><td class="r">${s.unverified}</td><td class="mono">${esc(s.hub)}</td></tr>`).join("")}</tbody></table>`;
    $("t-rings").onclick = e => { const tr = e.target.closest("tr[data-ci]"); if (tr) selectCluster(+tr.dataset.ci); };
    const CR = DATA.circular_rings.stats;
    $("cycles-card").innerHTML = `<div class="statgrid">${[["Accounts", int(CR.accounts)], ["Payments", int(CR.payments_in_graph)], ["Cyclic SCCs", int(CR.cyclic_components)], ["Candidate loops", int(CR.structural_cycles)], ["Validated", int(CR.validated_cycles)], ["Rings", int(CR.rings)]].map(([l, v]) => `<div class="stat"><div class="lbl">${l}</div><div class="v">${v}</div></div>`).join("")}</div>
      <div class="verdict" style="margin-top:4px">${CR.rings ? `<b>${int(CR.rings)} laundering rings</b> found.` : `<b>No money loops — and that is a real result.</b> In this data money only flows customer → merchant, so no cycle can close. The engine (15 unit tests) runs on every build and will surface round-tripping as soon as P2P or merchant-payout rails are added.`}</div>`;
  }
  $("n-min").addEventListener("input", e => { $("n-min-v").textContent = e.target.value; });
  $("n-min").addEventListener("change", e => { minScore = +e.target.value; draw(); side(); });
  $("n-reset").addEventListener("click", () => { minScore = 0; $("n-min").value = 0; $("n-min-v").textContent = 0; selected = -1; draw(); side(); });
  let tableDone = false;
  VIEWS.network = {
    render() { draw(); side(); if (!tableDone) { table(); tableDone = true; } },
  };
  return { select: ci => { go("network"); selectCluster(ci, false); } };
})();

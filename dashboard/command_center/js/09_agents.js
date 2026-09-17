/* =====================================================================================
   09 · Risk Agents — a small team that shares one tool registry
     🧭 Risk Lead      routes work and delegates (Claude mode: real delegation, in parallel)
     📊 Analyst        metrics, trends, breakdowns, rankings
     🕵️ Investigator   entities, networks, rings, case files
     🛰️ Sentinel       anomaly and alert scanning
     📝 Reporter       executive briefs and case-queue summaries
   Two brains: Claude Opus 5 (tool use, when a key is connected) or the built-in local
   reasoning engine (deterministic planner over the same tools) so the desk always works.
   ===================================================================================== */
const AGENTS = {
  lead: { name: "Risk Lead", emoji: "🧭", role: "Plans the work and delegates to specialists", tools: ["delegate", "get_kpis", "sentinel_alerts", "show_chart", "apply_filters", "navigate", "open_entity", "add_to_cases"] },
  analyst: { name: "Analyst", emoji: "📊", role: "Metrics, trends, breakdowns and rankings", tools: ["get_kpis", "query_breakdown", "rank_entities", "find_disputes", "data_quality", "model_health", "show_chart", "apply_filters", "navigate"] },
  investigator: { name: "Investigator", emoji: "🕵️", role: "Entity 360, networks, rings, case files", tools: ["get_entity", "get_network", "list_rings", "rank_entities", "find_disputes", "show_chart", "open_entity", "add_to_cases", "apply_filters"] },
  sentinel: { name: "Sentinel", emoji: "🛰️", role: "Scans for anomalies, spikes and control gaps", tools: ["sentinel_alerts", "get_kpis", "query_breakdown", "rank_entities", "find_disputes", "show_chart", "apply_filters"] },
  reporter: { name: "Reporter", emoji: "📝", role: "Executive briefs and investigation summaries", tools: ["get_kpis", "sentinel_alerts", "query_breakdown", "list_rings", "rank_entities", "model_health", "get_case_queue", "get_entity", "show_chart"] },
};
const MODEL = "claude-opus-5";

/* ------------------------------------------------------------------ small markdown renderer (escape first, then format) */
function md(src) {
  const lines = esc(src || "").split(/\r?\n/);
  const out = [];
  let list = null, table = null, para = [];
  const inline = s => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.t}>`); list = null; } };
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter(r => !/^\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
    if (rows.length) out.push(`<div class="tw"><table><thead><tr>${rows[0].map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td${/^[₹\d.,%\-+× ]+(Cr|L|d)?$/.test(c) ? ' class="r"' : ""}>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    table = null;
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) { flushPara(); flushList(); (table = table || []).push(l.trim()); continue; }
    flushTable();
    let m;
    if (!l.trim()) { flushPara(); flushList(); continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h4>${inline(m[2])}</h4>`); continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (!list || list.t !== "ul") { flushList(); list = { t: "ul", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.t !== "ol") { flushList(); list = { t: "ol", items: [] }; } list.items.push(m[1]); continue; }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushList(); para.push(l.trim());
  }
  flushPara(); flushList(); flushTable();
  return linkify(out.join(""));
}
function linkify(html) {
  // only touch text outside tags
  return html.replace(/(>|^)([^<]*)/g, (all, gt, text) => gt + text.replace(ID_RE, m => { const r = resolveId(m); return r ? `<button class="idl" data-open="${r.type}:${r.i}">${r.id}</button>` : m; }));
}

/* ------------------------------------------------------------------ chart artifacts */
function chartOption(spec) {
  const fmt = spec.value_format === "inr" ? inr : spec.value_format === "percent" ? v => pct(v) : v => (Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(2) : int(v));
  const series = (spec.series || []).slice(0, 3);
  if (spec.type === "pie") {
    return base({
      tooltip: { ...base().tooltip, trigger: "item", formatter: p => tipHead(p.name) + tipRow(p.color, series[0]?.name || "", `${fmt(p.value)} (${p.percent}%)`) },
      legend: { orient: "vertical", right: 0, top: "middle", itemWidth: 9, itemHeight: 9, textStyle: { color: TK.ink2, fontSize: 10.5 } },
      series: [{ type: "pie", radius: ["45%", "78%"], center: ["35%", "50%"], padAngle: 2, itemStyle: { borderRadius: 4 }, label: { show: false }, data: spec.labels.slice(0, 6).map((l, k) => ({ name: l, value: series[0]?.values[k] ?? 0, itemStyle: { color: TK.s[k] } })) }],
    });
  }
  const horiz = spec.type === "hbar";
  const cat = axisCat(spec.labels, horiz ? { inverse: true, axisLabel: { color: TK.ink2, fontSize: 10, width: 110, overflow: "truncate" } } : { axisLabel: { color: TK.ink3, fontSize: 10, hideOverlap: true } });
  const val = axisVal({ splitNumber: 3, axisLabel: { color: TK.ink3, fontSize: 10, formatter: fmt } });
  return base({
    grid: { left: 6, right: horiz ? 46 : 10, top: series.length > 1 ? 24 : 10, bottom: 4, containLabel: true },
    legend: series.length > 1 ? { top: 0, right: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: TK.ink2, fontSize: 10.5 } } : undefined,
    tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: horiz || spec.type === "bar" ? "shadow" : "line" }, formatter: ps => tipHead(ps[0].name) + ps.map(p => tipRow(p.color, p.seriesName, fmt(p.value))).join("") },
    xAxis: horiz ? val : cat, yAxis: horiz ? cat : val,
    series: series.map((s, k) => ({
      name: s.name, type: spec.type === "line" ? "line" : "bar", data: s.values, barMaxWidth: horiz ? 12 : 26, symbol: "none", smooth: .25,
      itemStyle: { color: TK.s[k], borderRadius: horiz ? [0, 4, 4, 0] : [4, 4, 0, 0] }, lineStyle: { width: 2, color: TK.s[k] },
      areaStyle: spec.type === "line" && series.length === 1 ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: fade(TK.s[k], .25) }, { offset: 1, color: fade(TK.s[k], 0) }]) } : undefined,
      label: horiz && series.length === 1 ? { show: true, position: "right", color: TK.ink3, fontSize: 10, formatter: p => fmt(p.value) } : undefined,
    })),
  });
}

/* =====================================================================================
   Copilot UI
   ===================================================================================== */
const Copilot = (() => {
  let agentPick = "lead", busy = false, apiKey = "", client = null, history = [], abort = null;
  const chartSpecs = [];
  try { apiKey = sessionStorage.getItem("upi-cc-key") || localStorage.getItem("upi-cc-key") || ""; } catch (e) { /* storage blocked */ }

  function isLive() { return !!apiKey; }
  function modeBadge() {
    const m = $("cp-mode");
    m.classList.toggle("live", isLive());
    m.querySelector("span").textContent = isLive() ? `Claude Opus 5 · tool use` : "Local reasoning engine · offline";
  }
  $("cp-agents").innerHTML = Object.entries(AGENTS).map(([k, a]) => `<button class="agent-chip" data-agent="${k}" aria-pressed="${k === agentPick}" title="${esc(a.role)}"><span class="e">${a.emoji}</span>${k === "lead" ? "Auto · Risk Lead" : a.name}</button>`).join("");
  $("cp-agents").addEventListener("click", e => { const b = e.target.closest("[data-agent]"); if (!b) return; agentPick = b.dataset.agent; $$("#cp-agents .agent-chip").forEach(x => x.setAttribute("aria-pressed", x === b)); $("cp-input").placeholder = `Ask ${AGENTS[agentPick].name}…`; });

  function welcome() {
    $("cp-body").innerHTML = `<div class="welcome">
      <h4>Your risk operations team</h4>
      <p>Five agents share one set of tools over the cleaned payment graph. They can answer questions, investigate entities and rings, drive the dashboard filters, and file cases. Every number comes from a tool call you can inspect.</p>
      <div class="team">${Object.values(AGENTS).map(a => `<div class="member"><span class="e">${a.emoji}</span><b>${a.name}</b><span>${esc(a.role)}</span></div>`).join("")}</div>
      <div class="suggest">${[
        ["📝", "Give me an executive risk brief with the top actions"],
        ["🕵️", `Investigate ${M.id[mIndex.get(DATA.top_merchants_cb[0].merchant_id)]}`],
        ["🕸️", "Find suspicious fraud rings in the payment graph"],
        ["📊", "Which merchant category has the highest disputed amount?"],
        ["📈", "Compare successful vs failed transactions by day"],
        ["⏱️", "Show disputes reported after 7 days"],
        ["🛰️", "What looks unusual in February?"],
        ["📌", "Add the top 5 highest-risk merchants to my case queue"],
      ].map(([i, q]) => `<button data-q="${esc(q)}"><span>${i}</span>${esc(q)}</button>`).join("")}</div>
    </div>`;
  }
  $("cp-body").addEventListener("click", e => {
    const q = e.target.closest("[data-q]"); if (q) { send(q.dataset.q); return; }
    const a = e.target.closest("[data-art]"); if (a) { const fn = actionsById.get(a.dataset.art); if (fn) fn(); }
  });
  const actionsById = new Map();

  function toggle(force) {
    const open = force ?? !$("copilot").classList.contains("open");
    $("copilot").classList.toggle("open", open);
    if (open) setTimeout(() => $("cp-input").focus(), 250);
    setTimeout(() => { for (const [, c] of charts) c.resize(); }, 320);
  }
  $("copilot-btn").addEventListener("click", () => toggle());
  $("cp-close").addEventListener("click", () => toggle(false));
  $("cp-new").addEventListener("click", () => { if (abort) abort.abort(); history = []; chartSpecs.length = 0; welcome(); });

  // settings
  $("cp-settings-btn").addEventListener("click", () => { $("cp-settings").hidden = !$("cp-settings").hidden; $("cp-key").value = apiKey ? "••••••••" + apiKey.slice(-4) : ""; });
  $("cp-key-save").addEventListener("click", async () => {
    const v = $("cp-key").value.trim();
    if (!v || v.startsWith("••")) { $("cp-key-msg").textContent = "Paste an API key first."; return; }
    apiKey = v; client = null;
    try { sessionStorage.setItem("upi-cc-key", v); if ($("cp-remember").checked) localStorage.setItem("upi-cc-key", v); } catch (e) { /* storage blocked */ }
    $("cp-key-msg").textContent = "Connecting…";
    try { await getClient(); $("cp-key-msg").textContent = "Connected. Agents now plan with Claude Opus 5."; modeBadge(); setTimeout(() => { $("cp-settings").hidden = true; }, 900); }
    catch (err) { $("cp-key-msg").textContent = "Could not load the Anthropic SDK: " + err.message; }
  });
  $("cp-key-clear").addEventListener("click", () => { apiKey = ""; client = null; try { sessionStorage.removeItem("upi-cc-key"); localStorage.removeItem("upi-cc-key"); } catch (e) { /* storage blocked */ } $("cp-key").value = ""; $("cp-key-msg").textContent = "Disconnected — using the local reasoning engine."; modeBadge(); });

  // composer
  const input = $("cp-input");
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  $("cp-send").addEventListener("click", () => busy && abort ? abort.abort() : send(input.value));
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $("cp-mic").hidden = true;
  else {
    let rec = null;
    $("cp-mic").addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = "en-IN"; rec.interimResults = true;
      $("cp-mic").classList.add("rec");
      rec.onresult = e => { input.value = [...e.results].map(r => r[0].transcript).join(" "); };
      rec.onend = () => { $("cp-mic").classList.remove("rec"); rec = null; if (input.value.trim()) send(input.value); };
      rec.start();
    });
  }

  /* ---------------------------------------------------------------- message scaffolding */
  function scroll() { const b = $("cp-body"); b.scrollTop = b.scrollHeight; }
  function userMsg(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    $("cp-body").appendChild(el);
  }
  function botMsg(agentKey, engine = isLive() ? "Claude Opus 5" : "local engine") {
    const el = document.createElement("div");
    el.className = "msg bot";
    el.innerHTML = `<div class="who"><span class="wl">${AGENTS[agentKey].emoji} ${AGENTS[agentKey].name}</span><span class="dim">· ${engine}</span></div>
      <details class="trace" open><summary><span class="spin"></span><span class="tt">Planning…</span><span class="chev">›</span></summary><ol class="steps"></ol></details>
      <div class="answer cursor"></div><div class="arts" style="display:grid;gap:8px"></div><div class="acts-row followups"></div>`;
    $("cp-body").appendChild(el);
    scroll();
    const t0 = performance.now();
    let nSteps = 0;
    const ui = {
      el, agentKey,
      route(to, why) { el.querySelector(".wl").innerHTML = `${AGENTS.lead.emoji} Risk Lead → ${AGENTS[to].emoji} ${AGENTS[to].name}`; ui.step("route", "⇢", `<b>Risk Lead</b> routed to <b>${AGENTS[to].name}</b>`, why); },
      step(kind, icon, html, code, child = false) {
        nSteps++;
        const li = document.createElement("li");
        li.className = `step ${kind}${child ? " child" : ""}`;
        li.innerHTML = `<span class="ic">${icon}</span><div class="st">${html}${code ? `<code>${esc(code)}</code>` : ""}</div>`;
        el.querySelector(".steps").appendChild(li);
        el.querySelector(".tt").textContent = `Working · ${nSteps} step${nSteps > 1 ? "s" : ""}`;
        scroll();
        return li;
      },
      status(t) { el.querySelector(".tt").textContent = t; },
      setText(html) { el.querySelector(".answer").innerHTML = html; scroll(); },
      art(a) {
        const box = el.querySelector(".arts");
        if (a.kind === "chart") {
          const d = document.createElement("div");
          d.className = "art";
          d.innerHTML = `<div class="t">${esc(a.spec.title)}</div><div class="chart"></div>`;
          box.appendChild(d);
          const c = chart(d.querySelector(".chart")); observe(d.querySelector(".chart"));
          c.setOption(chartOption(a.spec), true);
          chartSpecs.push([d.querySelector(".chart"), a.spec]);
        } else if (a.kind === "action") {
          let row = box.querySelector(".acts-row.actions");
          if (!row) { row = document.createElement("div"); row.className = "acts-row actions"; box.appendChild(row); }
          const id = "a" + Math.random().toString(36).slice(2);
          actionsById.set(id, a.run);
          row.insertAdjacentHTML("beforeend", `<button class="btn xs" data-art="${id}">${a.label.startsWith("Filter") ? "⚲" : a.label.startsWith("Open case") ? "📂" : "↗"} ${esc(a.label)}</button>`);
        }
        scroll();
      },
      followups(qs) { el.querySelector(".followups").innerHTML = qs.map(q => `<button class="btn xs ghost" data-q="${esc(q)}">↳ ${esc(q)}</button>`).join(""); },
      done(ok = true) {
        el.querySelector(".answer").classList.remove("cursor");
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        el.querySelector("summary").innerHTML = `<span class="${ok ? "ok" : ""}">${ok ? "✓" : "✕"}</span><span class="tt">${nSteps} step${nSteps === 1 ? "" : "s"} · ${secs}s · ${engine}</span><span class="chev">›</span>`;
        el.querySelector(".trace").open = false;
        scroll();
      },
    };
    return ui;
  }
  function ctxFor(ui, agentKey) {
    return {
      agent: AGENTS[agentKey].name,
      emit(a, autoRun) { ui.art(a); if (autoRun && a.run) a.run(); },
    };
  }

  /* ---------------------------------------------------------------- send */
  async function send(text, opts = {}) {
    text = String(text || "").trim();
    if (!text || busy) return;
    toggle(true);
    input.value = ""; input.style.height = "auto";
    if ($("cp-body").querySelector(".welcome")) $("cp-body").innerHTML = "";
    userMsg(text);
    const pick = opts.agent && AGENTS[opts.agent] ? opts.agent : agentPick;
    busy = true;
    $("cp-send").innerHTML = `<svg><use href="#i-x"/></svg>`; $("cp-send").title = "Stop";
    abort = new AbortController();
    try {
      if (isLive()) await Claude.run(text, pick, botMsg, ctxFor, abort.signal, history);
      else await Local.run(text, pick, botMsg, ctxFor, abort.signal);
    } catch (err) {
      console.error(err);
      if (abort.signal.aborted) { /* user pressed stop */ }
      else if (isLive()) {
        toast("⚠️", "Claude request failed", `${esc(apiError(err))} — answering with the local engine instead.`, 6000);
        try { await Local.run(text, pick, botMsg, ctxFor, abort.signal); } catch (e2) { console.error(e2); }
      } else {
        const ui = botMsg(pick);
        ui.setText(`<p>⚠️ ${esc(err?.message || String(err))}</p>`);
        ui.done(false);
      }
    } finally {
      busy = false; abort = null;
      $("cp-send").innerHTML = `<svg><use href="#i-send"/></svg>`; $("cp-send").title = "Send (Enter)";
    }
  }

  function apiError(err) {
    const status = err?.status, msg = err?.error?.error?.message || err?.message || String(err);
    if (status === 401) return "the API key was rejected — check it under ⚙";
    if (status === 429) return "rate limited — try again in a moment";
    if (status === 529 || status >= 500) return "Anthropic API is temporarily unavailable";
    return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
  }
  async function getClient() {
    if (client) return client;
    const mod = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.126.0/+esm");
    const Anthropic = mod.default || mod.Anthropic;
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    return client;
  }

  modeBadge();
  welcome();
  return {
    ask: (q, o) => send(q, o || {}), toggle, isOpen: () => $("copilot").classList.contains("open"), getClient,
    rethemeCharts() { for (const [el, spec] of chartSpecs) { if (!el.isConnected) continue; const c = chart(el); c.setOption(chartOption(spec), true); } },
  };
})();

/* =====================================================================================
   Claude runtime — manual streaming tool loop, with real delegation to specialist agents
   ===================================================================================== */
const Claude = (() => {
  const DELEGATE = {
    name: "delegate",
    description: "Hand a focused task to a specialist agent and get back its written findings. Specialists: analyst (metrics, trends, breakdowns, rankings), investigator (entity/ring deep dives, networks, case filing), sentinel (anomaly scan), reporter (executive brief). Call several in one turn to run them in parallel.",
    input_schema: { type: "object", required: ["agent", "task"], properties: { agent: { type: "string", enum: ["analyst", "investigator", "sentinel", "reporter"] }, task: { type: "string", description: "Self-contained instructions, including any ids, dates or filters." } } },
  };
  const k = DATA.kpi;
  const CONTEXT = `You work inside the UPI Risk Command Center, a fraud / dispute / merchant-risk desk for one quarter of UPI payments (${DATA.window.start} to ${DATA.window.end}), built for the TransOrg AgentIQ Datathon (Track 1).

Data model (already cleaned by the pipeline): ${int(k.txn_count)} de-duplicated payments (fact_transactions), ${int(k.chargeback_count)} complaints (fact_chargebacks, ${int(k.chargeback_linked)} linked to a payment), customers (dim_users, ids USR#####) and merchants (dim_merchants, ids MCH####). Payments TXN########, complaints CBK#######, dispute rings CL###.
Rules the pipeline established — respect them:
- Complaints are attributed to customers and merchants through txn_id. The complaint's own user/merchant ids never match the payment, so never attribute by them.
- Dispute rate / chargeback-to-transaction ratio = payments with ≥1 linked complaint ÷ payments.
- Reporting delay is measured from the complaint's own transaction date; impossible negative delays were nulled.
- Fraud-type reasons: ACCOUNT_TAKEOVER, UNAUTHORIZED_TXN, FRAUD_SUSPECTED. Unresolved = OPEN, IN_PROGRESS, PENDING_BANK.
- 67.6% of payments come from customer ids with no KYC record (NO_KYC_RECORD); 6,288 KYC ids map to several people; 400 duplicate payments (₹51.9 L) were removed.
- Risk scores are additive and explainable (each fired signal adds fixed points; HIGH ≥ 50, MEDIUM 30–49), computed on the whole quarter. An honest out-of-time backtest gives merchant AUC ${DATA.backtest.merchant.auc.toFixed(2)} and user AUC ${DATA.backtest.user.auc.toFixed(2)}: the scores are good worklists, not yet predictors. Say so when someone treats them as predictions.
- Rings are connected components of dispute-touched customers and merchants (≥4 members). Money only flows customer → merchant in this data, so the circular-laundering engine finds no loops; that is a real result, not a bug.

How to work:
- Get every number from a tool. Never invent ids, amounts or rates. If a tool errors, read the message and retry with valid arguments.
- Prefer one or two well-chosen tool calls; call independent tools in parallel.
- When a visual would help, call show_chart with the data you fetched (≤ 3 series, one unit per chart). When the analyst would benefit from seeing a slice or entity on the desk, use apply_filters / open_entity / navigate. Only file cases when asked or when you are clearly recommending an investigation.

How to answer:
- Lead with the direct answer in one or two sentences, with the key number in **bold**.
- Then short bullets or a compact markdown table (≤ 10 rows). Write ids plainly (e.g. MCH9572) — the UI turns them into links.
- Money in Indian format (₹ with L = lakh, Cr = crore). Rates as percentages with one decimal.
- End with one concrete recommended action for a risk team when it is relevant. Keep answers under ~220 words unless asked for a report.`;
  const ROLE = {
    lead: "You are the Risk Lead. For simple questions answer directly with your own tools. For deep dives, multi-part questions or reports, delegate focused tasks to specialists (in parallel when independent), then synthesise their findings into one answer. Do not repeat the specialists' text verbatim.",
    analyst: "You are the Analyst agent: quantitative questions — KPIs, breakdowns, trends, rankings, comparisons.",
    investigator: "You are the Investigator agent: deep dives into merchants, customers, payments, complaints and rings. Explain each risk score signal by signal, map the network (shared counterparties, ring membership), weigh the evidence, and recommend a concrete action (block, step-up KYC, hold settlement, reserve, monitor).",
    sentinel: "You are the Sentinel agent: scan for anomalies — spikes, control gaps, outliers — and rank them by severity with evidence.",
    reporter: "You are the Reporter agent: write crisp executive briefs for a Head of Risk — situation, top risks with numbers, where and who, confidence caveats, and 3–5 prioritised actions. Use short headings.",
  };
  const toolDefs = agentKey => AGENTS[agentKey].tools.map(n => n === "delegate" ? DELEGATE : { name: n, description: TOOL_BY_NAME[n].description, input_schema: TOOL_BY_NAME[n].input_schema });
  const clip = (s, n = 24000) => s.length > n ? s.slice(0, n) + `…[truncated ${s.length - n} chars]` : s;
  const brief = input => { const s = JSON.stringify(input); return s.length > 160 ? s.slice(0, 160) + "…" : s; };

  async function loop({ agentKey, messages, ui, ctx, signal, depth }) {
    const client = await Copilot.getClient();
    const system = [{ type: "text", text: `${CONTEXT}\n\n${ROLE[agentKey]}` }];
    let finalText = "";
    for (let turn = 0; turn < 10; turn++) {
      if (signal.aborted) throw new Error("Stopped.");
      ui.status(depth ? `${AGENTS[agentKey].name} thinking…` : "Thinking…");
      let draft = "", thinkLi = null, thinkTxt = "";
      const stream = client.beta.messages.stream({
        model: MODEL, max_tokens: 16000, system, tools: toolDefs(agentKey), messages,
        thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: depth ? "low" : "medium" },
        cache_control: { type: "ephemeral" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      }, { signal });
      stream.on("thinking", delta => {
        thinkTxt += delta;
        if (!thinkLi) thinkLi = ui.step("think", "💭", `<b>${AGENTS[agentKey].name}</b> reasoning`, "", depth > 0);
        const code = thinkLi.querySelector("code") || thinkLi.querySelector(".st").appendChild(document.createElement("code"));
        code.textContent = thinkTxt.length > 420 ? "…" + thinkTxt.slice(-420) : thinkTxt;
      });
      if (!depth) stream.on("text", delta => { draft += delta; ui.setText(md(draft)); });
      const msg = await stream.finalMessage();
      messages.push({ role: "assistant", content: msg.content });
      if (msg.stop_reason === "refusal") { const t = "This request was declined by the model's safety system."; if (!depth) ui.setText(md(t)); return t; }
      if (msg.stop_reason === "pause_turn") continue;
      const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
      const uses = msg.content.filter(b => b.type === "tool_use");
      if (!uses.length) { finalText = text; if (!depth) ui.setText(md(text)); break; }
      if (!depth && text.trim()) { ui.step("note", "✎", esc(text.trim()).slice(0, 300)); ui.setText(""); }
      const results = await Promise.all(uses.map(async u => {
        if (u.name === "delegate") {
          const who = AGENTS[u.input.agent] ? u.input.agent : "analyst";
          const li = ui.step("route", AGENTS[who].emoji, `<b>${AGENTS[agentKey].name}</b> delegated to <b>${AGENTS[who].name}</b>`, u.input.task, depth > 0);
          try {
            const sub = await loop({ agentKey: who, messages: [{ role: "user", content: u.input.task }], ui, ctx: { ...ctx, agent: AGENTS[who].name }, signal, depth: depth + 1 });
            li.querySelector(".st").insertAdjacentHTML("beforeend", `<code>✓ ${esc(sub.slice(0, 280))}${sub.length > 280 ? "…" : ""}</code>`);
            return { type: "tool_result", tool_use_id: u.id, content: sub || "(no findings)" };
          } catch (err) { return { type: "tool_result", tool_use_id: u.id, content: "Error: " + err.message, is_error: true }; }
        }
        const tool = TOOL_BY_NAME[u.name];
        const li = ui.step(tool?.kind === "ui" ? "tool" : "tool", tool?.kind === "ui" ? "◧" : "ƒ", `<b>${AGENTS[agentKey].name}</b> → <span class="mono">${esc(u.name)}</span>`, brief(u.input), depth > 0);
        try {
          if (!tool || !AGENTS[agentKey].tools.includes(u.name)) throw new Error(`Tool ${u.name} is not available to ${AGENTS[agentKey].name}`);
          const out = tool.run(u.input || {}, ctx);
          return { type: "tool_result", tool_use_id: u.id, content: clip(JSON.stringify(out)) };
        } catch (err) {
          li.classList.add("err");
          return { type: "tool_result", tool_use_id: u.id, content: "Error: " + err.message, is_error: true };
        }
      }));
      messages.push({ role: "user", content: results });
    }
    return finalText;
  }

  async function run(text, pick, botMsg, ctxFor, signal, history) {
    const ui = botMsg(pick);
    const ctx = ctxFor(ui, pick);
    const messages = pick === "lead" ? history : [];
    const start = messages.length;
    messages.push({ role: "user", content: text });
    try {
      const out = await loop({ agentKey: pick, messages, ui, ctx, signal, depth: 0 });
      if (!out) ui.setText(md("No answer was produced."));
      ui.done(true);
    } catch (err) {
      messages.length = start; // an unfinished turn would leave the shared history invalid
      ui.setText(signal.aborted ? `<p class="dim">Stopped.</p>` : `<p class="dim">Claude could not complete this request (${esc(err?.status ? "HTTP " + err.status : "network error")}).</p>`);
      ui.done(false);
      throw err;
    }
  }
  return { run };
})();

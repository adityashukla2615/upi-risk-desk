/* =====================================================================================
   11 · boot
   ===================================================================================== */
(function boot() {
  $("window-label").textContent = `Q1 ${SY} · ${int(K.txn_count)} payments`;
  $("window-label").title = `${int(K.txn_count)} payments · ${int(K.chargeback_count)} disputes · ${DATA.window.start} → ${DATA.window.end}`;
  const { f, view } = readHash();
  F = { ...f };
  SL = isFiltered(F) ? slice(F) : FULL_SLICE;
  S = isFiltered(F) ? summarize(SL) : FULL;
  Object.keys(VIEWS).forEach(v => dirty.add(v));
  syncControls();
  renderChips();
  go(view);
  addEventListener("hashchange", () => {
    const h = readHash();
    if (h.view !== activeView) go(h.view);
  });
  // first-visit nudge towards the agents
  if (!store.get("upi-cc-seen", false)) {
    store.set("upi-cc-seen", true);
    setTimeout(() => toast("✦", "Meet your risk agents", "Press <kbd>Ctrl J</kbd> or click <b>AI Agents</b> — try “Brief me on this quarter”.", 7000), 1600);
  }
})();

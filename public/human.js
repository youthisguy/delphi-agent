// Human Desk: manual evidence search + submit, backed by /api/evidence/human/*. Uses j(), esc() from dashboard.js.
(function () {
  const $h = (id) => document.getElementById(id);
  if (!$h("humanPanel")) return;
  const S = { markets: [], dry: true, cap: 3, links: [{ url: "", publishedAt: "", title: "" }], claims: [] };
  const post = (url, body) => j(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const msg = (e) => (e && e.message ? e.message.replace(/^\S+ -> \d+:?\s*/, "") : String(e));
  const out = (html) => { $h("hdOut").innerHTML = html; };
  const busy = (id, on) => { const b = $h(id); if (b) b.disabled = on; };
  const today = () => new Date().toISOString().slice(0, 10);

  function market() {
    const id = $h("hdMarket").value;
    const m = S.markets.find((x) => x.id === id);
    if (m) return { id: m.id, outcomes: m.outcomes, custom: undefined };
    const mid = $h("hdMId").value.trim();
    const q = $h("hdMQ").value.trim();
    const o = $h("hdMO").value.split(",").map((s) => s.trim()).filter(Boolean);
    if (mid) return { id: mid, outcomes: o.length >= 2 ? o : ["Yes", "No"], custom: { question: q, outcomes: o.length >= 2 ? o : ["Yes", "No"] } };
    return { id: "", outcomes: [], custom: undefined };
  }

  async function loadMarkets() {
    try {
      const r = await j("/api/evidence/human/markets");
      S.markets = r.markets; S.dry = r.dryRun; S.cap = r.cap;
      const sel = $h("hdMarket"), prev = sel.value;
      sel.innerHTML = r.markets.length
        ? r.markets.map((m) => `<option value="${esc(m.id)}">${esc(m.question.slice(0, 110))}</option>`).join("")
        : `<option value="">no markets on the board yet — enter one by hand below</option>`;
      if (prev && r.markets.some((m) => m.id === prev)) sel.value = prev;
      $h("hdMode").textContent = (S.dry ? "DRY-RUN · nothing is sent" : "LIVE · submissions are final") + " · shares the 3-per-market budget with the agent";
      onMarket();
    } catch (e) { out(`<span class="err">${esc(msg(e))}</span>`); }
  }

  function onMarket() {
    const m = S.markets.find((x) => x.id === $h("hdMarket").value);
    const oSel = $h("hdOutcome");
    const keep = oSel.value;
    oSel.innerHTML = `<option value="">which outcome does this evidence support?</option>` + (m ? m.outcomes : market().outcomes).map((o, i) => `<option value="${i}">${i} · ${esc(o)}</option>`).join("");
    if (keep !== "" && oSel.querySelector(`option[value="${keep}"]`)) oSel.value = keep;
    if (!m) { $h("hdMarketInfo").innerHTML = ""; return; }
    $h("hdHold").checked = !!m.held;
    const left = Math.max(0, S.cap - m.submissions);
    $h("hdMarketInfo").innerHTML =
      `<span class="${left ? "good" : "err"}">${m.submissions}/${S.cap} used · ${left} left</span>` +
      (m.lockedOutcome !== null && m.lockedOutcome !== undefined ? `<span class="warn">locked to outcome ${m.lockedOutcome} (${esc(m.outcomes[m.lockedOutcome] || "")})</span>` : "") +
      (m.resolvesAt ? `<span>resolves ${esc(new Date(m.resolvesAt).toISOString().slice(0, 16).replace("T", " "))} UTC</span>` : "") +
      (m.resolutionCriteria ? `<span title="${esc(m.resolutionCriteria)}">criteria ⓘ</span>` : "");
    if (m.lockedOutcome !== null && m.lockedOutcome !== undefined && !oSel.value) oSel.value = String(m.lockedOutcome);
  }

  function renderLinks() {
    $h("hdLinks").innerHTML = S.links.map((l, i) =>
      `<div class="linkrow"><input data-i="${i}" data-f="url" value="${esc(l.url)}" placeholder="https://…"><input class="d" data-i="${i}" data-f="publishedAt" value="${esc(l.publishedAt)}" placeholder="YYYY-MM-DD"><button data-rm="${i}" title="remove">×</button></div>`).join("");
  }
  function addLink(url, publishedAt, title) {
    if (url && S.links.some((l) => l.url === url)) return;
    const empty = S.links.findIndex((l) => !l.url);
    const row = { url: url || "", publishedAt: publishedAt || "", title: title || "" };
    if (empty >= 0 && url) S.links[empty] = row; else S.links.push(row);
    renderLinks();
  }

  async function search() {
    const m = market();
    const q = $h("hdQuery").value.trim();
    if (q.length < 3) return;
    busy("hdSearchBtn", true);
    $h("hdResults").innerHTML = `<div class="empty">searching…</div>`;
    try {
      const r = await post("/api/evidence/human/search", { query: q, days: Number($h("hdDays").value) || 30, marketId: m.id || undefined });
      $h("hdResults").innerHTML = r.results.length ? r.results.map((x, i) =>
        `<div class="res ${x.used ? "used" : ""}"><span class="t">${esc(x.title || x.url)}</span>
          <span class="m">${esc(x.domain)} · ${esc(x.publishedAt ? x.publishedAt.slice(0, 10) : "no date")} · ${esc(x.provider)}${x.used ? " · ALREADY USED ON THIS MARKET" : ""}${x.judgeMayNotFetch ? " · judge may not be able to open this" : ""}</span>
          <div class="sn">${esc(x.snippet)}</div>
          <div class="btns"><button data-read="${i}">Read</button><button data-addres="${i}">Add as link</button></div></div>`).join("") : `<div class="empty">no results — try different words or a longer window</div>`;
      S.results = r.results;
    } catch (e) { $h("hdResults").innerHTML = `<div class="err">${esc(msg(e))}</div>`; }
    busy("hdSearchBtn", false);
  }

  async function read(url, date, title) {
    const m = market();
    if (!m.id) return out(`<span class="err">pick a market first</span>`);
    busy("hdFetchBtn", true);
    $h("hdFetchUrl").value = url; if (date) $h("hdFetchDate").value = date.slice(0, 10);
    $h("hdClaims").innerHTML = `<div class="empty">reading and extracting…</div>`;
    try {
      const r = await post("/api/evidence/human/fetch", { marketId: m.id, market: m.custom, url, text: $h("hdPaste").value, publishedAt: date || $h("hdFetchDate").value || undefined, title });
      if (!r.ok) { $h("hdClaims").innerHTML = `<div class="warn">${esc(r.error)}<br>${esc(r.hint || "")}</div>`; }
      else {
        S.claims = r.claims;
        const head = `<div class="m">${esc(r.doc.domain)} · ${esc(r.doc.publishedAt ? r.doc.publishedAt.slice(0, 10) : "no date found")} · ${r.doc.chars} chars via ${esc(r.doc.method)}</div>`;
        $h("hdClaims").innerHTML = head + (r.claims.length ? r.claims.map((c, i) =>
          `<div class="res"><span class="t">${esc(c.claim)}</span><span class="m">supports ${c.supportsOutcomeIdx === null || c.supportsOutcomeIdx === undefined ? "?" : esc(String(c.supportsOutcomeIdx))} · relevance ${Number(c.relevance).toFixed(2)} · ${esc(c.sourceType)}</span>
          <div class="sn">“${esc(c.quote)}”</div><div class="btns"><button data-use="${i}">Use in note</button></div></div>`).join("") :
          `<div class="empty">no usable claims found. Read it yourself and write the note by hand.</div>`) +
          `<details><summary>page text preview</summary><div class="sn" style="white-space:pre-wrap">${esc(r.doc.preview)}</div></details>`;
        if (r.doc.publishedAt && !S.links.some((l) => l.url === url)) addLink(url, r.doc.publishedAt.slice(0, 10), r.doc.title);
      }
    } catch (e) { $h("hdClaims").innerHTML = `<div class="err">${esc(msg(e))}</div>`; }
    busy("hdFetchBtn", false);
  }

  function useClaim(c) {
    const note = $h("hdNote");
    note.value = note.value.trim() ? note.value.trim() + "\n" + c.claim : c.claim;
    if (!$h("hdExcerpt").value) $h("hdExcerpt").value = c.quote || "";
    if (c.supportsOutcomeIdx !== null && c.supportsOutcomeIdx !== undefined) $h("hdOutcome").value = String(c.supportsOutcomeIdx);
    addLink(c.sourceUrl, (c.sourcePublishedAt || c.eventDate || "").slice(0, 10), "");
    $h("hdSrcType").value = c.sourceType === "primary" ? "primary" : "secondary";
  }

  const b64 = (file) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => no(new Error("could not read " + file.name)); r.readAsDataURL(file); });
  async function draft(withFiles) {
    const m = market();
    const note = $h("hdNote").value.trim();
    const ex = $h("hdExcerpt").value.trim();
    const full = ex && !note.includes(ex) ? `${note}\n\nKey excerpt: "${ex}"` : note;
    const files = [];
    if (withFiles) for (const f of Array.from($h("hdFiles").files || []).slice(0, 4)) files.push({ name: f.name, mime: f.type || "application/octet-stream", dataBase64: await b64(f) });
    return {
      marketId: m.id, market: m.custom, outcomeIdx: $h("hdOutcome").value === "" ? -1 : Number($h("hdOutcome").value),
      note: full, links: S.links.filter((l) => l.url.trim()).map((l) => ({ url: l.url.trim(), publishedAt: l.publishedAt.trim() || null, title: l.title })),
      files, sourceType: $h("hdSrcType").value, force: $h("hdForce").checked,
    };
  }
  const showCheck = (c) => out(
    (c.ok ? `<span class="good">PASSES CHECKS</span>` : `<span class="err">BLOCKED</span>`) + ` · ${c.slotsLeft} slot(s) left` + (c.lockedOutcome !== null ? ` · locked to outcome ${c.lockedOutcome}` : "") +
    c.errors.map((x) => `\n<span class="err">✗ ${esc(x)}</span>`).join("") + c.warnings.map((x) => `\n<span class="warn">! ${esc(x)}</span>`).join("") +
    `\n\n--- final note as it will be sent ---\n${esc(c.note)}`);

  async function polish() {
    const d = await draft(false);
    if (d.outcomeIdx < 0 || !d.marketId) return out(`<span class="err">pick the market and outcome first</span>`);
    busy("hdPolishBtn", true); out("polishing…");
    try {
      const r = await post("/api/evidence/human/draft", { marketId: d.marketId, market: d.market, outcomeIdx: d.outcomeIdx, note: $h("hdNote").value, links: d.links, excerpt: $h("hdExcerpt").value.trim() });
      $h("hdNote").value = r.note;
      out(r.llm ? `<span class="good">Polished. Read it: the AI may only use your facts, but you are responsible for what is sent.</span>` : `<span class="warn">AI unavailable, kept your text unchanged.</span>`);
    } catch (e) { out(`<span class="err">${esc(msg(e))}</span>`); }
    busy("hdPolishBtn", false);
  }
  async function check() {
    busy("hdCheckBtn", true);
    try { showCheck(await post("/api/evidence/human/check", await draft(true))); } catch (e) { out(`<span class="err">${esc(msg(e))}</span>`); }
    busy("hdCheckBtn", false);
  }
  async function submit() {
    busy("hdSubmitBtn", true);
    try {
      const d = await draft(true);
      const c = await post("/api/evidence/human/check", d);
      if (!c.ok) { showCheck(c); busy("hdSubmitBtn", false); return; }
      if (!confirm((S.dry ? "DRY-RUN: record this submission (nothing is sent)?" : "LIVE: submit this evidence? It cannot be edited or retracted.") + `\n\n${c.note.slice(0, 400)}`)) { busy("hdSubmitBtn", false); return; }
      const r = await post("/api/evidence/human/submit", d);
      out(`<span class="good">${r.dryRun ? "RECORDED (dry-run)" : "SUBMITTED"}</span> · receipt ${esc(r.receipt.id)}${r.files.length ? ` · ${r.files.length} file(s)` : ""}`);
      $h("hdNote").value = ""; $h("hdExcerpt").value = ""; $h("hdFiles").value = ""; $h("hdForce").checked = false;
      S.links = [{ url: "", publishedAt: "", title: "" }]; renderLinks();
      await loadMarkets();
      if (typeof loadAttempts === "function") loadAttempts();
      if (typeof loadStatus === "function") loadStatus();
    } catch (e) { out(`<span class="err">${esc(msg(e))}</span>`); }
    busy("hdSubmitBtn", false);
  }

  $h("hdMarket").addEventListener("change", onMarket);
  $h("hdHold").addEventListener("change", async (ev) => {
    const id = $h("hdMarket").value; if (!id) return;
    try { await post("/api/evidence/human/hold", { marketId: id, on: ev.target.checked }); const m = S.markets.find((x) => x.id === id); if (m) m.held = ev.target.checked; } catch (e) { out(`<span class="err">${esc(msg(e))}</span>`); }
  });
  $h("hdMO").addEventListener("input", onMarket);
  $h("hdSearchBtn").addEventListener("click", search);
  $h("hdQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  $h("hdFetchBtn").addEventListener("click", () => { const u = $h("hdFetchUrl").value.trim(); if (u) read(u, $h("hdFetchDate").value.trim(), ""); });
  $h("hdAddLink").addEventListener("click", () => { if (S.links.length < 6) { S.links.push({ url: "", publishedAt: "", title: "" }); renderLinks(); } });
  $h("hdPolishBtn").addEventListener("click", polish);
  $h("hdCheckBtn").addEventListener("click", check);
  $h("hdSubmitBtn").addEventListener("click", submit);
  $h("hdResults").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.read !== undefined) { const r = S.results[Number(b.dataset.read)]; read(r.url, r.publishedAt || "", r.title); }
    if (b.dataset.addres !== undefined) { const r = S.results[Number(b.dataset.addres)]; addLink(r.url, (r.publishedAt || "").slice(0, 10), r.title); }
  });
  $h("hdClaims").addEventListener("click", (e) => { const b = e.target.closest("button[data-use]"); if (b) useClaim(S.claims[Number(b.dataset.use)]); });
  $h("hdLinks").addEventListener("input", (e) => { const t = e.target; if (t.dataset.i !== undefined) S.links[Number(t.dataset.i)][t.dataset.f] = t.value; });
  $h("hdLinks").addEventListener("click", (e) => { const b = e.target.closest("button[data-rm]"); if (b) { S.links.splice(Number(b.dataset.rm), 1); if (!S.links.length) S.links.push({ url: "", publishedAt: "", title: "" }); renderLinks(); } });

  renderLinks();
  loadMarkets();
  setInterval(loadMarkets, 30000);
})();

/* PRINGLES evidence-miner dashboard. Reads /api/evidence/* only. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => (s ?? "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(Number(x)) ? "—" : Number(x).toFixed(d));
const trunc = (s, n) => ((s ?? "").length > n ? s.slice(0, n - 1) + "…" : s ?? "");
const timeAgo = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};
const dur = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${ss}s` : `${ss}s`;
};
const untilResolve = (iso) => {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  return ms < 0 ? `<span class="v bad">overdue</span>` : dur(ms);
};

let pwPrompt = null;
let authCancelled = false;
function askPassword() {
  if (!pwPrompt) pwPrompt = Promise.resolve().then(() => { const p = prompt("Dashboard password:"); if (!p) authCancelled = true; pwPrompt = null; return p; });
  return pwPrompt;
}
async function j(url, opts = {}) {
  const call = (pw) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(pw ? { "x-dashboard-password": pw } : {}) } });
  let res = await call(sessionStorage.getItem("pw") || "");
  if (res.status === 401 && !authCancelled) {
    sessionStorage.removeItem("pw");
    const pw = await askPassword();
    if (pw) { sessionStorage.setItem("pw", pw); res = await call(pw); if (res.status === 401) sessionStorage.removeItem("pw"); }
  }
  if (!res.ok) {
    let detail = "";
    try { const b = await res.json(); detail = b?.error || JSON.stringify(b); } catch { /* status only */ }
    const e = new Error(`${url} -> ${res.status}${detail ? ": " + detail : ""}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

let status = null;
let attempts = [];
let eventsSeen = 0;
const feedEvents = [];
const attemptsById = new Map();

// Competition window per the DoraHacks page: opens 25 Nov 17:00 UTC, closes 11 Dec 17:00 UTC.
const COMP_START = Date.UTC(2026, 10, 25, 17, 0, 0);
const COMP_END = Date.UTC(2026, 11, 11, 17, 0, 0);

const labelFor = (a, idx) => (idx === null || idx === undefined ? "—" : a?.outcomes?.[idx] ?? "#" + idx);

// ---------------- status ----------------
async function loadStatus() {
  try {
    status = await j("/api/evidence/status");
  } catch (e) {
    $("#pulse").className = "pulse stale";
    $("#pulseLabel").textContent = authCancelled ? "PASSWORD REQUIRED — reload" : "API OFFLINE";
    return;
  }
  renderHeader();
  renderKpis();
  renderNow();
  renderFloor();
  renderHealth();
  renderBoard();
}

function renderHeader() {
  const s = status;
  const live = s.liveSubmitterReady && !s.dryRun;
  const pill = $("#modePill");
  pill.className = "mode-pill" + (live ? " live" : "");
  pill.textContent = live ? "LIVE SUBMIT" : s.liveSubmitterReady ? "DRY_RUN" : "DRY_RUN · live not ready";
  pill.title = `MODE=${s.mode}` + ((s.liveReasons || []).length ? "\n" + s.liveReasons.join("\n") : "");

  const p = s.progress;
  const stale = s.updatedAt ? Date.now() - new Date(s.updatedAt).getTime() > (s.cycleIntervalMs || 600000) * 2.5 && !p?.running : true;
  $("#pulse").className = "pulse " + (p?.running ? "work" : stale ? "stale" : "live");
  $("#pulseLabel").textContent = p?.running ? "RESEARCHING" : s.updatedAt ? (stale ? "STALE · " : "IDLE · ") + timeAgo(s.updatedAt).toUpperCase() : "NO LOOP DATA";
}

function renderKpis() {
  const f = status.floor;
  const done = attempts.filter((a) => ["submitted", "judged", "settled", "rejected"].includes(a.status));
  const acc = done.length ? done.filter((a) => a.status !== "rejected").length / done.length : null;
  const cards = [
    ["Judged (live)", `${f.liveJudged}<span style="font-size:11px;color:var(--text-muted)"> / ${f.required.judged}</span>`, f.floorMet ? "good" : "warn", "floor needs ≥" + f.required.judged],
    ["Markets judged", `${f.liveJudgedMarkets}<span style="font-size:11px;color:var(--text-muted)"> / ${f.required.markets}</span>`, f.liveJudgedMarkets >= f.required.markets ? "good" : "warn", "floor needs ≥" + f.required.markets],
    ["Total reward", fmt(f.totalReward, 4), f.totalReward > 0 ? "good" : "", "judgment + settlement"],
    ["Submitted (live)", f.liveSubmitted, f.liveSubmitted ? "good" : "", "real submissions"],
    ["Submitted (dry)", f.dryRunSubmitted, "cyan", "would-have-submitted"],
    ["Attempts", f.totalAttempts, "", "research cycles"],
    ["Acceptance rate", acc === null ? "—" : (acc * 100).toFixed(0) + "%", acc === null ? "" : acc >= 0.2 ? "good" : "warn", `${done.length} completed`],
  ];
  $("#kpis").innerHTML = cards.map(([k, v, cls, sub]) => `<div class="kpi"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span><div class="s">${esc(sub)}</div></div>`).join("");
}

function renderNow() {
  const p = status.progress || {};
  const sub = $("#nowSub");
  if (p.running) {
    sub.textContent = "WORKING";
    sub.style.color = "var(--cyan)";
    const last = [...feedEvents].reverse().find((e) => e.marketId === p.currentMarketId);
    $("#nowPanel").innerHTML = `
      <div class="panel-sub">RESEARCHING MARKET</div>
      <div class="now">${esc(p.currentQuestion || "(listing markets…)")}</div>
      <div class="row"><span class="k">Cycle running for</span><span class="v cyan" data-since="${esc(p.startedAt || "")}">${dur(Date.now() - new Date(p.startedAt || Date.now()).getTime())}</span></div>
      <div class="row"><span class="k">Last step</span><span class="v" style="text-align:right">${esc(last ? last.type + ": " + trunc(last.summary, 90) : "—")}</span></div>
      <div class="row"><span class="k">Last cycle</span><span class="v">${esc(lastCycleText())}</span></div>`;
  } else {
    sub.textContent = "IDLE";
    sub.style.color = "";
    $("#nowPanel").innerHTML = `
      <div class="panel-sub">WAITING FOR NEXT CYCLE</div>
      <div class="now" id="nextRun" data-next="${p.nextRunAt || ""}">next cycle in ${p.nextRunAt ? dur(p.nextRunAt - Date.now()) : "—"}</div>
      <div class="row"><span class="k">Last cycle</span><span class="v">${esc(lastCycleText())}</span></div>
      <div class="row"><span class="k">Cycle interval</span><span class="v">${dur(status.cycleIntervalMs)}</span></div>`;
  }
}
const lastCycleText = () => {
  const c = status?.lastCycle;
  return c ? `${timeAgo(c.at)} · tried ${c.marketsTried}, submitted ${c.submitted}, rejected ${c.rejected}, errors ${c.errors}` : "none yet";
};

function renderFloor() {
  const f = status.floor;
  const pct = (n, d) => Math.min(100, Math.round((n / d) * 100));
  $("#floorPanel").innerHTML = `
    <div class="row"><span class="k">Judged submissions</span><span class="v ${f.liveJudged >= f.required.judged ? "good" : "warn"}">${f.liveJudged} / ${f.required.judged}</span></div>
    <div class="bar ${f.liveJudged >= f.required.judged ? "ok" : ""}"><i style="width:${pct(f.liveJudged, f.required.judged)}%"></i></div>
    <div class="row"><span class="k">Distinct markets judged</span><span class="v ${f.liveJudgedMarkets >= f.required.markets ? "good" : "warn"}">${f.liveJudgedMarkets} / ${f.required.markets}</span></div>
    <div class="bar ${f.liveJudgedMarkets >= f.required.markets ? "ok" : ""}"><i style="width:${pct(f.liveJudgedMarkets, f.required.markets)}%"></i></div>
    <div class="row"><span class="k">Prize eligible</span><span class="v ${f.floorMet ? "good" : "bad"}">${f.floorMet ? "YES" : "NOT YET"}</span></div>
    <div class="panel-sub" style="margin-top:8px">Hard rules enforced in code: max 3 submissions/market · one direction per market (both sides cancel) · dated working link required · ≤3 files · public sources only.</div>`;
}

function renderHealth() {
  const s = status;
  const chips = ["tavily", "serper", "exa", "brave"].map((n) => `<span class="chip ${s.searchProviders.includes(n) ? "on" : "off"}">${n}</span>`).join("");
  const pw = `<span class="chip ${s.playwrightEnabled ? "on" : "off"}">playwright</span>`;
  let llm = `<div class="empty" style="padding:6px">no LLM data from the loop yet</div>`;
  const L = s.llm;
  if (L) {
    const compat = Object.fromEntries((L.compat || []).map((c) => [c.name, c]));
    const rows = (L.order || []).map((name) => {
      const st = (L.stats || {})[name] || { ok: 0, fail: 0 };
      let info = "", cls = "off", label = "no key";
      if (compat[name]) {
        const c = compat[name];
        if (c.keys) { cls = c.ok ? "ok" : c.cooldown ? "warn" : "off"; label = `${c.ok}/${c.keys} keys ok`; }
        info = c.model;
      } else {
        const nodes = (L.nodes || []).filter((n) => n.provider === name);
        if (nodes.length) {
          const ok = nodes.filter((n) => n.status === "ok" || n.status === "untested").length;
          cls = ok ? (nodes.some((n) => n.status === "ok") ? "ok" : "warn") : "off";
          label = `${ok}/${nodes.length} nodes usable`;
        }
        info = name === "openai" ? "pool" : "pool";
      }
      return `<div class="row" title="${esc(st.lastError || "")}"><span><span class="dot ${cls}"></span>${esc(name)} <span class="panel-sub">${esc(info)}</span></span><span class="v">${label} · <span class="good">${st.ok}✓</span> <span class="${st.fail ? "bad" : ""}">${st.fail}✗</span></span></div>${st.lastError ? `<div class="panel-sub" style="padding-left:12px;color:var(--red)">${esc(trunc(st.lastError, 110))}</div>` : ""}`;
    }).join("");
    llm = rows || llm;
  }
  $("#healthPanel").innerHTML = `<div class="panel-sub">SEARCH PROVIDERS</div><div style="margin:4px 0 8px">${chips} ${pw}</div><div class="panel-sub">LLM ROUTER (in fallback order)</div>${llm}`;
}

function renderBoard() {
  const board = status.marketBoard || [];
  $("#boardSub").textContent = board.length + " MARKETS";
  if (!board.length) { $("#boardBody").innerHTML = `<tr><td colspan="7"><div class="empty">no markets listed yet</div></td></tr>`; return; }
  $("#boardBody").innerHTML = board.map((m) => {
    const mine = attempts.filter((a) => a.marketId === m.id && a.polarity !== null && a.polarity !== undefined && ["submitted", "judged", "settled"].includes(a.status));
    const pol = mine.length ? labelFor(mine[0], mine[0].polarity) : "—";
    const state = m.held ? `<span class="pill s-researching">AGENT HELD</span>` : m.capReached ? `<span class="pill s-submitted">CAP REACHED</span>` : m.onCooldown ? `<span class="pill">COOLDOWN</span>` : m.score > 0 ? `<span class="pill s-researched">QUEUED</span>` : `<span class="pill">SKIPPED</span>`;
    return `<tr><td class="q-cell" title="${esc(m.question)}">${esc(m.question)}</td><td>${esc(m.topic)}</td><td>${untilResolve(m.resolvesAt)}</td><td>${fmt(m.score, 2)}</td><td>${m.submissions} / 3</td><td>${esc(pol)}</td><td>${state}</td></tr>`;
  }).join("");
}

// ---------------- attempts ----------------
async function loadAttempts() {
  try {
    const r = await j("/api/evidence/attempts?limit=200");
    attempts = r.attempts || [];
  } catch { return; }
  attemptsById.clear();
  attempts.forEach((a) => attemptsById.set(a.attemptId, a));
  renderLedger();
  renderRejections();
  renderNotes();
  renderJudge();
  if (status) { renderKpis(); renderBoard(); }
}

function statusPill(a) { return `<span class="pill s-${esc(a.status)}">${esc(a.status)}</span>`; }

function renderLedger() {
  $("#ledgerSub").textContent = `${attempts.length} attempts · click a row for the full trail`;
  if (!attempts.length) { $("#ledgerBody").innerHTML = `<tr><td colspan="10"><div class="empty">no attempts yet — press “Run cycle now” or wait for the loop</div></td></tr>`; return; }
  $("#ledgerBody").innerHTML = attempts.map((a) => {
    const ok = (a.sourcesFetched || []).filter((s) => s.ok).length;
    const reward = a.judgment ? `reward ${fmt(a.judgment.reward, 4)}` : a.receipt ? esc(trunc(a.receipt.id, 22)) : "—";
    return `<tr class="click" data-attempt="${esc(a.attemptId)}"><td>${timeAgo(a.startedAt)}</td><td class="q-cell" title="${esc(a.question)}">${esc(a.question)}</td><td>${statusPill(a)}</td><td>${(a.queriesRun || []).length}</td><td>${ok}/${(a.sourcesFetched || []).length}</td><td>${(a.extractedClaims || []).length}</td><td>${esc(labelFor(a, a.polarity))}</td><td>${a.novelty ? fmt(a.novelty.score, 2) : "—"}</td><td>${a.origin === "human" ? '<span class="pill s-researched">HUMAN</span> ' : ""}${a.dryRun ? '<span class="pill dry">DRY</span>' : '<span class="pill liveP">LIVE</span>'}</td><td>${reward}</td></tr>`;
  }).join("");
}

function bucket(r) {
  r = (r || "").toLowerCase();
  if (r.includes("no clear direction")) return "no clear direction";
  if (r.includes("near-duplicate") || r.includes("already used")) return "duplicate of earlier note/source";
  if (r.includes("opposite direction")) return "would cancel (opposite side)";
  if (r.includes("aggregator")) return "aggregator source";
  if (r.includes("guard:")) return "submit guard";
  if (r.includes("flags:")) return "judge flags (restatement/speculation…)";
  if (r.includes("score")) return "novelty score below threshold";
  if (r.includes("no readable sources")) return "no readable sources";
  if (r.includes("no verifiable")) return "no verifiable dated claims";
  return "other";
}

function renderRejections() {
  const counts = {};
  for (const a of attempts) {
    if (a.status !== "rejected") continue;
    if (a.rejectedCandidates?.length) for (const c of a.rejectedCandidates) { const b = bucket(c.reasons[c.reasons.length - 1]); counts[b] = (counts[b] || 0) + 1; }
    else { const b = bucket(a.rejectReason); counts[b] = (counts[b] || 0) + 1; }
  }
  const rows = Object.entries(counts).sort((x, y) => y[1] - x[1]);
  const max = rows.length ? rows[0][1] : 1;
  $("#rejSub").textContent = `${rows.reduce((s, r) => s + r[1], 0)} REJECTIONS · threshold ${status?.minNoveltyScore ?? "?"}`;
  $("#rejPanel").innerHTML = rows.length
    ? rows.map(([k, n]) => `<div class="brk"><span>${esc(k)}</span><div class="bar amber" style="margin:0"><i style="width:${Math.round((n / max) * 100)}%"></i></div><span class="v">${n}</span></div>`).join("")
    : `<div class="empty">nothing rejected yet</div>`;
}

function renderNotes() {
  const withNotes = attempts.filter((a) => a.packaged).slice(0, 8);
  $("#notesPanel").innerHTML = withNotes.length
    ? withNotes.map((a) => `<div class="note" data-attempt="${esc(a.attemptId)}" style="cursor:pointer"><div class="meta">${timeAgo(a.startedAt)} · ${esc(trunc(a.question, 80))} · supports <b>${esc(labelFor(a, a.polarity))}</b> · novelty ${fmt(a.novelty?.score, 2)} · ${a.dryRun ? "DRY-RUN" : "LIVE"}</div>${esc(a.packaged.note)}</div>`).join("")
    : `<div class="empty">no accepted evidence yet</div>`;
}

function renderJudge() {
  const judged = attempts.filter((a) => a.judgment || a.settlementLater).slice(0, 15);
  if (!judged.length) return;
  $("#judgePanel").innerHTML = judged.map((a) => `<div class="note" data-attempt="${esc(a.attemptId)}" style="cursor:pointer"><div class="meta">${esc(trunc(a.question, 90))}</div>${a.judgment ? `<b class="${(a.judgment.reward ?? 0) > 0 ? "v good" : "v warn"}">${esc(a.judgment.verdict)}</b> · reward ${fmt(a.judgment.reward, 4)}\n${esc(a.judgment.rationale)}` : ""}${a.settlementLater ? `\nSETTLED · reward ${fmt(a.settlementLater.reward, 4)} ${esc(a.settlementLater.detail || "")}` : ""}</div>`).join("");
}

// ---------------- live feed ----------------
let polling = false;
const feedSeen = new Set();
async function pollEvents() {
  if (polling) return; // never overlap: slow responses used to append the same events many times
  polling = true;
  try { await pollEventsInner(); } finally { polling = false; }
}
async function pollEventsInner() {
  let r;
  try { r = await j("/api/evidence/events?after=" + eventsSeen); } catch { return; }
  const fresh = r.events || [];
  if (r.total < eventsSeen) { feedEvents.length = 0; feedSeen.clear(); eventsSeen = 0; $("#feed").innerHTML = ""; }
  if (!fresh.length) { eventsSeen = r.total; return; }
  const box = $("#feed");
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  if (!feedEvents.length) box.innerHTML = "";
  for (const e of fresh) {
    if (feedSeen.has(e.seq)) continue;
    feedSeen.add(e.seq);
    feedEvents.push(e);
    const d = document.createElement("div");
    d.className = "fl";
    d.dataset.attempt = e.attemptId;
    d.innerHTML = `<span class="t">${new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span><span class="ty ${esc(e.type)}">${esc(e.type)}</span><span class="m" title="${esc(e.question)}">${esc(trunc(e.question || e.marketId, 34))}</span><span class="sm">${esc(e.summary)}</span>`;
    box.appendChild(d);
  }
  while (box.children.length > 400) box.removeChild(box.firstChild);
  if (feedEvents.length > 400) feedEvents.splice(0, feedEvents.length - 400);
  eventsSeen = fresh[fresh.length - 1].seq + 1;
  if (stick) box.scrollTop = box.scrollHeight;
  $("#feedSub").textContent = `${r.total} events · updated ${new Date().toLocaleTimeString([], { hour12: false })}`;
  // new activity => refresh dependent panels promptly
  loadAttempts();
  loadStatus();
}

// ---------------- detail modal ----------------
function openAttempt(id) {
  const a = attemptsById.get(id);
  if (!a) return;
  const L = (idx) => labelFor(a, idx);
  const sources = (a.sourcesFetched || []).map((s) => `<tr><td>${esc(s.domain)}</td><td>${s.publishedAt ? esc(s.publishedAt.slice(0, 10)) : "—"}</td><td>${esc(s.fetchMethod)}</td><td class="${s.ok ? "v good" : "v bad"}">${s.ok ? "readable" : esc(trunc(s.error || "failed", 40))}</td><td style="white-space:normal;word-break:break-all"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(trunc(s.url, 90))}</a></td></tr>`).join("");
  const claims = (a.extractedClaims || []).map((c) => `<div class="claim"><div>${esc(c.claim)}</div><div class="panel-sub">${esc(c.sourceType)} · ${esc(c.sourceDomain)} · event ${esc(c.eventDate || "—")} · published ${esc((c.sourcePublishedAt || "—").slice(0, 10))} · relevance ${fmt(c.relevance)} · confidence ${fmt(c.confidence)} · supports <b>${esc(L(c.supportsOutcomeIdx))}</b></div><div class="q">“${esc(c.quote)}”</div></div>`).join("");
  const rej = (a.rejectedCandidates || []).map((c) => `<div class="claim rej"><div>${esc(c.claim)}</div><div class="panel-sub">${esc(c.sourceType || "?")} · ${c.sourceUrl ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.sourceDomain || c.sourceUrl)}</a>` : esc(c.sourceDomain || "?")}${c.score !== undefined ? ` · score ${fmt(c.score, 2)}` : ""}</div>${c.reasons.map((r) => `<div class="panel-sub">→ ${esc(r)}</div>`).join("")}</div>`).join("");
  const nov = a.novelty ? `<div class="kv"><span class="k">score</span><span>${fmt(a.novelty.score, 3)} (${esc(a.novelty.decision)})</span><span class="k">frontier already knows</span><span>${fmt(a.novelty.checks.frontierLikelyKnows)}</span><span class="k">tight to resolution</span><span>${fmt(a.novelty.checks.tightToResolution)}</span><span class="k">primary strength</span><span>${fmt(a.novelty.checks.primaryStrength)}</span><span class="k">recency</span><span>${fmt(a.novelty.checks.recency)}</span><span class="k">flags</span><span>${esc((a.novelty.checks.flags || []).join(", ") || "none")}</span><span class="k">reasons</span><span>${esc((a.novelty.reasons || []).join(" | "))}</span></div>` : `<div class="panel-sub">no novelty assessment (rejected earlier or still running)</div>`;
  $("#modalBody").innerHTML = `
    <h3>${esc(a.question)}</h3>
    <div class="panel-sub">${esc(a.attemptId)} · ${esc(a.marketId)} · started ${esc(a.startedAt)} · ${a.dryRun ? "DRY-RUN" : "LIVE"}</div>
    <div style="margin:8px 0">${statusPill(a)} ${a.rejectReason ? `<span class="v warn">${esc(a.rejectReason)}</span>` : ""} ${a.error ? `<span class="v bad">${esc(a.error)}</span>` : ""}</div>
    ${a.packaged ? `<h4>Packaged note (supports ${esc(L(a.polarity))})</h4><div class="note">${esc(a.packaged.note)}</div>` : ""}
    <h4>Queries run (${(a.queriesRun || []).length})</h4><pre>${esc((a.queriesRun || []).join("\n") || "—")}</pre>
    <h4>Sources (${(a.sourcesFetched || []).length})</h4><div class="table-wrap"><table><thead><tr><th>DOMAIN</th><th>DATE</th><th>METHOD</th><th>RESULT</th><th>URL</th></tr></thead><tbody>${sources || `<tr><td colspan="5"><div class="empty">none</div></td></tr>`}</tbody></table></div>
    <h4>Extraction</h4>${a.extractionDiag ? `<pre>${esc(JSON.stringify(a.extractionDiag, null, 2))}</pre>` : ""}${claims || `<div class="panel-sub">no claims survived extraction</div>`}
    ${rej ? `<h4>Rejected candidates</h4>${rej}` : ""}
    <h4>Novelty &amp; quality gate</h4>${nov}
    ${a.submissionPayload ? `<h4>Submission payload</h4><pre>${esc(JSON.stringify(a.submissionPayload, null, 2))}</pre>` : ""}
    ${a.receipt ? `<h4>Receipt</h4><pre>${esc(JSON.stringify(a.receipt, null, 2))}</pre>` : ""}
    ${a.judgment ? `<h4>Judgment</h4><pre>${esc(JSON.stringify(a.judgment, null, 2))}</pre>` : ""}
    ${a.settlementLater ? `<h4>Settlement</h4><pre>${esc(JSON.stringify(a.settlementLater, null, 2))}</pre>` : ""}`;
  $("#modal").classList.add("open");
}
const closeModal = () => $("#modal").classList.remove("open");

// ---------------- actions ----------------
async function runNow() {
  const btn = $("#runBtn");
  btn.disabled = true;
  try {
    const r = await j("/api/evidence/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    btn.textContent = r.alreadyQueued ? "Already queued" : "Queued ✓";
  } catch (e) {
    btn.textContent = "Failed";
    alert("Could not queue a cycle: " + e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = "Run cycle now"; }, 4000);
  }
}

// ---------------- clocks ----------------
function tickClock() {
  const now = Date.now();
  const el = $("#compClock");
  el.textContent = now < COMP_START ? `COMPETITION STARTS IN ${dur(COMP_START - now)}` : now <= COMP_END ? `COMPETITION LIVE · ENDS IN ${dur(COMP_END - now)}` : "COMPETITION ENDED";
  el.style.color = now >= COMP_START && now <= COMP_END ? "var(--green)" : "";
  const nx = $("#nextRun");
  if (nx && nx.dataset.next) nx.textContent = "next cycle in " + dur(Number(nx.dataset.next) - now);
  const since = document.querySelector("[data-since]");
  if (since && since.dataset.since) since.textContent = dur(now - new Date(since.dataset.since).getTime());
  if ($("#footInfo") && status) $("#footInfo").textContent = `MODE=${status.mode} · refreshed ${new Date().toLocaleTimeString([], { hour12: false })}`;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-attempt]");
  if (t) return openAttempt(t.dataset.attempt);
  if (e.target.id === "modal" || e.target.id === "modalClose") closeModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
$("#runBtn").addEventListener("click", runNow);

// boot
(async function boot() {
  await Promise.all([loadAttempts(), loadStatus()]);
  await pollEvents();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(pollEvents, 3000);
  setInterval(() => { loadStatus(); loadAttempts(); }, 10000);
})();

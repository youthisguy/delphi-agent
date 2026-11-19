function statusDot(status) {
  if (status === "ok") return "ok";
  if (status === "cooldown") return "warn";
  return "off";
}


function statusLabel(status) {
  const map = {
    ok: "OK",
    cooldown: "COOLDOWN",
    dead: "DEAD",
    untested: "UNTESTED",
  };
  return map[status] || status;
}

async function loadNodes() {
  try {
    const r = await j("/api/nodes");
    const nodes = r.nodes || [];
    const sum = r.summary || {};
    if (!nodes.length) {
      $("#configHealth").innerHTML = `
        <div class="stat-row"><span class="k">OpenAI agents</span><span class="v bad">0 configured</span></div>
        <div class="stat-row"><span class="k">Gemini agents</span><span class="v bad">0 configured</span></div>
        <div class="empty" style="padding:8px 0;">Set OPENAI_API_KEYS / GEMINI_API_KEYS on the server</div>`;
      return;
    }
    let html = `
      <div class="stat-row">
        <span class="k">OpenAI nodes</span>
        <span class="v ${sum.openaiOk ? "good" : "bad"}">${sum.openaiOk ?? 0}/${sum.openaiTotal ?? 0} OK</span>
      </div>
      <div class="stat-row">
        <span class="k">Gemini nodes</span>
        <span class="v ${sum.geminiOk ? "good" : "bad"}">${sum.geminiOk ?? 0}/${sum.geminiTotal ?? 0} OK</span>
      </div>
      <div class="panel-sub" style="margin:8px 0 4px;">AGENT MATRIX</div>`;
    html += nodes.map((n) => `
      <div class="stat-row">
        <span class="k">${esc(n.label)} <span style="color:var(--text-muted)">agent</span></span>
        <span class="v">
          <span class="dot ${statusDot(n.status)}"></span>${statusLabel(n.status)}
        </span>
      </div>`).join("");
    $("#configHealth").innerHTML = html;
  } catch (e) {
    $("#configHealth").innerHTML = `<div class="empty">agents offline — ${esc(e.message)}</div>`;
  }
}

async function runNodeHealthCheck() {
  const btn = $("#nodeHealthBtn");
  const out = $("#nodeHealthResult");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Probing…";
  }
  if (out) out.textContent = "Running health check across all agents…";
  try {
    const r = await j("/api/nodes/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sum = r.summary || {};
    if (out) {
      out.innerHTML = `OpenAI ${sum.openaiOk}/${sum.openaiTotal} OK | Gemini ${sum.geminiOk}/${sum.geminiTotal} OK`;
    }
    // reuse same renderer
    const fake = { nodes: r.nodes, summary: r.summary };
    // simplest: call loadNodes after server state updated
    await loadNodes();
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--red)">ERR: ${esc(e.message)}</span>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Health check";
    }
  }
}

let watcherStateCache = {};

async function loadWatcherState() {
  try {
    const r = await j("/api/watcher/state");
    watcherStateCache = r.state || {};
  } catch (e) {
    watcherStateCache = {};
  }
}

async function loadClosedLegs() {
  try {
    const r = await j("/api/closed-legs");
    const legs = r.legs || [];
    $("#closedLegsCount").textContent = legs.length + " CLOSED";

    if (!legs.length) {
      $("#closedLegsBody").innerHTML = `<tr><td colspan="6"><div class="empty">no closed legs</div></td></tr>`;
      return;
    }

    // Most recently closed first.
    legs.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());

    $("#closedLegsBody").innerHTML = legs.map((leg) => {
      const reasonPill = leg.reason === "watcher-auto-exit"
        ? '<span class="pill gone" title="Auto-exited by the position watcher">AUTO-EXIT</span>'
        : '<span class="pill skip" title="Sold manually">MANUAL</span>';

      return `
        <tr>
          <td class="q-cell" title="${esc(leg.question || leg.marketId)}">${esc(leg.question || leg.marketId)}</td>
          <td>${esc(leg.outcomeLabel ?? ("#" + leg.outcomeIdx))}</td>
          <td>${reasonPill}</td>
          <td>${timeAgo(leg.closedAt)}</td>
          <td style="color:var(--text-muted); font-size:9px; max-width:220px; white-space:normal;">${esc(leg.note || "—")}</td>
          <td>
            <button class="reopen-btn" data-market="${esc(leg.marketId)}" data-outcome="${leg.outcomeIdx}">Reopen</button>
          </td>
        </tr>
      `;
    }).join("");
  } catch (e) {
    $("#closedLegsBody").innerHTML = `<tr><td colspan="6"><div class="empty">closed-legs unavailable</div></td></tr>`;
  }
}

async function handleReopen(marketId, outcomeIdx) {
  if (!confirm("Reopen this leg? The bot will be able to buy it again on the next qualifying signal.")) return;
  try {
    const r = await j("/api/closed-legs/reopen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId, outcomeIdx }),
    });
    if (!r.reopened) {
      alert("Nothing to reopen — it may have already been cleared.");
    }
    loadClosedLegs();
  } catch (e) {
    alert("Reopen failed: " + e.message);
  }
}

function healthCellFor(p) {
  const key = `${p.marketId.toLowerCase()}::${p.outcomeIdx}`;
  const w = watcherStateCache[key];

  if (!w) {
    return `<span class="v" style="color:var(--text-muted); font-size:9px;" title="Not yet checked, or not time-sensitive enough to qualify for checks">—</span>`;
  }

  if (w.pendingConfirmation) {
    const since = w.pendingSince ? timeAgo(w.pendingSince) : "";
    return `<span class="pill stale" title="Severity=${esc(w.pendingSeverity || "")} conf=${fmtNum(w.pendingConfidence, 2)} — flagged ${since}, awaiting a second confirming check before auto-exit">FLAGGED</span>`;
  }

  const checkedAgo = timeAgo(w.lastCheckedAt);
  return `<span class="v good" style="font-size:9px;" title="Last checked ${checkedAgo}, no concerning news found">OK <span style="color:var(--text-muted)">(${checkedAgo})</span></span>`;
}

// wire button once DOM ready
document.getElementById("nodeHealthBtn")?.addEventListener("click", runNodeHealthCheck);

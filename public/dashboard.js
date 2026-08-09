function statusDot(status) {
  if (status === "ok") return "ok";
  if (status === "untested") return "off";  
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

// wire button once DOM ready
document.getElementById("nodeHealthBtn")?.addEventListener("click", runNodeHealthCheck);

// ---- Checkpoint (persist data/ across redeploys) ----

// Prompted once per page load, not stored in the JS source — this
// dashboard has no login, so the secret only ever lives in the
// browser's memory for this tab, never on disk or in a request unless
// the button is actually clicked. Leave blank if CHECKPOINT_SECRET
// isn't set on the server; the server skips the check in that case.
let cachedCheckpointSecret = null;

async function runCheckpoint() {
  const btn = $("#checkpointBtn");
  const out = $("#checkpointResult");
  if (cachedCheckpointSecret === null) {
    cachedCheckpointSecret = window.prompt("Checkpoint secret (leave blank if none set):") || "";
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  if (out) out.textContent = "Committing data/ and pushing…";
  try {
    const r = await j("/api/checkpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-checkpoint-secret": cachedCheckpointSecret },
      body: "{}",
    });
    if (out) {
      const tail = (r.output || "").split("\n").filter(Boolean).slice(-1)[0] || "done";
      out.innerHTML = `<span style="color:var(--green)">${esc(tail)}</span>`;
    }
  } catch (e) {
    // Wrong/missing secret comes back as a normal HTTP error from j(),
    // so clear the cached value and let the next click re-prompt.
    cachedCheckpointSecret = null;
    if (out) out.innerHTML = `<span style="color:var(--red)">ERR: ${esc(e.message)}</span>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save checkpoint";
    }
  }
}

document.getElementById("checkpointBtn")?.addEventListener("click", runCheckpoint);
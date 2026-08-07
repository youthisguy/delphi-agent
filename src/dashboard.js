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
          <div class="stat-row"><span class="k">OpenAI nodes</span><span class="v bad">0 configured</span></div>
          <div class="stat-row"><span class="k">Gemini nodes</span><span class="v bad">0 configured</span></div>
          <div class="empty" style="padding:8px 0;">Set OPENAI_API_KEYS / GEMINI_API_KEYS on the server</div>`;
        return;
      }
      let html = `
        <div class="stat-row">
          <span class="k">OpenAI pool</span>
          <span class="v ${sum.openaiOk ? "good" : "bad"}">${sum.openaiOk ?? 0}/${sum.openaiTotal ?? 0} OK</span>
        </div>
        <div class="stat-row">
          <span class="k">Gemini pool</span>
          <span class="v ${sum.geminiOk ? "good" : "bad"}">${sum.geminiOk ?? 0}/${sum.geminiTotal ?? 0} OK</span>
        </div>
        <div class="panel-sub" style="margin:8px 0 4px;">NODE MATRIX</div>`;
      html += nodes.map((n) => `
        <div class="stat-row">
          <span class="k">${esc(n.label)} <span style="color:var(--text-muted)">${esc(n.provider)}</span></span>
          <span class="v">
            <span class="dot ${statusDot(n.status)}"></span>${statusLabel(n.status)}
            ${n.lastError ? `<span style="color:var(--text-muted);font-size:9px;"> ${esc(String(n.lastError).slice(0,40))}</span>` : ""}
          </span>
        </div>`).join("");
      $("#configHealth").innerHTML = html;
    } catch (e) {
      $("#configHealth").innerHTML = `<div class="empty">nodes offline — ${esc(e.message)}</div>`;
    }
  }
  
  async function runNodeHealthCheck() {
    const btn = $("#nodeHealthBtn");
    const out = $("#nodeHealthResult");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Probing…";
    }
    if (out) out.textContent = "Running health check across all nodes…";
    try {
      const r = await j("/api/nodes/health-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const sum = r.summary || {};
      if (out) {
        out.innerHTML = `OpenAI ${sum.openaiOk}/${sum.openaiTotal} OK · Gemini ${sum.geminiOk}/${sum.geminiTotal} OK`;
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
  
  // in refreshAll():
  // loadNodes();
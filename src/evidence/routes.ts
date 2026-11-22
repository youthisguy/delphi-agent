import fs from "node:fs";
import { EV } from "./evidenceConfig.js";
import { readAttempts, readEvents, floorStatus } from "./evidenceJournal.js";
import { effectiveDryRun, getLastCycle } from "./loop.js";
import { enabledProviders } from "./search.js";
import { isLiveReady } from "./submit.js";
import { registerHumanRoutes } from "./humanRoutes.js";
import { isHeld } from "./holds.js";
import type { EvidenceEvent, EvidenceAttempt } from "./types.js";

/** One-line, human summary of a journal event for the live feed. */
export function summarizeEvent(ev: EvidenceEvent, att?: EvidenceAttempt): string {
  const p: any = ev.patch ?? {};
  switch (ev.type) {
    case "started": return "research started";
    case "researched": {
      const parts: string[] = [];
      if (p.queriesRun) parts.push(`${p.queriesRun.length} queries`);
      if (p.sourcesFetched) parts.push(`${p.sourcesFetched.length} sources (${p.sourcesFetched.filter((s: any) => s.ok).length} readable)`);
      if (p.extractedClaims) parts.push(`${p.extractedClaims.length} claims extracted${p.extractionDiag ? ` · dropped quote ${p.extractionDiag.droppedQuote}, undated ${p.extractionDiag.droppedUndated}, low-rel ${p.extractionDiag.droppedRelevance}` : ""}`);
      return parts.join(" · ") || "researched";
    }
    case "rejected": {
      const rc = (p.rejectedCandidates ?? []) as { claim: string; reasons: string[] }[];
      const tail = rc.length ? ` — ${rc.map((c) => c.reasons[c.reasons.length - 1]).join(" | ")}` : "";
      return `REJECTED: ${p.rejectReason ?? "unknown"}${tail}`.slice(0, 400);
    }
    case "packaged": return `accepted · novelty ${p.novelty?.score ?? "?"} · supports outcome #${p.polarity ?? "?"}`;
    case "submitted": return `${att?.dryRun ? "DRY-RUN " : ""}submitted · receipt ${p.receipt?.id ?? "?"}`;
    case "judged": return `judged: ${p.judgment?.verdict ?? "?"} · reward ${p.judgment?.reward ?? "?"}`;
    case "settled": return `settled · reward ${p.settlementLater?.reward ?? "?"}`;
    case "error": return `ERROR: ${p.error ?? "unknown"}`.slice(0, 300);
    default: return ev.type;
  }
}

/**
 * Observability endpoints. ALL are behind the dashboard password (when DASHBOARD_PASSWORD is set): packaged notes
 * are competitive information — a duplicate of an earlier submission earns zero, so don't leave them public.
 * RUN NOW just drops a trigger file that the loop process picks up.
 */
export function registerEvidenceRoutes(app: any, guard: (req: any, res: any, next: any) => void, _client?: unknown): void {
  app.get("/api/evidence/status", guard, (_req: any, res: any) => {
    let file: any = {};
    try { file = JSON.parse(fs.readFileSync(EV.statusPath, "utf8")); } catch { /* loop hasn't written one yet */ }
    res.json({
      mode: EV.mode, dryRun: effectiveDryRun(), liveSubmitterReady: isLiveReady(),
      searchProviders: enabledProviders(), playwrightEnabled: EV.playwrightEnabled,
      cycleIntervalMs: EV.cycleIntervalMs, minNoveltyScore: EV.minNoveltyScore,
      floor: floorStatus(),
      lastCycle: file.lastCycle ?? getLastCycle(), progress: file.progress ?? null,
      marketBoard: (file.marketBoard ?? []).map((m: any) => ({ ...m, held: isHeld(m.id) })), llm: file.llm ?? null, updatedAt: file.updatedAt ?? null,
    });
  });

  app.get("/api/evidence/attempts", guard, (req: any, res: any) => {
    const limit = Math.min(Number(req.query.limit ?? 60), 500);
    let a = readAttempts();
    if (typeof req.query.marketId === "string") a = a.filter((x) => x.marketId === req.query.marketId);
    if (typeof req.query.status === "string") a = a.filter((x) => x.status === req.query.status);
    a = [...a].sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1));
    res.json({ attempts: a.slice(0, limit), total: a.length });
  });

  /** Live feed. `after` = number of events the client has already seen; first call (after=0) returns the tail. */
  app.get("/api/evidence/events", guard, (req: any, res: any) => {
    const events = readEvents();
    const total = events.length;
    let after = Number(req.query.after ?? 0);
    if (!Number.isFinite(after) || after < 0 || after > total) after = 0;
    const slice = after === 0 ? events.slice(-120) : events.slice(after, after + 300);
    const base = after === 0 ? Math.max(0, total - slice.length) : after;
    const byId = new Map(readAttempts().map((a) => [a.attemptId, a]));
    res.json({
      total,
      events: slice.map((ev, i) => {
        const att = byId.get(ev.attemptId);
        return { seq: base + i, ts: ev.ts, type: ev.type, attemptId: ev.attemptId, marketId: ev.marketId, question: att?.question ?? "", summary: summarizeEvent(ev, att) };
      }),
    });
  });

  app.get("/api/evidence/floor", guard, (_req: any, res: any) => res.json(floorStatus()));

  // Runs in the LOOP process (it polls this file), so it uses the real Delphi client and shares the loop's state.
  app.post("/api/evidence/run", guard, (_req: any, res: any) => {
    try {
      const already = fs.existsSync(EV.triggerPath);
      if (!already) fs.writeFileSync(EV.triggerPath, JSON.stringify({ requestedAt: new Date().toISOString() }));
      res.json({ queued: true, alreadyQueued: already });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  registerHumanRoutes(app, guard);
}

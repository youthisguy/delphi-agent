import fs from "node:fs";
import path from "node:path";
import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { getDryRun } from "../config.js";
import { runCheckpointScript } from "../checkpoint.js";
import { EV } from "./evidenceConfig.js";
import { appendEvent, newAttemptId, readAttempts, usedUrls, pendingJudgment, floorStatus, submissionsFor } from "./evidenceJournal.js";
import { listEvidenceMarkets } from "./markets.js";
import { prioritize, scoreMarket } from "./prioritizer.js";
import { classifyTopic } from "./queryTemplates.js";
import { lastResearchedAt } from "./evidenceJournal.js";
import { getAllNodesView } from "../keyPool.js";
import { compatStatus } from "./compatLlm.js";
import { llmStats } from "./llmRouter.js";
import { gatherSources } from "./research.js";
import { extractClaims } from "./extract.js";
import { assessNovelty } from "./novelty.js";
import { packageEvidence } from "./packager.js";
import { checkSubmitGuards, capReached } from "./guards.js";
import { createSubmitter, buildPayload, isLiveReady, type Submitter } from "./submit.js";
import { enabledProviders } from "./search.js";
import type { EvidenceMarket, NoveltyResult } from "./types.js";

export type MarketOutcome = "submitted" | "rejected" | "error";

export function effectiveDryRun(): boolean {
  return getDryRun() || !isLiveReady();
}

export async function processMarket(market: EvidenceMarket, submitter: Submitter, dryRun: boolean): Promise<MarketOutcome> {
  const attemptId = newAttemptId();
  const mid = market.id;
  appendEvent(attemptId, mid, "started", {
    question: market.question, outcomes: market.outcomes, startedAt: new Date().toISOString(), dryRun,
    queriesRun: [], sourcesFetched: [], extractedClaims: [], polarity: null,
  });

  try {
    const research = await gatherSources(market, usedUrls(mid));
    appendEvent(attemptId, mid, "researched", { queriesRun: research.queries, sourcesFetched: research.sources });

    if (!research.docs.length) {
      appendEvent(attemptId, mid, "rejected", { rejectReason: "no readable sources found" });
      return "rejected";
    }

    const { claims, diag } = await extractClaims(market, research.docs);
    appendEvent(attemptId, mid, "researched", { extractedClaims: claims, extractionDiag: diag });
    if (!claims.length) {
      const why = diag.llmFailed >= diag.docs ? "LLM failed on every document" : `dropped: quote ${diag.droppedQuote}, undated ${diag.droppedUndated}, low-relevance ${diag.droppedRelevance}, pages with nothing relevant ${diag.docsWithNoClaims}`;
      appendEvent(attemptId, mid, "rejected", { rejectReason: `no verifiable dated claims extracted (${why})` });
      return "rejected";
    }

    const rejected: { claim: string; reasons: string[] }[] = [];
    let lastNovelty: NoveltyResult | undefined;

    for (const claim of claims.slice(0, 3)) {
      const novelty = await assessNovelty(market, claim, dryRun);
      lastNovelty = novelty;
      if (novelty.decision === "reject") {
        rejected.push({ claim: claim.claim, reasons: novelty.reasons });
        continue;
      }

      const packaged = await packageEvidence(market, claim);
      const guard = checkSubmitGuards({ marketId: mid, outcomeIdx: claim.supportsOutcomeIdx, packaged, dryRun });
      if (!guard.ok) {
        rejected.push({ claim: claim.claim, reasons: [`guard: ${guard.reason}`] });
        continue;
      }

      appendEvent(attemptId, mid, "packaged", { novelty, packaged, polarity: claim.supportsOutcomeIdx });
      const payload = buildPayload(mid, claim.supportsOutcomeIdx!, packaged);
      const receipt = await submitter.submit(payload);
      appendEvent(attemptId, mid, "submitted", {
        submissionPayload: payload, submittedAt: receipt.submittedAt, receipt: { id: receipt.id, raw: receipt.raw },
      });
      return "submitted";
    }

    appendEvent(attemptId, mid, "rejected", {
      novelty: lastNovelty, rejectedCandidates: rejected,
      rejectReason: `all ${rejected.length} candidate claim(s) rejected`,
    });
    return "rejected";
  } catch (err) {
    appendEvent(attemptId, mid, "error", { error: err instanceof Error ? err.message : String(err) });
    return "error";
  }
}

/** Ingest judgment feedback for live submissions. Settlement ingestion lands with the API on 23 Nov. */
export async function pollJudgments(submitter: Submitter): Promise<number> {
  let n = 0;
  for (const a of pendingJudgment()) {
    try {
      const j = await submitter.fetchJudgment(a.receipt!.id);
      if (j) {
        appendEvent(a.attemptId, a.marketId, "judged", { judgment: j, reward: j.reward });
        n++;
      }
    } catch (err) {
      console.warn(`  [evidence] judgment poll failed for ${a.attemptId}:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}

export interface CycleSummary {
  at: string; dryRun: boolean; marketsSeen: number; marketsTried: number;
  submitted: number; rejected: number; errors: number; judgmentsIngested: number;
}

export interface Progress { running: boolean; startedAt?: string; currentMarketId?: string; currentQuestion?: string; nextRunAt?: number }

let running = false;
let lastCycle: CycleSummary | null = null;
let progress: Progress = { running: false };
let lastBoard: unknown[] = [];

export const isRunning = () => running;

export async function runEvidenceCycle(client?: DelphiClient): Promise<CycleSummary | null> {
  if (running) return null;
  running = true;
  try {
    const dryRun = effectiveDryRun();
    const submitter = createSubmitter(dryRun);
    const summary: CycleSummary = { at: new Date().toISOString(), dryRun, marketsSeen: 0, marketsTried: 0, submitted: 0, rejected: 0, errors: 0, judgmentsIngested: 0 };
    progress = { ...progress, running: true, startedAt: summary.at, currentMarketId: undefined, currentQuestion: undefined };
    writeStatus();

    console.log(`[evidence] cycle start (dryRun=${dryRun}, search=${enabledProviders().join(",") || "NONE"})`);
    summary.judgmentsIngested = await pollJudgments(submitter);

    const markets = await listEvidenceMarkets(client);
    summary.marketsSeen = markets.length;
    lastBoard = markets
      .map((m) => {
        const t = lastResearchedAt(m.id);
        return {
          id: m.id, question: m.question, category: m.category ?? null, topic: classifyTopic(m), resolvesAt: m.resolvesAt,
          score: Number(scoreMarket(m, dryRun).toFixed(3)), submissions: submissionsFor(m.id, dryRun).length,
          capReached: capReached(m.id, dryRun), onCooldown: t !== null && Date.now() - t < EV.marketCooldownMs,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
    const queue = prioritize(markets, dryRun).filter((m) => !capReached(m.id, dryRun)).slice(0, EV.maxMarketsPerCycle);
    writeStatus();

    for (const m of queue) {
      summary.marketsTried++;
      progress = { ...progress, currentMarketId: m.id, currentQuestion: m.question };
      writeStatus();
      console.log(`[evidence] → ${m.id} "${m.question.slice(0, 80)}"`);
      const r = await processMarket(m, submitter, dryRun);
      if (r === "submitted") summary.submitted++;
      else if (r === "rejected") summary.rejected++;
      else summary.errors++;
    }

    lastCycle = summary;
    console.log(`[evidence] cycle done:`, summary);

    if (EV.autoCheckpoint && summary.marketsTried > 0) {
      const cp = await runCheckpointScript();
      if (!cp.ok) console.warn("[evidence] checkpoint failed (non-fatal):", cp.output.slice(0, 200));
    }
    return summary;
  } finally {
    running = false;
    progress = { ...progress, running: false, currentMarketId: undefined, currentQuestion: undefined };
    try { writeStatus(); } catch { /* status is best-effort */ }
  }
}

export function writeStatus(last: CycleSummary | null = lastCycle): void {
  fs.mkdirSync(path.dirname(EV.statusPath), { recursive: true });
  fs.writeFileSync(EV.statusPath, JSON.stringify({
    updatedAt: new Date().toISOString(), mode: EV.mode, dryRun: effectiveDryRun(),
    liveSubmitterReady: isLiveReady(), searchProviders: enabledProviders(),
    cycleIntervalMs: EV.cycleIntervalMs, floor: floorStatus(), lastCycle: last,
    progress, marketBoard: lastBoard,
    llm: { order: EV.llmOrder, stats: llmStats, compat: compatStatus(), nodes: getAllNodesView() },
  }, null, 2));
}

export function getLastCycle() { return lastCycle; }
export { submissionsFor };

/**
 * Call from index.ts main(). Runs one cycle immediately, then on an interval.
 * Also polls data/evidence-trigger.json (written by the dashboard's RUN NOW button, which lives in
 * the other process) so manual cycles run HERE, with the real Delphi client.
 */
export function startEvidenceLoop(client?: DelphiClient): void {
  const tick = () => {
    progress = { ...progress, nextRunAt: Date.now() + EV.cycleIntervalMs };
    return runEvidenceCycle(client).catch((err) => console.error("[evidence] cycle error:", err));
  };
  console.log(`[evidence] loop starting, every ${EV.cycleIntervalMs / 1000}s`);
  void tick();
  setInterval(tick, EV.cycleIntervalMs);
  setInterval(() => {
    if (isRunning() || !fs.existsSync(EV.triggerPath)) return;
    try { fs.unlinkSync(EV.triggerPath); } catch { /* already gone */ }
    console.log("[evidence] manual cycle requested from dashboard");
    void runEvidenceCycle(client).catch((err) => console.error("[evidence] cycle error:", err));
  }, 5_000);
}

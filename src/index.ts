/**
 * Lazy Falcon — closed loop: forecast -> blend -> risk check -> journal ->
 * (maybe) trade -> redeem settled winners -> repeat.
 *
 * Run with: npx tsx src/index.ts
 */
import "dotenv/config";
import fs from "node:fs";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { findSimilarPolymarketOdds } from "./externalOdds.js";
import getLlmForecast from "./llmForecast.js";
import { getGeminiForecast } from "./geminiForecast.js";
import { blendSignals, isTimeSensitive, type Signal } from "./blend.js";
import { appendReceipt, patchReceiptExecution, recomputeSummary, type Receipt } from "./journal.js";
import { checkAndRedeemSettledPositions } from "./redeem.js";
import { getOpenPositions } from "./positions.js";
import { CONFIG, getDryRun } from "./config.js";

const client = new DelphiClient();

// Last line of defense: runCycle() already catches everything it knows
// about, but if something outside that (a genuinely unexpected bug)
// throws or rejects unhandled, log it loudly instead of letting Node kill
// the whole process. A silently-dead loop process looks identical, from
// the dashboard's side, to a stuck "running: true" cycle — this makes
// sure that failure mode is at least visible in the console instead of
// just... stopping.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] uncaught exception:", err);
});

interface TradeDecision {
  outcomeIdx: number;
  tokensToSpend: number;
  bestEdge: number;
  minEdge: number;
  blendedProbs: number[];
  confidence: number;
  disagreement: number | null;
}

interface CycleBudget {
  total: number;
  source: "on-chain" | "virtual (dry-run fallback)";
}

/**
 * Resolves how much capital this cycle is allowed to deploy, computed
 * ONCE at the top of runCycle (not per-market). available = live token
 * balance − tokens already committed to open (unresolved) positions −
 * a fixed reserve buffer. Markets are then sized as a fraction of this,
 * decremented as each signal is queued (see runCycle), so trade #20 in
 * a cycle sizes against what #1–19 already claimed rather than the same
 * starting balance.
 *
 * In dryRun, a failure to read a live balance (e.g. wallet not wired up
 * yet) falls back to a configured virtual bankroll so sizing logic can
 * still be exercised realistically. Outside dryRun, a balance-read
 * failure propagates — sizing against an unknown balance isn't safe.
 */
async function getCycleBudget(dryRun: boolean): Promise<CycleBudget> {
  try {
    const { balance, decimals } = await client.getErc20BalanceWithDecimals();
    const humanBalance = Number(balance) / 10 ** decimals;
    const openPositions = await getOpenPositions(client);
    const openExposure = openPositions.reduce((sum, p) => sum + p.size, 0);
    const available = Math.max(0, humanBalance - openExposure - CONFIG.bankrollReserveTokens);
    return { total: available, source: "on-chain" };
  } catch (err) {
    if (dryRun) {
      console.warn(
        "  [budget] couldn't read live balance in dry-run — using virtual bankroll:",
        err instanceof Error ? err.message : err
      );
      return { total: CONFIG.dryRunVirtualBankroll, source: "virtual (dry-run fallback)" };
    }
    throw err;
  }
}

async function decide(
  market: Market,
  remainingBudget: number
): Promise<{ decision: TradeDecision | null; receipt: Receipt }> {
  const question = (market as any).question || (market as any).metadata?.question || "";
  const outcomes: string[] =
    (market as any).outcomes || (market as any).metadata?.outcomes || ["Yes", "No"];
  const category = (market as any).category;

  const rawProbs = market.spotImpliedProbabilities ?? [];
  const hasValidPrice =
    rawProbs.length >= 2 && rawProbs.every((p) => Number.isFinite(p) && p > 0.01 && p < 0.99);
  const marketProbs = hasValidPrice
    ? rawProbs
    : Array.from({ length: Math.max(outcomes.length, 2) }, () => 0.5);

  // 1. Polymarket
  let external: Awaited<ReturnType<typeof findSimilarPolymarketOdds>> = null;
  try {
    external = await findSimilarPolymarketOdds(question, outcomes);
  } catch (err) {
    console.log(`  Polymarket lookup failed for ${market.id}:`, err instanceof Error ? err.message : err);
  }

  // 2. Primary OPENAI_MODEL 
  const { probs: llmProbs, confidence } = await getLlmForecast(question, outcomes);

  const signals: Signal[] = [{ name: "llm", probs: llmProbs, weight: 1.0 }];
  if (external && external.similarity > 0.65) {
    signals.push({ name: "polymarket", probs: external.probs, weight: Math.min(0.6, external.similarity) });
  }

  // 3. Gemini — only for time-sensitive markets, grounded with search.
  let geminiSignal: Awaited<ReturnType<typeof getGeminiForecast>> = null;
  if (CONFIG.geminiEnabled && isTimeSensitive(question)) {
    geminiSignal = await getGeminiForecast(question, outcomes, { grounded: true });
    if (geminiSignal) {
      signals.push({ name: "gemini", probs: geminiSignal.probs, weight: geminiSignal.confidence });
    }
  }

  // 4. Blend + disagreement-aware edge bar
  const blend = blendSignals(signals, marketProbs.length);

  let bestIdx = -1;
  let bestEdge = 0;
  for (let i = 0; i < blend.blendedProbs.length; i++) {
    const edge = blend.blendedProbs[i] - (marketProbs[i] ?? 0.5);
    if (edge > bestEdge) {
      bestEdge = edge;
      bestIdx = i;
    }
  }

  const baseMinEdge = hasValidPrice
    ? confidence > 0.7
      ? 0.08
      : 0.12
    : confidence > 0.65
      ? 0.15
      : 0.2;
  const minEdge = baseMinEdge * blend.edgeMultiplier;

  const receiptBase: Omit<Receipt, "decision" | "outcomeIdx" | "edge" | "thresholdUsed" | "size" | "execution" | "skipReason"> = {
    ts: new Date().toISOString(),
    marketId: market.id,
    question,
    category,
    outcomes,
    rawPrice: hasValidPrice ? rawProbs : null,
    syntheticPrice: !hasValidPrice,
    signals: {
      llm: { probs: llmProbs, confidence },
      gemini: geminiSignal ? { probs: geminiSignal.probs, confidence: geminiSignal.confidence, grounded: geminiSignal.grounded } : null,
      polymarket: external ? { probs: external.probs, similarity: external.similarity, url: external.url } : null,
    },
    disagreement: blend.disagreement,
    blendedProbs: blend.blendedProbs,
    confidence,
  };

  if (blend.skip || bestIdx === -1 || bestEdge < minEdge || remainingBudget <= 0) {
    const skipReason = blend.skip
      ? blend.skipReason!
      : remainingBudget <= 0
        ? `cycle budget exhausted (remaining=${remainingBudget.toFixed(2)})`
        : `bestEdge=${bestEdge.toFixed(3)} < minEdge=${minEdge.toFixed(2)}`;
    console.log(`  SKIP ${market.id}: ${skipReason}`);
    return {
      decision: null,
      receipt: { ...receiptBase, decision: "skip", outcomeIdx: bestIdx >= 0 ? bestIdx : null, edge: bestEdge, thresholdUsed: minEdge, size: null, execution: null, skipReason },
    };
  }

  // Conviction: how far past the edge bar this signal cleared, scaled by
  // confidence — 1x at exactly the threshold, capped at
  // maxConvictionMultiplier for signals that clear it by a wide margin.
  // Synthetic-price markets keep the existing 0.7x haircut on top.
  const sizeMultiplier = hasValidPrice ? 1.0 : 0.7;
  const convictionScore = Math.min(
    CONFIG.maxConvictionMultiplier,
    (bestEdge / minEdge) * confidence
  );
  const desiredSize = remainingBudget * CONFIG.bankrollFractionPerTrade * convictionScore * sizeMultiplier;
  const tokensToSpend = Math.max(0, Math.min(desiredSize, CONFIG.maxTokensPerTrade, remainingBudget));

  console.log(
    `  BUY signal ${market.id}: outcome=${bestIdx} edge=${bestEdge.toFixed(3)} conviction=${convictionScore.toFixed(2)} ` +
      `size≈${tokensToSpend.toFixed(2)} (of ${remainingBudget.toFixed(2)} remaining) ` +
      `disagreement=${blend.disagreement?.toFixed(2) ?? "n/a"}`
  );

  return {
    decision: { outcomeIdx: bestIdx, tokensToSpend, bestEdge, minEdge, blendedProbs: blend.blendedProbs, confidence, disagreement: blend.disagreement },
    receipt: { ...receiptBase, decision: "trade", outcomeIdx: bestIdx, edge: bestEdge, thresholdUsed: minEdge, size: tokensToSpend, execution: null },
  };
}

async function tradeOnMarket(market: Market, decision: TradeDecision, dryRun: boolean): Promise<Receipt["execution"]> {
  if (dryRun) {
    console.log(`  DRY RUN: would buy outcome ${decision.outcomeIdx} on ${market.id}, ~${decision.tokensToSpend.toFixed(2)} tokens`);
    return null;
  }

  const { balance, decimals } = await client.getErc20BalanceWithDecimals();
  const maxTokensIn = BigInt(Math.floor(Math.min(decision.tokensToSpend, CONFIG.maxTokensPerTrade) * 10 ** decimals));

  if (maxTokensIn > balance) {
    console.log(`  Skipping ${market.id}: insufficient balance for desired spend.`);
    return null;
  }

  const trialShares = maxTokensIn;
  const quote = await client.quoteBuy({
    marketAddress: market.id as `0x${string}`,
    outcomeIdx: decision.outcomeIdx,
    sharesOut: trialShares,
  });

  if (quote.tokensIn > maxTokensIn) {
    console.log("  Skipping: quoted cost exceeds max spend.");
    return null;
  }

  await client.ensureTokenApproval({ marketAddress: market.id as `0x${string}`, minimumAmount: quote.tokensIn });

  const result = await client.buyShares({
    marketAddress: market.id as `0x${string}`,
    outcomeIdx: decision.outcomeIdx,
    sharesOut: trialShares,
    maxTokensIn: quote.tokensIn,
  });

  console.log(`  Trade executed: ${result.transactionHash}`);
  return { txHash: result.transactionHash, quotedTokensIn: Number(quote.tokensIn), sharesOut: trialShares.toString() };
}

// Last completed cycle's counters, kept in memory so a "running: true"
// status write mid-cycle doesn't have to blank out the previous numbers
// the dashboard is already showing.
let lastCycleStats = { openMarkets: 0, evaluated: 0, traded: 0, skipped: 0, errors: [] as string[] };
let cycleInFlight = false;

function writeLoopStatus(status: Record<string, unknown>) {
  fs.writeFileSync(
    CONFIG.loopStatusPath,
    JSON.stringify({ ...lastCycleStats, ...status, updatedAt: new Date().toISOString() }, null, 2)
  );
}

async function runOnce() {
  if (cycleInFlight) {
    // Every network call in the pipeline is now timeout-bounded, so this
    // should be rare — but if a cycle somehow does run long, letting a
    // second one start on top of it would interleave writeLoopStatus()
    // calls and corrupt running/nextRunAt. Skip the tick instead.
    console.warn("[loop] previous cycle still in flight — skipping this tick");
    return;
  }
  cycleInFlight = true;
  try {
    await runCycle();
  } finally {
    cycleInFlight = false;
  }
}

async function runCycle() {
  const dryRun = getDryRun();
  // Fixed at the top of the cycle so "next run" reflects the loop's actual
  // cadence (setInterval fires on a fixed period from when this cycle
  // *started*, not from when it finishes), rather than drifting by however
  // long this particular cycle takes to run.
  const cycleStartedAt = Date.now();
  const nextRunAt = cycleStartedAt + CONFIG.loopIntervalMs;
  console.log(`\n[${new Date().toISOString()}] Loop start (dryRun=${dryRun})`);

  writeLoopStatus({ dryRun, running: true, intervalMs: CONFIG.loopIntervalMs, nextRunAt, startedAt: new Date(cycleStartedAt).toISOString() });

  let errors: string[] = [];
  let markets: Market[] = [];
  let traded = 0;
  let skipped = 0;
  let cycleBudget: CycleBudget = { total: 0, source: "on-chain" };
  let remainingBudget = 0;

  try {
    // 0. Redeem any settled winning positions from prior loops first, so
    // collateral is freed up before we size new trades this loop.
    try {
      const redemptions = await checkAndRedeemSettledPositions(client, dryRun);
      if (redemptions.length) console.log(`  Redemption check: ${JSON.stringify(redemptions)}`);
    } catch (err) {
      const msg = `redemption check failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
    }

    // 0.5 Resolve this cycle's deployable capital ONCE — every market
    // evaluated below sizes against what's left of it, not a fresh read.
    try {
      cycleBudget = await getCycleBudget(dryRun);
      remainingBudget = cycleBudget.total;
      console.log(`  Cycle budget: ${cycleBudget.total.toFixed(2)} tokens (${cycleBudget.source})`);
    } catch (err) {
      const msg = `budget resolution failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
      return; // can't size safely without a known live balance
    }

    const openStatus = "open" as any;
    try {
      const res = await client.listMarkets({ status: openStatus, limit: CONFIG.maxMarketsPerLoop, pricesAndImpliedProbabilities: true });
      markets = res.markets ?? [];
    } catch (err) {
      const msg = `listMarkets failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
      return; // status still gets written correctly by the finally block below
    }

    console.log(`Evaluating ${markets.length} market(s)`);

    for (const market of markets) {
      try {
        const { decision, receipt } = await decide(market, remainingBudget);
        if (!decision) {
          appendReceipt(receipt);
          skipped++;
          continue;
        }

        // Reserve the capital the moment it's decided, not after execution
        // fires — so the next market in this same loop, evaluated
        // microseconds later, sees the reduced remainder. This holds even
        // in dryRun: paper sizing should still reflect realistic
        // within-cycle capital constraints.
        remainingBudget -= decision.tokensToSpend;

        let execution: Receipt["execution"] = null;
        try {
          execution = await tradeOnMarket(market, decision, dryRun);
          traded++;
        } catch (err) {
          const msg = `trade failed for ${market.id}: ${err instanceof Error ? err.message : err}`;
          console.error(" ", msg);
          errors.push(msg);
        }
        appendReceipt({ ...receipt, execution });
      } catch (err) {
        const msg = `decide() failed for ${market.id}: ${err instanceof Error ? err.message : err}`;
        console.error(" ", msg);
        errors.push(msg);
      }
    }

    // Best-effort: recomputeSummary() touches the same journal file the
    // loop above just wrote to, and any hiccup here (malformed line,
    // transient fs error, concurrent write from a backtest run) must not
    // swallow the real evaluation counts we already have in hand.
    try {
      await recomputeSummary();
    } catch (err) {
      const msg = `recomputeSummary failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
    }
  } finally {
    lastCycleStats = { openMarkets: markets.length, evaluated: markets.length, traded, skipped, errors };
    writeLoopStatus({
      dryRun,
      running: false,
      intervalMs: CONFIG.loopIntervalMs,
      nextRunAt,
      cycleBudget: cycleBudget.total,
      cycleBudgetSource: cycleBudget.source,
      remainingBudget,
    });
  }
}

async function main() {
  console.log("Starting Lazy Falcon");
  console.log(`Loop interval: ${CONFIG.loopIntervalMs / 1000}s`);
  console.log(`Dry run: ${getDryRun()} (toggle via dashboard or data/runtime-config.json)\n`);

  writeLoopStatus({
    dryRun: getDryRun(),
    running: false,
    intervalMs: CONFIG.loopIntervalMs,
    nextRunAt: Date.now(), // first cycle kicks off immediately below
  });

  await runOnce().catch((err) => console.error("Loop error:", err));
  setInterval(() => {
    runOnce().catch((err) => console.error("Loop error:", err));
  }, CONFIG.loopIntervalMs);
}

main();
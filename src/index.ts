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
import { CONFIG, getDryRun } from "./config.js";

const client = new DelphiClient();

interface TradeDecision {
  outcomeIdx: number;
  tokensToSpend: number;
  bestEdge: number;
  minEdge: number;
  blendedProbs: number[];
  confidence: number;
  disagreement: number | null;
}

async function decide(market: Market): Promise<{ decision: TradeDecision | null; receipt: Receipt }> {
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

  if (blend.skip || bestIdx === -1 || bestEdge < minEdge) {
    const skipReason = blend.skip
      ? blend.skipReason!
      : `bestEdge=${bestEdge.toFixed(3)} < minEdge=${minEdge.toFixed(2)}`;
    console.log(`  SKIP ${market.id}: ${skipReason}`);
    return {
      decision: null,
      receipt: { ...receiptBase, decision: "skip", outcomeIdx: bestIdx >= 0 ? bestIdx : null, edge: bestEdge, thresholdUsed: minEdge, size: null, execution: null, skipReason },
    };
  }

  const sizeMultiplier = hasValidPrice ? 1.0 : 0.7;
  const tokensToSpend = Math.min(
    CONFIG.maxTokensPerTrade,
    (2 + bestEdge * 15 * confidence) * sizeMultiplier
  );

  console.log(
    `  BUY signal ${market.id}: outcome=${bestIdx} edge=${bestEdge.toFixed(3)} size≈${tokensToSpend.toFixed(2)} ` +
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

  const openStatus = "open" as any;
  let markets: Market[] = [];
  try {
    const res = await client.listMarkets({ status: openStatus, limit: CONFIG.maxMarketsPerLoop, pricesAndImpliedProbabilities: true });
    markets = res.markets ?? [];
  } catch (err) {
    const msg = `listMarkets failed: ${err instanceof Error ? err.message : err}`;
    console.error(" ", msg);
    errors.push(msg);
    lastCycleStats = { openMarkets: 0, evaluated: 0, traded: 0, skipped: 0, errors };
    writeLoopStatus({ dryRun, running: false, intervalMs: CONFIG.loopIntervalMs, nextRunAt });
    return;
  }

  console.log(`Evaluating ${markets.length} market(s)`);
  let traded = 0,
    skipped = 0;

  for (const market of markets) {
    try {
      const { decision, receipt } = await decide(market);
      if (!decision) {
        appendReceipt(receipt);
        skipped++;
        continue;
      }

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

  await recomputeSummary();
  lastCycleStats = { openMarkets: markets.length, evaluated: markets.length, traded, skipped, errors };
  writeLoopStatus({ dryRun, running: false, intervalMs: CONFIG.loopIntervalMs, nextRunAt });
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
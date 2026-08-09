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
import { getErc20Balance, getErc20Decimals, hasContractCode, resolveWalletAddress } from "./chainRead.js";
import { getCachedForecast, setCachedForecast, pruneForecastCache } from "./forecastCache.js";
import { CONFIG, getDryRun, getCompetitionTokenAddress } from "./config.js";

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
  /** The market's own implied probability for outcomeIdx at decision time
   * (or 0.5 if the book was synthetic) — same fallback backtest.ts's
   * entryPriceUsed and positions.ts's entryPriceFor() use. This is what
   * "shares per token spent" should be priced against, NOT the blended
   * forecast probability. */
  entryPriceUsed: number;
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
  // Dry-run is for paper-testing signal/sizing logic independent of
  // whatever the wallet's real balance happens to be right now (e.g.
  // pre-funding, it's legitimately 0 — that shouldn't block every
  // market from ever generating a sized signal). Live balance only
  // matters once trades actually execute, i.e. dryRun === false.
  if (dryRun) {
    return { total: CONFIG.dryRunVirtualBankroll, source: "virtual (dry-run fallback)" };
  }

  // Live sizing must be checked against the actual competition token —
  // client.getErc20BalanceWithDecimals() reads whatever token the SDK
  // is internally wired to by default, which is NOT guaranteed to be the
  // same contract as COMPETITION_TOKEN_ADDRESS. Read the configured
  // token explicitly via raw eth_call instead, same path the dashboard's
  // /api/balances competitionToken field already uses.
  const tokenAddress = getCompetitionTokenAddress();
  if (!tokenAddress) {
    throw new Error(
      "COMPETITION_TOKEN_ADDRESS is not set — refusing to size live trades against an unconfirmed token. " +
        "Set it via env or POST /api/token-address before disabling dryRun."
    );
  }
  if (!process.env.DELPHI_RPC_URL) {
    throw new Error("DELPHI_RPC_URL is not set — required to read the competition token's balance directly.");
  }

  const walletAddress = await resolveWalletAddress(client);
  if (!walletAddress) {
    throw new Error("Could not resolve trading wallet address — set WALLET_ADDRESS explicitly.");
  }

  const codeExists = await hasContractCode(tokenAddress);
  if (!codeExists) {
    throw new Error(
      `no contract found at ${tokenAddress} — DELPHI_RPC_URL is likely pointing at a different network ` +
        `than the one this token lives on.`
    );
  }

  const [rawBalance, onChainDecimals] = await Promise.all([
    getErc20Balance(tokenAddress, walletAddress),
    CONFIG.competitionTokenDecimals !== null ? Promise.resolve(null) : getErc20Decimals(tokenAddress),
  ]);
  const decimals = CONFIG.competitionTokenDecimals ?? onChainDecimals ?? 18;
  const humanBalance = Number(rawBalance) / 10 ** decimals;

  const openPositions = await getOpenPositions(client);
  const openExposure = openPositions.reduce((sum, p) => sum + p.size, 0);
  const available = Math.max(0, humanBalance - openExposure - CONFIG.bankrollReserveTokens);
  return { total: available, source: "on-chain" };
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

  // 2. Primary LLM forecast + 3. Gemini — cached per market for
  // CONFIG.forecastCacheTtlMs (default 20 min) so a small open-market
  // pool getting re-evaluated every loop tick doesn't burn a fresh
  // OpenAI + Gemini call on an unchanged question every single cycle.
  // Cache is invalidated early if the market's price has moved
  // meaningfully (see forecastCache.ts) since that's new information the
  // cached forecast never saw. Polymarket lookup above stays uncached —
  // it's a live external feed, not a model opinion.
  const currentMarketProbsForCache = hasValidPrice ? rawProbs : null;
  const cached = getCachedForecast(market.id, currentMarketProbsForCache);

  let llmProbs: number[];
  let confidence: number;
  let geminiSignal: Awaited<ReturnType<typeof getGeminiForecast>> = null;

  if (cached) {
    llmProbs = cached.llm.probs;
    confidence = cached.llm.confidence;
    geminiSignal = cached.gemini;
    console.log(`  [cache] reusing forecast for ${market.id} (age<${CONFIG.forecastCacheTtlMs / 60000}m, price unchanged)`);
  } else {
    const llmResult = await getLlmForecast(question, outcomes);
    llmProbs = llmResult.probs;
    confidence = llmResult.confidence;

    // Gemini — blended for every market (was previously gated to only
    // isTimeSensitive() questions). Grounding (Google Search) stays
    // limited to time-sensitive questions since that's specifically
    // where a stale training cutoff hurts — no reason to pay the extra
    // grounding latency/cost on a static question like "who wins this
    // golf tournament in 3 months."
    if (CONFIG.geminiEnabled) {
      const grounded = isTimeSensitive(question);
      geminiSignal = await getGeminiForecast(question, outcomes, { grounded });
    }

    setCachedForecast(market.id, {
      llm: { probs: llmProbs, confidence, reasoning: llmResult.reasoning },
      gemini: geminiSignal,
      marketProbsAtCache: currentMarketProbsForCache,
    });
  }

  const signals: Signal[] = [{ name: "llm", probs: llmProbs, weight: 1.0 }];
  if (external && external.similarity > 0.65) {
    signals.push({ name: "polymarket", probs: external.probs, weight: Math.min(0.6, external.similarity) });
  }
  if (geminiSignal) {
    signals.push({ name: "gemini", probs: geminiSignal.probs, weight: geminiSignal.confidence });
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

  const entryPriceUsed = marketProbs[bestIdx] ?? 0.5;

  return {
    decision: {
      outcomeIdx: bestIdx,
      tokensToSpend,
      bestEdge,
      minEdge,
      blendedProbs: blend.blendedProbs,
      confidence,
      disagreement: blend.disagreement,
      entryPriceUsed,
    },
    receipt: { ...receiptBase, decision: "trade", outcomeIdx: bestIdx, edge: bestEdge, thresholdUsed: minEdge, size: tokensToSpend, execution: null },
  };
}

async function tradeOnMarket(market: Market, decision: TradeDecision, dryRun: boolean): Promise<Receipt["execution"]> {
  if (dryRun) {
    console.log(`  DRY RUN: would buy outcome ${decision.outcomeIdx} on ${market.id}, ~${decision.tokensToSpend.toFixed(2)} tokens`);
    return null;
  }

  // Same fix as getCycleBudget(): check against the configured
  // competition token, not whatever the SDK defaults to.
  const tokenAddress = getCompetitionTokenAddress();
  if (!tokenAddress) throw new Error("COMPETITION_TOKEN_ADDRESS not set — refusing to trade live.");
  const walletAddress = await resolveWalletAddress(client);
  if (!walletAddress) throw new Error("Could not resolve trading wallet address.");

  const rawBalance = await getErc20Balance(tokenAddress, walletAddress);
  const decimals = CONFIG.competitionTokenDecimals ?? (await getErc20Decimals(tokenAddress));
  const maxTokensIn = BigInt(Math.floor(Math.min(decision.tokensToSpend, CONFIG.maxTokensPerTrade) * 10 ** decimals));

  if (maxTokensIn > rawBalance) {
    console.log(`  Skipping ${market.id}: insufficient competition-token balance for desired spend.`);
    return null;
  }

  // ⚠️ UNVERIFIED: quoteBuy / ensureTokenApproval / buyShares below are
  // opaque SDK calls that take no token-address parameter — they rely on
  // whatever collateral token the SDK itself resolves per market
  // internally. The balance check above now correctly confirms you HOLD
  // enough of the real competition token, but that does NOT guarantee
  // these calls will actually spend that same token. Before trusting
  // this live, confirm with the SDK docs/source (or a single small live
  // test trade) that the market's collateral token matches
  // COMPETITION_TOKEN_ADDRESS — otherwise approval/spend could target a
  // different contract than the balance you just checked.
  //
  // sharesOut is priced on a fixed 1e18 basis regardless of the
  // collateral token's own decimals (e.g. a 6-decimal competition token
  // still buys shares denominated in 1e18 units) — it must NOT be
  // derived from maxTokensIn, which is scaled to the token's decimals
  // (previously: `trialShares = maxTokensIn`, silently requesting a
  // wildly wrong share count on any token with decimals !== 18).
  // Instead derive the *desired* share count from tokensToSpend /
  // entryPrice (shares ≈ tokens spent ÷ price-per-share) and scale that
  // to 1e18.
  const entryPrice = Math.max(decision.entryPriceUsed, 0.01);
  const desiredShares = decision.tokensToSpend / entryPrice;
  const sharesOut = BigInt(Math.floor(desiredShares * 1e18));

  const quote = await client.quoteBuy({
    marketAddress: market.id as `0x${string}`,
    outcomeIdx: decision.outcomeIdx,
    sharesOut,
  });

  if (quote.tokensIn > maxTokensIn) {
    console.log("  Skipping: quoted cost exceeds max spend.");
    return null;
  }

  // 1.5% slippage buffer above the quoted cost. quoteBuy() and
  // buyShares() are two separate calls — the pool's price can move
  // between them (another trade lands, or plain AMM curve drift on a
  // thin market). Passing quote.tokensIn as an exact maxTokensIn meant
  // ANY movement at all reverted the tx. A small buffer lets execution
  // still go through as long as the move stays within tolerance, while
  // still capping worst-case slippage — never let it push spend past
  // this trade's own max, though.
  const SLIPPAGE_BPS = 150n; // 1.5%
  let maxTokensInWithSlippage = quote.tokensIn + (quote.tokensIn * SLIPPAGE_BPS) / 10000n;
  if (maxTokensInWithSlippage > maxTokensIn) maxTokensInWithSlippage = maxTokensIn;

  await client.ensureTokenApproval({ marketAddress: market.id as `0x${string}`, minimumAmount: maxTokensInWithSlippage });

  const result = await client.buyShares({
    marketAddress: market.id as `0x${string}`,
    outcomeIdx: decision.outcomeIdx,
    sharesOut,
    maxTokensIn: maxTokensInWithSlippage,
  });

  console.log(
    `  Trade executed: ${result.transactionHash} (shares=${sharesOut}, quotedTokensIn=${quote.tokensIn}, cap=${maxTokensInWithSlippage})`
  );

  // Price impact: quoted cost-per-share vs. the market's implied price at
  // decision time — how much more expensive the actual fill was than the
  // price the edge/sizing decision was made against, i.e. how thin this
  // market was for the size just traded.
  const costPerShare = Number(quote.tokensIn) / 10 ** decimals / desiredShares;
  const priceImpactPct = entryPrice > 0 ? Number(((costPerShare - entryPrice) / entryPrice).toFixed(4)) : null;

  return {
    txHash: result.transactionHash,
    quotedTokensIn: Number(quote.tokensIn),
    sharesOut: sharesOut.toString(),
    priceImpactPct,
  };
}

// Last completed cycle's counters, kept in memory so a "running: true"
// status write mid-cycle doesn't have to blank out the previous numbers
// the dashboard is already showing.
//
// Seeded from the existing loop-status.json on disk (if any) rather than
// hardcoded zeros — otherwise every process restart (redeploy, crash
// recovery, manual bounce) makes the dashboard show "0/0/0/0" for cycle
// metrics even though the journal already has real trading history,
// until an entirely new cycle completes (up to loopIntervalMs later).
function loadLastCycleStats(): { openMarkets: number; evaluated: number; traded: number; skipped: number; errors: string[] } {
  try {
    if (fs.existsSync(CONFIG.loopStatusPath)) {
      const prev = JSON.parse(fs.readFileSync(CONFIG.loopStatusPath, "utf8"));
      return {
        openMarkets: Number(prev.openMarkets) || 0,
        evaluated: Number(prev.evaluated) || 0,
        traded: Number(prev.traded) || 0,
        skipped: Number(prev.skipped) || 0,
        errors: Array.isArray(prev.errors) ? prev.errors : [],
      };
    }
  } catch (err) {
    console.warn("[loop] couldn't read existing loop-status.json, starting from zeros:", err instanceof Error ? err.message : err);
  }
  return { openMarkets: 0, evaluated: 0, traded: 0, skipped: 0, errors: [] };
}

let lastCycleStats = loadLastCycleStats();
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

    pruneForecastCache();
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
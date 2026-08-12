/**
 * Lazy Falcon — closed loop: forecast -> blend -> risk check -> journal ->
 * (maybe) trade -> redeem settled winners -> repeat.
 *
 */
import "dotenv/config";
import fs from "node:fs";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { findSimilarPolymarketOdds } from "./externalOdds.js";
import getLlmForecast from "./llmForecast.js";
import { getGeminiForecast } from "./geminiForecast.js";
import { blendSignals, isTimeSensitive, type Signal } from "./blend.js";
import { appendReceipt, patchReceiptExecution, readReceipts, recomputeSummary, type Receipt } from "./journal.js";
import { checkAndRedeemSettledPositions } from "./redeem.js";
import { checkSettledOutcomes } from "./settlement.js";
import { getOpenPositions } from "./positions.js";
import { getErc20Balance, getErc20Decimals, hasContractCode, resolveWalletAddress } from "./chainRead.js";
import { getCachedForecast, setCachedForecast, pruneForecastCache } from "./forecastCache.js";
import { runCheckpointScript } from "./checkpoint.js";
import { withDelphiRetry } from "./delphiRetry.js";
import { extractTradingFeePct, msUntilResolve } from "./marketFields.js";
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
  if (dryRun) {
    return { total: CONFIG.dryRunVirtualBankroll, source: "virtual (dry-run fallback)" };
  }

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

/** Same decimals resolution tradeOnMarket()/getCycleBudget() use — env
 * override first, then on-chain decimals(), falling back to 18. Kept
 * best-effort here: this is only used to interpret a *reference* quote
 * for sizing, not to move real funds, so a decimals miss here is far
 * less dangerous than the buyShares() path — still logged though. */
async function getReferenceTokenDecimals(): Promise<number> {
  if (CONFIG.competitionTokenDecimals !== null) return CONFIG.competitionTokenDecimals;
  const tokenAddress = getCompetitionTokenAddress();
  if (!tokenAddress) return 18;
  try {
    return await getErc20Decimals(tokenAddress);
  } catch {
    return 18;
  }
}

/**
 * For markets with no valid order book (hasValidPrice === false in
 * decide())
 * 
 * This asks the LMSR directly for a tiny reference quote (1 share) on
 * the candidate outcome and derives its implied price from that, so
 * decide()'s sizing and tradeOnMarket()'s real quote are working off
 * the same number. Returns null (caller falls back to 0.5, the old
 * behavior) if the call fails for any reason.
 */
async function getReferenceEntryPrice(market: Market, outcomeIdx: number): Promise<number | null> {
  try {
    const REFERENCE_SHARES = BigInt(1e18); // 1 share — enough to read a live price without materially moving it
    const decimals = await getReferenceTokenDecimals();
    const quote = await withDelphiRetry(
      () =>
        client.quoteBuy({
          marketAddress: market.id as `0x${string}`,
          outcomeIdx,
          sharesOut: REFERENCE_SHARES,
        }),
      { label: `quoteBuy(ref:${market.id})`, maxRetries: 2 }
    );
    const price = Number(quote.tokensIn) / 10 ** decimals; // tokensIn for 1 share ≈ that outcome's implied price
    if (!Number.isFinite(price) || price <= 0) return null;
    return Math.min(price, 0.99);
  } catch (err) {
    console.warn(
      `  [decide] reference quoteBuy failed for ${market.id}#${outcomeIdx}, falling back to synthetic 0.5:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function skipReceipt(market: Market, reason: string): Receipt {
  return {
    ts: new Date().toISOString(),
    marketId: market.id,
    question: (market as any).question || (market as any).metadata?.question || "",
    category: (market as any).category,
    outcomes: (market as any).outcomes || (market as any).metadata?.outcomes || ["Yes", "No"],
    rawPrice: null,
    syntheticPrice: false,
    signals: { llm: null, gemini: null, polymarket: null },
    disagreement: null,
    blendedProbs: [],
    confidence: 0,
    decision: "skip",
    outcomeIdx: null,
    edge: 0,
    thresholdUsed: 0,
    size: null,
    execution: null,
    skipReason: reason,
  };
}

async function decide(
  market: Market,
  remainingBudget: number
): Promise<{ decision: TradeDecision | null; receipt: Receipt }> {
  const question = (market as any).question || (market as any).metadata?.question || "";
  const outcomes: string[] =
    (market as any).outcomes || (market as any).metadata?.outcomes || ["Yes", "No"];
  const category = (market as any).category;

  // A market can still show status "open" via the API well after its
  // on-chain resolution window has actually closed — the contract itself
  // rejects buys once that happens (reverts quoteBuyExactOut), but the
  // off-chain listing doesn't necessarily reflect that in real time.
  // Checking this first, before any forecast calls, avoids burning an
  // LLM/Gemini call and an on-chain quote/revert on a market that can't
  // be traded regardless of what the signals say. A small safety buffer
  // (not just msRemaining <= 0) also skips markets that are *about* to
  // close mid-cycle, since a decide() → tradeOnMarket() round trip isn't
  // instant and the window can close between the two.
  const msRemaining = msUntilResolve(market);
  if (msRemaining !== null && msRemaining <= CONFIG.resolutionSafetyBufferMs) {
    const reason =
      msRemaining <= 0
        ? `market's resolution window has already passed (resolvesAt was ${Math.abs(msRemaining / 60000).toFixed(1)}m ago) — no longer tradable on-chain`
        : `market resolves in ${(msRemaining / 60000).toFixed(1)}m, inside the ${(CONFIG.resolutionSafetyBufferMs / 60000).toFixed(0)}m safety buffer — skipping to avoid a closing-window revert`;
    console.log(`  SKIP ${market.id}: ${reason}`);
    return {
      decision: null,
      receipt: {
        ts: new Date().toISOString(),
        marketId: market.id,
        question,
        category,
        outcomes: (market as any).outcomes || (market as any).metadata?.outcomes || ["Yes", "No"],
        rawPrice: null,
        syntheticPrice: false,
        signals: { llm: null, gemini: null, polymarket: null },
        disagreement: null,
        blendedProbs: [],
        confidence: 0,
        decision: "skip",
        outcomeIdx: null,
        edge: 0,
        thresholdUsed: 0,
        size: null,
        execution: null,
        skipReason: reason,
      },
    };
  }

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
  // Trading fee eats directly into edge — an 8%-edge signal against a
  // 5% fee is a much thinner bet than the same edge against a 0.5% fee
  // (see marketFields.ts's extractTradingFeePct doc comment). Added as
  // a flat addend rather than folded into edgeMultiplier so it stays
  // legible on its own and doesn't get compounded by the disagreement
  // multiplier, which is measuring something unrelated (signal spread,
  // not cost of entry).
  const tradingFeePct = extractTradingFeePct(market) ?? 0;
  const minEdge = baseMinEdge * blend.edgeMultiplier + tradingFeePct;

// A market can pass hasValidPrice and still be untraded — a freshly
  // opened LMSR pool starts at an exact 1/n price before any real trading,
  // and that spot price is only accurate for infinitesimal size. Treat
  // "looks untouched" the same as "no book at all".
  const looksUntouched =
    hasValidPrice && marketProbs.every((p) => Math.abs(p - 1 / marketProbs.length) < 0.005);

  if ((!hasValidPrice || looksUntouched) && bestIdx !== -1) {
    const refPrice = await getReferenceEntryPrice(market, bestIdx);
    if (refPrice !== null) {
      console.log(
        `  [decide] ${market.id}: ${hasValidPrice ? "untouched initial price" : "no order book"} — reference quote outcome=${bestIdx} price=${refPrice.toFixed(3)}`
      );
      marketProbs[bestIdx] = refPrice;
      bestEdge = blend.blendedProbs[bestIdx] - refPrice;
    }
  }

  const receiptBase: Omit<Receipt, "decision" | "outcomeIdx" | "edge" | "thresholdUsed" | "size" | "execution" | "skipReason"> = {
    ts: new Date().toISOString(),
    marketId: market.id,
    question,
    category,
    outcomes,
    // Once a reference quote replaces the 0.5 placeholder above,
    // marketProbs holds a real number at bestIdx — record it here too,
    // so positions.ts/settlement.ts's entryPriceFor() (which reads
    // rawPrice, not marketProbs) uses the same real price this trade
    // was actually sized and priced against, not a hardcoded 0.5.
    rawPrice: hasValidPrice ? rawProbs : bestIdx !== -1 && marketProbs[bestIdx] !== 0.5 ? marketProbs : null,
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

/**
 * Result of an execution attempt, distinct from the raw execution block
 * itself — lets the caller tell "genuinely filled" apart from "declined
 * without an on-chain call" (insufficient balance / slippage cap) apart
 * from "threw". Only the first case should ever be journaled as
 * decision: "trade" outside of dry-run.
 */
interface TradeAttemptResult {
  filled: boolean;
  execution: Receipt["execution"];
  declineReason?: string;
}

async function tradeOnMarket(market: Market, decision: TradeDecision, dryRun: boolean): Promise<TradeAttemptResult> {
  if (dryRun) {
    console.log(`[TRADE-EXEC] market=${market.id} dryRun=true result=SIMULATED outcome=${decision.outcomeIdx} tokens=${decision.tokensToSpend.toFixed(2)}`);
    return { filled: true, execution: null };
  }

  const tokenAddress = getCompetitionTokenAddress();
  if (!tokenAddress) throw new Error("COMPETITION_TOKEN_ADDRESS not set — refusing to trade live.");
  const walletAddress = await resolveWalletAddress(client);
  if (!walletAddress) throw new Error("Could not resolve trading wallet address.");

  const rawBalance = await getErc20Balance(tokenAddress, walletAddress);
  const decimals = CONFIG.competitionTokenDecimals ?? (await getErc20Decimals(tokenAddress));
  const maxTokensIn = BigInt(Math.floor(Math.min(decision.tokensToSpend, CONFIG.maxTokensPerTrade) * 10 ** decimals));

  if (maxTokensIn > rawBalance) {
    const reason = "insufficient_balance";
    console.log(`[TRADE-EXEC] market=${market.id} dryRun=false result=DECLINED reason=${reason}`);
    return { filled: false, execution: null, declineReason: "insufficient competition-token balance for desired spend" };
  }

  const entryPrice = Math.max(decision.entryPriceUsed, 0.01);
  const desiredShares = decision.tokensToSpend / entryPrice;
  const sharesOut = BigInt(Math.floor(desiredShares * 1e18));

  const quote = await withDelphiRetry(
    () =>
      client.quoteBuy({
        marketAddress: market.id as `0x${string}`,
        outcomeIdx: decision.outcomeIdx,
        sharesOut,
      }),
    { label: `quoteBuy(${market.id})` }
  );

  let finalSharesOut = sharesOut;
  let finalQuote = quote;

  if (quote.tokensIn > maxTokensIn) {
    // Real LMSR price impact on a meaningful-size buy — scale shares down
    // to fit the budget instead of declining outright, then requote once
    // to confirm the smaller size actually fits.
    const scale = Number(maxTokensIn) / Number(quote.tokensIn);
    const scaledShares = BigInt(Math.floor(Number(sharesOut) * scale * 0.98)); // small extra margin

    if (scaledShares <= 0n) {
      const reason = "quote_exceeds_max_spend";
      console.log(`[TRADE-EXEC] market=${market.id} dryRun=false result=DECLINED reason=${reason}`);
      return { filled: false, execution: null, declineReason: "quoted cost exceeds max spend even at minimal size" };
    }

    finalQuote = await withDelphiRetry(
      () =>
        client.quoteBuy({
          marketAddress: market.id as `0x${string}`,
          outcomeIdx: decision.outcomeIdx,
          sharesOut: scaledShares,
        }),
      { label: `quoteBuy(retry:${market.id})` }
    );

    if (finalQuote.tokensIn > maxTokensIn) {
      const reason = "quote_exceeds_max_spend";
      console.log(`[TRADE-EXEC] market=${market.id} dryRun=false result=DECLINED reason=${reason}`);
      return { filled: false, execution: null, declineReason: "quoted cost exceeds max spend after resize" };
    }

    finalSharesOut = scaledShares;
  }

// 1.5% slippage buffer above the quoted cost.
const SLIPPAGE_BPS = 150n;
let maxTokensInWithSlippage = finalQuote.tokensIn + (finalQuote.tokensIn * SLIPPAGE_BPS) / 10000n;
if (maxTokensInWithSlippage > maxTokensIn) maxTokensInWithSlippage = maxTokensIn;

await withDelphiRetry(
  () => client.ensureTokenApproval({ marketAddress: market.id as `0x${string}`, minimumAmount: maxTokensInWithSlippage }),
  { label: `ensureTokenApproval(${market.id})` }
);

const result = await withDelphiRetry(
  () =>
    client.buyShares({
      marketAddress: market.id as `0x${string}`,
      outcomeIdx: decision.outcomeIdx,
      sharesOut: finalSharesOut,
      maxTokensIn: maxTokensInWithSlippage,
    }),
  { label: `buyShares(${market.id})` }
);

console.log(
  `[TRADE-EXEC] market=${market.id} dryRun=false result=FILLED tx=${result.transactionHash} shares=${finalSharesOut} quotedTokensIn=${finalQuote.tokensIn} cap=${maxTokensInWithSlippage}`
);

const costPerShare = Number(finalQuote.tokensIn) / 10 ** decimals / (Number(finalSharesOut) / 1e18);
const priceImpactPct = entryPrice > 0 ? Number(((costPerShare - entryPrice) / entryPrice).toFixed(4)) : null;

return {
  filled: true,
  execution: {
    txHash: result.transactionHash,
    quotedTokensIn: Number(finalQuote.tokensIn),
    sharesOut: finalSharesOut.toString(),
    priceImpactPct,
  },
};
}

// Last completed cycle's counters, kept in memory so a "running: true"
// status write mid-cycle doesn't have to blank out the previous numbers
// the dashboard is already showing.
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
    // 0. Redeem any settled winning positions from prior loops first.
    try {
      const redemptions = await checkAndRedeemSettledPositions(client, dryRun);
      if (redemptions.length) console.log(`  Redemption check: ${JSON.stringify(redemptions)}`);
    } catch (err) {
      const msg = `redemption check failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
    }

    // 0.4 Record win/loss/void + P&L for every receipt whose market has settled.
    try {
      const settled = await checkSettledOutcomes(client);
      if (settled.settled) console.log(`  Settlement check: ${settled.settled}/${settled.checked} newly settled`);
    } catch (err) {
      const msg = `settlement check failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
    }

    // 0.5 Resolve this cycle's deployable capital ONCE.
    try {
      cycleBudget = await getCycleBudget(dryRun);
      remainingBudget = cycleBudget.total;
      console.log(`  Cycle budget: ${cycleBudget.total.toFixed(2)} tokens (${cycleBudget.source})`);
    } catch (err) {
      const msg = `budget resolution failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
      return;
    }

    const openStatus = "open" as any;
    try {
      const res = await withDelphiRetry(
        () => client.listMarkets({ status: openStatus, limit: CONFIG.maxMarketsPerLoop, pricesAndImpliedProbabilities: true }),
        { label: "listMarkets(open)" }
      );
      markets = res.markets ?? [];
    } catch (err) {
      const msg = `listMarkets failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
      return;
    }

    console.log(`Evaluating ${markets.length} market(s)`);

    // Per-market exposure so far this competition — not just a yes/no
    // "do we hold this market" flag. Lets a held market still take on
    // fresh capital up to CONFIG.maxExposurePerMarket instead of being
    // frozen out entirely once any position exists. Mutated below as
    // fills land, so a second candidate for the same market LATER IN
    // THIS SAME CYCLE also respects the running total, not just what's
    // already in the journal from prior cycles.
    const allReceiptsForHoldCheck = await readReceipts();
    const openExposureByMarket = new Map<string, number>();
    for (const r of allReceiptsForHoldCheck) {
      if (r.decision === "trade" && !r.execution?.resolved) {
        openExposureByMarket.set(r.marketId, (openExposureByMarket.get(r.marketId) ?? 0) + (r.size ?? 0));
      }
    }

    for (const market of markets) {
      const alreadyCommitted = openExposureByMarket.get(market.id) ?? 0;
      const roomLeft = CONFIG.maxExposurePerMarket - alreadyCommitted;
      // <1 token of room isn't worth a trade (gas/fees would eat it) —
      // treat it the same as being fully at cap. Guaranteed to leave
      // roomLeft >= 1 for every market that proceeds past this point, so
      // the clamp below never needs its own separate dust check.
      if (roomLeft < 1) {
        console.log(`  SKIP ${market.id}: at max exposure for this market (${alreadyCommitted.toFixed(2)}/${CONFIG.maxExposurePerMarket})`);
        skipped++;
        appendReceipt(skipReceipt(market, `already at max exposure for this market (${alreadyCommitted.toFixed(2)}/${CONFIG.maxExposurePerMarket} tokens)`));
        continue;
      }

      try {
        const { decision, receipt } = await decide(market, remainingBudget);
        if (!decision) {
          appendReceipt(receipt);
          skipped++;
          continue;
        }

        // decide() sizes against the CYCLE budget — it has no idea this
        // particular market already has capital in it. Clamp here so a
        // fresh signal on a held market never pushes total exposure past
        // the per-market cap. receipt.size is set independently inside
        // decide() (not a live reference to decision.tokensToSpend), so
        // it must be clamped too — forgetting this would silently record
        // a bigger size in the journal than what's actually committed,
        // which is exactly the drift that caused the SpaceX
        // journal/on-chain mismatch earlier.
        if (decision.tokensToSpend > roomLeft) {
          console.log(
            `  [loop] ${market.id}: clamping size ${decision.tokensToSpend.toFixed(2)} -> ${roomLeft.toFixed(2)} (per-market exposure cap)`
          );
          decision.tokensToSpend = roomLeft;
          receipt.size = roomLeft;
        }

        // Reserve the capital the moment it's decided, not after execution
        // fires — so the next market in this same loop sees the reduced
        // remainder. Holds even in dryRun: paper sizing should still
        // reflect realistic within-cycle capital constraints.
        remainingBudget -= decision.tokensToSpend;

        let attempt: TradeAttemptResult = { filled: false, execution: null };
        try {
          attempt = await tradeOnMarket(market, decision, dryRun);
        } catch (err) {
          const msg = `trade failed for ${market.id}: ${err instanceof Error ? err.message : err}`;
          console.error(" ", msg);
          errors.push(msg);
        }

        if (attempt.filled) {
          // Genuinely executed (or intentionally simulated in dry-run) —
          // this is a real trade.
          traded++;
          openExposureByMarket.set(market.id, alreadyCommitted + decision.tokensToSpend); // reflect this fill for the rest of THIS cycle too
          appendReceipt({ ...receipt, execution: attempt.execution });
        } else {
          // Live, but tradeOnMarket declined without an on-chain call
          // (insufficient balance / quote moved past cap) or threw.
          // Nothing actually happened — don't let it masquerade as a
          // trade in the counters or in positions.ts's DRY/LIVE badge
          // logic (which keys off `execution` being non-null).
          skipped++;
          const declineNote = attempt.declineReason ?? "trade attempt failed, see errors";
          console.warn(`  [loop] LIVE_NOOP ${market.id}: sizing decided a trade but execution never landed (${declineNote}) — recording as skip, not trade`);
          appendReceipt({
            ...receipt,
            decision: "skip",
            outcomeIdx: null,
            size: null,
            execution: null,
            skipReason: `live execution declined: ${declineNote}`,
          });
        }
      } catch (err) {
        const msg = `decide() failed for ${market.id}: ${err instanceof Error ? err.message : err}`;
        console.error(" ", msg);
        errors.push(msg);
      }
    }

    try {
      await recomputeSummary();
    } catch (err) {
      const msg = `recomputeSummary failed: ${err instanceof Error ? err.message : err}`;
      console.error(" ", msg);
      errors.push(msg);
    }

    if (CONFIG.autoCheckpointOnTrade && traded > 0) {
      try {
        const cp = await runCheckpointScript();
        if (cp.ok) {
          console.log(`  [checkpoint] ${cp.output || "pushed"}`);
        } else {
          console.warn("  [checkpoint] failed:", cp.output);
          errors.push(`checkpoint failed: ${cp.output}`);
        }
      } catch (err) {
        console.warn("  [checkpoint] threw:", err instanceof Error ? err.message : err);
      }
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
    nextRunAt: Date.now(),
  });

  await runOnce().catch((err) => console.error("Loop error:", err));
  setInterval(() => {
    runOnce().catch((err) => console.error("Loop error:", err));
  }, CONFIG.loopIntervalMs);
}

main();
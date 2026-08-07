/**
 * Lazy Falcon
 *
 * This is a skeleton trading loop. It fetches open markets, hands each one
 * to `decide()`, and executes whatever trade (if any) the strategy returns.
 * Replace `decide()` with any strategy — rules-based, quant model,
 * LLM-driven, whatever you want.
 *
 * Run with: npm start
 */
import "dotenv/config";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { MarketStatus } from "@gensyn-ai/gensyn-delphi-sdk";
import { findSimilarPolymarketOdds } from "./externalOdds.js";
import getLlmForecast from "./llmForecast.js";

const client = new DelphiClient();

// How often to run the trading loop.
const LOOP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Don't risk more than this many collateral tokens (human units) per trade.
const MAX_TOKENS_PER_TRADE = 10;

interface TradeDecision {
  outcomeIdx: number;
  /** Collateral tokens (human units, e.g. 5.0) to spend. */
  tokensToSpend: number;
}

/**
 * STRATEGY GOES HERE
 */
async function decide(market: Market): Promise<TradeDecision | null> {
  const question =
    (market as any).question ||
    (market as any).metadata?.question ||
    "";
  const outcomes: string[] =
    (market as any).outcomes ||
    (market as any).metadata?.outcomes ||
    ["Yes", "No"];

  // Already 0-1 floats  
  const rawProbs = market.spotImpliedProbabilities ?? [];

  // Treat missing / zero / near-zero books as even odds (new markets assumption)
  const hasValidPrice =
    rawProbs.length >= 2 &&
    rawProbs.every((p) => Number.isFinite(p) && p > 0.01 && p < 0.99);

  const marketProbs = hasValidPrice
    ? rawProbs
    : Array.from({ length: Math.max(outcomes.length, 2) }, () => 0.5);

  // 1. External signal (Polymarket or similar)
  let external: Awaited<ReturnType<typeof findSimilarPolymarketOdds>> = null;
  try {
    external = await findSimilarPolymarketOdds(question, outcomes);
  } catch (err) {
    console.log(
      `  Polymarket lookup failed for ${market.id}:`,
      err instanceof Error ? err.message : err
    );
  }

  // 2. LLM forecast
  const { probs: llmProbs, confidence } = await getLlmForecast(question, outcomes);

  // 3. Blend when we have a strong external match
  let myProbs = [...llmProbs];
  if (external && external.similarity > 0.65) {
    const w = Math.min(0.6, external.similarity);
    myProbs = myProbs.map((p, i) => (1 - w) * p + w * (external.probs[i] ?? p));
  }

  // Ensure length matches
  while (myProbs.length < marketProbs.length) myProbs.push(0.5);
  myProbs = myProbs.slice(0, marketProbs.length);

  // 4. Edge check against real price or synthetic 0.5
  let bestIdx = -1;
  let bestEdge = 0;
  for (let i = 0; i < myProbs.length; i++) {
    const edge = myProbs[i] - (marketProbs[i] ?? 0.5);
    if (edge > bestEdge) {
      bestEdge = edge;
      bestIdx = i;
    }
  }

  // Stricter threshold when price is synthetic (empty book)
  const minEdge = hasValidPrice
    ? confidence > 0.7
      ? 0.08
      : 0.12
    : confidence > 0.65
      ? 0.15
      : 0.20;

  if (bestIdx === -1 || bestEdge < minEdge) {
    console.log(
      `  SKIP ${market.id}: bestEdge=${bestEdge.toFixed(3)} < minEdge=${minEdge.toFixed(2)} ` +
        `(validPrice=${hasValidPrice}, conf=${confidence.toFixed(2)})`
    );
    return null;
  }

  // Slightly smaller size when we are guessing against synthetic 0.5
  const sizeMultiplier = hasValidPrice ? 1.0 : 0.7;
  const tokensToSpend = Math.min(
    MAX_TOKENS_PER_TRADE,
    (2 + bestEdge * 15 * confidence) * sizeMultiplier
  );

  console.log(
    `  BUY signal ${market.id}: outcome=${bestIdx} edge=${bestEdge.toFixed(3)} ` +
      `size≈${tokensToSpend.toFixed(2)} validPrice=${hasValidPrice}`
  );

  return {
    outcomeIdx: bestIdx,
    tokensToSpend,
  };
}

async function tradeOnMarket(market: Market, decision: TradeDecision) {
  const { balance, decimals } = await client.getErc20BalanceWithDecimals();
  const maxTokensIn = BigInt(
    Math.floor(Math.min(decision.tokensToSpend, MAX_TOKENS_PER_TRADE) * 10 ** decimals)
  );

  if (maxTokensIn > balance) {
    console.log(`  Skipping ${market.id}: insufficient balance for desired spend.`);
    return;
  }

  // Quote first — you need a target share amount, so estimate via quoteBuy
  // in reverse isn't directly supported; a simple approach is to quote a
  // trial share amount and scale, or iterate. Keeping this simple/explicit
  // so you can swap in your own sizing logic.
  const trialShares = maxTokensIn; // 1:1 starting guess in wei units, refine as needed
  const quote = await client.quoteBuy({
    marketAddress: market.id as `0x${string}`,
    outcomeIdx: decision.outcomeIdx,
    sharesOut: trialShares,
  });

  console.log(
    `  Quote: ${trialShares} shares of outcome ${decision.outcomeIdx} costs ${quote.tokensIn} tokens`
  );

  if (quote.tokensIn > maxTokensIn) {
    console.log("  Skipping: quoted cost exceeds max spend.");
    return;
  }

  await client.ensureTokenApproval({
    marketAddress: market.id as `0x${string}`,
    minimumAmount: quote.tokensIn,
  });

  const result = await client.buyShares({
    marketAddress: market.id as `0x${string}`,
    outcomeIdx: decision.outcomeIdx,
    sharesOut: trialShares,
    maxTokensIn: quote.tokensIn,
  });

  console.log(`  Trade executed: ${result.transactionHash}`);
}

async function runOnce() {
  console.log(`\n[${new Date().toISOString()}] Fetching open markets...`);

  const openStatus: MarketStatus = "open";
  const { markets } = await client.listMarkets({
    status: openStatus,
    limit: 50,
    pricesAndImpliedProbabilities: true,
  });

  if (!markets || markets.length === 0) {
    console.log("No open markets found.");
    return;
  }

  console.log(`Evaluating ${markets.length} market(s)`);

  for (const market of markets) {
    const decision = await decide(market);
    if (!decision) continue;

    console.log(`Decision for ${market.id}: buy outcome ${decision.outcomeIdx}`);
    try {
      await tradeOnMarket(market, decision);
    } catch (err) {
      console.error(`  Trade failed for ${market.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function main() {
  console.log("Starting Lazy Falcon");
  console.log(`Loop interval: ${LOOP_INTERVAL_MS / 1000}s\n`);

  // Run immediately, then on an interval.
  await runOnce().catch((err) => console.error("Loop error:", err));
  setInterval(() => {
    runOnce().catch((err) => console.error("Loop error:", err));
  }, LOOP_INTERVAL_MS);
}

main();

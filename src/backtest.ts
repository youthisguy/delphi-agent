import "dotenv/config";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { findSimilarPolymarketOdds } from "./externalOdds.js";
import getLlmForecast from "./llmForecast.js";

const client = new DelphiClient();
const MAX_MARKETS = 100;
const MAX_TOKENS_PER_TRADE = 10;

interface BacktestRow {
  id: string;
  question: string;
  llmProbs: number[];
  confidence: number;
  bestIdx: number;
  bestEdge: number;
  hasValidPrice: boolean;
  signaled: boolean;
  winningOutcomeIdx: number | null;
  correct: boolean | null; // null = no signal (didn't trade), so no verdict
  tokensToSpend: number;
  entryPriceUsed: number; // implied price for the picked outcome at decision time (see caveat)
}

async function evaluateForBacktest(market: Market): Promise<BacktestRow | null> {
  const question = market.metadata?.question ?? "";
  const outcomes: string[] = market.metadata?.outcomes ?? ["Yes", "No"];

  if (market.winningOutcomeIdx === null) {
    // Failed markets have no winner — can't score these, skip.
    return null;
  }
  const winningOutcomeIdx = Number(market.winningOutcomeIdx);

  const rawProbs = market.spotImpliedProbabilities ?? [];
  const hasValidPrice =
    rawProbs.length >= 2 &&
    rawProbs.every((p) => Number.isFinite(p) && p > 0.01 && p < 0.99);
  const marketProbs = hasValidPrice
    ? rawProbs
    : Array.from({ length: Math.max(outcomes.length, 2) }, () => 0.5);

  let external: Awaited<ReturnType<typeof findSimilarPolymarketOdds>> = null;
  try {
    external = await findSimilarPolymarketOdds(question, outcomes);
  } catch {
    // ignore — treated same as no match
  }

  const { probs: llmProbs, confidence } = await getLlmForecast(question, outcomes);

  let myProbs = [...llmProbs];
  if (external && external.similarity > 0.65) {
    const w = Math.min(0.6, external.similarity);
    myProbs = myProbs.map((p, i) => (1 - w) * p + w * (external!.probs[i] ?? p));
  }
  while (myProbs.length < marketProbs.length) myProbs.push(0.5);
  myProbs = myProbs.slice(0, marketProbs.length);

  let bestIdx = -1;
  let bestEdge = 0;
  for (let i = 0; i < myProbs.length; i++) {
    const edge = myProbs[i] - (marketProbs[i] ?? 0.5);
    if (edge > bestEdge) {
      bestEdge = edge;
      bestIdx = i;
    }
  }

  const minEdge = hasValidPrice
    ? confidence > 0.7
      ? 0.08
      : 0.12
    : confidence > 0.65
      ? 0.15
      : 0.2;

  const signaled = bestIdx !== -1 && bestEdge >= minEdge;
  const sizeMultiplier = hasValidPrice ? 1.0 : 0.7;
  const tokensToSpend = signaled
    ? Math.min(MAX_TOKENS_PER_TRADE, (2 + bestEdge * 15 * confidence) * sizeMultiplier)
    : 0;

  return {
    id: market.id,
    question,
    llmProbs,
    confidence,
    bestIdx,
    bestEdge,
    hasValidPrice,
    signaled,
    winningOutcomeIdx,
    correct: signaled ? bestIdx === winningOutcomeIdx : null,
    tokensToSpend,
    entryPriceUsed: bestIdx >= 0 ? (marketProbs[bestIdx] ?? 0.5) : 0.5,
  };
}

async function main() {
  console.log("Lazy Falcon — backtest against settled markets\n");

  const { markets } = await client.listMarkets({
    status: "settled",
    limit: MAX_MARKETS,
    pricesAndImpliedProbabilities: true,
  });

  if (!markets?.length) {
    console.log("No settled markets returned.");
    return;
  }

  console.log(`Fetched ${markets.length} settled market(s). Evaluating…\n`);

  const rows: BacktestRow[] = [];
  for (const m of markets) {
    const row = await evaluateForBacktest(m);
    if (!row) continue;
    rows.push(row);

    const verdict =
      row.correct === null ? "NO SIGNAL" : row.correct ? "✓ CORRECT" : "✗ WRONG";
    console.log(
      `${verdict.padEnd(10)} edge=${row.bestEdge.toFixed(3)} conf=${row.confidence.toFixed(2)} ` +
        `picked=${row.bestIdx} won=${row.winningOutcomeIdx} | ${row.question.slice(0, 70)}`
    );
  }

  const signaled = rows.filter((r) => r.signaled);
  const correct = signaled.filter((r) => r.correct);
  const hitRate = signaled.length > 0 ? correct.length / signaled.length : 0;

  // Illustrative P&L only — see caveat below. Assumes you buy at
  // `entryPriceUsed` (the market/synthetic price seen right now, fetched
  // AFTER settlement) and, if correct, redeem 1 token per share purchased.
  let hypotheticalPnl = 0;
  for (const r of signaled) {
    const shares = r.tokensToSpend / Math.max(r.entryPriceUsed, 0.01);
    const payout = r.correct ? shares * 1 : 0;
    hypotheticalPnl += payout - r.tokensToSpend;
  }

  console.log("\n──────── Summary ────────");
  console.log(`Settled markets evaluated: ${rows.length}`);
  console.log(`Signals generated:         ${signaled.length}`);
  console.log(`Correct calls:             ${correct.length}`);
  console.log(`Hit rate:                  ${(hitRate * 100).toFixed(1)}%`);
  console.log(`Illustrative P&L:          ${hypotheticalPnl.toFixed(2)} tokens (see caveat)`);
  console.log(
    "\nCaveat: P&L above uses the price fetched right now (after these markets\n" +
      "already settled), not the real price you'd have gotten when the market\n" +
      "was actually open and tradeable. The API has no historical-price endpoint,\n" +
      "so this number is illustrative at best — treat the hit rate as the real signal."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

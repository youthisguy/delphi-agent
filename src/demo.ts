/**
 * Dry-run demo: fetch live open markets, run the decision pipeline,
 * log full details + edge. Never places a trade.
 *
 * Run: npx tsx src/demo.ts
 */
import "dotenv/config";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { findSimilarPolymarketOdds } from "./externalOdds.js";
import getLlmForecast from "./llmForecast.js";

const client = new DelphiClient();
const MAX_MARKETS = 50; 


function logMarketHeader(m: Market, i: number) {
  const q =
    (m as any).question ||
    (m as any).metadata?.question ||
    "(no question field)";
  const outcomes =
    (m as any).outcomes ||
    (m as any).metadata?.outcomes ||
    ["?"];
  const probs = (m.spotImpliedProbabilities ?? []).map(
    (p: any) => (Number(p) / 1e18).toFixed(3)
  );
  console.log(`\n──────── Market ${i + 1} ────────`);
  console.log(`id:       ${m.id}`);
  console.log(`category: ${(m as any).category ?? "?"}`);
  console.log(`status:   ${m.status}`);
  console.log(`question: ${q}`);
  console.log(`outcomes: ${JSON.stringify(outcomes)}`);
  console.log(`implied:  [${probs.join(", ")}]`);
}



async function evaluate(market: Market) {
  const question =
    (market as any).question ||
    (market as any).metadata?.question ||
    "";
  const outcomes: string[] =
    (market as any).outcomes ||
    (market as any).metadata?.outcomes ||
    ["Yes", "No"];

  // Raw implied probabilities from the API (1e18 → [0,1])
  const rawProbs = (market.spotImpliedProbabilities ?? []).map(
    (p) => Number(p) / 1e18
  );

  // Treat missing / zero / near-zero books as even odds (new markets assumption)
  const hasValidPrice =
    rawProbs.length >= 2 &&
    rawProbs.every((p) => Number.isFinite(p) && p > 0.01 && p < 0.99);

  const marketProbs = hasValidPrice
    ? rawProbs
    : Array.from({ length: Math.max(outcomes.length, 2) }, () => 0.5);

  // 1. External signal
  let external = null;
  try {
    external = await findSimilarPolymarketOdds(question, outcomes);
  } catch (err) {
    console.log(
      `    Polymarket lookup failed:`,
      err instanceof Error ? err.message : err
    );
  }

  if (external) {
    console.log(
      `    Polymarket match (sim=${external.similarity.toFixed(2)}): "${external.question.slice(0, 60)}..."`
    );
    console.log(
      `    external probs: [${external.probs.map((p) => p.toFixed(3)).join(", ")}]`
    );
  } else {
    console.log(`    No good Polymarket match`);
  }

  // 2. LLM forecast
  const { probs: llmProbs, confidence } = await getLlmForecast(
    question,
    outcomes
  );
  console.log(
    `    LLM probs: [${llmProbs.map((p) => p.toFixed(3)).join(", ")}] conf=${confidence.toFixed(2)}`
  );

  // 3. Blend when we have a strong external match
  let myProbs = [...llmProbs];
  if (external && external.similarity > 0.65) {
    const w = Math.min(0.6, external.similarity);
    myProbs = myProbs.map(
      (p, i) => (1 - w) * p + w * (external.probs[i] ?? p)
    );
    console.log(
      `    blended: [${myProbs.map((p) => p.toFixed(3)).join(", ")}] (w=${w.toFixed(2)})`
    );
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
      `    → SKIP (bestEdge=${bestEdge.toFixed(3)} < minEdge=${minEdge.toFixed(2)}, ` +
        `validPrice=${hasValidPrice}, conf=${confidence.toFixed(2)})`
    );
    return;
  }

  // Slightly smaller size when guessing against synthetic 0.5
  const sizeMultiplier = hasValidPrice ? 1.0 : 0.7;
  const tokens = Math.min(
    10,
    (2 + bestEdge * 15 * confidence) * sizeMultiplier
  );

  console.log(
    `    → WOULD BUY outcome ${bestIdx}  edge=${bestEdge.toFixed(3)}  ` +
      `size≈${tokens.toFixed(2)} TST  validPrice=${hasValidPrice}`
  );
}

async function main() {
  console.log("Lazy Falcon — live dry-run demo\n");

  const { markets } = await client.listMarkets({
    status: "open",
    limit: MAX_MARKETS,
    pricesAndImpliedProbabilities: true,
  });

  if (!markets?.length) {
    console.log("No open markets returned.");
    return;
  }

  console.log(`Fetched ${markets.length} open market(s). Evaluating…`);

  for (let i = 0; i < markets.length; i++) {
    logMarketHeader(markets[i], i);
    await evaluate(markets[i]);
  }

  console.log("\nDemo complete — no trades were sent.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
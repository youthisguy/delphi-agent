import fs from "node:fs";

const rows = fs.readFileSync("data/journal.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const byId = new Map<string, any>();
for (const r of rows) {
  const cur = byId.get(r.marketId);
  if (!cur) byId.set(r.marketId, { first: r, settle: r.settlement ?? null, probs: [] });
  else if (r.settlement && !cur.settle) cur.settle = r.settlement;
  if (r.blendedProbs?.length) byId.get(r.marketId).probs.push(r.blendedProbs);
}

const out = [...byId.values()]
  .filter((m) => m.settle && !m.settle.void && m.settle.winningOutcomeIdx != null)
  .map((m) => ({
    id: m.first.marketId,
    question: m.first.question,
    outcomes: m.first.outcomes,
    category: m.first.category,
    resolvesAt: m.settle.settledAt,
    asOf: m.first.ts,
    winnerIdx: m.settle.winningOutcomeIdx,
    oldBotProbs: m.probs.at(-1) ?? null,   // proxy for "what the forecaster already thinks"
    sourceUrls: [],                         // fill from Delphi dataSources if you have them
  }));

fs.writeFileSync("data/backtest-markets.json", JSON.stringify(out, null, 2));
console.log(`wrote ${out.length} markets`);
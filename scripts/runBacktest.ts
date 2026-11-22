import fs from "node:fs";
import { processMarket } from "../src/evidence/loop.js";
import { DryRunSubmitter } from "../src/evidence/submit.js";
import { readAttempts } from "../src/evidence/evidenceJournal.js";
import type { EvidenceMarket, EvidenceAttempt } from "../src/evidence/types.js";

type M = EvidenceMarket & { winnerIdx: number; oldBotProbs: number[] | null };
let markets: M[] = JSON.parse(fs.readFileSync("data/backtest-markets.json", "utf8"));
if (process.env.ONLY) markets = markets.filter((m) => m.id.startsWith(process.env.ONLY!));
if (process.env.LIMIT) markets = markets.slice(0, Number(process.env.LIMIT));

const submitter = new DryRunSubmitter();
const rows: any[] = [];

for (const m of markets) {
  const t0 = new Date().toISOString();
  const outcome = await processMarket(m, submitter, true);

  const all = (await Promise.resolve(readAttempts())) as EvidenceAttempt[];
  const a = all.filter((x) => x.marketId === m.id && x.startedAt >= t0).at(-1) ?? null;

  const cut = Date.parse(m.asOf!);
  const claims = a?.extractedClaims ?? [];
  const srcLeaks = (a?.sourcesFetched ?? []).filter((s) => s.ok && (!s.publishedAt || Date.parse(s.publishedAt) > cut)).length;
  const claimLeaks = claims.filter((c) => c.eventDate && Date.parse(c.eventDate) > cut).length;
  const accepted = outcome === "submitted";
  const polarity = a?.polarity ?? null;
  const oldFav = m.oldBotProbs ? (m.oldBotProbs[0] >= m.oldBotProbs[1] ? 0 : 1) : null;

  rows.push({
    id: m.id.slice(0, 10), q: m.question.slice(0, 50), cat: m.category ?? "-", winner: m.winnerIdx,
    outcome,
    sourcesTried: a?.sourcesFetched.length ?? 0,
    sourcesOk: a?.sourcesFetched.filter((s) => s.ok).length ?? 0,
    claims: claims.length, accepted, polarity,
    correct: accepted && polarity !== null ? polarity === m.winnerIdx : null,
    oldBotWrong: oldFav !== null ? oldFav !== m.winnerIdx : null,
    leaks: srcLeaks + claimLeaks,
    reject: a?.rejectReason ?? a?.rejectedCandidates?.[0]?.reasons?.[0] ?? a?.error ?? "",
  });
  console.log(rows.at(-1));
}

const acc = rows.filter((r) => r.accepted);
const dir = acc.filter((r) => r.correct !== null);
const hit = dir.filter((r) => r.correct).length;
const wrongOld = rows.filter((r) => r.oldBotWrong);
console.table({
  markets: rows.length,
  acceptRate: `${acc.length}/${rows.length}`,
  directionAccuracy: dir.length ? `${hit}/${dir.length} (${((hit / dir.length) * 100).toFixed(0)}%)` : "n/a",
  baselineAlwaysNo: `${markets.filter((m) => m.winnerIdx === 1).length}/${markets.length}`,
  oldBotWrong: wrongOld.length,
  oldBotWrong_correctedByEvidence: wrongOld.filter((r) => r.accepted && r.correct).length,
  leakCount: rows.reduce((s, r) => s + r.leaks, 0),
});
fs.writeFileSync("data/backtest-results.json", JSON.stringify(rows, null, 2));

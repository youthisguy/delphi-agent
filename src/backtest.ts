import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { findSimilarPolymarketOdds } from "./externalOdds.js";
import getLlmForecast from "./llmForecast.js";
import { getGeminiForecast } from "./geminiForecast.js";
import { blendSignals, isTimeSensitive, type Signal } from "./blend.js";
import { recomputeSummary } from "./journal.js";
import { CONFIG } from "./config.js";

const MAX_TOKENS_PER_TRADE = CONFIG.maxTokensPerTrade;

export interface BacktestRow {
  id: string;
  question: string;
  category?: string;
  llmProbs: number[];
  confidence: number;
  disagreement: number | null;
  bestIdx: number;
  bestEdge: number;
  hasValidPrice: boolean;
  signaled: boolean;
  winningOutcomeIdx: number | null;
  correct: boolean | null;
  tokensToSpend: number;
  entryPriceUsed: number;
}

export interface BacktestOptions {
  maxMarkets?: number;
  useGemini?: boolean;
}

export interface BacktestResult {
  runAt: string;
  marketsEvaluated: number;
  marketsFetched: number;
  skippedNoWinner: number;
  signaled: number;
  correct: number;
  hitRate: number;
  hypotheticalPnl: number;
  breakdowns: {
    byCategory: Record<string, { n: number; correct: number; hitRate: number }>;
    byConfidenceBucket: Record<string, { n: number; correct: number; hitRate: number }>;
    bySyntheticPrice: {
      synthetic: { n: number; hitRate: number };
      real: { n: number; hitRate: number };
    };
  };
  logPath: string;
}

/** Normalize API probs: competition sometimes returns 0–1 floats, sometimes 1e18 fixed-point. */
function normalizeProbs(raw: unknown[]): number[] {
  const nums = (raw ?? []).map((p) => Number(p));
  if (nums.length === 0) return [];
  // Heuristic: if any value is clearly fixed-point, scale all down
  if (nums.some((p) => Number.isFinite(p) && p > 1.5)) {
    return nums.map((p) => (Number.isFinite(p) ? p / 1e18 : 0));
  }
  return nums.map((p) => (Number.isFinite(p) ? p : 0));
}

export function extractWinningIdx(market: Market): number | null {
  const m = market as any;
  const candidates = [
    m.winningOutcomeIdx,
    m.winning_outcome_idx,
    m.winner,
    m.metadata?.winningOutcomeIdx,
    m.metadata?.winning_outcome_idx,
  ];
  for (const c of candidates) {
    if (c === null || c === undefined || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

async function evaluateForBacktest(
  _client: DelphiClient,
  market: Market,
  useGemini: boolean
): Promise<BacktestRow | null> {
  const question =
    (market as any).metadata?.question ?? (market as any).question ?? "";
  const outcomes: string[] =
    (market as any).metadata?.outcomes ??
    (market as any).outcomes ?? ["Yes", "No"];
  const category = (market as any).category;

  const winningOutcomeIdx = extractWinningIdx(market);
  if (winningOutcomeIdx === null) {
    return null; // failed/void or API didn't attach winner — can't score
  }

  const rawProbs = normalizeProbs(market.spotImpliedProbabilities ?? []);
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
    /* treat as no match */
  }

  const { probs: llmProbs, confidence } = await getLlmForecast(question, outcomes);

  const signals: Signal[] = [{ name: "llm", probs: llmProbs, weight: 1.0 }];
  if (external && external.similarity > 0.65) {
    signals.push({
      name: "polymarket",
      probs: external.probs,
      weight: Math.min(0.6, external.similarity),
    });
  }
  // Gemini — blended for every market when useGemini is on, matching
  // index.ts's live behavior (previously gated to only isTimeSensitive()
  // questions, which made backtest hit-rate not representative of what
  // the live loop actually does). Grounding (Google Search) stays
  // limited to time-sensitive questions since that's specifically where
  // a stale training cutoff hurts — no reason to pay the extra
  // grounding latency/cost on a static question.
  if (useGemini) {
    const grounded = isTimeSensitive(question);
    const gem = await getGeminiForecast(question, outcomes, { grounded });
    if (gem) {
      signals.push({ name: "gemini", probs: gem.probs, weight: gem.confidence });
    }
  }

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

  const signaled = !blend.skip && bestIdx !== -1 && bestEdge >= minEdge;
  const sizeMultiplier = hasValidPrice ? 1.0 : 0.7;
  const tokensToSpend = signaled
    ? Math.min(
        MAX_TOKENS_PER_TRADE,
        (2 + bestEdge * 15 * confidence) * sizeMultiplier
      )
    : 0;

  return {
    id: market.id,
    question,
    category,
    llmProbs,
    confidence,
    disagreement: blend.disagreement,
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

function bucketFor(conf: number): string {
  if (conf < 0.4) return "low(<0.4)";
  if (conf < 0.6) return "mid(0.4-0.6)";
  if (conf < 0.8) return "high(0.6-0.8)";
  return "veryhigh(0.8+)";
}

/**
 * Callable entry point — CLI (`npx tsx src/backtest.ts`) and
 * HTTP (`POST /api/backtest/run`). Gemini defaults ON, matching live.
 */
export async function runBacktest(
  opts: BacktestOptions = {}
): Promise<BacktestResult> {
  const client = new DelphiClient();
  const maxMarkets = opts.maxMarkets ?? 10;
  // Defaults to true — matches index.ts's live behavior (Gemini blended
  // for every market). Pass useGemini: false for a cheaper/faster run.
  const useGemini = opts.useGemini ?? true;

  console.log(
    `[backtest] fetching up to ${maxMarkets} settled markets (useGemini=${useGemini})…`
  );

  let markets: Market[] = [];
  try {
    const res = await client.listMarkets({
      status: "settled" as any,
      limit: maxMarkets,
      pricesAndImpliedProbabilities: true,
    });
    markets = res.markets ?? [];
  } catch (err) {
    console.error(
      "[backtest] listMarkets(settled) failed:",
      err instanceof Error ? err.message : err
    );
    throw err;
  }

  console.log(`[backtest] fetched ${markets.length} market(s)`);
  if (markets.length === 0) {
    console.warn(
      "[backtest] no settled markets returned — check DELPHI_NETWORK / competition id / API key"
    );
  }

  // Peek first market shape once (helps debug missing winningOutcomeIdx)
  if (markets[0]) {
    const m0 = markets[0] as any;
    console.log("[backtest] sample market keys:", Object.keys(m0).slice(0, 25).join(", "));
    console.log("[backtest] sample winning fields:", {
      winningOutcomeIdx: m0.winningOutcomeIdx,
      winner: m0.winner,
      status: m0.status,
      spotImpliedProbabilities: m0.spotImpliedProbabilities,
    });
  }

  const rows: BacktestRow[] = [];
  let skippedNoWinner = 0;

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const q =
      (m as any).metadata?.question ?? (m as any).question ?? m.id;
    process.stdout.write(
      `[backtest] ${i + 1}/${markets.length} ${String(q).slice(0, 60)}… `
    );
    try {
      const row = await evaluateForBacktest(client, m, useGemini);
      if (row) {
        rows.push(row);
        console.log(
          row.signaled
            ? `SIGNAL outcome=${row.bestIdx} edge=${row.bestEdge.toFixed(3)} correct=${row.correct}`
            : `no signal (edge=${row.bestEdge.toFixed(3)})`
        );
      } else {
        skippedNoWinner++;
        console.log("skip (no winningOutcomeIdx)");
      }
    } catch (err) {
      console.log("ERROR", err instanceof Error ? err.message : err);
    }
  }

  const signaled = rows.filter((r) => r.signaled);
  const correct = signaled.filter((r) => r.correct);
  const hitRate = signaled.length > 0 ? correct.length / signaled.length : 0;

  let hypotheticalPnl = 0;
  for (const r of signaled) {
    const shares = r.tokensToSpend / Math.max(r.entryPriceUsed, 0.01);
    const payout = r.correct ? shares * 1 : 0;
    hypotheticalPnl += payout - r.tokensToSpend;
  }

  const byCategory: BacktestResult["breakdowns"]["byCategory"] = {};
  const byConfidenceBucket: BacktestResult["breakdowns"]["byConfidenceBucket"] =
    {};
  let syntheticN = 0,
    syntheticCorrect = 0,
    realN = 0,
    realCorrect = 0;

  for (const r of signaled) {
    const cat = r.category ?? "uncategorized";
    byCategory[cat] ??= { n: 0, correct: 0, hitRate: 0 };
    byCategory[cat].n += 1;
    if (r.correct) byCategory[cat].correct += 1;

    const bucket = bucketFor(r.confidence);
    byConfidenceBucket[bucket] ??= { n: 0, correct: 0, hitRate: 0 };
    byConfidenceBucket[bucket].n += 1;
    if (r.correct) byConfidenceBucket[bucket].correct += 1;

    if (r.hasValidPrice) {
      realN += 1;
      if (r.correct) realCorrect += 1;
    } else {
      syntheticN += 1;
      if (r.correct) syntheticCorrect += 1;
    }
  }
  for (const v of Object.values(byCategory))
    v.hitRate = v.n ? v.correct / v.n : 0;
  for (const v of Object.values(byConfidenceBucket))
    v.hitRate = v.n ? v.correct / v.n : 0;

  if (!fs.existsSync(CONFIG.backtestLogDir)) {
    fs.mkdirSync(CONFIG.backtestLogDir, { recursive: true });
  }

  const runAt = new Date().toISOString();
  const logPath = path.join(
    CONFIG.backtestLogDir,
    `${runAt.replace(/[:.]/g, "-")}.json`
  );

  const result: BacktestResult = {
    runAt,
    marketsEvaluated: rows.length,
    marketsFetched: markets.length,
    skippedNoWinner,
    signaled: signaled.length,
    correct: correct.length,
    hitRate,
    hypotheticalPnl,
    breakdowns: {
      byCategory,
      byConfidenceBucket,
      bySyntheticPrice: {
        synthetic: {
          n: syntheticN,
          hitRate: syntheticN ? syntheticCorrect / syntheticN : 0,
        },
        real: { n: realN, hitRate: realN ? realCorrect / realN : 0 },
      },
    },
    logPath,
  };

  fs.writeFileSync(logPath, JSON.stringify({ result, rows }, null, 2));
  await recomputeSummary({ winRate: hitRate, n: signaled.length });

  return result;
}

export function listBacktestRuns(
  limit = 20
): { file: string; runAt: string }[] {
  if (!fs.existsSync(CONFIG.backtestLogDir)) return [];
  return fs
    .readdirSync(CONFIG.backtestLogDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => ({ file: f, runAt: f.replace(/\.json$/, "") }));
}

export function readBacktestRun(file: string): any | null {
  // Prevent path traversal; resolve both sides the same way
  const base = path.resolve(CONFIG.backtestLogDir);
  const p = path.resolve(base, path.basename(file)); // basename strips any ../
  if (!p.startsWith(base + path.sep) && p !== base) return null;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Robust "is this file the process entrypoint?" check for node + tsx. */
function isCliMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const resolved = path.resolve(argv1);
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    return false;
  }
}

// Also match when argv path ends with backtest.ts (tsx sometimes differs)
function isBacktestCli(): boolean {
  if (isCliMain()) return true;
  const argv1 = process.argv[1] ?? "";
  return /backtest\.(ts|js|mts|cjs)$/.test(argv1);
}

if (isBacktestCli()) {
  runBacktest({ maxMarkets: Number(process.env.BACKTEST_MAX ?? 10), useGemini: true })
    .then((r) => {
      console.log("\n──────── Backtest Summary ────────");
      console.log(`Markets fetched:   ${r.marketsFetched}`);
      console.log(`Scored (had winner): ${r.marketsEvaluated}`);
      console.log(`Skipped no winner: ${r.skippedNoWinner}`);
      console.log(`Signals generated: ${r.signaled}`);
      console.log(`Correct calls:     ${r.correct}`);
      console.log(`Hit rate:          ${(r.hitRate * 100).toFixed(1)}%`);
      console.log(`Illustrative P&L:  ${r.hypotheticalPnl.toFixed(2)} tokens`);
      console.log(`Log written to:    ${r.logPath}`);
    })
    .catch((err) => {
      console.error("\n[backtest] failed:");
      console.error(err);
      process.exit(1);
    });
}
import fs from "node:fs";
import readline from "node:readline";
import { CONFIG } from "./config.js";

/**
 * One receipt per market evaluated, trade or skip. Append-only JSONL —
 * never rewritten in place, so it stays a trustworthy audit trail even if
 * the summary/backtest code has bugs later.
 */
export interface Receipt {
  ts: string; // ISO timestamp
  marketId: string;
  question: string;
  category?: string;
  outcomes: string[];

  rawPrice: number[] | null; // null if book was empty
  syntheticPrice: boolean; // true if we fell back to 0.5/0.5

  signals: {
    llm: { probs: number[]; confidence: number } | null;
    gemini: { probs: number[]; confidence: number; grounded: boolean } | null;
    polymarket: { probs: number[]; similarity: number; url?: string } | null;
  };

  disagreement: number | null; // max pairwise spread across available signals on the leading outcome
  blendedProbs: number[];
  confidence: number;

  decision: "trade" | "skip";
  outcomeIdx: number | null;
  edge: number;
  thresholdUsed: number;
  size: number | null; // tokens

  execution: {
    txHash?: string;
    quotedTokensIn?: number;
    sharesOut?: string;
    redeemedTxHash?: string;
    redeemedAmount?: string;
    resolved?: boolean; 
    won?: boolean;  
  } | null;

  skipReason?: string;
}

export function appendReceipt(r: Receipt) {
  fs.appendFileSync(CONFIG.journalPath, JSON.stringify(r) + "\n");
}

/** Patch an existing receipt (used when a winning position is later redeemed). */
export function patchReceiptExecution(
  marketId: string,
  patch: Partial<NonNullable<Receipt["execution"]>>
) {
  if (!fs.existsSync(CONFIG.journalPath)) return;
  const lines = fs.readFileSync(CONFIG.journalPath, "utf8").split("\n").filter(Boolean);
  let changed = false;
  const out = lines.map((line) => {
    const r: Receipt = JSON.parse(line);
    if (r.marketId === marketId && r.decision === "trade") {
      r.execution = { ...(r.execution ?? {}), ...patch };
      changed = true;
    }
    return JSON.stringify(r);
  });
  if (changed) fs.writeFileSync(CONFIG.journalPath, out.join("\n") + "\n");
}

export async function readReceipts(limit?: number): Promise<Receipt[]> {
  if (!fs.existsSync(CONFIG.journalPath)) return [];
  const rl = readline.createInterface({
    input: fs.createReadStream(CONFIG.journalPath),
    crlfDelay: Infinity,
  });
  const out: Receipt[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line rather than crash the whole read */
    }
  }
  if (limit) return out.slice(-limit).reverse();
  return out.reverse();
}

export interface Summary {
  updatedAt: string;
  totalReceipts: number;
  totalTrades: number;
  totalSkips: number;
  rollingAccuracy: { n: number; hitRate: number | null }; // settled trades only
  calibrationByConfidenceBucket: Record<string, { n: number; hitRate: number | null }>;
  perCategory: Record<string, { n: number; hitRate: number | null; trades: number }>;
  openExposureTokens: number;
  lastNDecisions: Receipt[];
}

const CONF_BUCKETS: [number, number, string][] = [
  [0, 0.4, "low(<0.4)"],
  [0.4, 0.6, "mid(0.4-0.6)"],
  [0.6, 0.8, "high(0.6-0.8)"],
  [0.8, 1.01, "veryhigh(0.8+)"],
];

function bucketFor(conf: number): string {
  for (const [lo, hi, label] of CONF_BUCKETS) {
    if (conf >= lo && conf < hi) return label;
  }
  return "unknown";
}

/**
 * Recompute the pinned summary from the full journal. Settled outcomes are
 * pulled in by cross-referencing execution.redeemedTxHash presence (a
 * trade only gets redeemed once the market has settled AND we won) plus
 * receipts whose skipReason indicates the market later settled losing.
 * For a more precise picture, the backtest job (which matches receipts
 * against actual resolved markets) periodically overwrites the accuracy
 * fields with ground truth — see backtest.ts.
 */
export async function recomputeSummary(
  groundTruth?: { winRate: number; n: number }
): Promise<Summary> {
  const receipts = await readReceipts();
  const trades = receipts.filter((r) => r.decision === "trade");
  const skips = receipts.filter((r) => r.decision === "skip");

  const byBucket: Record<string, { n: number; correct: number }> = {};
  const byCategory: Record<string, { n: number; correct: number; trades: number }> = {};

  let openExposureTokens = 0;
  for (const r of trades) {
    const cat = r.category ?? "uncategorized";
    byCategory[cat] ??= { n: 0, correct: 0, trades: 0 };
    byCategory[cat].trades += 1;
  
    const bucket = bucketFor(r.confidence);
    byBucket[bucket] ??= { n: 0, correct: 0 };
  
    if (r.execution?.resolved) {
      byBucket[bucket].n += 1;
      byCategory[cat].n += 1;
      if (r.execution.won) {
        byBucket[bucket].correct += 1;
        byCategory[cat].correct += 1;
      }
    } else if (r.size) {
      // still open / unresolved — counts toward exposure, not accuracy yet
      openExposureTokens += r.size;
    }
  }

  const calibrationByConfidenceBucket: Summary["calibrationByConfidenceBucket"] = {};
  for (const [k, v] of Object.entries(byBucket)) {
    calibrationByConfidenceBucket[k] = { n: v.n, hitRate: v.n ? v.correct / v.n : null };
  }
  const perCategory: Summary["perCategory"] = {};
  for (const [k, v] of Object.entries(byCategory)) {
    perCategory[k] = { n: v.n, hitRate: v.n ? v.correct / v.n : null, trades: v.trades };
  }

  const overallN = Object.values(byBucket).reduce((a, b) => a + b.n, 0);
  const overallCorrect = Object.values(byBucket).reduce((a, b) => a + b.correct, 0);

  const summary: Summary = {
    updatedAt: new Date().toISOString(),
    totalReceipts: receipts.length,
    totalTrades: trades.length,
    totalSkips: skips.length,
    rollingAccuracy: groundTruth
      ? { n: groundTruth.n, hitRate: groundTruth.n ? groundTruth.winRate : null }
      : { n: overallN, hitRate: overallN ? overallCorrect / overallN : null },
    calibrationByConfidenceBucket,
    perCategory,
    openExposureTokens,
    lastNDecisions: receipts.slice(0, 25),
  };

  fs.writeFileSync(CONFIG.summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}

export function readPinnedSummary(): Summary | null {
  if (!fs.existsSync(CONFIG.summaryPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG.summaryPath, "utf8"));
  } catch {
    return null;
  }
}

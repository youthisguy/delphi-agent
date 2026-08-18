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
    /** (quoted cost-per-share ÷ entryPriceUsed) − 1 — how much more
     * expensive the actual fill was than the market's implied price at
     * decision time. Positive = paid above that price (thin book eats
     * into edge); null if it couldn't be computed. Only ever set on live
     * trades — dry-run receipts never call buyShares(), so this stays
     * undefined for them. */
    priceImpactPct?: number | null;
    redeemedTxHash?: string;
    redeemedAmount?: string;
    resolved?: boolean; 
    won?: boolean;
    exitReason?: "manual-sell" | "watcher-auto-exit";
    /** Gemini's sourceSummary for a watcher-triggered exit, or a free-text
     * note for a manual one — why this leg was closed. */
    exitNote?: string;
    /** True for markets that settled "failed" (void/undecided) and were
     * liquidated rather than redeemed against a winning outcome — see
     * redeem.ts. These never resolved to an actual right-or-wrong
     * forecast, so recomputeSummary excludes them from the accuracy
     * denominator entirely (not just from the `correct` count). */
    void?: boolean;
  } | null;

  /** Ground-truth settlement result, filled in by settlement.ts's
   * checkSettledOutcomes() once the underlying market resolves — for
   * BOTH decision types, not just trades. A skip never risked capital,
   * so its settlement.pnl is always null; what it DOES record is
   * whether the model's own favorite outcome would have been right,
   * for calibration. Absent/undefined means "market hasn't settled yet
   * (or hasn't been checked yet)" — never overwritten once set. */
  settlement?: ReceiptSettlement | null;

  skipReason?: string;
}

export interface ReceiptSettlement {
  settledAt: string; // ISO timestamp this was recorded, not when the market itself settled
  winningOutcomeIdx: number | null; // null for a void/failed market
  void: boolean; // true = market settled "failed" (no single winner) — see redeem.ts's liquidate() path
  /** trade: outcomeIdx === winningOutcomeIdx. skip: argmax(blendedProbs)
   * === winningOutcomeIdx (i.e. "would the model's own favorite pick
   * have been right"). null when void, or when there's nothing to
   * compare (e.g. an empty blend). */
  correct: boolean | null;
  /** Realized (live, from execution.redeemedAmount) or hypothetical
   * (dry-run, from size ÷ entryPrice) P&L in tokens. Always null for
   * skip receipts — capital was never risked, there's nothing to P&L —
   * and null for void trades, since a dry-run void has no reliable
   * recovery estimate absent an actual liquidate() call. */
  pnl: number | null;
}

export function appendReceipt(r: Receipt) {
  fs.appendFileSync(CONFIG.journalPath, JSON.stringify(r) + "\n");
}

/** Patch an existing receipt's execution block (used when a winning
 * position is later redeemed). Trade receipts only. */
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

/** Patch every not-yet-settled receipt for a market with its ground-truth
 * settlement result — trade AND skip receipts alike, live and dry-run.
 * Unlike patchReceiptExecution this isn't decision-gated: every past
 * evaluation of a market (it may have been skipped several cycles, then
 * traded once, or vice versa) gets the same settlement outcome recorded
 * once it's known. Idempotent — a receipt that already has `settlement`
 * set is left untouched, so re-running the check never overwrites a
 * recorded result. */
export function patchReceiptSettlement(marketId: string, settlement: ReceiptSettlement) {
  if (!fs.existsSync(CONFIG.journalPath)) return;
  const lines = fs.readFileSync(CONFIG.journalPath, "utf8").split("\n").filter(Boolean);
  let changed = false;
  const out = lines.map((line) => {
    const r: Receipt = JSON.parse(line);
    if (r.marketId === marketId && !r.settlement) {
      r.settlement = settlement;
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
  /** Ground-truth win/loss/P&L, sourced from settlement.ts's
   * checkSettledOutcomes() — covers BOTH live and dry-run trades (unlike
   * the older execution-only bookkeeping, which only ever saw live
   * redemptions). This is what the dashboard's win-rate/P&L panel reads. */
  tradePerformance: {
    settled: number; // non-void trades with a recorded settlement
    wins: number;
    losses: number;
    winRate: number | null;
    voidTrades: number; // settled "failed"/void — excluded from win/loss and winRate
    totalPnl: number; // tokens; sums every trade with a non-null settlement.pnl, including void recoveries
    openTrades: number; // no settlement recorded yet (still open, or not yet checked)
  };
  /** Same idea for skips — calibration only, never P&L (a skip risks
   * nothing). wouldHaveWon compares the model's own favorite outcome
   * (argmax of the blend) against the actual winner. */
  skipCalibration: {
    settled: number;
    wouldHaveWon: number;
    wouldHaveWonRate: number | null;
    voidSkips: number;
  };
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
 * Recompute the pinned summary from the full journal. Win/loss/P&L now
 * come from each receipt's `settlement` block (see settlement.ts's
 * checkSettledOutcomes(), which patches it in once a market's market
 * resolves) — that covers dry-run trades and skips too, not just live
 * on-chain redemptions the way the old execution-only bookkeeping did.
 *
 * Void/failed markets (settlement.void — liquidated rather than
 * resolved to a winning outcome, see redeem.ts) are excluded from the
 * win/loss and accuracy denominators entirely: they never resolved to
 * an actual right-or-wrong forecast, so folding them in as a miss would
 * understate hit rate. Their P&L (recovered collateral minus size, when
 * known) still counts toward totalPnl.
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
  let wins = 0,
    losses = 0,
    voidTrades = 0,
    openTrades = 0,
    totalPnl = 0;

  for (const r of trades) {
    const cat = r.category ?? "uncategorized";
    byCategory[cat] ??= { n: 0, correct: 0, trades: 0 };
    byCategory[cat].trades += 1;

    const bucket = bucketFor(r.confidence);
    byBucket[bucket] ??= { n: 0, correct: 0 };

    if (!r.settlement) {
      openTrades += 1;
      if (r.size) openExposureTokens += r.size; // still open — counts toward exposure, not accuracy yet
      continue;
    }

    if (r.settlement.pnl !== null && r.settlement.pnl !== undefined) {
      totalPnl += r.settlement.pnl;
    }

    if (r.settlement.void) {
      voidTrades += 1;
      continue; // never resolved to a right-or-wrong forecast
    }

    byBucket[bucket].n += 1;
    byCategory[cat].n += 1;
    if (r.settlement.correct) {
      wins += 1;
      byBucket[bucket].correct += 1;
      byCategory[cat].correct += 1;
    } else if (r.settlement.correct === false) {
      losses += 1;
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

  const settledTradeCount = wins + losses;

  let skipsSettled = 0,
    skipsWouldHaveWon = 0,
    voidSkips = 0;
  for (const r of skips) {
    if (!r.settlement) continue;
    if (r.settlement.void) {
      voidSkips += 1;
      continue;
    }
    skipsSettled += 1;
    if (r.settlement.correct) skipsWouldHaveWon += 1;
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
    tradePerformance: {
      settled: settledTradeCount,
      wins,
      losses,
      winRate: settledTradeCount ? wins / settledTradeCount : null,
      voidTrades,
      totalPnl: Number(totalPnl.toFixed(4)),
      openTrades,
    },
    skipCalibration: {
      settled: skipsSettled,
      wouldHaveWon: skipsWouldHaveWon,
      wouldHaveWonRate: skipsSettled ? skipsWouldHaveWon / skipsSettled : null,
      voidSkips,
    },
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
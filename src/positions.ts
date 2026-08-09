import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { readReceipts, type Receipt } from "./journal.js";
import { extractLiquidity, extractVolume } from "./marketFields.js";
import { withDelphiRetry } from "./delphiRetry.js";

/**
 * Mark-to-market for still-open trades — deliberately NOT part of the
 * trading loop (index.ts). It's read-only, has no bearing on any
 * decision, and every extra SDK call inside the loop's hot path is one
 * more thing that can throw and (before the recent try/finally fix)
 * jam the whole cycle. Instead this is computed on demand, whenever the
 * dashboard asks for it via GET /api/positions.
 */

export interface OpenPosition {
  marketId: string;
  question: string;
  category?: string;
  outcomeIdx: number;
  outcomeLabel: string;
  size: number; // tokens committed (receipt.size — the sizing decision, dry-run or live)
  entryPrice: number; // 0–1, the market's implied probability for this outcome at decision time
  currentPrice: number | null; // 0–1, same outcome's current implied probability; null if unavailable
  unrealizedPnl: number | null; // tokens; null when currentPrice is unavailable
  unrealizedPnlPct: number | null;
  /** Quoted cost-per-share vs. entryPrice at trade time — how thin the
   * market was for the size actually traded. Passed straight through
   * from the receipt's execution.priceImpactPct; null/undefined for
   * dry-run positions (no real fill happened) or older receipts logged
   * before this field existed. */
  priceImpactPct: number | null;
  marketStatus: string | null;
  /** Current liquidity/volume for this market, in tokens (or null if the
   * API doesn't expose a field this build recognizes — see
   * marketFields.ts's header comment; unverified field names/scaling). */
  liquidityTokens: number | null;
  volumeTokens: number | null;
  isDryRun: boolean;
  ts: string;
}

/** Same fallback the sizing logic itself uses for synthetic/no-book markets
 * (see index.ts's decide() and backtest.ts's evaluateForBacktest) — a
 * trade priced against an empty book was priced against 0.5, so mark it
 * against 0.5 here too rather than inventing a different assumption. */
function entryPriceFor(r: Receipt): number {
  if (r.rawPrice && r.outcomeIdx !== null && r.rawPrice[r.outcomeIdx] !== undefined) {
    return r.rawPrice[r.outcomeIdx];
  }
  return 0.5;
}

/** Same 1e18-fixed-point-vs-plain-float heuristic used in backtest.ts's
 * normalizeProbs — the API is inconsistent about which shape it returns. */
function normalizeProb(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 1.5 ? n / 1e18 : n;
}

/**
 * Every trade receipt that hasn't been marked resolved yet counts as
 * "open" — this covers both live trades still awaiting settlement AND
 * dry-run trades (execution is always null there, so nothing ever marks
 * them resolved; they're priced purely off the market's current implied
 * probability, never an actual fill).
 */
export async function getOpenPositions(client: DelphiClient): Promise<OpenPosition[]> {
  const receipts = await readReceipts();
  const openTrades = receipts.filter(
    (r) => r.decision === "trade" && r.outcomeIdx !== null && !r.execution?.resolved
  );
  if (openTrades.length === 0) return [];

  const positions: OpenPosition[] = [];

  for (const r of openTrades) {
    const outcomeIdx = r.outcomeIdx as number;
    const entryPrice = entryPriceFor(r);
    const outcomeLabel = r.outcomes?.[outcomeIdx] ?? `outcome #${outcomeIdx}`;

    let currentPrice: number | null = null;
    let marketStatus: string | null = null;
    let liquidityTokens: number | null = null;
    let volumeTokens: number | null = null;
    try {
      // getMarket() takes an options object (not a bare address string),
      // and — same as listMarkets() — only returns spotImpliedProbabilities
      // when pricesAndImpliedProbabilities is explicitly requested.
      const market: Market | undefined = await withDelphiRetry(
        () =>
          client.getMarket({
            id: r.marketId,
            pricesAndImpliedProbabilities: true,
          } as any),
        { label: `getMarket(${r.marketId})` }
      );
      if (market) {
        marketStatus = (market as any).status ?? null;
        liquidityTokens = extractLiquidity(market);
        volumeTokens = extractVolume(market);
        const rawProbs = (market as any).spotImpliedProbabilities as unknown[] | undefined;
        if (rawProbs && rawProbs[outcomeIdx] !== undefined) {
          currentPrice = normalizeProb(rawProbs[outcomeIdx]);
        }
      }
    } catch (err) {
      console.warn(`  [positions] couldn't fetch market ${r.marketId}:`, err instanceof Error ? err.message : err);
    }

    const size = r.size ?? 0;
    let unrealizedPnl: number | null = null;
    let unrealizedPnlPct: number | null = null;
    if (currentPrice !== null && entryPrice > 0) {
      // 1 share pays out 1 token if this outcome wins, 0 otherwise, so a
      // share's fair value tracks its implied probability directly —
      // P&L% is just how much that probability has moved since entry.
      unrealizedPnlPct = (currentPrice - entryPrice) / entryPrice;
      unrealizedPnl = size * unrealizedPnlPct;
    }

    positions.push({
      marketId: r.marketId,
      question: r.question,
      category: r.category,
      outcomeIdx,
      outcomeLabel,
      size,
      entryPrice,
      currentPrice,
      unrealizedPnl,
      unrealizedPnlPct,
      priceImpactPct: r.execution?.priceImpactPct ?? null,
      marketStatus,
      liquidityTokens,
      volumeTokens,
      isDryRun: !r.execution,
      ts: r.ts,
    });
  }

  return positions;
}
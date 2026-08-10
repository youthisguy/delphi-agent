import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { readReceipts, type Receipt } from "./journal.js";
import { extractLiquidity, extractVolume } from "./marketFields.js";
import { withDelphiRetry } from "./delphiRetry.js";
import {
  extractTradingFeePct,
  extractResolvesAt,
} from "./marketFields.js";

/**
 * Mark-to-market for still-open trades — deliberately NOT part of the
 * trading loop (index.ts). It's read-only, has no bearing on any
 * decision, and every extra SDK call inside the loop's hot path is one
 * more thing that can throw and jam the whole cycle. Instead this is
 * computed on demand, whenever the dashboard asks for it via
 * GET /api/positions.
 *
 * All per-position getMarket() calls run in parallel (Promise.all) and
 * are capped at maxRetries: 2 — fail fast on a rate-limited market
 * rather than blocking the whole page for minutes. The tradeoff of
 * failing fast is that a live rate-limit storm can make EVERY position's
 * getMarket() call fail within its 2 retries simultaneously — without a
 * fallback, that would blank out PnL/current-price for the whole table
 * at once, flickering in and out with every rate-limit window. The
 * lastKnownSnapshot cache below fixes that: a transient failure falls
 * back to the last successfully-fetched price (marked `stale: true`)
 * instead of going blank, while a genuine 404 (market no longer exists)
 * still clears the cache and shows nothing, since there's no real value
 * to fall back to for a market that's actually gone.
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
  /** Current liquidity/volume for this market, in tokens. */
  liquidityTokens: number | null;
  volumeTokens: number | null;
  tradingFeePct: number | null;
  resolvesAt: string | null;
  msUntilResolve: number | null;
  /** True if the underlying getMarket() call for this position 404'd
   * (market no longer exists server-side — e.g. an old testnet market
   * that's been removed) rather than merely failing transiently. Lets
   * the dashboard distinguish "stale/gone" from "temporarily
   * unreachable" instead of showing the same blank dashes for both. */
  marketNotFound: boolean;
  /** True if this poll's getMarket() call failed transiently (rate
   * limit, timeout, etc.) and the values shown are carried over from
   * the last successful fetch rather than freshly read this poll. False
   * on a fresh successful read OR when marketNotFound is true (no
   * fallback value exists for a genuinely-gone market). */
  stale: boolean;
  isDryRun: boolean;
  ts: string;
}

/** Same fallback the sizing logic itself uses for synthetic/no-book markets
 * (see index.ts's decide() and backtest.ts's evaluateForBacktest) — a
 * trade priced against an empty book was priced against 0.5, so mark it
 * against 0.5 here too rather than inventing a different assumption. */
function entryPriceFor(r: Receipt): number {
  if (
    r.rawPrice &&
    r.outcomeIdx !== null &&
    r.rawPrice[r.outcomeIdx] !== undefined
  ) {
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

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b404\b/.test(msg) ||
    /not found/i.test(msg) ||
    /no rows in result set/i.test(msg)
  );
}

/**
 * Last successfully-fetched snapshot per market, keyed by marketId.
 * Module-level (persists across polls within this process, same
 * lifetime as everything else in this file) so a transient failure on
 * one poll can fall back to real numbers from a recent successful poll
 * instead of going blank. Unbounded growth isn't a practical concern —
 * this only ever holds one entry per currently-open position, and open
 * positions are naturally bounded by bankroll/maxTokensPerTrade.
 */
interface CachedMarketSnapshot {
  currentPrice: number | null;
  marketStatus: string | null;
  liquidityTokens: number | null;
  volumeTokens: number | null;
  tradingFeePct: number | null;
  resolvesAt: string | null;
  fetchedAt: number;
}

const lastKnownSnapshot = new Map<string, CachedMarketSnapshot>();

/**
 * Every trade receipt that hasn't been marked resolved yet counts as
 * "open" — this covers both live trades still awaiting settlement AND
 * dry-run trades (execution is always null there, so nothing ever marks
 * them resolved; they're priced purely off the market's current implied
 * probability, never an actual fill).
 */
export async function getOpenPositions(
  client: DelphiClient
): Promise<OpenPosition[]> {
  const receipts = await readReceipts();

  const openTrades = receipts.filter(
    (r) =>
      r.decision === "trade" &&
      r.outcomeIdx !== null &&
      // `execution.resolved` only ever gets set for LIVE trades (see
      // redeem.ts) — dry-run trades' execution stays null forever, so
      // checking that alone left settled dry-run trades stuck "open"
      // permanently. `r.settlement` (from settlement.ts) is the actual
      // ground truth for both live and dry-run, so check that too.
      !r.settlement &&
      !r.execution?.resolved
  );

  if (openTrades.length === 0) return [];

  // Firing every open position's getMarket() at once (old Promise.all
  // over the full list) is what caused the rate-limit thundering herd:
  // N simultaneous calls hit the same 429 window, all wait it out
  // together, then all retry on the same tick, re-triggering it
  // indefinitely. Batching a few at a time keeps this endpoint fast
  // without hammering the API in one burst every 15s poll.
  const POSITION_FETCH_CONCURRENCY = 3;
  const positions: OpenPosition[] = [];

  for (
    let i = 0;
    i < openTrades.length;
    i += POSITION_FETCH_CONCURRENCY
  ) {
    const batch = openTrades.slice(
      i,
      i + POSITION_FETCH_CONCURRENCY
    );

    const batchResults = await Promise.all(
      batch.map(async (r) => {
        const outcomeIdx = r.outcomeIdx as number;
        const entryPrice = entryPriceFor(r);
        const outcomeLabel =
          r.outcomes?.[outcomeIdx] ?? `outcome #${outcomeIdx}`;

        let currentPrice: number | null = null;
        let marketStatus: string | null = null;
        let liquidityTokens: number | null = null;
        let volumeTokens: number | null = null;
        let tradingFeePct: number | null = null;
        let resolvesAt: string | null = null;
        let marketNotFound = false;
        let stale = false;

        try {
          const market: Market | undefined = await withDelphiRetry(
            () =>
              client.getMarket({
                id: r.marketId,
                pricesAndImpliedProbabilities: true,
              } as any),
            {
              label: `getMarket(${r.marketId})`,
              maxRetries: 2,
            } // dashboard read on a 15s poll — fail fast
          );

          if (market) {
            marketStatus = (market as any).status ?? null;
            liquidityTokens = extractLiquidity(market);
            volumeTokens = extractVolume(market);
            tradingFeePct = extractTradingFeePct(market);
            resolvesAt = extractResolvesAt(market);

            const rawProbs =
              (market as any).spotImpliedProbabilities as
                | unknown[]
                | undefined;

            if (
              rawProbs &&
              rawProbs[outcomeIdx] !== undefined
            ) {
              currentPrice = normalizeProb(
                rawProbs[outcomeIdx]
              );
            }

            // Fresh success — refresh the cache so a LATER transient
            // failure has something real to fall back to.
            lastKnownSnapshot.set(r.marketId, {
              currentPrice,
              marketStatus,
              liquidityTokens,
              volumeTokens,
              tradingFeePct,
              resolvesAt,
              fetchedAt: Date.now(),
            });
          }
        } catch (err) {
          marketNotFound = isNotFoundError(err);

          console.warn(
            `  [positions] couldn't fetch market ${r.marketId}${
              marketNotFound
                ? " (404 — market no longer exists server-side)"
                : ""
            }:`,
            err instanceof Error ? err.message : err
          );

          if (marketNotFound) {
            // Genuinely gone — don't resurrect stale numbers for a market
            // that no longer exists on the API at all.
            lastKnownSnapshot.delete(r.marketId);
          } else {
            // Transient (rate limit, timeout, etc.) — fall back to the
            // last successful read rather than showing a blank PnL that
            // flickers in and out with every rate-limit window.
            const cached = lastKnownSnapshot.get(r.marketId);

            if (cached) {
              currentPrice = cached.currentPrice;
              marketStatus = cached.marketStatus;
              liquidityTokens = cached.liquidityTokens;
              volumeTokens = cached.volumeTokens;
              tradingFeePct = cached.tradingFeePct;
              resolvesAt = cached.resolvesAt;
              stale = true;
            }
          }
        }

        // Recomputed fresh from resolvesAt every poll (even when
        // resolvesAt itself came from the stale-fallback cache above) —
        // it's a function of "now", so caching the ms delta itself would
        // just grow staler than the resolvesAt timestamp it's derived
        // from for no benefit.
        const msUntilResolveVal = resolvesAt
          ? new Date(resolvesAt).getTime() - Date.now()
          : null;

        const size = r.size ?? 0;

        let unrealizedPnl: number | null = null;
        let unrealizedPnlPct: number | null = null;

        if (currentPrice !== null && entryPrice > 0) {
          // 1 share pays out 1 token if this outcome wins, 0 otherwise,
          // so a share's fair value tracks its implied probability
          // directly — P&L% is just how much that probability has moved
          // since entry.
          unrealizedPnlPct =
            (currentPrice - entryPrice) / entryPrice;
          unrealizedPnl = size * unrealizedPnlPct;
        }

        return {
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
          priceImpactPct:
            r.execution?.priceImpactPct ?? null,
          marketStatus,
          liquidityTokens,
          volumeTokens,
          tradingFeePct,
          resolvesAt,
          msUntilResolve: msUntilResolveVal,
          marketNotFound,
          stale,
          isDryRun: !r.execution,
          ts: r.ts,
        } satisfies OpenPosition;
      })
    );

    positions.push(...batchResults);
  }

  return positions;
}
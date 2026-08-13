import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { readReceipts, type Receipt } from "./journal.js";
import { extractLiquidity, extractVolume } from "./marketFields.js";
import { withDelphiRetry } from "./delphiRetry.js";
import { resolveWalletAddress } from "./chainRead.js";
import {
  extractTradingFeePct,
  extractResolvesAt,
} from "./marketFields.js";

/** Shares are fixed at 18 decimals — same convention as
 * scripts/sell-positions.ts. */
const SHARES_DECIMALS = 18;

function sharesToHuman(raw: string | bigint): number {
  try {
    return Number(BigInt(raw)) / 10 ** SHARES_DECIMALS;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n / 10 ** SHARES_DECIMALS : 0;
  }
}

/** Client-visitable competition page for a market. The on-chain address
 * IS the id (confirmed: competition.delphi.fyi/markets/0x… uses the
 * market's contract address directly), so this is always constructible
 * without depending on marketUrl from the API (confirmed absent on this
 * API version — see marketFields.ts's extractMarketUrl). */
function competitionUrlFor(marketId: string): string {
  return `https://competition.delphi.fyi/markets/${marketId}`;
}

/**
 * On-chain source of truth for what the wallet actually still holds,
 * keyed the same way as the journal-derived groups (`${marketId}::${outcomeIdx}`,
 * marketId lowercased so casing differences between journal receipts and
 * the API's own casing don't cause false misses).
 * Same pagination loop as scripts/sell-positions.ts's loadAllPositions().
 *
 * The journal (aggregateReceipts) is still the source for entryPrice /
 * cost-basis / category / question — a sell doesn't touch the journal,
 * only the chain — so this is cross-checked against, not used to
 * replace, the journal-derived groups. See getOpenPositions() below.
 */
async function loadOnChainPositions(
  client: DelphiClient,
  wallet: string
): Promise<Map<string, bigint>> {
  const byKey = new Map<string, bigint>();
  let skip = 0;
  const limit = 50;

  for (;;) {
    const res = await withDelphiRetry(
      () =>
        (client as any).listPositions({
          wallet,
          redeemedOrLiquidated: false,
          skip,
          limit,
        }),
      { label: `listPositions(skip=${skip})`, maxRetries: 2 }
    );

    const batch = (res as any)?.positions ?? (Array.isArray(res) ? res : []);
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const p of batch) {
      const marketId = String(
        p.marketProxy ?? p.marketId ?? p.marketAddress ?? p.market ?? ""
      ).toLowerCase();
      if (!marketId) continue;
      const outcomeIdx = Number(p.outcomeIdx ?? p.outcome ?? 0);
      let sharesRaw: bigint;
      try {
        sharesRaw = BigInt(String(p.shares ?? "0"));
      } catch {
        sharesRaw = 0n;
      }
      const key = `${marketId}::${outcomeIdx}`;
      // A wallet could in principle have more than one row surface for
      // the same market+outcome across pages — sum rather than overwrite.
      byKey.set(key, (byKey.get(key) ?? 0n) + sharesRaw);
    }

    if (batch.length < limit) break;
    skip += limit;
  }

  return byKey;
}

/**
 * Mark-to-market for still-open trades — deliberately NOT part of the
 * trading loop (index.ts). It's read-only, has no bearing on any
 * decision, and every extra SDK call inside the loop's hot path is one
 * more thing that can throw and jam the whole cycle. Instead this is
 * computed on demand, whenever the dashboard asks for it via
 * GET /api/positions.
 *
 * Rows are aggregated by `marketId + outcomeIdx` before any network call
 * is made. The same market/outcome can accumulate multiple buy receipts
 * across cycles (see maxExposurePerMarket in config.ts, which explicitly
 * allows topping up a held position) — without aggregation those showed
 * up as separate rows AND triggered one getMarket() call per receipt. So
 * a market bought into 3 times fired 3 identical getMarket() calls and
 * rendered 3 rows for what is, from a "what do I currently hold" point of
 * view, one position. Grouping first fixes both: one row per unique
 * market+outcome, and one getMarket() call per unique market regardless
 * of how many receipts contributed to it.
 *
 * All per-market getMarket() calls run in parallel batches (not full
 * Promise.all) and are capped at maxRetries: 2 — fail fast on a
 * rate-limited market rather than blocking the whole page for minutes.
 * The tradeoff of failing fast is that a live rate-limit storm can make
 * EVERY position's getMarket() call fail within its 2 retries
 * simultaneously — without a fallback, that would blank out PnL/current-
 * price for the whole table at once, flickering in and out with every
 * rate-limit window. The lastKnownSnapshot cache below fixes that: a
 * transient failure falls back to the last successfully-fetched price
 * (marked `stale: true`) instead of going blank, while a genuine 404
 * (market no longer exists) still clears the cache and shows nothing,
 * since there's no real value to fall back to for a market that's
 * actually gone.
 */

export interface OpenPosition {
  marketId: string;
  question: string;
  category?: string;
  outcomeIdx: number;
  outcomeLabel: string;
  size: number; // tokens committed, SUMMED across every contributing receipt
  /** 0–1, size-weighted average TRUE COST BASIS across contributing
   * receipts — the market's pre-trade price adjusted by that receipt's
   * recorded price impact (costBasisFor() below), not the raw pre-trade
   * price. For dry-run receipts (no priceImpactPct) this is just the
   * pre-trade price, same as before. */
  entryPrice: number;
  currentPrice: number | null; // 0–1, same outcome's current implied probability; null if unavailable
  unrealizedPnl: number | null; // tokens; null when currentPrice is unavailable
  unrealizedPnlPct: number | null;
  /** Size-weighted average of contributing receipts' execution.priceImpactPct
   * (only receipts that have one are counted). null if none of the
   * contributing receipts have a recorded price impact (e.g. all dry-run,
   * or older receipts logged before this field existed). */
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
  /** True only if EVERY contributing receipt was dry-run. A position
   * built from a mix of live and dry-run buys (same market+outcome,
   * bought once dry-run then once live, or vice versa) is real capital
   * at that point and is reported as live rather than silently hidden
   * behind a DRY badge. */
  isDryRun: boolean;
  /** Timestamp of the most recent contributing receipt — "when was this
   * position last added to", not when it was first opened. */
  ts: string;
  /** How many journal receipts were folded into this row. 1 = a normal
   * single-buy position; >1 = topped up across multiple cycles. */
  receiptCount: number;
  /** Raw on-chain share balance (18-decimal fixed point), as a string —
   * JS numbers can't safely hold a bigint from JSON. This is what the
   * sell-quote/sell endpoints need as sharesIn; null if on-chain
   * verification wasn't available this poll (wallet unresolved or the
   * listPositions call failed), in which case `size` above still falls
   * back to the journal-derived total. */
  sharesRaw: string | null;
  /** True if this row's `size`/`sharesRaw` were cross-checked against
   * on-chain listPositions() this poll. False means the wallet couldn't
   * be resolved or the on-chain call failed, so `size` is the journal's
   * (potentially stale, e.g. after a sell made outside this dashboard)
   * total instead. */
  onChainVerified: boolean;
  /** competition.delphi.fyi page for this market — always constructible
   * client-side from the address, no dependency on marketUrl from the
   * API (see marketFields.ts's extractMarketUrl, confirmed absent). */
  marketUrl: string;
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

/**
 * True cost basis per receipt — what was actually paid per share, not
 * just the market's pre-trade price. On a live trade with a recorded
 * price impact, the fill happened at entryPriceFor(r) * (1 + impact):
 * priceImpactPct is (quoted cost-per-share ÷ pre-trade price) − 1, so
 * inverting that back out recovers the real per-share cost.
 *
 * Without this, `entryPrice` (and every P&L figure derived from it) was
 * quietly assuming every trade filled at the frictionless pre-trade
 * price — on a thin LMSR book that overstates unrealized P&L by roughly
 * the impact cost, since priceImpactPct was tracked on the receipt but
 * never actually folded into the cost basis (see the SILSO/NSIDC
 * incidents: displayed entry sat at the pre-trade 0.085 when the real
 * average fill was closer to 0.104).
 *
 * dry-run receipts never call buyShares() and so never get a
 * priceImpactPct (see journal.ts) — those fall through to the raw
 * pre-trade price unchanged, same as before.
 */
function costBasisFor(r: Receipt): number {
  const rawEntry = entryPriceFor(r);
  const impact = r.execution?.priceImpactPct;
  if (typeof impact === "number" && Number.isFinite(impact)) {
    return rawEntry * (1 + impact);
  }
  return rawEntry;
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
 * this only ever holds one entry per currently-open market, and open
 * markets are naturally bounded by bankroll/maxTokensPerTrade.
 */
interface CachedMarketSnapshot {
  marketStatus: string | null;
  liquidityTokens: number | null;
  volumeTokens: number | null;
  tradingFeePct: number | null;
  resolvesAt: string | null;
  /** Raw spotImpliedProbabilities array off the market, so any outcome
   * index sharing this market can be re-derived from one cached fetch. */
  rawProbs: unknown[] | null;
  fetchedAt: number;
}

const lastKnownSnapshot = new Map<string, CachedMarketSnapshot>();

/** One aggregated position-in-progress, keyed by `${marketId}::${outcomeIdx}`,
 * before any network call happens. */
interface AggregatedInput {
  marketId: string;
  outcomeIdx: number;
  question: string;
  category?: string;
  outcomeLabel: string;
  totalSize: number;
  sharesRawSum: bigint;
  entryPriceWeightedSum: number; // Σ(size × entryPrice), divide by totalSize for the average
  impactWeightedSum: number; // Σ(size × priceImpactPct) over receipts that have one
  impactWeight: number; // Σ(size) over those same receipts — denominator for the above
  allDryRun: boolean;
  latestTs: string;
  receiptCount: number;
}

/**
 * Group open-trade receipts by market+outcome. Every not-yet-settled
 * trade receipt counts as "open" — this covers both live trades still
 * awaiting settlement AND dry-run trades (execution is always null
 * there, so nothing ever marks them resolved; they're priced purely off
 * the market's current implied probability, never an actual fill).
 */
function aggregateReceipts(receipts: Receipt[]): Map<string, AggregatedInput> {
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

  const groups = new Map<string, AggregatedInput>();

  for (const r of openTrades) {
    const outcomeIdx = r.outcomeIdx as number;
    const key = `${r.marketId}::${outcomeIdx}`;
    const size = r.size ?? 0;

    // Cost basis, not the raw pre-trade price — see costBasisFor() above.
    // This is what feeds entryPriceWeightedSum below, so the "Entry"
    // column and every P&L figure derived from it reflect what was
    // actually paid, impact included.
    const entryPrice = costBasisFor(r);
    const impact = r.execution?.priceImpactPct;
    const hasImpact = typeof impact === "number" && Number.isFinite(impact);

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        marketId: r.marketId,
        outcomeIdx,
        question: r.question,
        category: r.category,
        outcomeLabel: r.outcomes?.[outcomeIdx] ?? `outcome #${outcomeIdx}`,
        totalSize: size,
        sharesRawSum: r.execution?.sharesOut
          ? BigInt(r.execution.sharesOut)
          : 0n,
        entryPriceWeightedSum: size * entryPrice,
        impactWeightedSum: hasImpact ? size * (impact as number) : 0,
        impactWeight: hasImpact ? size : 0,
        allDryRun: !r.execution,
        latestTs: r.ts,
        receiptCount: 1,
      });

      continue;
    }

    existing.totalSize += size;

    if (r.execution?.sharesOut) {
      try {
        existing.sharesRawSum += BigInt(r.execution.sharesOut);
      } catch {}
    }

    existing.entryPriceWeightedSum += size * entryPrice;

    if (hasImpact) {
      existing.impactWeightedSum += size * (impact as number);
      existing.impactWeight += size;
    }

    if (r.execution) existing.allDryRun = false;

    if (new Date(r.ts).getTime() > new Date(existing.latestTs).getTime()) {
      existing.latestTs = r.ts;

      // Prefer the most recent receipt's question/category/outcomeLabel
      // in case any of those drifted (e.g. outcomes relabeled upstream).
      existing.question = r.question;
      existing.category = r.category;
      existing.outcomeLabel =
        r.outcomes?.[outcomeIdx] ?? existing.outcomeLabel;
    }

    existing.receiptCount += 1;
  }

  return groups;
}

export async function getOpenPositions(
  client: DelphiClient
): Promise<OpenPosition[]> {
  const receipts = await readReceipts();
  const groups = aggregateReceipts(receipts);

  if (groups.size === 0) return [];

  // Cross-check against on-chain truth: selling doesn't touch the
  // journal, so without this a sold position sat in the table forever
  // until something separately patched the journal. Wallet resolution
  // or the listPositions() call itself can fail (RPC hiccup, SDK signer
  // not configured, etc.) — in that case we don't have ground truth this
  // poll, so rows fall back to the journal's totals rather than being
  // wrongly dropped.
  let onChainMap: Map<string, bigint> | null = null;
  try {
    const wallet = await resolveWalletAddress(client);
    if (wallet) {
      onChainMap = await loadOnChainPositions(client, wallet);
    } else {
      console.warn(
        "  [positions] couldn't resolve wallet address — showing journal-only totals, unverified"
      );
    }
  } catch (err) {
    console.warn(
      "  [positions] on-chain listPositions() failed — showing journal-only totals, unverified:",
      err instanceof Error ? err.message : err
    );
  }

  // One getMarket() call per unique marketId, regardless of how many
  // aggregated groups (outcomes) or original receipts reference it.
  const uniqueMarketIds = [...new Set([...groups.values()].map((g) => g.marketId))];

  interface MarketFetchResult {
    marketStatus: string | null;
    liquidityTokens: number | null;
    volumeTokens: number | null;
    tradingFeePct: number | null;
    resolvesAt: string | null;
    rawProbs: unknown[] | null;
    marketNotFound: boolean;
    stale: boolean;
  }

  const marketResults = new Map<string, MarketFetchResult>();

  // Firing every unique market's getMarket() at once (old Promise.all
  // over the full receipt list) is what caused the rate-limit thundering
  // herd: N simultaneous calls hit the same 429 window, all wait it out
  // together, then all retry on the same tick, re-triggering it
  // indefinitely. Batching a few at a time keeps this endpoint fast
  // without hammering the API in one burst every 15s poll.
  const MARKET_FETCH_CONCURRENCY = 3;

  for (let i = 0; i < uniqueMarketIds.length; i += MARKET_FETCH_CONCURRENCY) {
    const batch = uniqueMarketIds.slice(i, i + MARKET_FETCH_CONCURRENCY);

    await Promise.all(
      batch.map(async (marketId) => {
        try {
          const market: Market | undefined = await withDelphiRetry(
            () =>
              client.getMarket({
                id: marketId,
                pricesAndImpliedProbabilities: true,
              } as any),
            {
              label: `getMarket(${marketId})`,
              maxRetries: 2,
            } // dashboard read on a 15s poll — fail fast
          );

          if (market) {
            const result: MarketFetchResult = {
              marketStatus: (market as any).status ?? null,
              liquidityTokens: extractLiquidity(market),
              volumeTokens: extractVolume(market),
              tradingFeePct: extractTradingFeePct(market),
              resolvesAt: extractResolvesAt(market),
              rawProbs:
                ((market as any).spotImpliedProbabilities as unknown[] | undefined) ?? null,
              marketNotFound: false,
              stale: false,
            };
            marketResults.set(marketId, result);

            // Fresh success — refresh the cache so a LATER transient
            // failure has something real to fall back to.
            lastKnownSnapshot.set(marketId, {
              marketStatus: result.marketStatus,
              liquidityTokens: result.liquidityTokens,
              volumeTokens: result.volumeTokens,
              tradingFeePct: result.tradingFeePct,
              resolvesAt: result.resolvesAt,
              rawProbs: result.rawProbs,
              fetchedAt: Date.now(),
            });
          } else {
            marketResults.set(marketId, {
              marketStatus: null,
              liquidityTokens: null,
              volumeTokens: null,
              tradingFeePct: null,
              resolvesAt: null,
              rawProbs: null,
              marketNotFound: false,
              stale: false,
            });
          }
        } catch (err) {
          const marketNotFound = isNotFoundError(err);

          console.warn(
            `  [positions] couldn't fetch market ${marketId}${
              marketNotFound ? " (404 — market no longer exists server-side)" : ""
            }:`,
            err instanceof Error ? err.message : err
          );

          if (marketNotFound) {
            // Genuinely gone — don't resurrect stale numbers for a market
            // that no longer exists on the API at all.
            lastKnownSnapshot.delete(marketId);
            marketResults.set(marketId, {
              marketStatus: null,
              liquidityTokens: null,
              volumeTokens: null,
              tradingFeePct: null,
              resolvesAt: null,
              rawProbs: null,
              marketNotFound: true,
              stale: false,
            });
          } else {
            // Transient (rate limit, timeout, etc.) — fall back to the
            // last successful read rather than showing a blank PnL that
            // flickers in and out with every rate-limit window.
            const cached = lastKnownSnapshot.get(marketId);
            marketResults.set(marketId, {
              marketStatus: cached?.marketStatus ?? null,
              liquidityTokens: cached?.liquidityTokens ?? null,
              volumeTokens: cached?.volumeTokens ?? null,
              tradingFeePct: cached?.tradingFeePct ?? null,
              resolvesAt: cached?.resolvesAt ?? null,
              rawProbs: cached?.rawProbs ?? null,
              marketNotFound: false,
              stale: Boolean(cached),
            });
          }
        }
      })
    );
  }

  const positions: OpenPosition[] = [];

  for (const g of groups.values()) {
    const fetched = marketResults.get(g.marketId);

    // Entry price is token cost per share and must be calculated before
    // converting the verified on-chain share count back into the
    // token-denominated SIZE used by the dashboard and P&L calculation.
    const entryPrice =
      g.totalSize > 0 ? g.entryPriceWeightedSum / g.totalSize : 0.5;

    // On-chain cross-check. When we have a verified map for this poll,
    // a group with no matching on-chain position (or zero shares there)
    // means the wallet has actually sold/redeemed out of it — the
    // journal just hasn't (and, by design, doesn't need to) catch up.
    // Drop the row entirely rather than showing a stale "still open"
    // position. When on-chain data isn't available this poll, fall back
    // to the journal's total, unverified, rather than guessing.
    let effectiveSize = g.totalSize;
    let effectiveSharesRaw = g.sharesRawSum;
    const onChainVerified = onChainMap !== null;

    if (onChainMap) {
      const onChainKey = `${g.marketId.toLowerCase()}::${g.outcomeIdx}`;
      const onChainShares = onChainMap.get(onChainKey) ?? 0n;

      if (onChainShares === 0n) {
        continue; // sold/redeemed — drop the row
      }

      // Convert shares back into token terms so SIZE remains
      // "tokens committed" and P&L is calculated in the same units.
      effectiveSize = sharesToHuman(onChainShares) * entryPrice;

      // Use on-chain truth for the Sell button. This prevents the
      // dashboard from attempting to sell shares that were already
      // sold/redeemed outside the dashboard.
      effectiveSharesRaw = onChainShares;
    }

    const priceImpactPct =
      g.impactWeight > 0
        ? g.impactWeightedSum / g.impactWeight
        : null;

    let currentPrice: number | null = null;
    if (
      fetched?.rawProbs &&
      fetched.rawProbs[g.outcomeIdx] !== undefined
    ) {
      currentPrice = normalizeProb(fetched.rawProbs[g.outcomeIdx]);
    }

    // Recomputed fresh from resolvesAt every poll (even when resolvesAt
    // itself came from the stale-fallback cache) — it's a function of
    // "now", so caching the ms delta itself would just grow staler than
    // the resolvesAt timestamp it's derived from for no benefit.
    const msUntilResolveVal = fetched?.resolvesAt
      ? new Date(fetched.resolvesAt).getTime() - Date.now()
      : null;

    let unrealizedPnl: number | null = null;
    let unrealizedPnlPct: number | null = null;

    if (currentPrice !== null && entryPrice > 0) {
      // 1 share pays out 1 token if this outcome wins, 0 otherwise, so a
      // share's fair value tracks its implied probability directly —
      // P&L% is just how much that probability has moved since the
      // (size-weighted average) entry. effectiveSize is always in token
      // terms, including when it was reconstructed from on-chain shares.
      unrealizedPnlPct = (currentPrice - entryPrice) / entryPrice;
      unrealizedPnl = effectiveSize * unrealizedPnlPct;
    }

    positions.push({
      marketId: g.marketId,
      question: g.question,
      category: g.category,
      outcomeIdx: g.outcomeIdx,
      outcomeLabel: g.outcomeLabel,
      size: effectiveSize,
      entryPrice,
      currentPrice,
      unrealizedPnl,
      unrealizedPnlPct,
      priceImpactPct,
      marketStatus: fetched?.marketStatus ?? null,
      liquidityTokens: fetched?.liquidityTokens ?? null,
      volumeTokens: fetched?.volumeTokens ?? null,
      tradingFeePct: fetched?.tradingFeePct ?? null,
      resolvesAt: fetched?.resolvesAt ?? null,
      msUntilResolve: msUntilResolveVal,
      marketNotFound: fetched?.marketNotFound ?? false,
      stale: fetched?.stale ?? false,
      isDryRun: g.allDryRun,
      ts: g.latestTs,
      receiptCount: g.receiptCount,
      sharesRaw:
        effectiveSharesRaw > 0n
          ? effectiveSharesRaw.toString()
          : null,
      onChainVerified,
      marketUrl: competitionUrlFor(g.marketId),
    });
  }

  // Stable, readable default order — most recently touched first.
  positions.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  return positions;
}
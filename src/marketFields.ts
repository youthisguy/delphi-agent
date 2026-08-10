import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";

function firstDefined(...vals: unknown[]): unknown {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

/** A probability is always <=1, so backtest.ts's normalizeProbs() can use
 * >1.5 as its fixed-point trigger. Liquidity/volume can legitimately be
 * in the thousands, so this threshold is much higher to avoid false-
 * positive-rescaling a real $50,000 pool down to $0.00005. */
function normalizeTokenAmount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 1e12) return n / 1e18; // near-certainly 1e18 fixed-point
  return n;
}

export function extractLiquidity(market: Market): number | null {
  const m = market as any;
  const raw = firstDefined(
    m.liquidity,
    m.totalLiquidity,
    m.poolLiquidity,
    m.liquidityUsd,
    m.liquidityTokens,
    m.metadata?.liquidity,
    m.metadata?.totalLiquidity
  );
  return normalizeTokenAmount(raw);
}

export function extractVolume(market: Market): number | null {
  const m = market as any;
  const raw = firstDefined(
    m.volume,
    m.totalVolume,
    m.tradingVolume,
    m.volumeUsd,
    m.volumeTokens,
    m.metadata?.volume,
    m.metadata?.totalVolume
  );
  return normalizeTokenAmount(raw);
}

/** ISO timestamp the market is expected to resolve, straight off the
 * Market object — confirmed present in every sample market dumped via
 * rawprices.ts. Null if genuinely absent. */
export function extractResolvesAt(market: Market): string | null {
  const m = market as any;
  return typeof m.resolvesAt === "string" ? m.resolvesAt : null;
}

export function extractSettlesAt(market: Market): string | null {
  const m = market as any;
  return typeof m.settlesAt === "string" ? m.settlesAt : null;
}

/** Milliseconds from now until resolvesAt, or null if unavailable.
 * Negative values mean the market's resolution window has already
 * passed but hasn't settled yet — still useful to surface (flags a
 * market that's overdue) rather than hiding it. */
export function msUntilResolve(market: Market): number | null {
  const iso = extractResolvesAt(market);
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return t - Date.now();
}

/**
 * tradingFee comes back as a fixed-point string in the SAME 1e18
 * convention as everything else this API returns (confirmed via
 * rawprices.ts: "50000000000000000" / "30000000000000000" /
 * "25000000000000000" on different markets — i.e. 5%, 3%, 2.5%). This
 * directly eats into edge: an 8%-edge signal against a 5% fee is a much
 * thinner bet than the same edge against a 0.5% fee. Not yet factored
 * into index.ts's minEdge — surfaced here for visibility first.
 */
export function extractTradingFeePct(market: Market): number | null {
  const m = market as any;
  if (m.tradingFee === undefined || m.tradingFee === null) return null;
  const n = Number(m.tradingFee);
  if (!Number.isFinite(n)) return null;
  return n / 1e18;
}

export function extractDataSources(market: Market): string[] {
  const m = market as any;
  return Array.isArray(m.dataSources) ? m.dataSources.filter((s: unknown) => typeof s === "string") : [];
}

export function extractMarketUrl(market: Market): string | null {
  const m = market as any;
  return typeof m.marketUrl === "string" ? m.marketUrl : null;
}

/** The competition portal's own market identifier (UUID), distinct from
 * `market.id` (the on-chain contract address). Journal receipts only
 * store the address — this lets you cross-reference a receipt against
 * the portal UI, which links by appMarketId, not by address. */
export function extractAppMarketId(market: Market): string | null {
  const m = market as any;
  return typeof m.appMarketId === "string" ? m.appMarketId : null;
}
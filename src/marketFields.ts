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

import { CONFIG } from "./config.js";

/**
 * Caches LLM + Gemini forecasts per market for a short TTL so re-running
 * the loop every few minutes on a small open-market pool doesn't burn a
 * fresh OpenAI + Gemini call on the exact same question every cycle.
 *
 * Deliberately does NOT cache the Polymarket lookup (externalOdds.ts) —
 * that's a live external price feed, not a model opinion, so it should
 * stay fresh every cycle regardless of TTL.
 *
 * In-memory only (per process). index.ts's loop runs as a single long-
 * lived process, so this survives across cycles within a deploy; it
 * resets on restart, which is fine — a cold cache just means the first
 * cycle after a restart pays full cost again.
 */

export interface CachedForecast {
  llm: { probs: number[]; confidence: number; reasoning?: string };
  gemini: { probs: number[]; confidence: number; grounded: boolean; reasoning?: string } | null;
  /** Market's implied probs at the time this was cached, or null if the
   * book was synthetic (empty) at cache time — used to detect a
   * meaningful price move that should force a re-forecast even within TTL. */
  marketProbsAtCache: number[] | null;
  cachedAt: number;
}

const cache = new Map<string, CachedForecast>();

function probsMovedSignificantly(
  a: number[] | null,
  b: number[] | null,
  threshold: number
): boolean {
  // One side synthetic and the other real means the book just
  // appeared/disappeared — that's always a meaningful change.
  if (a === null || b === null) return a !== b;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > threshold) return true;
  }
  return false;
}

/** Returns the cached forecast if still valid, or null if it must be refetched. */
export function getCachedForecast(
  marketId: string,
  currentMarketProbs: number[] | null
): CachedForecast | null {
  const entry = cache.get(marketId);
  if (!entry) return null;

  const age = Date.now() - entry.cachedAt;
  if (age > CONFIG.forecastCacheTtlMs) return null;

  if (
    probsMovedSignificantly(
      entry.marketProbsAtCache,
      currentMarketProbs,
      CONFIG.forecastCachePriceMoveThreshold
    )
  ) {
    return null;
  }

  return entry;
}

export function setCachedForecast(
  marketId: string,
  data: Omit<CachedForecast, "cachedAt">
): void {
  cache.set(marketId, { ...data, cachedAt: Date.now() });
}

/** Drops expired entries so a long-running process doesn't accumulate
 * unbounded memory across many distinct markets over the competition. */
export function pruneForecastCache(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (now - entry.cachedAt > CONFIG.forecastCacheTtlMs) cache.delete(id);
  }
}

export function getForecastCacheSize(): number {
  return cache.size;
}

import stringSimilarity from "string-similarity";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

export interface ExternalOdds {
  source: "polymarket";
  question: string;
  url?: string;
  probs: number[];          // same order as Delphi outcomes when possible
  similarity: number;       // 0–1
  raw?: any;
}

const GAMMA = "https://gamma-api.polymarket.com";

/** Fetch a batch of active Polymarket markets */
export async function fetchPolymarketMarkets(limit = 50): Promise<any[]> {
  const url = new URL(`${GAMMA}/markets`);
  url.searchParams.set("closed", "false");
  url.searchParams.set("active", "true");
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithTimeout(url.toString(), {}, 15_000);
  if (!res.ok) throw new Error(`Polymarket Gamma ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data) ? data : data.markets ?? [];
}

/**
 * Find the best matching Polymarket market for a Delphi question.
 * Returns null if nothing is close enough.
 */
export async function findSimilarPolymarketOdds(
  delphiQuestion: string,
  delphiOutcomes: string[],
  minSimilarity = 0.55
): Promise<ExternalOdds | null> {
  const markets = await fetchPolymarketMarkets(80);

  // Score by title similarity
  const scored = markets
    .map((m) => {
      const title = m.question || m.title || "";
      const sim = stringSimilarity.compareTwoStrings(
        delphiQuestion.toLowerCase(),
        title.toLowerCase()
      );
      return { m, sim, title };
    })
    .filter((x) => x.sim >= minSimilarity)
    .sort((a, b) => b.sim - a.sim);

  if (scored.length === 0) return null;

  const best = scored[0];
  // Polymarket binary markets expose outcomePrices as strings "0.62","0.38"
  let probs: number[] = [];
  if (best.m.outcomePrices) {
    probs = best.m.outcomePrices.map((p: string) => parseFloat(p));
  } else if (best.m.tokens) {
    // fallback shape
    probs = best.m.tokens.map((t: any) => parseFloat(t.price ?? "0.5"));
  } else {
    probs = [0.5, 0.5]; // last resort
  }

  // crude alignment: if both binary, keep order; otherwise leave as-is
  // (you can improve later with outcome-label matching)

  return {
    source: "polymarket",
    question: best.title,
    url: best.m.slug ? `https://polymarket.com/event/${best.m.slug}` : undefined,
    probs,
    similarity: best.sim,
    raw: best.m,
  };
}
import { CONFIG } from "./config.js"
export interface Signal {
  name: "llm" | "gemini" | "polymarket";
  probs: number[];
  weight: number; // base weight before disagreement adjustment
}

export interface BlendResult {
  blendedProbs: number[];
  confidence: number;
  disagreement: number | null;
  edgeMultiplier: number; // >1 means "raise the edge bar", Infinity means "skip"
  skip: boolean;
  skipReason?: string;
}

/**
 * Very rough time-sensitivity heuristic: markets whose question text
 * implies a fast-moving, news-driven event benefit most from a
 * search-grounded second opinion. Tune this list freely — it's meant as
 * a cheap gate to avoid burning Gemini free-tier quota on slow-moving or
 * purely historical questions.
 */
const TIME_SENSITIVE_PATTERNS = [
  /\btoday\b/i,
  /\bthis week\b/i,
  /\btomorrow\b/i,
  /\bbreaking\b/i,
  /\belection\b/i,
  /\bannounce/i,
  /\brelease[sd]?\b/i,
  /\bwill .* (resign|win|lose|pass|approve|reject)\b/i,
  /\b(price|close|open) .* (today|by)\b/i,
];

export function isTimeSensitive(question: string): boolean {
  return TIME_SENSITIVE_PATTERNS.some((re) => re.test(question));
}

/**
 * Pairwise max-spread disagreement, measured on the outcome each signal
 * individually favors most (not just the LLM's favorite), so two models
 * confidently backing *different* outcomes shows up as high disagreement
 * even if their probability vectors overlap elsewhere.
 */
function computeDisagreement(signals: Signal[]): number | null {
  if (signals.length < 2) return null;
  let maxSpread = 0;
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const a = signals[i].probs;
      const b = signals[j].probs;
      const len = Math.max(a.length, b.length);
      for (let k = 0; k < len; k++) {
        const spread = Math.abs((a[k] ?? 0) - (b[k] ?? 0));
        if (spread > maxSpread) maxSpread = spread;
      }
    }
  }
  return maxSpread;
}

/**
 * Blend available signals (LLM always present; Gemini and Polymarket
 * optional) into one probability vector, and decide whether disagreement
 * between them should raise the edge bar or force a skip outright.
 */
export function blendSignals(signals: Signal[], outcomeLen: number): BlendResult {
  const disagreement = computeDisagreement(signals);

  let edgeMultiplier = 1;
  let skip = false;
  let skipReason: string | undefined;

  if (disagreement !== null) {
    if (disagreement >= CONFIG.disagreementHardThreshold) {
      skip = true;
      skipReason = `models disagree sharply (spread=${disagreement.toFixed(2)} >= hard threshold ${CONFIG.disagreementHardThreshold})`;
    } else if (disagreement >= CONFIG.disagreementSoftThreshold) {
      edgeMultiplier = CONFIG.disagreementEdgeMultiplier;
    }
  }

  const totalWeight = signals.reduce((a, s) => a + s.weight, 0) || 1;
  const blended = Array.from({ length: outcomeLen }, (_, i) =>
    signals.reduce((acc, s) => acc + s.weight * (s.probs[i] ?? 0), 0) / totalWeight
  );
  const sum = blended.reduce((a, b) => a + b, 0) || 1;
  const normalized = blended.map((p) => p / sum);

  return {
    blendedProbs: normalized,
    confidence: 0, // caller fills in — confidence comes from the primary LLM signal, not this blend
    disagreement,
    edgeMultiplier,
    skip,
    skipReason,
  };
}

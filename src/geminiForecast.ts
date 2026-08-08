import {
  getCandidateNodes,
  advanceCursor,
  markSuccess,
  markFailure,
  isDeadKeyError,
  type NodeState,
} from "./keyPool.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

/**
 * Selective backup forecaster. Only called for markets flagged
 * time-sensitive by the caller (see isTimeSensitive() in blend.ts) so we
 * don't burn free-tier quota on every market, and grounding (Google
 * Search) is only switched on for those same time-sensitive calls since
 * that's where a stale training cutoff actually hurts.
 *
 * Rotates through GEMINI_API_KEYS nodes the same way llmForecast.ts does:
 * a failing node goes on cooldown (or dead, for 401/403) and the next
 * node in the pool is tried immediately, up to NODE_MAX_RETRIES nodes.
 */

export interface GeminiForecast {
  probs: number[];
  confidence: number;
  grounded: boolean;
  reasoning?: string;
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

async function callGemini(
  node: NodeState,
  question: string,
  outcomes: string[],
  opts: { grounded: boolean }
): Promise<GeminiForecast> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${node.apiKey}`;

  const prompt = `You are a careful probabilistic forecaster for prediction markets.
Question: ${question}

Outcomes (in this exact order):
${outcomes.map((o, i) => `${i}: ${o}`).join("\n")}

Estimate a calibrated probability for each outcome (sum to 1.0), plus a
confidence score in [0,1] (0.3 = weak/guessy, 0.8+ = strong evidence).
Avoid extreme 0%/100% unless the outcome is essentially certain.

Return ONLY this JSON object, no markdown fences, no extra text:
{"probs": [number, ...], "confidence": number, "reasoning": "1-3 sentences"}`;

  const body: any = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  };

  if (opts.grounded) {
    body.tools = [{ google_search: {} }];
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    25_000
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err: any = new Error(`Gemini HTTP ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const data: any = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "{}";
  const cleaned = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned) as {
    probs?: number[];
    confidence?: number;
    reasoning?: string;
  };

  let probs = Array.isArray(parsed.probs) ? parsed.probs.map(Number) : [];
  while (probs.length < outcomes.length) probs.push(0);
  probs = probs.slice(0, outcomes.length);
  const sum = probs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  probs =
    sum > 0
      ? probs.map((p) => (Number.isFinite(p) ? p : 0) / sum)
      : Array.from({ length: outcomes.length }, () => 1 / outcomes.length);

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0.05, Math.min(0.95, confidence));

  const groundedActual = Boolean(data?.candidates?.[0]?.groundingMetadata) || opts.grounded;

  console.log(
    `  [Gemini:${node.label}${groundedActual ? "+search" : ""}] probs=[${probs
      .map((p) => p.toFixed(3))
      .join(", ")}] conf=${confidence.toFixed(2)}`
  );

  return { probs, confidence, grounded: groundedActual, reasoning: parsed.reasoning };
}

export async function getGeminiForecast(
  question: string,
  outcomes: string[],
  opts: { grounded: boolean }
): Promise<GeminiForecast | null> {
  const candidates = getCandidateNodes("gemini");

  if (candidates.length === 0) {
    return null; // no keys configured — caller treats as "signal unavailable", not zero-fill
  }

  let lastErr: unknown;
  for (const node of candidates) {
    try {
      const result = await callGemini(node, question, outcomes, opts);
      markSuccess(node);
      advanceCursor("gemini");
      return result;
    } catch (err) {
      lastErr = err;
      markFailure(node, err, { dead: isDeadKeyError(err) });
      console.warn(
        `  [Gemini] node ${node.label} failed (${isDeadKeyError(err) ? "dead" : "cooldown"}), trying next…`,
        err instanceof Error ? err.message : err
      );
    }
  }

  advanceCursor("gemini");
  console.warn(
    "  [Gemini] all candidate nodes failed this request:",
    lastErr instanceof Error ? lastErr.message : lastErr
  );
  return null; 
}

export default getGeminiForecast;
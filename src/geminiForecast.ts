import { CONFIG } from "./config.js";

/**
 * Selective backup forecaster. Only called for markets flagged
 * time-sensitive by the caller (see isTimeSensitive() in blend.ts) so we
 * don't burn free-tier quota on every market, and grounding (Google
 * Search) is only switched on for those same time-sensitive calls since
 * that's where a stale training cutoff actually hurts.
 *
 * Uses the plain REST endpoint rather than a client library so this file
 * has zero extra deps beyond `dotenv`. Swap in `@google/genai` if you'd
 * rather have typed responses.
 */

export interface GeminiForecast {
  probs: number[];
  confidence: number;
  grounded: boolean;
  reasoning?: string;
}

export async function getGeminiForecast(
  question: string,
  outcomes: string[],
  opts: { grounded: boolean }
): Promise<GeminiForecast | null> {
  if (!CONFIG.geminiEnabled || !CONFIG.geminiApiKey) {
    return null; // no key configured — caller should treat as "signal unavailable", not zero-fill
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent?key=${CONFIG.geminiApiKey}`;

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

  // Grounding only for time-sensitive markets, per scope.
  if (opts.grounded) {
    body.tools = [{ google_search: {} }];
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`  [Gemini] HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
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

    // Was grounding actually used, per the API's own report? Fall back to
    // what we requested if the field isn't present in this API version.
    const groundedActual =
      Boolean(data?.candidates?.[0]?.groundingMetadata) || opts.grounded;

    console.log(
      `  [Gemini${groundedActual ? "+search" : ""}] probs=[${probs
        .map((p) => p.toFixed(3))
        .join(", ")}] conf=${confidence.toFixed(2)}`
    );

    return { probs, confidence, grounded: groundedActual, reasoning: parsed.reasoning };
  } catch (err) {
    console.warn("  [Gemini] forecast failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export default getGeminiForecast;

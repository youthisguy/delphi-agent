import OpenAI from "openai";
import {
  getCandidateNodes,
  advanceCursor,
  markSuccess,
  markFailure,
  isDeadKeyError,
  type NodeState,
} from "./keyPool.js";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function uniformFallback(outcomes: string[], confidence: number) {
  const n = Math.max(outcomes.length, 2);
  return { probs: Array.from({ length: n }, () => 1 / n), confidence };
}

async function callOpenAi(
  node: NodeState,
  question: string,
  outcomes: string[]
): Promise<{ probs: number[]; confidence: number; reasoning?: string }> {
  const openai = new OpenAI({ apiKey: node.apiKey, timeout: 30_000, maxRetries: 1 });

  const system = `You are a careful probabilistic forecaster for prediction markets.
You estimate probabilities from public historical patterns, base rates, and current context.
Be calibrated: avoid extreme 0% or 100% unless the outcome is essentially certain.
Always output valid JSON only. No markdown, no extra text.`;

  const user = `Question: ${question}

Outcomes (in this exact order):
${outcomes.map((o, i) => `${i}: ${o}`).join("\n")}

Today's date context: August 2026.

Tasks:
1. Estimate a probability for each outcome. The probabilities MUST sum to 1.0.
2. Give a confidence score between 0 and 1 reflecting how solid your estimate is
   (0.3 = weak/guessy, 0.6 = moderate, 0.8+ = strong evidence).
3. Briefly explain the key reasons (2-4 sentences).

Return ONLY this JSON shape:
{
  "probs": [number, number, ...],
  "confidence": number,
  "reasoning": "string"
}`;

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as {
    probs?: number[];
    confidence?: number;
    reasoning?: string;
  };

  let probs = Array.isArray(parsed.probs) ? parsed.probs.map(Number) : [];
  while (probs.length < outcomes.length) probs.push(0);
  probs = probs.slice(0, outcomes.length);

  const sum = probs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (sum <= 0) {
    probs = Array.from({ length: outcomes.length }, () => 1 / outcomes.length);
  } else {
    probs = probs.map((p) => (Number.isFinite(p) ? p : 0) / sum);
  }

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0.05, Math.min(0.95, confidence));

  console.log(
    `  [LLM:${node.label}] probs=[${probs.map((p) => p.toFixed(3)).join(", ")}] conf=${confidence.toFixed(2)}`
  );
  if (parsed.reasoning) {
    console.log(`  [LLM:${node.label}] reason: ${parsed.reasoning.slice(0, 160)}...`);
  }

  return { probs, confidence, reasoning: parsed.reasoning };
}

/**
 * Ask ChatGPT for a probability distribution over the given outcomes.
 * Rotates through OPENAI_API_KEYS nodes: if the active node fails
 * (rate-limited, out of credits, revoked), it's marked cooldown/dead and
 * the next node in the pool is tried immediately, up to NODE_MAX_RETRIES
 * nodes. Only if every candidate fails does this fall back to a uniform
 * prior with low confidence — the loop keeps running either way.
 */
export async function getLlmForecast(
  question: string,
  outcomes: string[]
): Promise<{ probs: number[]; confidence: number; reasoning?: string }> {
  const candidates = getCandidateNodes("openai");

  if (candidates.length === 0) {
    console.warn("  [LLM] no usable OpenAI nodes in pool — falling back to uniform");
    return uniformFallback(outcomes, 0.3);
  }

  let lastErr: unknown;
  for (const node of candidates) {
    try {
      const result = await callOpenAi(node, question, outcomes);
      markSuccess(node);
      advanceCursor("openai");
      return result;
    } catch (err) {
      lastErr = err;
      markFailure(node, err, { dead: isDeadKeyError(err) });
      console.warn(
        `  [LLM] node ${node.label} failed (${isDeadKeyError(err) ? "dead" : "cooldown"}), trying next…`,
        err instanceof Error ? err.message : err
      );
    }
  }

  advanceCursor("openai");
  console.error(
    "  [LLM] all candidate nodes failed this request:",
    lastErr instanceof Error ? lastErr.message : lastErr
  );
  return uniformFallback(outcomes, 0.25);
}

export default getLlmForecast;
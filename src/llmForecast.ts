import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Ask ChatGPT for a probability distribution over the given outcomes.
 * Returns probs that (approximately) sum to 1 and a confidence in [0,1].
 */
export async function getLlmForecast(
  question: string,
  outcomes: string[]
): Promise<{ probs: number[]; confidence: number; reasoning?: string }> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("  [LLM] OPENAI_API_KEY missing — falling back to uniform");
    const n = Math.max(outcomes.length, 2);
    return { probs: Array.from({ length: n }, () => 1 / n), confidence: 0.3 };
  }

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

  try {
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
    // Pad / trim to match outcomes length
    while (probs.length < outcomes.length) probs.push(0);
    probs = probs.slice(0, outcomes.length);

    // Normalize so they sum to 1
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
      `  [LLM] probs=[${probs.map((p) => p.toFixed(3)).join(", ")}] conf=${confidence.toFixed(2)}`
    );
    if (parsed.reasoning) {
      console.log(`  [LLM] reason: ${parsed.reasoning.slice(0, 160)}...`);
    }

    return { probs, confidence, reasoning: parsed.reasoning };
  } catch (err) {
    console.error(
      "  [LLM] forecast failed:",
      err instanceof Error ? err.message : err
    );
    const n = Math.max(outcomes.length, 2);
    return {
      probs: Array.from({ length: n }, () => 1 / n),
      confidence: 0.25,
    };
  }
}

export default getLlmForecast;
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
 * Position-delta check — distinct from geminiForecast.ts's
 * getGeminiForecast(). That function asks "what's your prior on this
 * question" from scratch; this asks "has anything happened SINCE we
 * entered that should change our mind." Re-asking the entry prompt on a
 * timer would just surface sampling noise as false "news" — this prompt
 * is anchored to the entry price/outcome and requires a cited, dated
 * development before it's allowed to report anything above "minor"
 * severity.
 *
 * Always grounded (google_search on) — unlike the entry forecaster,
 * which only grounds time-sensitive questions (see blend.ts's
 * isTimeSensitive()), there's no ungrounded version of this call that
 * makes sense: the entire point is live search. It rotates through the
 * SAME Gemini key pool as the entry forecaster (keyPool.ts) and
 * competes for the same quota, not a separate one.
 */

export type Severity = "none" | "minor" | "moderate" | "severe";

export interface PositionCheckResult {
  newsFound: boolean;
  updatedProbs: number[];
  severity: Severity;
  confidence: number; // 0-1, self-reported by Gemini — not independently calibrated
  sourceSummary?: string;
  grounded: boolean;
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const VALID_SEVERITIES: Severity[] = ["none", "minor", "moderate", "severe"];

function buildPrompt(
  question: string,
  outcomes: string[],
  entryOutcomeIdx: number,
  entryProb: number,
  currentProb: number,
  lookbackHours: number
): string {
  return `You are monitoring an ALREADY-OPEN prediction market position for news that would
change the outcome — you are NOT producing a fresh independent forecast.

Question: ${question}

Outcomes (in this exact order):
${outcomes.map((o, i) => `${i}: ${o}`).join("\n")}

We currently hold outcome ${entryOutcomeIdx} ("${outcomes[entryOutcomeIdx]}").
Our estimate when we entered this position was ~${entryProb.toFixed(2)} for that outcome.
The market's current implied price for that outcome is ${currentProb.toFixed(2)}.

Search for news, announcements, or developments in roughly the last ${lookbackHours} hours
that are SPECIFICALLY relevant to this question — not general background, not commentary,
not "here's why the outcome was always uncertain."

Then answer:
1. Is there a specific, dated, sourced development since our entry that changes the likely
   outcome? Ongoing uncertainty or "still too early to tell" does NOT count as news found.
2. If yes, your updated probability for each outcome (sum to 1.0).
3. A severity rating for how much this changes the position:
   - "none": no relevant new development found
   - "minor": some new information, but the position's original thesis still holds
   - "moderate": edge has shrunk meaningfully, worth a human reviewing manually
   - "severe": the position's original thesis is broken or reversed by this development
4. Confidence in this assessment, 0-1. If you are not highly confident there is a specific
   dated development driving this, do NOT report "severe" — cap severity at "moderate" when
   unsure. Confidence should reflect how solid the SOURCE is, not how interesting the story is.

Return ONLY this JSON object, no markdown fences, no extra text:
{"newsFound": boolean, "updatedProbs": [number, ...], "severity": "none"|"minor"|"moderate"|"severe",
 "confidence": number, "sourceSummary": "1-2 sentences citing what changed, or empty string"}`;
}

async function callGemini(node: NodeState, prompt: string): Promise<PositionCheckResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${node.apiKey}`;

  const body: any = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 },
    tools: [{ google_search: {} }], // always on — see module doc comment
  };

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
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
  const parsed = JSON.parse(cleaned) as Partial<PositionCheckResult>;

  const rawSeverity = parsed.severity;
  const parsedSeverity: Severity = VALID_SEVERITIES.includes(rawSeverity as Severity)
    ? (rawSeverity as Severity)
    : "none";

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const newsFound = Boolean(parsed.newsFound);

  // Guardrail matching the prompt's own instruction (models don't always
  // follow instructions): severity can't be reported above "minor"
  // without newsFound === true. This is enforced here in code, not just
  // asked for in the prompt, since this value directly gates auto-exit.
  const severity: Severity = !newsFound && parsedSeverity !== "none" ? "minor" : parsedSeverity;

  const updatedProbs = Array.isArray(parsed.updatedProbs)
    ? parsed.updatedProbs.map(Number).filter(Number.isFinite)
    : [];

  const grounded = Boolean(data?.candidates?.[0]?.groundingMetadata);

  console.log(
    `  [Gemini-watch:${node.label}${grounded ? "+search" : ""}] severity=${severity} conf=${confidence.toFixed(
      2
    )} newsFound=${newsFound}`
  );

  return { newsFound, updatedProbs, severity, confidence, sourceSummary: parsed.sourceSummary, grounded };
}

export async function getGeminiPositionCheck(
  question: string,
  outcomes: string[],
  entryOutcomeIdx: number,
  entryProb: number,
  currentProb: number,
  lookbackHours: number
): Promise<PositionCheckResult | null> {
  const candidates = getCandidateNodes("gemini");
  if (candidates.length === 0) return null; // no keys configured — caller treats as "couldn't check", not "nothing changed"

  const prompt = buildPrompt(question, outcomes, entryOutcomeIdx, entryProb, currentProb, lookbackHours);

  let lastErr: unknown;
  for (const node of candidates) {
    try {
      const result = await callGemini(node, prompt);
      markSuccess(node);
      advanceCursor("gemini");
      return result;
    } catch (err) {
      lastErr = err;
      markFailure(node, err, { dead: isDeadKeyError(err) });
      console.warn(
        `  [Gemini-watch] node ${node.label} failed (${isDeadKeyError(err) ? "dead" : "cooldown"}), trying next…`,
        err instanceof Error ? err.message : err
      );
    }
  }

  advanceCursor("gemini");
  console.warn(
    "  [Gemini-watch] all candidate nodes failed this check:",
    lastErr instanceof Error ? lastErr.message : lastErr
  );
  return null;
}

export default getGeminiPositionCheck;

import OpenAI from "openai";
import {
  getCandidateNodes,
  advanceCursor,
  markSuccess,
  markFailure,
  isDeadKeyError,
  type NodeState,
  type Provider,
} from "../keyPool.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";
import { EV } from "./evidenceConfig.js";
import { isCompat, compatEnabled, compatCandidates, compatAdvance, compatFail, callCompat } from "./compatLlm.js";

/** Error text can embed the request URL (Gemini puts ?key=... in it) — never log keys. */
export const redact = (s: string): string =>
  s.replace(/([?&]key=)[^&\s"']+/gi, "$1***").replace(/\b(sk-|gsk_|ghp_|csk-|AIza)[A-Za-z0-9_-]{8,}/g, "$1***");
const msg = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

/** Per-provider usage since process start — snapshotted into evidence-status.json for the dashboard. */
export const llmStats: Record<string, { ok: number; fail: number; lastOkAt?: string; lastError?: string; lastErrorAt?: string }> = {};
function stat(p: string, ok: boolean, err?: unknown) {
  const s = (llmStats[p] ??= { ok: 0, fail: 0 });
  const now = new Date().toISOString();
  if (ok) { s.ok++; s.lastOkAt = now; } else { s.fail++; s.lastError = msg(err).slice(0, 160); s.lastErrorAt = now; }
}

/**
 * Thin generic wrapper over keyPool.ts (which is untouched). Text-in/JSON-out
 * only — the LLM never browses; it only sees text our search/fetch layer gave it.
 * Same node semantics as llmForecast.ts / geminiForecast.ts: a failing node goes
 * cooldown/dead and the next is tried. A JSON *parse/validation* failure is NOT a
 * node failure (the key is fine) — we just try the next candidate without penalising it.
 */

export interface JsonCall<T> {
  label: string;
  system: string;
  user: string;
  validate: (raw: unknown) => T;
  temperature?: number;
}

export interface JsonResult<T> {
  data: T;
  provider: Provider;
  node: string;
}

async function callOpenAi(node: NodeState, system: string, user: string, temperature: number): Promise<string> {
  const client = new OpenAI({ apiKey: node.apiKey, timeout: 30_000, maxRetries: 0 });
  const c = await client.chat.completions.create({
    model: EV.openaiModel,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return c.choices[0]?.message?.content ?? "{}";
}

async function callGemini(node: NodeState, system: string, user: string, temperature: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EV.geminiModel}:generateContent?key=${node.apiKey}`;
  // NOTE: deliberately NO google_search grounding here — live data stays in the search layer.
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature, responseMimeType: "application/json" },
      }),
    },
    30_000
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err: any = new Error(`Gemini HTTP ${res.status}: ${redact(t).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data: any = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "{}";
}

export function parseJsonLoose(text: string): unknown {
  // reasoning models (qwen, deepseek-r1…) may emit <think>…</think> first; braces in it would corrupt extraction
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("no JSON object in LLM output");
  }
}

export async function generateJson<T>(call: JsonCall<T>): Promise<JsonResult<T>> {
  const temperature = call.temperature ?? 0.1;
  let lastErr: unknown = new Error("no usable LLM nodes (check EVIDENCE_LLM_ORDER and that keys are set)");

  const tryParse = (text: string, label: string, provider: string) => {
    try {
      const r = { data: call.validate(parseJsonLoose(text)), provider, node: label };
      stat(provider, true);
      return r;
    } catch (err) {
      lastErr = err;
      stat(provider, false, err);
      console.warn(`  [llm:${call.label}] ${label} returned unusable JSON: ${msg(err)}`);
      return null;
    }
  };

  for (const name of EV.llmOrder) {
    if (isCompat(name)) {
      if (!compatEnabled(name)) continue;
      for (const k of compatCandidates(name)) {
        let text: string;
        try {
          text = await callCompat(name, k, call.system, call.user, temperature);
        } catch (err) {
          lastErr = err;
          stat(name, false, err);
          compatFail(k, err);
          console.warn(`  [llm:${call.label}] ${name} failed, trying next…`, msg(err).slice(0, 160));
          continue;
        }
        const ok = tryParse(text, name, name);
        if (ok) { compatAdvance(name); return ok as JsonResult<T>; }
      }
      compatAdvance(name);
      continue;
    }

    const provider = name as Provider;
    if (provider !== "openai" && provider !== "gemini") continue;
    for (const node of getCandidateNodes(provider)) {
      let text: string;
      try {
        text = provider === "openai"
          ? await callOpenAi(node, call.system, call.user, temperature)
          : await callGemini(node, call.system, call.user, temperature);
        markSuccess(node);
      } catch (err) {
        lastErr = err;
        stat(provider, false, err);
        markFailure(node, err, { dead: isDeadKeyError(err) });
        console.warn(`  [llm:${call.label}] ${node.label} failed, trying next…`, msg(err).slice(0, 160));
        continue;
      }
      const ok = tryParse(text, node.label, provider);
      if (ok) { advanceCursor(provider); return ok as JsonResult<T>; }
    }
    advanceCursor(provider);
  }
  throw new Error(`[llm:${call.label}] all providers failed: ${msg(lastErr).slice(0, 200)}`);
}

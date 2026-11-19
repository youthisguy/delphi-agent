import OpenAI from "openai";

/**
 * Free/cheap OpenAI-compatible providers, bolted on beside keyPool.ts (which is untouched).
 * Each is enabled simply by setting its key; override the model with <NAME>_MODEL.
 * List a provider's real model names with e.g.:
 *   curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
 */
export type CompatName = "groq" | "cerebras" | "openrouter" | "deepseek";

interface Preset { baseURL: string; keyEnvs: string[]; modelEnv: string; defaultModel: string }

const PRESETS: Record<CompatName, Preset> = {
  groq: { baseURL: "https://api.groq.com/openai/v1", keyEnvs: ["GROQ_API_KEYS", "GROQ_API_KEY"], modelEnv: "GROQ_MODEL", defaultModel: "llama-3.3-70b-versatile" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", keyEnvs: ["CEREBRAS_API_KEYS", "CEREBRAS_API_KEY"], modelEnv: "CEREBRAS_MODEL", defaultModel: "llama-3.3-70b" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnvs: ["OPENROUTER_API_KEYS", "OPENROUTER_API_KEY"], modelEnv: "OPENROUTER_MODEL", defaultModel: "meta-llama/llama-3.3-70b-instruct:free" },
  deepseek: { baseURL: "https://api.deepseek.com", keyEnvs: ["DEEPSEEK_API_KEYS", "DEEPSEEK_API_KEY"], modelEnv: "DEEPSEEK_MODEL", defaultModel: "deepseek-chat" },
};

export const isCompat = (n: string): n is CompatName => n in PRESETS;

interface KeyState { key: string; cooldownUntil: number; dead: boolean }
const pools = new Map<CompatName, { keys: KeyState[]; cursor: number; nextSlot: number }>();

const COOLDOWN_MS = Number(process.env.COMPAT_COOLDOWN_MS ?? 90_000);
// Free tiers cap requests/minute; space calls out instead of tripping 429s.
const MIN_GAP_MS = Number(process.env.COMPAT_MIN_GAP_MS ?? 2_200);
const MAX_TRIES = Number(process.env.COMPAT_MAX_TRIES ?? 2);

function pool(name: CompatName) {
  let p = pools.get(name);
  if (!p) {
    const keys = PRESETS[name].keyEnvs
      .flatMap((k) => (process.env[k] ?? "").split(","))
      .map((s) => s.trim())
      .filter((s) => s && s !== "...");
    p = { keys: [...new Set(keys)].map((key) => ({ key, cooldownUntil: 0, dead: false })), cursor: 0, nextSlot: 0 };
    pools.set(name, p);
  }
  return p;
}

export function compatEnabled(name: CompatName): boolean {
  return pool(name).keys.length > 0;
}

export function compatCandidates(name: CompatName): KeyState[] {
  const p = pool(name);
  const now = Date.now();
  const n = p.keys.length;
  const ordered = Array.from({ length: n }, (_, i) => p.keys[(p.cursor + i) % n]);
  return ordered.filter((k) => !k.dead && k.cooldownUntil <= now).slice(0, MAX_TRIES);
}

export function compatAdvance(name: CompatName) {
  const p = pool(name);
  if (p.keys.length) p.cursor = (p.cursor + 1) % p.keys.length;
}

export function compatFail(k: KeyState, err: unknown) {
  const s = (err as any)?.status;
  if (s === 401 || s === 403) k.dead = true;
  else k.cooldownUntil = Date.now() + COOLDOWN_MS;
}

async function throttle(name: CompatName) {
  const p = pool(name);
  const at = Math.max(Date.now(), p.nextSlot);
  p.nextSlot = at + MIN_GAP_MS;
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function callCompat(name: CompatName, k: KeyState, system: string, user: string, temperature: number): Promise<string> {
  const pre = PRESETS[name];
  await throttle(name);
  const client = new OpenAI({ apiKey: k.key, baseURL: pre.baseURL, timeout: 30_000, maxRetries: 0 });
  const model = process.env[pre.modelEnv] || pre.defaultModel;
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  try {
    const c = await client.chat.completions.create({ model, temperature, messages, response_format: { type: "json_object" } });
    return c.choices[0]?.message?.content ?? "{}";
  } catch (err: any) {
    // Some free models reject json mode — retry once without it (parseJsonLoose copes with fences).
    if (err?.status === 400) {
      const c = await client.chat.completions.create({ model, temperature, messages });
      return c.choices[0]?.message?.content ?? "{}";
    }
    throw err;
  }
}

export function compatStatus() {
  const now = Date.now();
  return (Object.keys(PRESETS) as CompatName[]).map((name) => {
    const keys = pool(name).keys;
    return {
      name,
      model: process.env[PRESETS[name].modelEnv] || PRESETS[name].defaultModel,
      keys: keys.length,
      ok: keys.filter((k) => !k.dead && k.cooldownUntil <= now).length,
      cooldown: keys.filter((k) => !k.dead && k.cooldownUntil > now).length,
      dead: keys.filter((k) => k.dead).length,
    };
  });
}

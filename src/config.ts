import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

/**
 * Central, hot-reloadable config. Most values come from env, but `dryRun`
 * can also be flipped at runtime via the dashboard (POST /api/dryrun),
 * which writes to data/runtime-config.json. That file wins over env
 * on every read so the dashboard toggle survives loop iterations without
 * a restart.
 */

const DATA_DIR = path.resolve(process.cwd(), "data");
const RUNTIME_CONFIG_PATH = path.join(DATA_DIR, "runtime-config.json");

export interface RuntimeConfig {
  dryRun: boolean;
  /**
   * Contract address of the trding competition token
   */
  competitionTokenAddress: string | null;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readRuntimeConfig(): RuntimeConfig {
  ensureDataDir();
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
    const initial: RuntimeConfig = {
      // Default is dry-run ON. This is a safety default: the scope calls
      // for keeping dry-run on until the receipt ledger + settled win-rate
      // pipeline + dashboard are producing stable numbers. Flip explicitly
      // via the dashboard or DRY_RUN=false once you're ready.
      dryRun: process.env.DRY_RUN !== "false",
      competitionTokenAddress: process.env.COMPETITION_TOKEN_ADDRESS || null,
    };
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    return {
      dryRun: typeof parsed.dryRun === "boolean" ? parsed.dryRun : true,
      competitionTokenAddress:
        typeof parsed.competitionTokenAddress === "string" ? parsed.competitionTokenAddress : null,
    };
  } catch {
    return { dryRun: true, competitionTokenAddress: null };
  }
}

export function getDryRun(): boolean {
  return readRuntimeConfig().dryRun;
}

/** Merges onto the existing file rather than overwriting it — dryRun and
 * competitionTokenAddress now share runtime-config.json, so a write from
 * one must not blow away the other. */
export function setDryRun(value: boolean): RuntimeConfig {
  ensureDataDir();
  const cfg: RuntimeConfig = { ...readRuntimeConfig(), dryRun: value };
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

export function getCompetitionTokenAddress(): string | null {
  return readRuntimeConfig().competitionTokenAddress;
}

/** Pass null to clear back to "unknown" (e.g. if you swap CAs mid-competition). */
export function setCompetitionTokenAddress(address: string | null): RuntimeConfig {
  ensureDataDir();
  const cfg: RuntimeConfig = { ...readRuntimeConfig(), competitionTokenAddress: address };
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

export const CONFIG = {
  loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS ?? 5 * 60 * 1000),
  maxTokensPerTrade: Number(process.env.MAX_TOKENS_PER_TRADE ?? 10),
  maxMarketsPerLoop: Number(process.env.MAX_MARKETS_PER_LOOP ?? 50),

  // Server
  port: Number(process.env.PORT ?? 8787),

  // Gemini backup forecaster — enabled if either a single key or a pool is set.
  // The actual key(s) used at call time come from keyPool.ts, not this field.
  geminiEnabled: Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS),
  geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",

  // Agreement / disagreement rules for blending LLM + Gemini + Polymarket
  disagreementSoftThreshold: Number(process.env.DISAGREEMENT_SOFT ?? 0.15), // raise edge bar
  disagreementHardThreshold: Number(process.env.DISAGREEMENT_HARD ?? 0.30), // skip entirely
  disagreementEdgeMultiplier: Number(process.env.DISAGREEMENT_EDGE_MULT ?? 1.5),

  dataDir: DATA_DIR,
  journalPath: path.join(DATA_DIR, "journal.jsonl"),
  summaryPath: path.join(DATA_DIR, "summary.json"),
  loopStatusPath: path.join(DATA_DIR, "loop-status.json"),
  backtestLogDir: path.join(DATA_DIR, "backtests"),
};

ensureDataDir();
if (!fs.existsSync(CONFIG.backtestLogDir)) {
  fs.mkdirSync(CONFIG.backtestLogDir, { recursive: true });
}
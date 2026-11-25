import path from "node:path";
import { CONFIG } from "../config.js";

const e = process.env;
const num = (k: string, d: number): number => {
  const v = Number(e[k]);
  return e[k] !== undefined && e[k] !== "" && Number.isFinite(v) ? v : d;
};
const bool = (k: string, d: boolean): boolean => (e[k] === undefined || e[k] === "" ? d : e[k] !== "false");
const list = (k: string, d: string): string[] =>
  (e[k] ?? d).split(",").map((s) => s.trim()).filter(Boolean);

/** Competition rules — hard-coded on purpose, NOT env-configurable. */
export const COMPETITION_RULES = Object.freeze({
  maxSubmissionsPerMarket: 3,
  maxSupportingFiles: 3,
  maxItemsPerSubmission: 3, // note + links + files
  maxTotalFileBytes: 10 * 1024 * 1024,
  minJudgedSubmissions: 10,
  minJudgedMarkets: 3,
});

export type RunMode = "evidence" | "trade" | "both";

export const EV = {
  mode: (["evidence", "trade", "both"].includes(e.MODE ?? "") ? e.MODE : "evidence") as RunMode,

  journalPath: e.EVIDENCE_JOURNAL_PATH || path.join(CONFIG.dataDir, "evidence.jsonl"),
  statusPath: e.EVIDENCE_STATUS_PATH || path.join(CONFIG.dataDir, "evidence-status.json"),
  triggerPath: path.join(CONFIG.dataDir, "evidence-trigger.json"),
  holdsPath: path.join(CONFIG.dataDir, "evidence-holds.json"),
  filesDir: path.join(CONFIG.dataDir, "evidence-files"),
  maxHumanFileBytes: num("EVIDENCE_MAX_FILE_BYTES", 5 * 1024 * 1024),

  // loop pacing
  cycleIntervalMs: num("EVIDENCE_CYCLE_MS", 10 * 60 * 1000),
  maxMarketsPerCycle: num("EVIDENCE_MAX_MARKETS_PER_CYCLE", 5),
  marketCooldownMs: num("EVIDENCE_MARKET_COOLDOWN_MS", 30 * 60 * 1000),
  autoCheckpoint: bool("EVIDENCE_AUTO_CHECKPOINT", true),
  mockMarkets: bool("EVIDENCE_MOCK_MARKETS", false),

  // FORCE MODE: submit even when the novelty gate would reject (hard competition rules still apply)
  forceSubmit: bool("EVIDENCE_FORCE_SUBMIT", false),

  // search / fetch
  searchProviders: list("SEARCH_PROVIDERS", "tavily,serper,exa,brave"),
  searchFanout: num("SEARCH_FANOUT", 2), // providers queried per query
  queriesPerMarket: num("EVIDENCE_QUERIES_PER_MARKET", 4),
  resultsPerQuery: num("EVIDENCE_RESULTS_PER_QUERY", 8),
  recencyDays: num("EVIDENCE_RECENCY_DAYS", 14),
  maxDocsPerMarket: num("EVIDENCE_MAX_DOCS_PER_MARKET", 6),
  fetchConcurrency: num("EVIDENCE_FETCH_CONCURRENCY", 3),
  perDomainDelayMs: num("EVIDENCE_PER_DOMAIN_DELAY_MS", 2000),
  maxDocChars: num("EVIDENCE_MAX_DOC_CHARS", 9000),
  blockedDomains: list(
    "EVIDENCE_BLOCKED_DOMAINS",
    "facebook.com,instagram.com,x.com,twitter.com,tiktok.com,linkedin.com,pinterest.com,reddit.com"
  ),
  userAgent:
    e.EVIDENCE_USER_AGENT ||
    "PringlesAgent/1.0 (+public-evidence-research; respects robots.txt)",

  // playwright (fallback only)
  playwrightEnabled: bool("PLAYWRIGHT_ENABLED", false),
  playwrightTimeoutMs: num("PLAYWRIGHT_TIMEOUT_MS", 20_000),
  playwrightProxy: e.PLAYWRIGHT_PROXY || null, // e.g. http://user:pass@host:port

  // quality filter
  minRelevance: num("EVIDENCE_MIN_RELEVANCE", 0.5),
  minNoveltyScore: num("EVIDENCE_MIN_SCORE", 0.6),
  dupJaccard: num("EVIDENCE_DUP_JACCARD", 0.55),
  maxSourceAgeDays: num("EVIDENCE_MAX_SOURCE_AGE_DAYS", 45),
  maxNoteWords: num("EVIDENCE_MAX_NOTE_WORDS", 110),
  maxNoteChars: num("EVIDENCE_MAX_NOTE_CHARS", 1500),

  // llm
  // providers without keys are skipped instantly, so a long default order is harmless
  llmOrder: list("EVIDENCE_LLM_ORDER", "groq,cerebras,openrouter,deepseek,gemini,openai"),
  openaiModel: e.OPENAI_MODEL || "gpt-4o-mini",
  geminiModel: e.GEMINI_MODEL || "gemini-flash-latest",

  // prioritizer
  topicFit: list("EVIDENCE_TOPIC_FIT", "politics,macro,crypto,tech,sports,current_events"),

  // submission API (Delphi Evidence API)
  apiUrl: e.EVIDENCE_API_URL || null,
  agentId: e.EVIDENCE_AGENT_ID || null,
  harness: e.EVIDENCE_HARNESS || "pringles-evidence",
  model: e.EVIDENCE_MODEL || e.OPENAI_MODEL || e.GEMINI_MODEL || "multi",
  apiKey: e.DELPHI_API_ACCESS_KEY || e.EVIDENCE_API_KEY || null,
};

import "dotenv/config";
import OpenAI from "openai";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

export type Provider = "openai" | "gemini";
export type NodeStatus = "ok" | "cooldown" | "dead" | "untested";

export interface NodeState {
  id: string;
  provider: Provider;
  label: string;
  apiKey: string;
  status: NodeStatus;
  lastError?: string;
  lastCheckedAt?: string;
  cooldownUntil?: number; // epoch ms, only meaningful while status === "cooldown"
  failCount: number;
}

export interface NodeView {
  id: string;
  provider: Provider;
  label: string;
  status: NodeStatus;
  lastError?: string;
  lastCheckedAt?: string;
  failCount: number;
}

const COOLDOWN_MS = Number(process.env.NODE_COOLDOWN_MS ?? 5 * 60 * 1000);
const MAX_RETRIES_PER_REQUEST = Number(process.env.NODE_MAX_RETRIES ?? 3);

function parseKeyList(envVar: string, fallbackSingle?: string): string[] {
  const raw = process.env[envVar];
  const keys = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (keys.length === 0 && fallbackSingle) keys.push(fallbackSingle);
  // de-dupe while preserving order
  return [...new Set(keys)];
}

const nodes: NodeState[] = [];

function buildPool() {
  if (nodes.length) return; // idempotent — module singleton

  const openaiKeys = parseKeyList("OPENAI_API_KEYS", process.env.OPENAI_API_KEY);
  openaiKeys.forEach((key, i) => {
    nodes.push({
      id: `openai-${i}`,
      provider: "openai",
      label: `OpenAI #${i + 1}`,
      apiKey: key,
      status: "untested",
      failCount: 0,
    });
  });

  const geminiKeys = parseKeyList("GEMINI_API_KEYS", process.env.GEMINI_API_KEY);
  geminiKeys.forEach((key, i) => {
    nodes.push({
      id: `gemini-${i}`,
      provider: "gemini",
      label: `Gemini #${i + 1}`,
      apiKey: key,
      status: "untested",
      failCount: 0,
    });
  });
}

buildPool();

// Round-robin cursor per provider, advanced on every successful pick so
// consecutive requests spread load across nodes rather than hammering #1.
const cursors: Record<Provider, number> = { openai: 0, gemini: 0 };

function isUsable(n: NodeState): boolean {
  if (n.status === "dead") return false;
  if (n.status === "cooldown") {
    if (n.cooldownUntil !== undefined && Date.now() >= n.cooldownUntil) {
      n.status = "ok";
      n.cooldownUntil = undefined;
      return true;
    }
    return false;
  }
  return true; // "ok" or "untested"
}

export function getNodesForProvider(provider: Provider): NodeState[] {
  return nodes.filter((n) => n.provider === provider);
}

/**
 * Ordered candidates to try for ONE request. Starts at the round-robin
 * cursor, wraps around the pool, skips dead/cooling nodes, capped at
 * MAX_RETRIES_PER_REQUEST so a bad pool can't stall a single forecast call
 * indefinitely.
 */
export function getCandidateNodes(provider: Provider): NodeState[] {
  const pool = getNodesForProvider(provider);
  if (pool.length === 0) return [];
  const start = cursors[provider] % pool.length;
  const ordered = [...pool.slice(start), ...pool.slice(0, start)];
  return ordered.filter(isUsable).slice(0, MAX_RETRIES_PER_REQUEST);
}

/** Call after a node is used (success or failure) to rotate the start point. */
export function advanceCursor(provider: Provider) {
  const pool = getNodesForProvider(provider);
  if (pool.length === 0) return;
  cursors[provider] = (cursors[provider] + 1) % pool.length;
}

export function markSuccess(node: NodeState) {
  node.status = "ok";
  node.failCount = 0;
  node.lastError = undefined;
  node.cooldownUntil = undefined;
  node.lastCheckedAt = new Date().toISOString();
}

/**
 * `dead` should be set by the caller for errors that mean "this key is
 * bad and retrying won't help" (401/403 — revoked/invalid key). Anything
 * retryable (429 rate limit, 5xx, timeouts, network errors) should NOT
 * pass dead:true — those nodes go on cooldown and self-heal.
 */
export function markFailure(node: NodeState, err: unknown, opts?: { dead?: boolean }) {
  node.failCount += 1;
  node.lastError = err instanceof Error ? err.message : String(err);
  node.lastCheckedAt = new Date().toISOString();
  if (opts?.dead) {
    node.status = "dead";
    node.cooldownUntil = undefined;
    return;
  }
  node.status = "cooldown";
  node.cooldownUntil = Date.now() + COOLDOWN_MS;
}

/** Classify a thrown error as a dead-key vs. retryable failure, for OpenAI/fetch-style errors. */
export function isDeadKeyError(err: unknown): boolean {
  const status =
    (err as any)?.status ??
    (err as any)?.response?.status ??
    (err as any)?.code; // some SDKs surface it here
  return status === 401 || status === 403;
}

export function getPoolSummary() {
  const openai = getNodesForProvider("openai");
  const gemini = getNodesForProvider("gemini");
  return {
    openaiOk: openai.filter((n) => n.status === "ok").length,
    openaiTotal: openai.length,
    geminiOk: gemini.filter((n) => n.status === "ok").length,
    geminiTotal: gemini.length,
  };
}

export function getAllNodesView(): NodeView[] {
  return nodes.map(({ apiKey, cooldownUntil, ...view }) => view);
}

// --- manual health check (button-triggered, or periodic cron if you add one) ---

async function healthCheckOpenAiNode(n: NodeState): Promise<void> {
  try {
    const client = new OpenAI({ apiKey: n.apiKey, timeout: 15_000, maxRetries: 1 });
    // Cheapest possible call that still proves the key is live & has access.
    await client.models.list();
    markSuccess(n);
  } catch (err) {
    markFailure(n, err, { dead: isDeadKeyError(err) });
  }
}

async function healthCheckGeminiNode(n: NodeState): Promise<void> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${n.apiKey}`;
    const res = await fetchWithTimeout(url, {}, 10_000);
    if (!res.ok) {
      const dead = res.status === 401 || res.status === 403;
      markFailure(n, new Error(`HTTP ${res.status}`), { dead });
      return;
    }
    markSuccess(n);
  } catch (err) {
    markFailure(n, err);
  }
}

export async function runHealthCheck(): Promise<{
  nodes: NodeView[];
  summary: ReturnType<typeof getPoolSummary>;
}> {
  await Promise.all(
    nodes.map((n) => (n.provider === "openai" ? healthCheckOpenAiNode(n) : healthCheckGeminiNode(n)))
  );
  return { nodes: getAllNodesView(), summary: getPoolSummary() };
}
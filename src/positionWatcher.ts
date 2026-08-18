import fs from "node:fs";
import path from "node:path";
import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { CONFIG } from "./config.js";
import { getOpenPositions, type OpenPosition } from "./positions.js";
import { getGeminiPositionCheck, type Severity } from "./geminiPositionCheck.js";
import { isTimeSensitive } from "./blend.js";
import { sellLeg } from "./sellLeg.js";
import { withDelphiRetry } from "./delphiRetry.js";
import { getErc20Decimals } from "./chainRead.js";
import { getCompetitionTokenAddress } from "./config.js";

/**
 * Loss-prevention watcher for already-open positions — separate from
 * index.ts's trading loop, on its own cadence, same reasoning
 * positions.ts already documents for staying out of the hot path: every
 * extra SDK/LLM call in the trading loop is one more thing that can jam
 * a cycle. This module is meant to be ticked from a slower interval in
 * index.ts's main(), or triggered manually via the dashboard.
 *
 * Design (see conversation history / PATCHES.md for the full rationale):
 *
 *  1. TWO-OF-TWO CONFIRMATION. A single "severe" read from Gemini is not
 *     enough to act on — self-reported LLM confidence isn't independently
 *     calibrated, and a single grounded call can overreact to an
 *     ambiguous headline. A position must come back severe+confident on
 *     TWO CONSECUTIVE checks (separated by at least one cooldown period)
 *     AND show real market price movement between those checks before
 *     auto-exit is eligible to fire. State machine: none -> pending ->
 *     confirmed (or pending -> none if the second check doesn't hold up).
 *
 *  2. EXIT-ONLY, NEVER FLIP. A confirmed auto-exit sells the held leg via
 *     sellLeg.ts. It never buys the opposite outcome — flipping is a full
 *     second bet that the NEW narrative is right, which compounds the
 *     exact risk (overreacting to grounded-search output) this feature
 *     exists to guard against. Closing is a bounded cost; flipping isn't.
 *
 *  3. PERMANENT PER-LEG EXCLUSION. Every successful sell through
 *     sellLeg.ts (manual or watcher-triggered) permanently blocks that
 *     exact market+outcome from being re-bought — see closedLegs.ts.
 *     Only that leg; the opposite outcome on the same market is
 *     untouched and can still be entered on a fresh qualifying signal.
 */

export type WatcherAction =
  | "checked-clear"
  | "flagged-pending"
  | "confirmed-exited"
  | "confirmed-exit-disabled"
  | "cleared-false-alarm"
  | "skipped-cooldown"
  | "skipped-not-time-sensitive"
  | "skipped-no-gemini"
  | "error";

export interface WatcherCheckLogEntry {
  ts: string;
  marketId: string;
  outcomeIdx: number;
  question: string;
  severity: Severity;
  confidence: number;
  newsFound: boolean;
  priceMoved: boolean;
  sourceSummary?: string;
  action: WatcherAction;
  detail?: string;
}

interface PositionWatchState {
  lastCheckedAt: string;
  lastCheckedPrice: number;
  pendingConfirmation: boolean;
  pendingSince?: string;
  pendingSeverity?: Severity;
  pendingConfidence?: number;
}

const WATCHER_STATE_PATH = path.join(CONFIG.dataDir, "watcher-state.json");
const WATCHER_LOG_PATH = path.join(CONFIG.dataDir, "watcher-log.jsonl");

function keyFor(marketId: string, outcomeIdx: number): string {
  return `${marketId.toLowerCase()}::${outcomeIdx}`;
}

function readState(): Record<string, PositionWatchState> {
  if (!fs.existsSync(WATCHER_STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(WATCHER_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state: Record<string, PositionWatchState>): void {
  fs.mkdirSync(path.dirname(WATCHER_STATE_PATH), { recursive: true });
  fs.writeFileSync(WATCHER_STATE_PATH, JSON.stringify(state, null, 2));
}

function appendWatcherLog(entry: WatcherCheckLogEntry): void {
  fs.mkdirSync(path.dirname(WATCHER_LOG_PATH), { recursive: true });
  fs.appendFileSync(WATCHER_LOG_PATH, JSON.stringify(entry) + "\n");
}

export function readWatcherLog(limit = 100): WatcherCheckLogEntry[] {
  if (!fs.existsSync(WATCHER_LOG_PATH)) return [];
  const lines = fs.readFileSync(WATCHER_LOG_PATH, "utf8").split("\n").filter(Boolean);
  const out: WatcherCheckLogEntry[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line, same tolerance as journal.ts's readReceipts */
    }
  }
  return out.slice(-limit).reverse();
}

export function readWatcherState(): Record<string, PositionWatchState> {
  return readState();
}

/** Hours of lookback to give Gemini's search — wider for a position
 * that's gone a long time between checks (first check after entry, or
 * after a cooldown-skipped stretch), narrower for a position checked
 * recently, so consecutive checks aren't re-surfacing the same articles
 * as "new." Clamped to a sane range regardless. */
function lookbackHoursFor(prevCheckedAt: string | undefined, positionTs: string): number {
  const since = prevCheckedAt ?? positionTs;
  const hours = (Date.now() - new Date(since).getTime()) / 3_600_000;
  return Math.min(72, Math.max(6, Math.ceil(hours)));
}

function priceMovedSignificantly(a: number, b: number): boolean {
  return Math.abs(a - b) > CONFIG.positionWatcherPriceMoveThreshold;
}

async function fetchOutcomes(client: DelphiClient, marketId: string): Promise<string[] | null> {
  try {
    const market = (await withDelphiRetry(() => client.getMarket({ id: marketId } as any), {
      label: `getMarket(watch:${marketId})`,
      maxRetries: 2,
    })) as Market | null;
    if (!market) return null;
    return (market as any).outcomes ?? (market as any).metadata?.outcomes ?? null;
  } catch {
    return null;
  }
}

async function resolveCollateralDecimals(): Promise<number> {
  if (CONFIG.competitionTokenDecimals !== null) return CONFIG.competitionTokenDecimals;
  const tokenAddress = getCompetitionTokenAddress();
  if (!tokenAddress) return 18;
  try {
    return await getErc20Decimals(tokenAddress);
  } catch {
    return 18;
  }
}

async function checkOnePosition(
  client: DelphiClient,
  position: OpenPosition,
  state: Record<string, PositionWatchState>,
  dryRun: boolean
): Promise<WatcherCheckLogEntry | null> {
  const key = keyFor(position.marketId, position.outcomeIdx);
  const existing = state[key];

  // Gate 1: only bother polling news for markets whose question pattern
  // suggests it's actually news-driven (reuses blend.ts's heuristic —
  // same gate the entry forecaster uses to decide when to burn a Gemini
  // call). A position already mid-confirmation is re-checked regardless,
  // so it can't get stuck "pending" forever just because the question
  // text doesn't match the pattern.
  if (CONFIG.positionWatcherOnlyTimeSensitive && !isTimeSensitive(position.question) && !existing?.pendingConfirmation) {
    return null; // not logged — this isn't a check that happened, it's one that was never attempted
  }

  // Gate 2: per-position cooldown, independent of however often this
  // pass itself is ticked.
  if (existing && Date.now() - new Date(existing.lastCheckedAt).getTime() < CONFIG.positionWatcherCooldownMs) {
    return null;
  }

  if (position.currentPrice === null) {
    // Can't assess price movement without a live read — skip rather than
    // guess, same posture positions.ts takes on a stale/unavailable market.
    return null;
  }

  const outcomes = (await fetchOutcomes(client, position.marketId)) ?? [
    ...Array(position.outcomeIdx + 1).fill("?"),
  ];
  outcomes[position.outcomeIdx] = position.outcomeLabel;

  const lookbackHours = lookbackHoursFor(existing?.lastCheckedAt, position.ts);

  const result = await getGeminiPositionCheck(
    position.question,
    outcomes,
    position.outcomeIdx,
    position.entryPrice,
    position.currentPrice,
    lookbackHours
  );

  if (!result) {
    return {
      ts: new Date().toISOString(),
      marketId: position.marketId,
      outcomeIdx: position.outcomeIdx,
      question: position.question,
      severity: "none",
      confidence: 0,
      newsFound: false,
      priceMoved: false,
      action: "skipped-no-gemini",
      detail: "no usable Gemini node this pass",
    };
  }

  const priceMoved = priceMovedSignificantly(
    existing?.lastCheckedPrice ?? position.entryPrice,
    position.currentPrice
  );

  const qualifies =
    result.severity === "severe" &&
    result.confidence >= CONFIG.positionWatcherMinConfidenceForExit &&
    priceMoved;

  let action: WatcherAction;
  let detail: string | undefined;
  const nowIso = new Date().toISOString();

  if (qualifies && existing?.pendingConfirmation) {
    // Second consecutive qualifying check — confirmed.
    if (!CONFIG.positionWatcherAutoExitEnabled) {
      action = "confirmed-exit-disabled";
      detail = "auto-exit disabled via config — flagged for manual review, not executed";
      state[key] = {
        lastCheckedAt: nowIso,
        lastCheckedPrice: position.currentPrice,
        pendingConfirmation: true, // stays flagged so it keeps surfacing until a human acts or the position closes
        pendingSince: existing.pendingSince,
        pendingSeverity: result.severity,
        pendingConfidence: result.confidence,
      };
    } else if (!position.sharesRaw) {
      action = "error";
      detail = "confirmed exit, but no on-chain shares balance available to sell against";
      state[key] = {
        lastCheckedAt: nowIso,
        lastCheckedPrice: position.currentPrice,
        pendingConfirmation: true,
        pendingSince: existing.pendingSince,
        pendingSeverity: result.severity,
        pendingConfidence: result.confidence,
      };
    } else {
      const decimals = await resolveCollateralDecimals();
      const sellResult = await sellLeg(client, {
        marketAddress: position.marketId as `0x${string}`,
        outcomeIdx: position.outcomeIdx,
        sharesIn: BigInt(position.sharesRaw),
        collateralDecimals: decimals,
        dryRun,
        closeReason: "watcher-auto-exit",
        closeNote: result.sourceSummary,
        question: position.question,
        outcomeLabel: position.outcomeLabel,
      });

      if (sellResult.sold) {
        action = "confirmed-exited";
        detail = `sold via tx=${sellResult.txHash}, got ~${sellResult.tokensOutHuman?.toFixed(4)} tokens`;
        // Position is closed — clear watcher state for this leg entirely
        // rather than leaving a stale "pending" record behind.
        delete state[key];
      } else {
        action = "error";
        detail = sellResult.reason ?? "sell failed for an unknown reason";
        state[key] = {
          lastCheckedAt: nowIso,
          lastCheckedPrice: position.currentPrice,
          pendingConfirmation: true, // keep pending — will retry next qualifying check
          pendingSince: existing.pendingSince,
          pendingSeverity: result.severity,
          pendingConfidence: result.confidence,
        };
      }
    }
  } else if (qualifies) {
    // First qualifying check — flag and wait for confirmation.
    action = "flagged-pending";
    detail = "severe + high-confidence + price-confirmed on first check — awaiting second confirming check";
    state[key] = {
      lastCheckedAt: nowIso,
      lastCheckedPrice: position.currentPrice,
      pendingConfirmation: true,
      pendingSince: nowIso,
      pendingSeverity: result.severity,
      pendingConfidence: result.confidence,
    };
  } else if (existing?.pendingConfirmation) {
    // Was pending, didn't hold up this time — clear it.
    action = "cleared-false-alarm";
    detail = `previous flag didn't reconfirm (severity=${result.severity}, conf=${result.confidence.toFixed(2)}, priceMoved=${priceMoved})`;
    state[key] = {
      lastCheckedAt: nowIso,
      lastCheckedPrice: position.currentPrice,
      pendingConfirmation: false,
    };
  } else {
    action = "checked-clear";
    state[key] = {
      lastCheckedAt: nowIso,
      lastCheckedPrice: position.currentPrice,
      pendingConfirmation: false,
    };
  }

  return {
    ts: nowIso,
    marketId: position.marketId,
    outcomeIdx: position.outcomeIdx,
    question: position.question,
    severity: result.severity,
    confidence: result.confidence,
    newsFound: result.newsFound,
    priceMoved,
    sourceSummary: result.sourceSummary,
    action,
    detail,
  };
}

export interface WatcherPassSummary {
  checked: number;
  flagged: number;
  confirmed: number;
  exited: number;
  errors: number;
  entries: WatcherCheckLogEntry[];
}

/**
 * Runs one pass over all currently-open positions. Call this from its
 * own timer in index.ts's main() (NOT the trading loop's interval — see
 * module doc comment) or from a dashboard-triggered endpoint.
 */
export async function runPositionWatcherPass(client: DelphiClient, dryRun: boolean): Promise<WatcherPassSummary> {
  const summary: WatcherPassSummary = { checked: 0, flagged: 0, confirmed: 0, exited: 0, errors: 0, entries: [] };

  if (!CONFIG.positionWatcherEnabled) return summary;

  const positions = await getOpenPositions(client);
  const state = readState();

  for (const position of positions) {
    if (position.marketNotFound) continue; // nothing to check against

    let entry: WatcherCheckLogEntry | null;
    try {
      entry = await checkOnePosition(client, position, state, dryRun);
    } catch (err) {
      entry = {
        ts: new Date().toISOString(),
        marketId: position.marketId,
        outcomeIdx: position.outcomeIdx,
        question: position.question,
        severity: "none",
        confidence: 0,
        newsFound: false,
        priceMoved: false,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (!entry) continue; // gated out (cooldown / not time-sensitive) — not a real check, don't log it

    summary.checked++;
    if (entry.action === "flagged-pending") summary.flagged++;
    if (entry.action === "confirmed-exited" || entry.action === "confirmed-exit-disabled") summary.confirmed++;
    if (entry.action === "confirmed-exited") summary.exited++;
    if (entry.action === "error") summary.errors++;

    appendWatcherLog(entry);
    summary.entries.push(entry);

    console.log(
      `  [watcher] ${position.marketId}#${position.outcomeIdx} "${position.question.slice(0, 60)}" -> ${entry.action}${
        entry.detail ? ` (${entry.detail})` : ""
      }`
    );
  }

  writeState(state);
  return summary;
}
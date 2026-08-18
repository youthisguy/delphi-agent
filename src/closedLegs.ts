import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

/**
 * Permanent record of market+outcome legs that have been deliberately
 * closed — either by a human (scripts/sell-positions.ts, the dashboard's
 * Sell button) or by positionWatcher.ts's confirmed auto-exit. index.ts's
 * decide() consults this before ever sizing a candidate: a leg that was
 * sold on purpose must never be silently re-bought back into on the next
 * qualifying signal, live or dry-run.
 *
 * Deliberately per-OUTCOME, not per-market: closing the "Yes" leg because
 * its thesis broke says nothing about "No" — blocking the whole market
 * would throw away a legitimately different (and now possibly BETTER)
 * opportunity on the other side. See positionWatcher.ts's doc comment for
 * the reasoning on why exit-only (never flip) keeps these independent.
 *
 * Closures are permanent by design — no TTL, no auto-expiry. reopenLeg()
 * exists as a manual escape hatch for a confirmed false positive, but
 * nothing in the codebase calls it automatically.
 */

export type CloseReason = "manual-sell" | "watcher-auto-exit";

export interface ClosedLeg {
  marketId: string; // always lowercased — matches positions.ts's on-chain key convention
  outcomeIdx: number;
  reason: CloseReason;
  closedAt: string; // ISO
  note?: string;
  /** Snapshot of the market question / outcome label AT THE TIME OF
   * CLOSING, purely for display (the dashboard's Closed Legs panel).
   * Optional and best-effort — callers that have this on hand already
   * (positionWatcher.ts, the dashboard's sell request) should pass it so
   * the panel doesn't need an extra getMarket() call just to render a
   * label; callers that don't have it (a bare CLI invocation) can omit
   * it and the panel falls back to showing the raw address. */
  question?: string;
  outcomeLabel?: string;
}

const CLOSED_LEGS_PATH = path.join(CONFIG.dataDir, "closed-legs.json");

function keyFor(marketId: string, outcomeIdx: number): string {
  return `${marketId.toLowerCase()}::${outcomeIdx}`;
}

function readAll(): Record<string, ClosedLeg> {
  if (!fs.existsSync(CLOSED_LEGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLOSED_LEGS_PATH, "utf8"));
  } catch {
    // Corrupt file shouldn't brick the exclusion check — treat as empty
    // rather than throwing, same defensive posture as config.ts's
    // readRuntimeConfig().
    return {};
  }
}

function writeAll(data: Record<string, ClosedLeg>): void {
  fs.mkdirSync(path.dirname(CLOSED_LEGS_PATH), { recursive: true });
  fs.writeFileSync(CLOSED_LEGS_PATH, JSON.stringify(data, null, 2));
}

/** Idempotent — closing an already-closed leg just overwrites the record
 * (latest reason/timestamp wins). Never throws; a bookkeeping failure
 * here shouldn't be treated as the sell itself having failed by callers
 * (sellLeg.ts calls this AFTER the on-chain sell already landed). */
export function markLegClosed(
  marketId: string,
  outcomeIdx: number,
  reason: CloseReason,
  note?: string,
  display?: { question?: string; outcomeLabel?: string }
): void {
  const all = readAll();
  all[keyFor(marketId, outcomeIdx)] = {
    marketId: marketId.toLowerCase(),
    outcomeIdx,
    reason,
    closedAt: new Date().toISOString(),
    note,
    question: display?.question,
    outcomeLabel: display?.outcomeLabel,
  };
  writeAll(all);
}

export function isLegClosed(marketId: string, outcomeIdx: number): ClosedLeg | null {
  return readAll()[keyFor(marketId, outcomeIdx)] ?? null;
}

export function getAllClosedLegs(): ClosedLeg[] {
  return Object.values(readAll());
}

/** Manual escape hatch only — nothing in index.ts/positionWatcher.ts
 * calls this automatically. Use if a closure is later judged to have
 * been a false positive (e.g. investigated a watcher auto-exit and
 * decided it overreacted). */
export function reopenLeg(marketId: string, outcomeIdx: number): boolean {
  const all = readAll();
  const key = keyFor(marketId, outcomeIdx);
  if (!(key in all)) return false;
  delete all[key];
  writeAll(all);
  return true;
}
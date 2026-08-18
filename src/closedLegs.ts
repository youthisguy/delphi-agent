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
 * Closures are permanent by design.
 */

export type CloseReason = "manual-sell" | "watcher-auto-exit";

export interface ClosedLeg {
  marketId: string; // always lowercased — matches positions.ts's on-chain key convention
  outcomeIdx: number;
  reason: CloseReason;
  closedAt: string; // ISO
  note?: string;
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
  note?: string
): void {
  const all = readAll();
  all[keyFor(marketId, outcomeIdx)] = {
    marketId: marketId.toLowerCase(),
    outcomeIdx,
    reason,
    closedAt: new Date().toISOString(),
    note,
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

import { COMPETITION_RULES, EV } from "./evidenceConfig.js";
import { submissionsFor } from "./evidenceJournal.js";

/**
 * Server-truth slot accounting for LIVE mode. Limits belong to the Delphi ACCOUNT, so app submissions and
 * other agents on the same account count too — the local journal can only under-count. The loop refreshes
 * this cache (getEntryState / getLimits) at the start of each cycle; everything else reads it synchronously.
 * Dry-run keeps using the local journal.
 */

export interface ServerSlots { canSubmit: boolean; remaining: number | null; reason?: string; at: number }
export interface HourLimits { remaining: number | null; resetsAt: string | null; dailyRewardLeft: number | null; at: number }

const slots = new Map<string, ServerSlots>();
let hour: HourLimits | null = null;
const key = (id: string) => id.toLowerCase();
const freshMs = () => Math.max(20 * 60e3, EV.cycleIntervalMs * 2);

export function setServerSlots(id: string, s: Omit<ServerSlots, "at">): void {
  slots.set(key(id), { ...s, at: Date.now() });
}

export function getServerSlots(id: string): ServerSlots | null {
  const s = slots.get(key(id));
  return s && Date.now() - s.at < freshMs() ? s : null;
}

/** Call right after a successful submit so the rest of the cycle sees the slot as used. */
export function bumpServerSlots(id: string): void {
  const s = slots.get(key(id));
  if (s && s.remaining !== null) {
    s.remaining = Math.max(0, s.remaining - 1);
    if (s.remaining === 0) s.canSubmit = false;
  }
  if (hour && hour.remaining !== null) hour.remaining = Math.max(0, hour.remaining - 1);
}

export function setHourLimits(h: Omit<HourLimits, "at">): void { hour = { ...h, at: Date.now() }; }
export function getHourLimits(): HourLimits | null { return hour; }

/** Slots left on this market. Live + fresh server data wins; otherwise the local journal vs. the standard cap. */
export function slotsLeft(marketId: string, dryRun: boolean): number {
  if (!dryRun) {
    const s = getServerSlots(marketId);
    if (s) {
      if (!s.canSubmit) return 0;
      if (s.remaining !== null) return Math.max(0, s.remaining);
    }
  }
  return Math.max(0, COMPETITION_RULES.maxSubmissionsPerMarket - submissionsFor(marketId, dryRun).length);
}

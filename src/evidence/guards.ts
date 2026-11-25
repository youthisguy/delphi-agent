import { COMPETITION_RULES, EV } from "./evidenceConfig.js";
import { submissionsFor } from "./evidenceJournal.js";
import { slotsLeft } from "./slots.js";
import type { PackagedEvidence } from "./types.js";

/**
 * Hard-coded competition rules. These run in CODE, after the LLM, so no prompt
 * drift can talk the agent past them.
 */

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function capReached(marketId: string, dryRun: boolean): boolean {
  return slotsLeft(marketId, dryRun) <= 0;
}

/** Both-sides evidence on one market cancels: once we've committed to a direction, never submit the other. */
export function polarityConflict(marketId: string, outcomeIdx: number, dryRun: boolean): boolean {
  return submissionsFor(marketId, dryRun).some((a) => a.polarity !== null && a.polarity !== outcomeIdx);
}

export function checkSubmitGuards(args: {
  marketId: string;
  outcomeIdx: number | null;
  packaged: PackagedEvidence;
  dryRun: boolean;
}): GuardResult {
  const { marketId, outcomeIdx, packaged, dryRun } = args;
  if (outcomeIdx === null || !Number.isInteger(outcomeIdx) || outcomeIdx < 0) return { ok: false, reason: "no clear direction (polarity) — would risk cancelling" };
  if (capReached(marketId, dryRun)) return { ok: false, reason: "no submission slots left for this market" };
  if (polarityConflict(marketId, outcomeIdx, dryRun)) return { ok: false, reason: "opposite polarity to an earlier submission on this market (both sides cancel)" };
  if (packaged.files.length > COMPETITION_RULES.maxSupportingFiles) return { ok: false, reason: `more than ${COMPETITION_RULES.maxSupportingFiles} files` };
  if (1 + packaged.links.length + packaged.files.length > COMPETITION_RULES.maxItemsPerSubmission) return { ok: false, reason: `more than ${COMPETITION_RULES.maxItemsPerSubmission} items (note + links + files)` };
  if (!packaged.note.trim()) return { ok: false, reason: "empty note" };
  if (packaged.note.length > EV.maxNoteChars) return { ok: false, reason: "note too long" };
  const links = packaged.links.filter((l) => /^https?:\/\//i.test(l.url));
  if (!links.length) return { ok: false, reason: "no working http(s) link" };
  if (!links.some((l) => l.publishedAt) && !packaged.claim.eventDate) return { ok: false, reason: "no dated source" };
  return { ok: true };
}

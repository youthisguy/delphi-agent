import { EV } from "./evidenceConfig.js";
import { classifyTopic } from "./queryTemplates.js";
import { capReached } from "./guards.js";
import { isHeld } from "./holds.js";
import { lastResearchedAt, submissionsFor } from "./evidenceJournal.js";
import type { EvidenceMarket } from "./types.js";

/**
 * STUB — score = rewardPot × timeFactor × evidenceDensity × topicFit.
 * rewardPot, density and cutoff are placeholders until the competition market list
 * (23 Nov) exposes real values; swap the three estimate* functions then.
 */

function estimateRewardPot(m: EvidenceMarket): number {
  return m.rewardPot ?? 1;
}

/** Use the evidence cutoff (the real submission deadline); early evidence earns most. */
function timeFactor(m: EvidenceMarket): number {
  const end = m.evidenceCutoffAt ?? m.resolvesAt;
  if (!end) return 0.6;
  const days = (new Date(end).getTime() - Date.now()) / 86400e3;
  if (!Number.isFinite(days) || days <= 0.1) return 0; // too late to matter
  if (days <= 3) return 1;
  if (days <= 14) return 0.85;
  return 0.6;
}

/** The docs point at 20-80% odds as the sweet spot; extreme prices leave little room to move the forecast. */
function oddsFactor(m: EvidenceMarket): number {
  const p = m.odds?.[0];
  if (p === undefined) return 0.8;
  return p >= 0.2 && p <= 0.8 ? 1 : 0.4;
}

/** Placeholder: topics with abundant public reporting score higher. Replace with search-hit counts later. */
function evidenceDensity(m: EvidenceMarket): number {
  const t = classifyTopic(m);
  return { politics: 0.9, macro: 0.85, crypto: 0.9, tech: 0.8, sports: 0.75, current_events: 0.6 }[t];
}

function topicFit(m: EvidenceMarket): number {
  const rank = EV.topicFit.indexOf(classifyTopic(m));
  return rank < 0 ? 0.5 : 1 - rank * 0.06;
}

export function scoreMarket(m: EvidenceMarket, dryRun: boolean): number {
  if (isHeld(m.id)) return 0; // a human is working this market — keep the agent off it
  if (capReached(m.id, dryRun)) return 0;
  const last = lastResearchedAt(m.id);
  if (last !== null && Date.now() - last < EV.marketCooldownMs) return 0;
  // Slight boost for markets we haven't touched yet: spreads us across >=3 markets for the activity floor.
  const novelty = submissionsFor(m.id, dryRun).length === 0 ? 1.25 : 1;
  return estimateRewardPot(m) * timeFactor(m) * evidenceDensity(m) * topicFit(m) * novelty * oddsFactor(m);
}

export function prioritize(markets: EvidenceMarket[], dryRun: boolean): EvidenceMarket[] {
  return markets
    .map((m) => ({ m, s: scoreMarket(m, dryRun) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

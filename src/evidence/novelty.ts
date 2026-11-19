import { generateJson } from "./llmRouter.js";
import { EV } from "./evidenceConfig.js";
import { polarityConflict } from "./guards.js";
import { priorClaims, usedUrls, normUrl, recentJudgments } from "./evidenceJournal.js";
import type { EvidenceMarket, ExtractedClaim, NoveltyResult } from "./types.js";

const STOP = new Set("a an the of to in on for and or by with from at is are was were be been has have had will would that this it as its their".split(" "));
export function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9% .$-]/g, " ").split(/\s+/).map((w) => w.replace(/^[.$-]+|[.-]+$/g, "")).filter((w) => w.length > 1 && !STOP.has(w)));
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function isNearDuplicate(claim: string, prior: string[], threshold = EV.dupJaccard): boolean {
  const t = tokens(claim);
  return prior.some((p) => jaccard(t, tokens(p)) >= threshold);
}

function recencyScore(c: ExtractedClaim): number {
  const d = c.eventDate ?? c.sourcePublishedAt;
  if (!d) return 0;
  const ageDays = (Date.now() - new Date(d).getTime()) / 86400e3;
  return Math.max(0, Math.min(1, 1 - (ageDays - 2) / Math.max(EV.maxSourceAgeDays - 2, 1)));
}

const SYSTEM = `You are the quality gate for a prediction-market evidence desk. A judge pays only for evidence that is NEW, DATED, PRIMARY and decision-relevant to the market's resolution.
Score honestly and conservatively. Return JSON only.`;

export async function assessNovelty(market: EvidenceMarket, c: ExtractedClaim, dryRun: boolean): Promise<NoveltyResult> {
  const reasons: string[] = [];
  const flags: string[] = [];
  const checks: NoveltyResult["checks"] = {
    duplicateOfPrior: false, polarityConflict: false,
    frontierLikelyKnows: null, tightToResolution: null, primaryStrength: null, recency: recencyScore(c), flags,
  };
  const reject = (why: string): NoveltyResult => ({ score: 0, decision: "reject", reasons: [...reasons, why], checks });

  // 1. deterministic gates first (cheap, no LLM)
  if (c.supportsOutcomeIdx === null) return reject("no clear direction — evidence must point one way");
  if (usedUrls(market.id).has(normUrl(c.sourceUrl))) { checks.duplicateOfPrior = true; return reject("source URL already used on this market"); }
  if (isNearDuplicate(c.claim, priorClaims(market.id))) { checks.duplicateOfPrior = true; return reject("near-duplicate of an earlier note on this market"); }
  if (polarityConflict(market.id, c.supportsOutcomeIdx, dryRun)) { checks.polarityConflict = true; return reject("opposite direction to an earlier submission (would cancel)"); }
  if (c.sourceType === "aggregator") return reject("aggregator source, not primary or reputable reporting");

  // 2. LLM judgement on novelty / tightness / privacy
  const judged = recentJudgments(4);
  const user = `Market: ${market.question}
Outcomes: ${market.outcomes.map((o, i) => `${i}: ${o}`).join(" | ")}
${market.resolutionCriteria ? `Resolution criteria: ${market.resolutionCriteria}\n` : ""}Today: ${new Date().toISOString().slice(0, 10)}

CANDIDATE EVIDENCE
claim: ${c.claim}
event date: ${c.eventDate ?? "n/a"}   source published: ${c.sourcePublishedAt ?? "n/a"}
source: ${c.sourceDomain} (${c.sourceType})
points toward outcome ${c.supportsOutcomeIdx}: ${market.outcomes[c.supportsOutcomeIdx]}
${judged.length ? `\nRecent judge feedback on our earlier notes (learn from it):\n${judged.map((j) => `- ${j.verdict} (reward ${j.reward ?? "?"}): ${j.rationale.slice(0, 200)}`).join("\n")}\n` : ""}
Return {"frontierLikelyKnows":0-1 (would a strong, up-to-date forecaster already know this?),"tightToResolution":0-1 (does it bear directly on the resolution criteria?),"primaryStrength":0-1,"isRestatement":bool (restates the question/common knowledge),"isSpeculation":bool,"privateOrConfidential":bool (private individual's data or non-public info),"directionOk":bool (does the fact genuinely favour outcome ${c.supportsOutcomeIdx}?),"rationale":string}`;

  const { data } = await generateJson<any>({
    label: "novelty", system: SYSTEM, user,
    validate: (r: any) => {
      if (!r || typeof r.tightToResolution !== "number") throw new Error("bad novelty JSON");
      return r;
    },
  });

  const n = (x: unknown) => Math.max(0, Math.min(1, Number(x) || 0));
  checks.frontierLikelyKnows = n(data.frontierLikelyKnows);
  checks.tightToResolution = n(data.tightToResolution);
  checks.primaryStrength = n(data.primaryStrength);
  if (data.isRestatement) flags.push("restatement");
  if (data.isSpeculation) flags.push("speculation");
  if (data.privateOrConfidential) flags.push("private-or-confidential");
  if (data.directionOk === false) flags.push("direction-mismatch");
  if (typeof data.rationale === "string") reasons.push(data.rationale.slice(0, 300));

  const score =
    (1 - checks.frontierLikelyKnows) * 0.35 + checks.tightToResolution * 0.35 + checks.primaryStrength * 0.2 + (checks.recency ?? 0) * 0.1;
  const decision = flags.length === 0 && score >= EV.minNoveltyScore ? "accept" : "reject";
  if (decision === "reject") reasons.push(flags.length ? `flags: ${flags.join(", ")}` : `score ${score.toFixed(2)} < ${EV.minNoveltyScore}`);
  return { score: Number(score.toFixed(3)), decision, reasons, checks };
}

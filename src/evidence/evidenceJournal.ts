import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EV, COMPETITION_RULES } from "./evidenceConfig.js";
import type { EvidenceAttempt, EvidenceEvent, EvidenceEventType, AttemptStatus } from "./types.js";

/**
 * Append-only event log (data/evidence.jsonl). Events are NEVER rewritten, which
 * is what makes `.gitattributes: data/evidence.jsonl merge=union` safe — unlike
 * journal.ts's patch-in-place rewrites. Attempts are rebuilt by folding events
 * in file order (later patches win, arrays/objects replaced wholesale).
 */

const STATUS_FOR: Record<EvidenceEventType, AttemptStatus> = {
  started: "researching",
  researched: "researched",
  rejected: "rejected",
  packaged: "packaged",
  submitted: "submitted",
  judged: "judged",
  settled: "settled",
  error: "error",
};

export function newAttemptId(): string {
  return crypto.randomUUID();
}

export function appendEvent(
  attemptId: string,
  marketId: string,
  type: EvidenceEventType,
  patch: Partial<EvidenceAttempt> = {}
): void {
  const ev: EvidenceEvent = { v: 1, ts: new Date().toISOString(), attemptId, marketId, type, patch };
  fs.mkdirSync(path.dirname(EV.journalPath), { recursive: true });
  fs.appendFileSync(EV.journalPath, JSON.stringify(ev) + "\n");
  cache = null;
}

let cache: { size: number; attempts: EvidenceAttempt[] } | null = null;

export function foldEvents(events: EvidenceEvent[]): EvidenceAttempt[] {
  const map = new Map<string, EvidenceAttempt>();
  for (const ev of events) {
    const prev = map.get(ev.attemptId);
    const base: EvidenceAttempt =
      prev ??
      ({
        attemptId: ev.attemptId,
        marketId: ev.marketId,
        question: "",
        startedAt: ev.ts,
        dryRun: true,
        status: "researching",
        queriesRun: [],
        sourcesFetched: [],
        extractedClaims: [],
        polarity: null,
      } as EvidenceAttempt);
    map.set(ev.attemptId, { ...base, ...ev.patch, attemptId: ev.attemptId, marketId: ev.marketId, status: STATUS_FOR[ev.type] ?? base.status });
  }
  return [...map.values()];
}

export function readEvents(): EvidenceEvent[] {
  if (!fs.existsSync(EV.journalPath)) return [];
  const out: EvidenceEvent[] = [];
  for (const line of fs.readFileSync(EV.journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line (e.g. half-written after a crash) */
    }
  }
  return out;
}

export function readAttempts(): EvidenceAttempt[] {
  if (!fs.existsSync(EV.journalPath)) return [];
  const size = fs.statSync(EV.journalPath).size;
  if (cache && cache.size === size) return cache.attempts;
  const attempts = foldEvents(readEvents());
  cache = { size, attempts };
  return attempts;
}

const SUBMITTED: AttemptStatus[] = ["submitted", "judged", "settled"];

/** Submissions that count against the 3-per-market cap — same mode only (dry runs never eat live slots). */
export function submissionsFor(marketId: string, dryRun: boolean): EvidenceAttempt[] {
  return readAttempts().filter(
    (a) => a.marketId === marketId && a.dryRun === dryRun && SUBMITTED.includes(a.status)
  );
}

export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) x.searchParams.delete(k);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/** URLs already used as the basis of a packaged/submitted note on this market. */
export function usedUrls(marketId: string, dryRun?: boolean): Set<string> {
  const s = new Set<string>();
  for (const a of readAttempts()) {
    if (a.marketId !== marketId || !a.packaged) continue;
    if (dryRun !== undefined && a.dryRun !== dryRun) continue; // dry-run history must never block live submissions
    for (const l of a.packaged.links) s.add(normUrl(l.url));
  }
  return s;
}

/** Claim texts previously packaged on this market (any mode) — for near-duplicate detection. */
export function priorClaims(marketId: string, dryRun?: boolean): string[] {
  return readAttempts()
    .filter((a) => a.marketId === marketId && a.packaged && (dryRun === undefined || a.dryRun === dryRun))
    .map((a) => a.packaged!.claim.claim);
}

export function lastResearchedAt(marketId: string): number | null {
  let t: number | null = null;
  for (const a of readAttempts()) {
    if (a.marketId !== marketId) continue;
    const ms = new Date(a.startedAt).getTime();
    if (Number.isFinite(ms) && (t === null || ms > t)) t = ms;
  }
  return t;
}

export function recentJudgments(limit = 5): { verdict: string; rationale: string; reward: number | null; note?: string }[] {
  return readAttempts()
    .filter((a) => a.judgment)
    .sort((a, b) => (a.judgment!.judgedAt < b.judgment!.judgedAt ? 1 : -1))
    .slice(0, limit)
    .map((a) => ({ verdict: a.judgment!.verdict, rationale: a.judgment!.rationale, reward: a.judgment!.reward, note: a.packaged?.note }));
}

export function pendingJudgment(): EvidenceAttempt[] {
  return readAttempts().filter((a) => a.status === "submitted" && a.receipt && !a.judgment && !a.dryRun);
}

export function floorStatus() {
  const attempts = readAttempts();
  const live = attempts.filter((a) => !a.dryRun);
  const judged = live.filter((a) => a.judgment);
  const judgedMarkets = new Set(judged.map((a) => a.marketId));
  const reward = live.reduce(
    (s, a) => s + (a.judgment?.reward ?? 0) + (a.settlementLater?.reward ?? 0),
    0
  );
  return {
    liveSubmitted: live.filter((a) => SUBMITTED.includes(a.status)).length,
    liveJudged: judged.length,
    liveJudgedMarkets: judgedMarkets.size,
    floorMet:
      judged.length >= COMPETITION_RULES.minJudgedSubmissions &&
      judgedMarkets.size >= COMPETITION_RULES.minJudgedMarkets,
    required: {
      judged: COMPETITION_RULES.minJudgedSubmissions,
      markets: COMPETITION_RULES.minJudgedMarkets,
    },
    totalReward: Number(reward.toFixed(6)),
    dryRunSubmitted: attempts.filter((a) => a.dryRun && SUBMITTED.includes(a.status)).length,
    totalAttempts: attempts.length,
  };
}

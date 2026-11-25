import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { EV, COMPETITION_RULES } from "./evidenceConfig.js";
import { setServerSlots, setHourLimits, bumpServerSlots, type ServerSlots } from "./slots.js";
import type { Judgment, SubmissionPayload } from "./types.js";

export interface SubmissionReceipt {
  id: string;
  submittedAt: string;
  raw?: unknown;
}

export interface Submitter {
  name: string;
  submit(p: SubmissionPayload): Promise<SubmissionReceipt>;
  /** null = not judged yet. */
  fetchJudgment(receiptId: string): Promise<Judgment | null>;
}

/** Master latch. Live still needs a key, accepted terms and a working getLimits() — see refreshLiveReadiness(). */
export const LIVE_SUBMITTER_WIRED = true;

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ascii64 = (s: string) => s.replace(/[^\x20-\x7e]/g, "").slice(0, 64);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

const pick = (o: any, ...keys: string[]): any => {
  for (const k of keys) {
    const v = k.split(".").reduce((x: any, p) => (x == null ? undefined : x[p]), o);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};
const num = (v: any): number | null => {
  if (v && typeof v === "object") v = v.amount ?? v.value;
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Rewards arrive as strings in USDC base units (6 decimals). */
const usdc = (v: any): number | null => {
  const n = num(v);
  return n === null ? null : n / 1e6;
};
const str = (v: any): string | undefined => (typeof v === "string" && v ? v : undefined);

const seen = new Set<string>();
/** The docs don't spell out every response field, so log each raw shape once — makes the parsers below easy to tighten. */
function logOnce(k: string, v: unknown) {
  if (seen.has(k)) return;
  seen.add(k);
  console.log(`  [evidence-api] first ${k} response shape:`, JSON.stringify(v).slice(0, 600));
}

/**
 * Retry policy from the Evidence API docs: 429 -> wait retryAfterSeconds (only if short, otherwise surface it),
 * 500/503/network -> back off and retry, 400/401/403/404/409 -> never retried.
 * Retrying submitEvidence is safe because every call carries a deterministic Idempotency-Key.
 */
async function api<T = any>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < 4; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = Number(err?.status ?? err?.statusCode ?? err?.httpStatus ?? 0);
      const code = String(err?.code ?? "");
      const noRetry =
        [400, 401, 403, 404, 409].includes(status) ||
        ["invalid_request", "unauthorized", "forbidden", "not_found", "terms_not_accepted", "idempotency_conflict"].includes(code) ||
        err?.retryable === false;
      if (noRetry) throw err;
      if (status === 429 || code === "rate_limited") {
        const wait = Number(err?.retryAfterSeconds ?? 0);
        if (wait > 0 && wait <= 45 && i < 2) { await sleep(wait * 1000 + 250); continue; }
        throw err;
      }
      if (i === 3) break;
      console.warn(`  [evidence-api] ${label} failed (${errMsg(err)}), retrying…`);
      await sleep(1500 * 2 ** i);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- client + readiness

let _client: EvidenceClient | null = null;
function client(): EvidenceClient {
  if (!EV.apiKey) throw new Error("DELPHI_API_ACCESS_KEY is not set");
  return (_client ??= new EvidenceClient({
    baseUrl: EV.apiUrl ?? "https://delphi.fyi/v1",
    apiKey: EV.apiKey,
    agentId: ascii64(EV.agentId ?? "pringles"),
    agentHarness: ascii64(EV.harness),
    agentModel: ascii64(EV.model),
  } as any));
}

export interface LiveState {
  checkedAt: string | null;
  ready: boolean;
  reasons: string[];
  termsAccepted: boolean | null;
  termsUrl?: string;
  termsVersion?: string;
}
let live: LiveState = { checkedAt: null, ready: false, reasons: ["not checked yet"], termsAccepted: null };

/** Sync on purpose (effectiveDryRun() is sync). False until refreshLiveReadiness() has succeeded => everything stays dry-run. */
export function isLiveReady(): boolean {
  return LIVE_SUBMITTER_WIRED && live.ready;
}
export const liveStatus = (): LiveState => ({ ...live });

function parseLimits(raw: any) {
  return {
    remaining: num(pick(raw, "submissionsLeftThisHour", "submissionsRemainingThisHour", "hourRemaining", "submissions.remaining", "hour.remaining", "hourly.remaining", "remaining")),
    resetsAt: str(pick(raw, "hourResetsAt", "resetsAt", "resetAt", "hour.resetsAt", "submissions.resetsAt")) ?? null,
    dailyRewardLeft: num(pick(raw, "dailyRewardCapLeft", "dailyRewardLeft", "reward.remaining", "rewards.remaining", "daily.remaining")),
  };
}

/** Pulls the hour budget. Returns null when the shape isn't recognised (loop then just doesn't cap on it). */
export async function refreshLimits() {
  const { data } = await api("getLimits", () => (client() as any).getLimits());
  logOnce("getLimits", data);
  const l = parseLimits(data);
  setHourLimits(l);
  return l;
}

/**
 * Live gate, evaluated at the top of every cycle: key present + terms accepted + getLimits() works.
 * NEVER accepts terms itself — run `npx tsx src/evidence/acceptTerms.ts --yes` once, after reading them.
 */
export async function refreshLiveReadiness(): Promise<LiveState> {
  const reasons: string[] = [];
  let termsAccepted: boolean | null = null, termsUrl: string | undefined, termsVersion: string | undefined;
  if (!EV.apiKey) {
    reasons.push("DELPHI_API_ACCESS_KEY not set (needs a MAINNET key)");
  } else {
    try {
      const { data } = await api("getTerms", () => (client() as any).getTerms());
      termsAccepted = Boolean(data?.acceptedAt);
      termsUrl = data?.url;
      termsVersion = data?.version;
      if (!termsAccepted) reasons.push(`terms not accepted — read ${data?.url ?? "the terms"} then run: npx tsx src/evidence/acceptTerms.ts --yes`);
    } catch (err) {
      reasons.push(`getTerms failed: ${errMsg(err)}`);
    }
    try {
      await refreshLimits();
    } catch (err: any) {
      const status = Number(err?.status ?? err?.statusCode ?? 0);
      reasons.push(
        status === 404
          ? "getLimits 404: no evidence access yet (not registered on DoraHacks with the profile wallet, account <1h old, or competition not open)"
          : status === 401
            ? "getLimits 401: bad key — use a Mainnet key from api-access.delphi.fyi"
            : `getLimits failed: ${errMsg(err)}`
      );
    }
  }
  live = { checkedAt: new Date().toISOString(), ready: reasons.length === 0, reasons, termsAccepted, termsUrl, termsVersion };
  if (!live.ready && EV.apiKey) console.warn("[evidence] live NOT ready ->", reasons.join(" | "));
  return live;
}

// ---------------------------------------------------------------- entry state (server-side slot accounting)

function parseEntryState(raw: any): Omit<ServerSlots, "at"> | null {
  const remaining = num(pick(raw, "submissionsLeft", "submissionsRemaining", "remaining", "slotsLeft", "left", "submissions.remaining", "limits.remaining"));
  let can = pick(raw, "canSubmit", "can_submit", "allowed", "eligible", "open");
  if (typeof can !== "boolean") can = remaining !== null ? remaining > 0 : null;
  if (can === null) return null;
  return { canSubmit: Boolean(can) && remaining !== 0, remaining, reason: str(pick(raw, "reason", "message", "blockedReason")) };
}

/** null = not live, or response shape unrecognised (callers fall back to the local journal). */
export async function fetchEntryState(marketId: string): Promise<Omit<ServerSlots, "at"> | null> {
  if (!isLiveReady()) return null;
  const { data } = await api(`getEntryState(${marketId})`, () => (client() as any).getEntryState(marketId));
  logOnce("getEntryState", data);
  const s = parseEntryState(data);
  if (s) setServerSlots(marketId, s);
  return s;
}

/** Refresh entry state for many markets, 3 at a time; per-market failures are non-fatal. */
export async function refreshEntryStates(ids: string[]): Promise<void> {
  if (!isLiveReady()) return;
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try { await fetchEntryState(id); } catch (err) { console.warn(`  [evidence-api] entry-state ${id}: ${errMsg(err)}`); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------------------------------------------------------------- submitters

export class DryRunSubmitter implements Submitter {
  name = "dry-run";
  async submit(p: SubmissionPayload): Promise<SubmissionReceipt> {
    console.log(`  [submit:dry-run] market=${p.marketId} outcome=${p.outcomeIdx} links=${p.links.length}`);
    return { id: `dry-${crypto.randomUUID()}`, submittedAt: new Date().toISOString(), raw: { dryRun: true } };
  }
  async fetchJudgment(): Promise<Judgment | null> {
    return null;
  }
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain" };

function toUpload(p: string): { file: File; bytes: number } {
  const buf = fs.readFileSync(p);
  const type = MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
  return { file: new File([buf], path.basename(p), { type }), bytes: buf.length };
}

/** Same body => same key, so a resend after a timeout returns the original submission instead of burning a slot. */
export function idempotencyKeyFor(p: SubmissionPayload): string {
  const body = JSON.stringify([p.marketId.toLowerCase(), p.note, p.links.map((l) => l.url), p.files.map((f) => path.basename(f))]);
  return "pg-" + crypto.createHash("sha256").update(body).digest("hex").slice(0, 40);
}

export class LiveSubmitter implements Submitter {
  name = "live";

  async submit(p: SubmissionPayload): Promise<SubmissionReceipt> {
    const links = p.links.map((l) => l.url);
    const items = 1 + links.length + p.files.length; // the note is item #1
    if (items > COMPETITION_RULES.maxItemsPerSubmission) throw new Error(`too many items (${items} > ${COMPETITION_RULES.maxItemsPerSubmission}: note + links + files)`);
    if (p.note.length > 8000) throw new Error("note exceeds the API's 8,000 character cap");
    const uploads = p.files.map(toUpload);
    if (uploads.reduce((s, u) => s + u.bytes, 0) > COMPETITION_RULES.maxTotalFileBytes) throw new Error("files exceed the 10 MB total cap");

    const { data } = await api(`submitEvidence(${p.marketId})`, () =>
      (client() as any).submitEvidence({
        marketAddress: p.marketId,
        note: p.note,
        links,
        files: uploads.map((u) => u.file),
        idempotencyKey: idempotencyKeyFor(p),
      })
    );
    logOnce("submitEvidence", data);
    bumpServerSlots(p.marketId); // queued AND immediately-rejected submissions both consume a slot
    return {
      id: String(data?.id),
      submittedAt: str(data?.createdAt) ?? new Date().toISOString(),
      raw: { status: data?.status, reason: data?.reason },
    };
  }

  /**
   * null while queued/judging. A content-check `rejected`, a non-retryable `failed` and `unmatched` are all FINAL results,
   * returned as judgments with reward 0 so the loop stops polling them. `failed` + canRetry triggers retrySubmission.
   */
  async fetchJudgment(id: string): Promise<Judgment | null> {
    const { data } = await api(`getSubmission(${id})`, () => (client() as any).getSubmission(id));
    logOnce("getSubmission", data);
    const status = String(data?.status ?? "").toLowerCase();
    const now = new Date().toISOString();

    if (status === "queued" || status === "judging" || status === "pending") return null;
    if (status === "failed") {
      if (data?.canRetry) {
        await api(`retrySubmission(${id})`, () => (client() as any).retrySubmission(id));
        return null;
      }
      return { verdict: "failed", rationale: str(pick(data, "error", "reason")) ?? "judging failed", reward: 0, judgedAt: now };
    }
    if (status === "rejected" || status === "unmatched") {
      return { verdict: status, rationale: str(pick(data, "reason", "rejectReason", "message")) ?? status, reward: 0, judgedAt: now };
    }
    if (status !== "judged") return null;

    const lines: any[] = pick(data, "markets", "results", "lines") ?? [];
    const rewards = lines.map((l) => usdc(pick(l, "reward", "judgmentReward", "bounty")));
    const settle = lines.map((l) => usdc(pick(l, "settlementUpTo")));
    const sum = (a: (number | null)[]) => (a.every((x) => x === null) ? null : a.reduce<number>((s, x) => s + (x ?? 0), 0));
    return {
      verdict: lines.map((l) => str(l?.verdict)).filter(Boolean).join("/") || "judged",
      rationale: lines.map((l) => str(pick(l, "reason", "rationale"))).filter(Boolean).join(" | "),
      reward: sum(rewards),
      rewardState: str(pick(lines[0], "rewardState", "state", "rewardStatus", "reward.state")),
      settlementUpTo: sum(settle),
      judgedAt: str(pick(data, "judgedAt", "updatedAt")) ?? now,
    };
  }
}

export function createSubmitter(dryRun: boolean): Submitter {
  return dryRun || !isLiveReady() ? new DryRunSubmitter() : new LiveSubmitter();
}

// ---------------------------------------------------------------- payload

/** Trim to the 3-item cap: the note is item #1; keep at least one link (dated ones first), files get the next slots. */
export function fitItems<L extends { publishedAt?: string | null }>(links: L[], files: string[]): { links: L[]; files: string[] } {
  const room = COMPETITION_RULES.maxItemsPerSubmission - 1;
  const fileCap = Math.min(COMPETITION_RULES.maxSupportingFiles, links.length ? room - 1 : room);
  const f = files.slice(0, fileCap);
  const sorted = [...links].sort((a, b) => Number(Boolean(b.publishedAt)) - Number(Boolean(a.publishedAt)));
  return { links: sorted.slice(0, room - f.length), files: f };
}

/**
 * The API has NO outcome field — the judge infers direction from the note. So the note itself must say which way the
 * fact points: when an outcome label is supplied, a short "Relevance:" line is appended (once).
 */
export function buildPayload(
  marketId: string,
  outcomeIdx: number,
  p: { note: string; links: SubmissionPayload["links"]; files: string[] },
  outcomeLabel?: string
): SubmissionPayload {
  const fit = fitItems(p.links, p.files);
  let note = p.note.trim();
  if (outcomeLabel && !/\bRelevance:/i.test(note)) note += `\n\nRelevance: this fact points toward the outcome "${outcomeLabel}".`;
  return { marketId, outcomeIdx, note, links: fit.links, files: fit.files, agent: { agentId: EV.agentId, harness: EV.harness, model: EV.model } };
}

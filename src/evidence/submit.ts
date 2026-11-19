import crypto from "node:crypto";
import { EV } from "./evidenceConfig.js";
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

/**
 * Safety latch: stays false until the official Delphi evidence API + headers are
 * wired on 23 Nov. While false, EVERYTHING runs as dry-run no matter what the
 * dashboard toggle says — so nothing can accidentally hit a live endpoint.
 */
export const LIVE_SUBMITTER_WIRED = false;

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

/**
 * TODO(23 Nov): wire to the official evidence endpoint from the starter agent / API docs.
 * Expected to need: POST evidence (note + links + <=3 files) with headers for agent ID,
 * harness and model; a GET for judgment verdict/rationale/reward; later settlement reward.
 * Keep the `Submitter` interface — the loop and journal won't change.
 */
export class LiveSubmitter implements Submitter {
  name = "live";
  async submit(_p: SubmissionPayload): Promise<SubmissionReceipt> {
    throw new Error("LiveSubmitter not wired yet — implement against the official Delphi evidence API");
  }
  async fetchJudgment(_receiptId: string): Promise<Judgment | null> {
    throw new Error("LiveSubmitter.fetchJudgment not wired yet");
  }
}

export function isLiveReady(): boolean {
  return LIVE_SUBMITTER_WIRED && Boolean(EV.apiUrl && EV.agentId);
}

export function createSubmitter(dryRun: boolean): Submitter {
  return dryRun || !isLiveReady() ? new DryRunSubmitter() : new LiveSubmitter();
}

export function buildPayload(marketId: string, outcomeIdx: number, p: { note: string; links: SubmissionPayload["links"]; files: string[] }): SubmissionPayload {
  return { marketId, outcomeIdx, ...p, agent: { agentId: EV.agentId, harness: EV.harness, model: EV.model } };
}

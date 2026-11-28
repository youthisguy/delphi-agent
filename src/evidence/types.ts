export interface EvidenceMarket {
  id: string;
  question: string;
  outcomes: string[];
  category?: string;
  resolvesAt: string | null;
  resolutionCriteria?: string;
  rewardPot?: number;
  url?: string;
  /** Backtests only: pretend it is this ISO time — search/fetch ignore anything published later. */
  asOf?: string;
  /** Official resolution-source URLs (Delphi `dataSources`) — the oracle settles from these. */
  sourceUrls?: string[];
  /** [yes, no] implied probabilities from the competition list. */
  odds?: number[];
  /** Evidence submission deadline (before trading closes). */
  evidenceCutoffAt?: string | null;
  tier?: string;
}

export interface SourceRef {
  url: string;
  domain: string;
  title?: string;
  publishedAt: string | null;
  fetchMethod: "fetch" | "playwright" | "snippet";
  ok: boolean;
  error?: string;
}

export type SourceType = "primary" | "secondary" | "aggregator";

export interface ExtractedClaim {
  claim: string;
  eventDate: string | null;
  sourceUrl: string;
  sourceDomain: string;
  sourcePublishedAt: string | null;
  sourceType: SourceType;
  relevance: number; // 0-1
  confidence: number; // 0-1
  supportsOutcomeIdx: number | null; // which outcome this fact points toward; null = no clear direction
  supportRationale: string;
  quote: string; // verbatim excerpt from the page (verified in code)
}

export interface NoveltyResult {
  score: number;
  decision: "accept" | "reject";
  reasons: string[];
  checks: {
    duplicateOfPrior: boolean;
    polarityConflict: boolean;
    frontierLikelyKnows: number | null;
    tightToResolution: number | null;
    primaryStrength: number | null;
    recency: number | null;
    flags: string[];
  };
}

export interface PackagedEvidence {
  note: string;
  links: { url: string; title?: string; publishedAt?: string | null }[];
  files: string[]; // <=3, only when they materially help verification
  claim: ExtractedClaim;
  /** packaging style tag, e.g. "v2+derived+translated+bundled" - lets rewards be compared across styles */
  style?: string;
}

export interface SubmissionPayload {
  marketId: string;
  outcomeIdx: number;
  note: string;
  links: PackagedEvidence["links"];
  files: string[];
  agent: { agentId: string | null; harness: string; model: string };
}

export interface Judgment {
  verdict: string;
  rationale: string;
  reward: number | null;
  judgedAt: string;
  rewardState?: string;
  settlementUpTo?: number | null;
}

export type AttemptStatus =
  | "researching"
  | "researched"
  | "rejected"
  | "packaged"
  | "submitted"
  | "judged"
  | "settled"
  | "error";

/** One research cycle on one market, ending in at most one submission. */
export interface EvidenceAttempt {
  attemptId: string;
  marketId: string;
  question: string;
  outcomes?: string[];
  /** "human" = submitted from the Human Desk; absent/"agent" = the automated loop. Both share the same caps and polarity lock. */
  origin?: "agent" | "human";
  startedAt: string;
  dryRun: boolean;
  status: AttemptStatus;
  queriesRun: string[];
  sourcesFetched: SourceRef[];
  extractedClaims: ExtractedClaim[];
  extractionDiag?: Record<string, number | string[]>;
  novelty?: NoveltyResult;
  rejectedCandidates?: { claim: string; reasons: string[]; sourceDomain?: string; sourceUrl?: string; sourceType?: string; score?: number }[];
  packaged?: PackagedEvidence;
  polarity: number | null; // outcome index the submitted evidence supports
  submissionPayload?: SubmissionPayload;
  submittedAt?: string;
  receipt?: { id: string; raw?: unknown };
  judgment?: Judgment;
  reward?: number | null; // judgment reward
  settlementLater?: { settledAt: string; reward: number | null; detail?: string };
  rejectReason?: string;
  error?: string;
}

export type EvidenceEventType =
  | "started" | "researched" | "rejected" | "packaged" | "submitted" | "judged" | "settled" | "error";

export interface EvidenceEvent {
  v: 1;
  ts: string;
  attemptId: string;
  marketId: string;
  type: EvidenceEventType;
  patch: Partial<EvidenceAttempt>;
}

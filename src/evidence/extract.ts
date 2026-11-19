import { generateJson } from "./llmRouter.js";
import { EV } from "./evidenceConfig.js";
import type { EvidenceMarket, ExtractedClaim, SourceType } from "./types.js";
import type { FetchedDoc } from "./fetchExtract.js";

const SYSTEM = `You extract verifiable, dated facts from ONE web page for a prediction-market evidence desk.
Rules:
- Use ONLY the provided page text. Never add outside knowledge. Never infer facts the page does not state.
- Each claim must be a concrete, checkable fact (who/what/when/number), not opinion or speculation.
- "quote" must be copied VERBATIM from the page text (max 25 words) and directly support the claim.
- Skip anything confidential, leaked, or about private individuals (only public figures acting in public roles are OK).
- Judge sourceType: "primary" = the originating body (government, regulator, company filing/press release, official league/organizer, court, the data publisher); "secondary" = reporting that cites primary sources; "aggregator" = roundups, blogs, forums.
- supportsOutcomeIdx = the index of the outcome this fact makes MORE LIKELY (e.g. a fact that rules something out points to the opposite outcome). Use null only if the fact genuinely does not shift the odds either way.
Return JSON only.`;

function norm(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}
const alnum = (s: string) => norm(s).replace(/[^a-z0-9]+/g, " ").trim();

/** Quote must really be on the page: exact (ignoring punctuation/whitespace) or >=85% of its 4-word runs present. */
export function quoteInText(quote: string, text: string): boolean {
  const q = alnum(quote);
  if (q.length < 12) return false;
  const t = alnum(text);
  if (t.includes(q)) return true;
  const qw = q.split(" ");
  if (qw.length < 6) return false;
  const tw = t.split(" ");
  const have = new Set<string>();
  for (let i = 0; i + 4 <= tw.length; i++) have.add(tw.slice(i, i + 4).join(" "));
  let hit = 0, tot = 0;
  for (let i = 0; i + 4 <= qw.length; i++) { tot++; if (have.has(qw.slice(i, i + 4).join(" "))) hit++; }
  return tot > 0 && hit / tot >= 0.85;
}

const clamp01 = (n: unknown, d = 0.5) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : d);
const isoDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= Date.now() + 86400e3 ? new Date(t).toISOString().slice(0, 10) : null;
};

export interface ExtractDiag { [k: string]: number | string[]; docs: number; llmFailed: number; docsWithNoClaims: number; droppedShape: number; droppedQuote: number; droppedUndated: number; droppedRelevance: number; kept: number; samples: string[] }

export async function extractClaims(market: EvidenceMarket, docs: FetchedDoc[]): Promise<{ claims: ExtractedClaim[]; diag: ExtractDiag }> {
  const out: ExtractedClaim[] = [];
  const diag: ExtractDiag = { docs: docs.length, llmFailed: 0, docsWithNoClaims: 0, droppedShape: 0, droppedQuote: 0, droppedUndated: 0, droppedRelevance: 0, kept: 0, samples: [] };
  const today = new Date().toISOString().slice(0, 10);

  for (const doc of docs) {
    const user = `Today: ${today}
Market question: ${market.question}
Outcomes (index: label):
${market.outcomes.map((o, i) => `${i}: ${o}`).join("\n")}
${market.resolutionCriteria ? `Resolution criteria: ${market.resolutionCriteria}\n` : ""}
PAGE METADATA
url: ${doc.finalUrl}
domain: ${doc.domain}
title: ${doc.title}
published: ${doc.publishedAt ?? "unknown"}

PAGE TEXT
${doc.text}

Return {"claims":[{"claim":string,"eventDate":"YYYY-MM-DD"|null,"sourceType":"primary"|"secondary"|"aggregator","relevance":0-1,"confidence":0-1,"supportsOutcomeIdx":int|null,"supportRationale":string,"quote":string}]}
Max 3 claims, best first. Return {"claims":[]} if the page has nothing relevant to the resolution of this market.`;

    try {
      const { data } = await generateJson<any[]>({
        label: "extract",
        system: SYSTEM,
        user,
        validate: (raw: any) => {
          if (!raw || !Array.isArray(raw.claims)) throw new Error("missing claims[]");
          return raw.claims;
        },
      });

      if (!data.length) diag.docsWithNoClaims++;
      for (const c of data.slice(0, 3)) {
        if (!c || typeof c.claim !== "string" || typeof c.quote !== "string") { diag.droppedShape++; continue; }
        if (!quoteInText(c.quote, doc.text)) { // anti-fabrication: quote must exist on the page
          diag.droppedQuote++;
          if (diag.samples.length < 3) diag.samples.push(`quote not on page (${doc.domain}): ${c.quote.slice(0, 90)}`);
          continue;
        }
        const eventDate = isoDate(c.eventDate);
        const pub = doc.publishedAt ? doc.publishedAt.slice(0, 10) : null;
        if (!eventDate && !pub) { diag.droppedUndated++; continue; } // undated => unusable
        const relevance = clamp01(c.relevance, 0);
        if (relevance < EV.minRelevance) { diag.droppedRelevance++; continue; }
        const idx = Number.isInteger(c.supportsOutcomeIdx) && c.supportsOutcomeIdx >= 0 && c.supportsOutcomeIdx < market.outcomes.length ? c.supportsOutcomeIdx : null;
        const st: SourceType = ["primary", "secondary", "aggregator"].includes(c.sourceType) ? c.sourceType : "secondary";
        diag.kept++;
        out.push({
          claim: c.claim.trim().slice(0, 600),
          eventDate,
          sourceUrl: doc.finalUrl,
          sourceDomain: doc.domain,
          sourcePublishedAt: doc.publishedAt,
          sourceType: st,
          relevance,
          confidence: clamp01(c.confidence),
          supportsOutcomeIdx: idx,
          supportRationale: String(c.supportRationale ?? "").slice(0, 400),
          quote: c.quote.trim().slice(0, 300),
        });
      }
    } catch (err) {
      diag.llmFailed++;
      console.warn(`  [extract] ${doc.domain}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`  [extract] ${market.id}: ${JSON.stringify({ ...diag, samples: undefined })}`);
  return { claims: out.sort((a, b) => b.relevance * b.confidence - a.relevance * a.confidence), diag };
}

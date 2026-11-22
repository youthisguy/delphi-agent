import { generateJson } from "./llmRouter.js";
import { EV } from "./evidenceConfig.js";
import { recentJudgments } from "./evidenceJournal.js";
import type { EvidenceMarket, ExtractedClaim, PackagedEvidence } from "./types.js";

const SYSTEM = `You write ultra-concise evidence notes for a prediction-market judge.
Structure: (1) the claim, plainly; (2) the primary source and its date; (3) why it matters to the market's resolution.
Rules: only restate facts given to you; add no new facts, numbers, names or links; no hype, no probabilities, no betting advice; plain text, no markdown. Return JSON only.`;

export async function packageEvidence(market: EvidenceMarket, c: ExtractedClaim): Promise<PackagedEvidence> {
  const judged = recentJudgments(3).filter((j) => (j.reward ?? 0) > 0 && j.note);
  const user = `Market: ${market.question}
Outcome this evidence supports: ${c.supportsOutcomeIdx} (${c.supportsOutcomeIdx !== null ? market.outcomes[c.supportsOutcomeIdx] : "?"})
Claim: ${c.claim}
Event date: ${c.eventDate ?? "n/a"}; source published: ${c.sourcePublishedAt ?? "n/a"}; source: ${c.sourceDomain} (${c.sourceType})
Supporting excerpt: "${c.quote}"
Why it points that way: ${c.supportRationale}
${judged.length ? `\nExamples of notes the judge rewarded:\n${judged.map((j) => `- ${j.note!.slice(0, 300)}`).join("\n")}\n` : ""}
Write the note body in at most ${EV.maxNoteWords} words. Do NOT include URLs (they are attached separately).
Return {"note": string}`;

  const { data } = await generateJson<string>({
    label: "package", system: SYSTEM, user,
    validate: (r: any) => {
      if (!r || typeof r.note !== "string" || r.note.trim().length < 30) throw new Error("note missing/too short");
      return r.note.trim();
    },
  });

  // Deterministic assembly: the LLM never writes URLs, so links can't be fabricated.
  const words = data.split(/\s+/);
  const body = words.length > EV.maxNoteWords ? words.slice(0, EV.maxNoteWords).join(" ") + "…" : data;
  const when = c.sourcePublishedAt?.slice(0, 10) ?? c.eventDate ?? "undated";
  // The judge reads only the submission and opens each link once with a basic fetch (paywalls/X/Reddit fail),
  // so the decisive sentence is quoted in the note itself. The quote was verified against the page in extract.ts.
  const qw = c.quote.split(/\s+/);
  const excerpt = qw.length > 40 ? qw.slice(0, 40).join(" ") + "…" : c.quote;
  const note = `${body}\n\nKey excerpt: "${excerpt}"\n\nSource: ${c.sourceUrl} (${c.sourceDomain}, ${when})`;

  return {
    note,
    links: [{ url: c.sourceUrl, publishedAt: c.sourcePublishedAt ?? c.eventDate }],
    files: [],
    claim: c,
  };
}

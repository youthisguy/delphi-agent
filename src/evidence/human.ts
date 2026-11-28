import fs from "node:fs";
import path from "node:path";
import { EV, COMPETITION_RULES } from "./evidenceConfig.js";
import { appendEvent, newAttemptId, priorClaims, usedUrls, normUrl, submissionsFor, readAttempts } from "./evidenceJournal.js";
import { checkSubmitGuards } from "./guards.js";
import { slotsLeft as serverSlotsLeft } from "./slots.js";
import { isNearDuplicate } from "./novelty.js";
import { generateJson } from "./llmRouter.js";
import { buildPayload, type Submitter } from "./submit.js";
import { domainOf } from "./search.js";
import type { EvidenceMarket, ExtractedClaim, PackagedEvidence, SourceRef } from "./types.js";

/**
 * HUMAN DESK — manual evidence, as a backup to the agent. A human finds/reads sources, the agent helps
 * (search, fetch+extract, polish), and the submission goes through the SAME guards, journal and submitter
 * as the automated loop — so the 3-per-market cap and the one-direction rule hold across both.
 */

export interface HumanLink { url: string; publishedAt?: string | null; title?: string }
export interface HumanFile { name: string; mime: string; dataBase64: string }
export interface HumanDraft {
  marketId: string;
  outcomeIdx: number;
  note: string;
  links: HumanLink[];
  files?: HumanFile[];
  sourceType?: "primary" | "secondary";
  force?: boolean;
  /** Only for markets not on the board (e.g. typed in by hand). */
  market?: { question: string; outcomes: string[] };
}
export interface CheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  slotsLeft: number;
  lockedOutcome: number | null;
  note: string; // final note as it will be sent
}

// Sites the judge's single basic fetch usually can't read (login/paywall/JS) — paste the text + attach a screenshot.
const JUDGE_HOSTILE = /(^|\.)(x\.com|twitter\.com|reddit\.com|facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|wsj\.com|ft\.com|nytimes\.com|bloomberg\.com|economist\.com|thetimes\.co\.uk|telegraph\.co\.uk)$/i;
const ALLOWED_MIME = /^(image\/(png|jpeg)|application\/pdf|text\/(plain|csv))$/;

export function readBoard(): any[] {
  try { return JSON.parse(fs.readFileSync(EV.statusPath, "utf8")).marketBoard ?? []; } catch { return []; }
}

export function findMarket(id: string, custom?: HumanDraft["market"]): EvidenceMarket | null {
  const b = readBoard().find((m) => m.id === id);
  if (b) return { id: b.id, question: b.question, outcomes: b.outcomes ?? ["Yes", "No"], category: b.category ?? undefined, resolvesAt: b.resolvesAt ?? null, resolutionCriteria: b.resolutionCriteria ?? undefined };
  const a = readAttempts().find((x) => x.marketId === id && x.question);
  if (a) return { id, question: a.question, outcomes: a.outcomes ?? ["Yes", "No"], resolvesAt: null };
  if (custom?.question && Array.isArray(custom.outcomes) && custom.outcomes.length >= 2) return { id, question: custom.question, outcomes: custom.outcomes, resolvesAt: null };
  return null;
}

const validDate = (s?: string | null): boolean => {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && t <= Date.now() + 86400e3;
};

export function assembleNote(d: Pick<HumanDraft, "note" | "links">): string {
  let note = (d.note ?? "").trim();
  const missing = d.links
    .filter((l) => l.url && !note.includes(l.url))
    .map((l) => `Source: ${l.url} (${domainOf(l.url)}${l.publishedAt ? ", " + l.publishedAt.slice(0, 10) : ""})`);
  if (missing.length) note += "\n\n" + missing.join("\n");
  return note;
}

export function lockedOutcomeFor(marketId: string, dryRun: boolean): number | null {
  const p = submissionsFor(marketId, dryRun).find((a) => a.polarity !== null);
  return p ? p.polarity : null;
}

export function checkHuman(d: HumanDraft, dryRun: boolean): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const market = findMarket(d.marketId, d.market);
  const note = assembleNote(d);
  const slotsLeft = serverSlotsLeft(d.marketId, dryRun);
  const lockedOutcome = lockedOutcomeFor(d.marketId, dryRun);
  const res = (): CheckResult => ({ ok: errors.length === 0, errors, warnings, slotsLeft, lockedOutcome, note });

  if (!market) { errors.push("unknown market — pick one from the list or enter its id, question and outcomes"); return res(); }
  if (!Number.isInteger(d.outcomeIdx) || d.outcomeIdx < 0 || d.outcomeIdx >= market.outcomes.length) { errors.push("choose which outcome this evidence supports"); return res(); }

  if (note.length < 40) errors.push("note is too short to be useful");
  if (note.length > EV.maxNoteChars) errors.push(`note is ${note.length} chars; limit is ${EV.maxNoteChars}`);

  const links = (d.links ?? []).filter((l) => l.url?.trim());
  if (!links.length) errors.push("add at least one working link");
  for (const l of links) if (!/^https?:\/\/\S+$/i.test(l.url)) errors.push(`not a valid http(s) link: ${l.url.slice(0, 60)}`);
  if (links.length && !links.some((l) => validDate(l.publishedAt))) errors.push("at least one link needs its publication date (YYYY-MM-DD, not in the future)");
  for (const l of links) if (l.publishedAt && !validDate(l.publishedAt)) errors.push(`bad date for ${domainOf(l.url)}: ${l.publishedAt}`);

  const files = d.files ?? [];
  if (files.length > COMPETITION_RULES.maxSupportingFiles) errors.push(`max ${COMPETITION_RULES.maxSupportingFiles} files`);
  if (1 + links.length + files.length > COMPETITION_RULES.maxItemsPerSubmission) warnings.push(`Delphi says a submission holds up to ${COMPETITION_RULES.maxItemsPerSubmission} items in total (note + links + files); this has ${1 + links.length + files.length}, so the API may refuse it`);
  for (const f of files) {
    if (!ALLOWED_MIME.test(f.mime)) errors.push(`${f.name}: unsupported type ${f.mime} (png, jpg, pdf, csv, txt)`);
    if (Math.floor((f.dataBase64.length * 3) / 4) > EV.maxHumanFileBytes) errors.push(`${f.name}: larger than ${Math.round(EV.maxHumanFileBytes / 1e6)} MB`);
  }

  const hostile = links.filter((l) => JUDGE_HOSTILE.test(domainOf(l.url)));
  if (hostile.length && !files.length)
    warnings.push(`${hostile.map((l) => domainOf(l.url)).join(", ")}: the judge's one basic fetch will likely fail. Paste the key text into the note and attach a screenshot showing the URL and date.`);
  if (!/\d/.test(note)) warnings.push("note has no numbers or dates — judges reward concrete, checkable facts");

  // duplicates (same fact or same URL already used on this market, in this mode)
  if (isNearDuplicate(note, priorClaims(d.marketId, dryRun))) warnings.push("DUPLICATE: reads like an earlier note on this market — repeats earn nothing and use up a slot");
  const used = usedUrls(d.marketId, dryRun);
  if (links.some((l) => used.has(normUrl(l.url)))) warnings.push("DUPLICATE: one of these URLs was already used on this market");

  // hard competition rules, same code path as the agent
  if (!errors.length) {
    const claim: ExtractedClaim = {
      claim: note.split(/(?<=[.!?])\s/)[0].slice(0, 300), eventDate: null, sourceUrl: links[0].url, sourceDomain: domainOf(links[0].url),
      sourcePublishedAt: links.find((l) => validDate(l.publishedAt))?.publishedAt ?? null, sourceType: d.sourceType ?? "secondary",
      relevance: 1, confidence: 1, supportsOutcomeIdx: d.outcomeIdx, supportRationale: "human-reviewed", quote: "",
    };
    const packaged: PackagedEvidence = { note, links: links.map((l) => ({ url: l.url, title: l.title, publishedAt: l.publishedAt ?? null })), files: files.map((f) => f.name), claim };
    const g = checkSubmitGuards({ marketId: d.marketId, outcomeIdx: d.outcomeIdx, packaged, dryRun });
    if (!g.ok) errors.push(g.reason);
  }
  return res();
}

export async function submitHuman(d: HumanDraft, submitter: Submitter, dryRun: boolean) {
  const market = findMarket(d.marketId, d.market)!;
  const chk = checkHuman(d, dryRun);
  if (!chk.ok) throw new Error(chk.errors.join("; "));
  if (chk.warnings.some((w) => w.startsWith("DUPLICATE")) && !d.force) throw new Error("possible duplicate — tick “submit anyway” if you are sure this is new");

  const attemptId = newAttemptId();
  const links = d.links.filter((l) => l.url?.trim());
  const filePaths: string[] = [];
  if (d.files?.length) {
    const dir = path.join(EV.filesDir, attemptId);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of d.files) {
      const p = path.join(dir, f.name.replace(/[^\w.\-]+/g, "_").slice(-80) || "file");
      fs.writeFileSync(p, Buffer.from(f.dataBase64, "base64"));
      filePaths.push(p);
    }
  }
  const sources: SourceRef[] = links.map((l) => ({ url: l.url, domain: domainOf(l.url), title: l.title, publishedAt: l.publishedAt ?? null, fetchMethod: "fetch", ok: true }));
  const claim: ExtractedClaim = {
    claim: chk.note.split(/(?<=[.!?])\s/)[0].slice(0, 300), eventDate: null, sourceUrl: links[0].url, sourceDomain: domainOf(links[0].url),
    sourcePublishedAt: links.find((l) => validDate(l.publishedAt))?.publishedAt ?? null, sourceType: d.sourceType ?? "secondary",
    relevance: 1, confidence: 1, supportsOutcomeIdx: d.outcomeIdx, supportRationale: "human-reviewed", quote: "",
  };
  const packaged: PackagedEvidence = { note: chk.note, links: links.map((l) => ({ url: l.url, title: l.title, publishedAt: l.publishedAt ?? null })), files: filePaths, claim };

  appendEvent(attemptId, market.id, "started", { question: market.question, outcomes: market.outcomes, origin: "human", startedAt: new Date().toISOString(), dryRun, queriesRun: [], sourcesFetched: sources, extractedClaims: [claim], polarity: null });
  appendEvent(attemptId, market.id, "packaged", { packaged, polarity: d.outcomeIdx });
  const payload = buildPayload(market.id, d.outcomeIdx, packaged, market.outcomes[d.outcomeIdx]);
  const receipt = await submitter.submit(payload);
  appendEvent(attemptId, market.id, "submitted", { submissionPayload: payload, submittedAt: receipt.submittedAt, receipt: { id: receipt.id, raw: receipt.raw } });
  return { attemptId, receipt, files: filePaths, note: chk.note, dryRun };
}

/** Turn rough human notes into a judge-ready note. Uses only the facts supplied. Falls back to the rough note on LLM failure. */
export async function polishNote(input: { marketId: string; outcomeIdx: number; note: string; links: HumanLink[]; excerpt?: string; market?: HumanDraft["market"] }): Promise<{ note: string; llm: boolean }> {
  const market = findMarket(input.marketId, input.market);
  const raw = (input.note ?? "").trim();
  if (!market || raw.length < 10) return { note: raw, llm: false };
  const user = `Market: ${market.question}
Outcome this evidence supports: ${input.outcomeIdx} (${market.outcomes[input.outcomeIdx] ?? "?"})
${market.resolutionCriteria ? `Resolution criteria: ${market.resolutionCriteria}\n` : ""}Today: ${new Date().toISOString().slice(0, 10)}

A human researcher's rough notes (the ONLY facts you may use):
${raw}
${input.excerpt ? `\nKey excerpt copied from the source: "${input.excerpt}"` : ""}
Sources and dates:
${input.links.filter((l) => l.url).map((l) => `- ${l.url} (${l.publishedAt || "date unknown"})`).join("\n")}

Rewrite as a short evidence note for a judge who only reads this text: (1) the claim, plainly; (2) the primary source and its date; (3) why it matters to the market's resolution.${input.excerpt ? " Keep the key excerpt in quotation marks." : ""}
At most ${EV.maxNoteWords} words, plain text, no markdown, no URLs, no probabilities, no betting advice. Add NO facts, numbers or names that are not in the rough notes. Return {"note": string}`;
  try {
    const { data } = await generateJson<string>({
      label: "human-polish",
      system: "You edit rough research notes into concise, faithful evidence notes for a prediction-market judge. Never add facts. Return JSON only.",
      user,
      validate: (r: any) => { if (!r || typeof r.note !== "string" || r.note.trim().length < 20) throw new Error("note missing"); return r.note.trim(); },
    });
    return { note: data, llm: true };
  } catch {
    return { note: raw, llm: false };
  }
}

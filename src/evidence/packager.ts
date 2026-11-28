import { generateJson } from "./llmRouter.js";
import { EV } from "./evidenceConfig.js";
import { recentJudgments, normUrl, usedUrls } from "./evidenceJournal.js";
import { assessNovelty } from "./novelty.js";
import { localesFor, looksNonEnglish } from "./locale.js";
import type { EvidenceMarket, ExtractedClaim, PackagedEvidence } from "./types.js";

/**
 * Packaging v2. The accepted Slovenian note won on its fact, so v2 keeps the fact intact and makes it easier to weigh:
 *  1. keeps every specific (who measured, when, who was covered, exact figures);
 *  2. a "Derived:" line with the gap to the market's threshold, only if the arithmetic checks out in code;
 *  3. an English translation next to a non-English excerpt, only if it adds/drops no numbers;
 *  4. optionally bundles one second, independent fact + link (a submission holds note + links + files, max 3 items);
 *  5. never writes "date not provided" - says "retrieved <date>" instead;
 *  6. tags the packaging style so rewards can be compared across styles.
 */

// Tracking junk (?ref=adjacent-news..., utm_*) must not reach the judge: it looks sloppy and can change what the page serves.
const TRACKING = /^(utm_|ref$|ref_|fbclid$|gclid$|igshid$|mc_cid$|mc_eid$|ocid$|ncid$)/i;
export function cleanUrl(u: string): string {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    x.hash = "";
    return x.toString().replace(/\?$/, "");
  } catch {
    return u;
  }
}

// ---------- number handling: the LLM never gets to invent a figure ----------
/** Every number written in `text`, with both readings of ambiguous separators (36,8 -> 36.8; 1.234 -> 1.234 and 1234). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const s = m[0];
    const add = (v: number) => { if (Number.isFinite(v)) out.push(v); };
    if (/^\d+$/.test(s)) add(Number(s));
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) add(Number(s.replace(/,/g, "")));                 // 1,234.5
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) add(Number(s.replace(/\./g, "").replace(",", "."))); // 1.234,5
    if (/^\d+\.\d+$/.test(s)) add(Number(s));                                                   // 36.8
    if (/^\d+,\d+$/.test(s) && !/^\d{1,3}(,\d{3})+$/.test(s)) add(Number(s.replace(",", "."))); // 36,8
  }
  return out;
}

function evalArithmetic(src: string): number {
  let i = 0;
  const peek = (): string | undefined => { while (src[i] === " ") i++; return src[i]; };
  const num = (): number => {
    const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error("number expected");
    i += m[0].length;
    return Number(m[0]);
  };
  const atom = (): number => {
    const c = peek();
    if (c === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error(") expected"); i++; return v; }
    if (c === "-") { i++; return -atom(); }
    return num();
  };
  const term = (): number => {
    let v = atom();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v *= atom(); }
      else if (c === "/") { i++; const d = atom(); if (d === 0) throw new Error("divide by zero"); v /= d; }
      else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v += term(); }
      else if (c === "-") { i++; v -= term(); }
      else return v;
    }
  };
  const v = expr();
  if (peek() !== undefined) throw new Error("trailing input");
  return v;
}

export interface DerivedProposal { expression: string; result: number; statement: string }

/**
 * Accept an LLM-proposed "gap to threshold" line only if: the expression is pure arithmetic, every operand appears in the
 * claim / excerpt / market question, the recomputed result matches, and the sentence contains no other number.
 */
export function verifyDerived(d: unknown, sources: string[]): string | null {
  const p = d as DerivedProposal | null;
  if (!p || typeof p.expression !== "string" || typeof p.statement !== "string" || typeof p.result !== "number") return null;
  if (!/^[\d\s.+\-*/()]+$/.test(p.expression)) return null;
  const operands = p.expression.match(/\d+(?:\.\d+)?/g) ?? [];
  if (operands.length < 2 || operands.length > 4) return null;
  const allowed = new Set(sources.flatMap(numbersIn));
  if (!operands.every((o) => allowed.has(Number(o)))) return null;
  let value: number;
  try { value = evalArithmetic(p.expression); } catch { return null; }
  if (!Number.isFinite(value) || Math.abs(value - p.result) > 0.011) return null;
  const st = p.statement.trim().replace(/^derived:\s*/i, "");
  if (st.length < 10 || st.length > 220) return null;
  const nums = numbersIn(st);
  if (!nums.some((n) => Math.abs(n - Math.abs(value)) < 0.011)) return null;           // must state the result
  if (!nums.every((n) => allowed.has(n) || Math.abs(n - Math.abs(value)) < 0.011)) return null; // and no invented number
  return st;
}

/** Accept a translation only if it neither adds nor drops a number found in the original excerpt. */
export function verifyTranslation(tr: unknown, quote: string): string | null {
  if (typeof tr !== "string") return null;
  const t = tr.trim().replace(/^["“„«]+|["”“»]+$/g, "").trim();
  if (t.length < 10 || t.length > quote.length * 2.5 + 60) return null;
  const q = new Set(numbersIn(quote));
  const tn = numbersIn(t);
  if (tn.some((n) => !q.has(n))) return null;
  for (const n of q) if (!tn.includes(n)) return null;
  return t;
}

const UNDATED_PHRASE = /,?\s*(?:source\s+)?dates?\s+(?:was\s+|is\s+)?(?:not\s+(?:provided|available|specified|given|stated|known)|unavailable|unknown|n\/a)/gi;
export const scrubUndated = (s: string): string => s.replace(UNDATED_PHRASE, "").replace(/\s+([.,;:])/g, "$1").replace(/ {2,}/g, " ").trim();

const SYSTEM = `You write concise evidence notes for a prediction-market judge who only reads this text.
Lead with the decisive fact. Keep EVERY specific you were given: who measured or announced it (pollster, agency, official), when it was measured or announced, who or what it covered, and the exact figures with units. Then say in one sentence how it bears on the market's resolution line.
Rules: only restate facts given to you; add no new facts, numbers, names or links; no hype, no probabilities, no betting advice; never write that a date is missing or unknown; plain text, no markdown. Return JSON only.`;

export const PACKAGING_STYLE = "v2";
const today = () => new Date().toISOString().slice(0, 10);

/** One extra, independent fact in the same direction (a submission holds note + links + files, max 3 items => note + 2 links). */
export async function pickRelated(market: EvidenceMarket, primary: ExtractedClaim, all: ExtractedClaim[], dryRun: boolean): Promise<ExtractedClaim[]> {
  if (process.env.EVIDENCE_BUNDLE === "false" || primary.supportsOutcomeIdx === null) return [];
  const used = usedUrls(market.id, dryRun);
  const pKey = normUrl(primary.sourceUrl);
  const cands = all
    .filter((x) => x !== primary && x.supportsOutcomeIdx === primary.supportsOutcomeIdx && normUrl(x.sourceUrl) !== pKey && !used.has(normUrl(x.sourceUrl)) && x.sourceType !== "aggregator" && x.relevance >= 0.7 && x.claim !== primary.claim)
    .sort((a, b) => b.relevance * b.confidence - a.relevance * a.confidence);
  for (const x of cands.slice(0, 2)) {
    const n = await assessNovelty(market, x, dryRun);
    if (n.decision !== "reject") return [x];
  }
  return [];
}

export async function packageEvidence(market: EvidenceMarket, c: ExtractedClaim, related: ExtractedClaim[] = []): Promise<PackagedEvidence> {
  const judged = recentJudgments(3).filter((j) => (j.reward ?? 0) > 0 && j.note);
  const foreign = looksNonEnglish(c.quote);
  const langName = foreign ? (localesFor(market)[0]?.name ?? "original language") : "";
  const rel = related.slice(0, 1);
  const srcDate = (x: ExtractedClaim) => x.sourcePublishedAt?.slice(0, 10) ?? x.eventDate ?? `retrieved ${today()}`;

  const user = `Market: ${market.question}
Outcome this evidence supports: ${c.supportsOutcomeIdx} (${c.supportsOutcomeIdx !== null ? market.outcomes[c.supportsOutcomeIdx] : "?"})
Claim: ${c.claim}
Event date: ${c.eventDate ?? "n/a"}; source date: ${srcDate(c)}; source: ${c.sourceDomain} (${c.sourceType})
Supporting excerpt${foreign ? ` (${langName})` : ""}: "${c.quote}"
Why it points that way: ${c.supportRationale}
${rel.length ? `\nSecond, independent fact from a different source (cover it in a second sentence; it supports the same outcome):\nClaim: ${rel[0].claim}\nSource: ${rel[0].sourceDomain}, ${srcDate(rel[0])}\nExcerpt: "${rel[0].quote}"\n` : ""}${judged.length ? `\nExamples of notes the judge rewarded:\n${judged.map((j) => `- ${j.note!.slice(0, 300)}`).join("\n")}\n` : ""}
Write the note body in at most ${EV.maxNoteWords + (rel.length ? 35 : 0)} words. Do NOT include URLs, raw timestamps (use YYYY-MM-DD) or the supporting excerpt itself (attached separately).
Also return:
- "derived": ONLY if the market asks whether a measured figure crosses a threshold written in the market question AND the claim contains that measured figure: {"expression": arithmetic using only numbers that appear in the claim, excerpt or market question (e.g. "50 - 36.8"), "result": number, "statement": one sentence stating the gap, containing the result and no other new numbers}. Otherwise null.
- "translation": ${foreign ? `a faithful English translation of the ${langName} excerpt, adding nothing and dropping nothing, with every number kept` : "null"}.
Return {"note": string, "derived": object|null, "translation": string|null}`;

  const { data } = await generateJson<{ note: string; derived: unknown; translation: unknown }>({
    label: "package", system: SYSTEM, user,
    validate: (r: any) => {
      if (!r || typeof r.note !== "string" || r.note.trim().length < 30) throw new Error("note missing/too short");
      return { note: r.note.trim(), derived: r.derived ?? null, translation: r.translation ?? null };
    },
  });

  // Deterministic assembly: the LLM never writes URLs, derived figures are re-computed, translations are number-checked.
  const clean = scrubUndated(data.note);
  const limit = EV.maxNoteWords + (rel.length ? 35 : 0);
  const words = clean.split(/\s+/);
  const body = words.length > limit ? words.slice(0, limit).join(" ") + "…" : clean;

  const sources = [c.claim, c.quote, market.question, ...(rel.length ? [rel[0].claim, rel[0].quote] : [])];
  const derived = verifyDerived(data.derived, sources);
  const translation = foreign ? verifyTranslation(data.translation, c.quote) : null;

  const qw = c.quote.split(/\s+/);
  const excerpt = qw.length > 40 ? qw.slice(0, 40).join(" ") + "…" : c.quote;
  const bodyHasQuote = body.toLowerCase().includes(excerpt.replace(/…$/, "").toLowerCase());
  const url = cleanUrl(c.sourceUrl);

  const parts: string[] = [body];
  if (derived) parts.push(`Derived: ${derived}`);
  if (!bodyHasQuote) parts.push(`Key excerpt${foreign ? ` (${langName})` : ""}: "${excerpt}"` + (translation ? `\nEnglish (our translation): ${translation}` : ""));
  else if (translation) parts.push(`English (our translation): ${translation}`);
  const srcLines = [`Source: ${url} (${c.sourceDomain}, ${srcDate(c)})`];
  const links: PackagedEvidence["links"] = [{ url, publishedAt: c.sourcePublishedAt ?? c.eventDate }];
  if (rel.length) {
    const u2 = cleanUrl(rel[0].sourceUrl);
    srcLines.push(`Source 2: ${u2} (${rel[0].sourceDomain}, ${srcDate(rel[0])})`);
    links.push({ url: u2, publishedAt: rel[0].sourcePublishedAt ?? rel[0].eventDate });
  }
  parts.push(srcLines.join("\n"));

  const style = [PACKAGING_STYLE, derived ? "derived" : "", translation ? "translated" : "", rel.length ? "bundled" : ""].filter(Boolean).join("+");
  return { note: parts.join("\n\n"), links, files: [], claim: c, style };
}

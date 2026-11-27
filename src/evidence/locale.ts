import { generateJson } from "./llmRouter.js";
import type { EvidenceMarket } from "./types.js";

/**
 * Local-language research. The forecaster mostly reads English, so fresh local-language reporting (polls, turnout,
 * filings, local officials) is where unpriced facts live. This file detects a market's country/language and writes
 * local-language search queries. Tunable via env; set EVIDENCE_LOCAL_LANG=false to switch it all off.
 */
export interface Locale { lang: string; name: string; country: string } // country = ISO alpha-2, lower-case (Google "gl")

const n = (k: string, d: number) => (Number.isFinite(Number(process.env[k])) && process.env[k] ? Number(process.env[k]) : d);
export const LOCAL = {
  enabled: process.env.EVIDENCE_LOCAL_LANG !== "false",
  maxLangs: n("EVIDENCE_LOCAL_MAX_LANGS", 2),      // languages searched per market
  queriesPerLang: n("EVIDENCE_LOCAL_QUERIES", 3),  // local-language queries per language
  docQuota: n("EVIDENCE_LOCAL_DOCS", 2),           // fetched-document slots reserved for local sources
  bonus: n("EVIDENCE_LOCAL_BONUS", 0.1),           // novelty-score bonus for a non-English quote
};

const L = (lang: string, name: string, country: string): Locale => ({ lang, name, country });
const RULES: [RegExp, Locale[]][] = [
  [/\bslovenia|sloven(ian|ija)|\bdvk\b|ljubljana|\.si\b/i, [L("sl", "Slovenian", "si")]],
  [/\bswitzerland|\bswiss\b|\bbern\b|\.ch\b/i, [L("de", "German", "ch"), L("fr", "French", "ch")]],
  [/\bspain\b|\bspanish\b|madrid|\.es\b/i, [L("es", "Spanish", "es")]],
  [/\bfrance\b|\bfrench\b|macron|assembl[ée]e nationale|49\.3|\.fr\b/i, [L("fr", "French", "fr")]],
  [/\bgerman(y)?\b|bundestag|bundesbank|\bberlin\b|\.de\b/i, [L("de", "German", "de")]],
  [/\baustria|\bvienna\b|\.at\b/i, [L("de", "German", "at")]],
  [/\bitaly\b|\bitalian\b|meloni|\.it\b/i, [L("it", "Italian", "it")]],
  [/\bportugal|portuguese|\.pt\b/i, [L("pt", "Portuguese", "pt")]],
  [/\bbrazil|brazilian|\.br\b/i, [L("pt", "Portuguese", "br")]],
  [/\bnetherlands|\bdutch\b|amsterdam|\.nl\b/i, [L("nl", "Dutch", "nl")]],
  [/\bbelgi(um|an)\b|brussels/i, [L("nl", "Dutch", "be"), L("fr", "French", "be")]],
  [/\bpoland|polish|warsaw|\.pl\b/i, [L("pl", "Polish", "pl")]],
  [/\bczech|prague|\.cz\b/i, [L("cs", "Czech", "cz")]],
  [/\bhungar(y|ian)|budapest|\.hu\b/i, [L("hu", "Hungarian", "hu")]],
  [/\bromania|bucharest|\.ro\b/i, [L("ro", "Romanian", "ro")]],
  [/\bbulgaria|sofia\b|\.bg\b/i, [L("bg", "Bulgarian", "bg")]],
  [/\bcroatia|zagreb|\.hr\b/i, [L("hr", "Croatian", "hr")]],
  [/\bserbia|belgrade|\.rs\b/i, [L("sr", "Serbian", "rs")]],
  [/\bgreece|greek|athens|\.gr\b/i, [L("el", "Greek", "gr")]],
  [/\bturkey\b|t[üu]rkiye|turkish|ankara|\.tr\b/i, [L("tr", "Turkish", "tr")]],
  [/\bukrain(e|ian)|kyiv|kiev|\.ua\b/i, [L("uk", "Ukrainian", "ua")]],
  [/\brussia|kremlin|moscow|\.ru\b/i, [L("ru", "Russian", "ru")]],
  [/\bjapan|tokyo|\bboj\b|bank of japan|councillors|\.jp\b/i, [L("ja", "Japanese", "jp")]],
  [/\bkorea|seoul|\.kr\b/i, [L("ko", "Korean", "kr")]],
  [/\bchina\b|chinese|beijing|pboc|\.cn\b/i, [L("zh-cn", "Chinese", "cn")]],
  [/\btaiwan|taipei|\.tw\b/i, [L("zh-tw", "Chinese", "tw")]],
  [/\bindonesia|jakarta|\.id\b/i, [L("id", "Indonesian", "id")]],
  [/\bvietnam|hanoi|\.vn\b/i, [L("vi", "Vietnamese", "vn")]],
  [/\bthailand|bangkok|\.th\b/i, [L("th", "Thai", "th")]],
  [/\begypt|saudi|emirates|\buae\b|qatar|\bdubai\b/i, [L("ar", "Arabic", "eg")]],
  [/\bisrael|knesset|jerusalem|\.il\b/i, [L("he", "Hebrew", "il")]],
  [/\biran(ian)?\b|tehran/i, [L("fa", "Persian", "ir")]],
  [/(?<!new )\bmexic(o|an)\b|banxico|\.mx\b/i, [L("es", "Spanish", "mx")]],
  [/\bargentin|milei|buenos aires|\.ar\b/i, [L("es", "Spanish", "ar")]],
  [/\bchile|santiago de|\.cl\b/i, [L("es", "Spanish", "cl")]],
  [/\bcolombia|bogot[aá]|\.co\b/i, [L("es", "Spanish", "co")]],
  [/\bsweden|swedish|stockholm|\.se\b/i, [L("sv", "Swedish", "se")]],
  [/\bnorway|norwegian|oslo|\.no\b/i, [L("no", "Norwegian", "no")]],
  [/\bdenmark|danish|copenhagen|\.dk\b/i, [L("da", "Danish", "dk")]],
  [/\bfinland|finnish|helsinki|\.fi\b/i, [L("fi", "Finnish", "fi")]],
];

function hostsOf(urls: string[] | undefined): string {
  return (urls ?? []).map((u) => { try { return new URL(u).hostname; } catch { return ""; } }).join(" ");
}

/** Which non-English languages are worth searching for this market (empty = English-only market). */
export function localesFor(m: Pick<EvidenceMarket, "question" | "category" | "resolutionCriteria" | "sourceUrls">): Locale[] {
  const hay = `${m.question} ${m.category ?? ""} ${m.resolutionCriteria ?? ""} ${hostsOf(m.sourceUrls)}`;
  const out: Locale[] = [];
  for (const [re, locs] of RULES) {
    if (!re.test(hay)) continue;
    for (const l of locs) if (!out.some((o) => o.lang === l.lang && o.country === l.country)) out.push(l);
  }
  return out;
}

const cache = new Map<string, string[]>();
/** Local-language search queries, written the way a local journalist would phrase them. Cached per market+language. */
export async function localQueries(m: Pick<EvidenceMarket, "id" | "question" | "resolutionCriteria">, loc: Locale, count: number): Promise<string[]> {
  const key = `${m.id}|${loc.lang}|${loc.country}|${count}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const { data } = await generateJson<string[]>({
      label: "local-queries",
      system: "You write web search queries in the requested language, phrased as a local journalist or researcher would search. Return JSON only.",
      user: `Market question (English): ${m.question}
${m.resolutionCriteria ? `Resolution criteria: ${m.resolutionCriteria}\n` : ""}
Write ${count} short search queries in ${loc.name} (max 8 words each) that would find the freshest local reporting, official announcements and numbers (polls, turnout, results, filings, statements by local officials) bearing on this question. Use the local names of institutions, parties and places. Do not translate word for word if a local term is more common.
Return {"queries": string[]}`,
      validate: (r: any) => {
        const qs = (Array.isArray(r?.queries) ? r.queries : []).filter((q: any) => typeof q === "string").map((q: string) => q.trim()).filter((q: string) => q.length >= 3 && q.length <= 120);
        if (!qs.length) throw new Error("no queries");
        return qs.slice(0, count);
      },
    });
    cache.set(key, data);
    return data;
  } catch (e) {
    console.warn(`  [locale] could not write ${loc.name} queries:`, e instanceof Error ? e.message : e);
    return [];
  }
}

const EN_STOP = new Set("the of and to in is that for with on as by was are at from this be it or an have has not will but they their".split(" "));
/** Cheap language check: non-Latin script, or almost no English function words in a passage of 8+ words. */
export function looksNonEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 12) return false;
  const nonLatin = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
  if (nonLatin / letters.length > 0.3) return true;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 8) return false;
  return words.filter((w) => EN_STOP.has(w)).length / words.length < 0.1;
}

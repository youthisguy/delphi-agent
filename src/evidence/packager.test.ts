process.env.EVIDENCE_LLM_ORDER = "gemini"; process.env.GEMINI_API_KEY = "x";
process.env.EVIDENCE_JOURNAL_PATH = "data/pk.jsonl"; process.env.EVIDENCE_STATUS_PATH = "data/pk-status.json";
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const { numbersIn, verifyDerived, verifyTranslation, scrubUndated, packageEvidence, pickRelated, cleanUrl } = await import("./packager.js");
const { checkSubmitGuards } = await import("./guards.js");

// ---------- numbers ----------
const has = (t: string, n: number) => numbersIn(t).includes(n);
ok(has("36,8 odstotka", 36.8) && has("proti 48,3 %", 48.3), "decimal comma read as 36.8 / 48.3");
ok(has("36.8% support", 36.8) && has("$61,890 today", 61890), "decimal point and thousands comma");
ok(has("1.234 trucks", 1234) && has("1.234 trucks", 1.234), "ambiguous 1.234 yields both readings");

// ---------- derived: only verified arithmetic survives ----------
const src = ["Ninamedia poll: 36.8% support and 48.3% opposition", "Na vprašanje ... 36,8 odstotka ... 48,3 odstotka", "Will DVK's results show >50% of valid votes FOR?"];
const good = { expression: "50 - 36.8", result: 13.2, statement: "Derived: FOR would need +13.2 points from this reading to pass 50%." };
ok(!!verifyDerived(good, src)?.startsWith("FOR would need +13.2"), "valid gap accepted ('Derived:' prefix stripped, not doubled)");
ok(verifyDerived({ ...good, expression: "40 - 36.8", result: 3.2, statement: "It needs +3.2 points." }, src) === null, "operand not in the sources (40) refused");
ok(verifyDerived({ ...good, result: 14.2 }, src) === null, "result that does not recompute refused");
ok(verifyDerived({ ...good, statement: "FOR would need +13.2 points, and turnout was 61%." }, src) === null, "statement containing an invented number refused");
ok(verifyDerived({ ...good, statement: "FOR trails the line." }, src) === null, "statement that does not state the result refused");
ok(verifyDerived({ expression: "process.exit(1)", result: 1, statement: "x +1 point gap here" }, src) === null, "non-arithmetic expression refused");
ok(verifyDerived({ expression: "50 / 0", result: 0, statement: "gap of 0 here ok" }, src) === null, "division by zero refused");
ok(verifyDerived(null, src) === null && verifyDerived("junk", src) === null, "null / junk refused");

// ---------- translation ----------
const quote = "Na vprašanje, ali so za uveljavitev interventnega zakona, je med tistimi, ki se 6. decembra nameravajo udeležiti referenduma, pritrdilno odgovorilo 36,8 odstotka vprašanih, proti se jih je izreklo 48,3 odstotka.";
ok(verifyTranslation("Asked whether they support the intervention law, 36.8% of those planning to vote on 6 December said yes and 48.3% said no.", quote) !== null, "faithful translation accepted");
ok(verifyTranslation("Asked whether they support the law, 38.6% of those planning to vote on 6 December said yes and 48.3% said no.", quote) === null, "translation with a changed number refused");
ok(verifyTranslation("Asked whether they support the law, 36.8% of those planning to vote said yes and 48.3% said no.", quote) === null, "translation that drops a number (the date) refused");

// ---------- undated phrasing ----------
ok(scrubUndated("Primary source: seco.admin.ch, date not provided. This matters.") === "Primary source: seco.admin.ch. This matters.", "'date not provided' removed");
ok(scrubUndated("The source date is unknown, but the claim holds.") === "The source, but the claim holds." || !/unknown/.test(scrubUndated("The source date is unknown, but the claim holds.")), "'date is unknown' removed");

// ---------- full packaging with a mocked LLM ----------
let reply: any = {};
let lastPrompt = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.includes("generativelanguage")) {
    lastPrompt = JSON.parse(init.body).contents[0].parts[0].text;
    const isNovelty = lastPrompt.includes("tightToResolution");
    const out = isNovelty ? { frontierLikelyKnows: 0.3, tightToResolution: 0.8, primaryStrength: 0.7, directionOk: true, rationale: "ok" } : reply;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
  }
  return realFetch(input, init);
}) as any;

const market: any = { id: "m-si", question: "Will DVK's election-night results show >50% of valid votes FOR in Slovenia's Dec 6, 2026 referendum on the intervention law (ZIURS)?", outcomes: ["Yes", "No"], resolvesAt: null };
const claim: any = { claim: "According to the Vox Populi poll by Ninamedia (16-18 Nov 2026), 36.8% of respondents planning to vote on 6 December supported the intervention law, while 48.3% opposed it.", eventDate: "2026-11-25", sourceUrl: "https://www.rtvslo.si/a/801215?utm_source=tw&ref=x", sourceDomain: "rtvslo.si", sourcePublishedAt: "2026-11-25T11:42:38.000Z", sourceType: "secondary", relevance: 0.9, confidence: 0.9, supportsOutcomeIdx: 1, supportRationale: "more opposition than support", quote };

reply = { note: "Ninamedia's Vox Populi poll (fieldwork 16-18 Nov 2026, published 2026-11-25) of people intending to vote on 6 December found 36.8% for the intervention law and 48.3% against. Opposition leads support among likely voters.", derived: good, translation: "Asked whether they support the intervention law, 36.8% of those planning to vote on 6 December said yes and 48.3% said no." };
const p1 = await packageEvidence(market, claim);
ok(/Derived: FOR would need \+13\.2 points/.test(p1.note) && !/Derived: Derived/.test(p1.note), "note carries the verified Derived line");
ok(/Key excerpt \(.+\): "Na vprašanje/.test(p1.note) && /English \(our translation\): Asked whether/.test(p1.note), "original-language excerpt + our translation present");
ok(p1.note.includes("Source: https://www.rtvslo.si/a/801215 (rtvslo.si, 2026-11-25)") && !p1.note.includes("utm_"), "source line clean (tracking removed, date shown)");
ok(p1.style === "v2+derived+translated" && p1.links.length === 1, "style tag set; single link");
ok(/"derived": ONLY if/.test(lastPrompt) && /faithful English translation of the/.test(lastPrompt) && /excerpt \(.+\): "Na vprašanje/i.test(lastPrompt), "prompt asks for derived + translation and labels the foreign excerpt");

// LLM proposes a bogus derived figure and a bad translation -> both dropped, note still valid
reply = { note: "Ninamedia's poll of likely voters found 36.8% for and 48.3% against the intervention law, as published on 2026-11-25.", derived: { expression: "50 - 30", result: 20, statement: "FOR would need +20 points." }, translation: "36.8% said yes, 99% said no." };
const p2 = await packageEvidence(market, claim);
ok(!/Derived:/.test(p2.note) && !/English \(our translation\)/.test(p2.note) && p2.style === "v2", "unverifiable derived/translation silently dropped");

// undated source -> 'retrieved <date>', never 'date not provided'
reply = { note: "The agency announced the decision on the measure; source date not provided. It bears directly on the question asked.", derived: null, translation: null };
const undated = { ...claim, sourcePublishedAt: null, eventDate: null, quote: "Hike 25bps 94%", sourceDomain: "agency.gov" };
const p3 = await packageEvidence({ ...market, question: "Will the agency act?" }, undated);
ok(/retrieved \d{4}-\d{2}-\d{2}/.test(p3.note) && !/not provided|undated/.test(p3.note), "undated source says 'retrieved <date>', no 'not provided'");

// bundling
const second: any = { ...claim, claim: "The siol.net comparison of polls shows opposition ahead in all three polls since October.", sourceUrl: "https://siol.net/novice/primerjava", sourceDomain: "siol.net", quote: "vse tri raziskave kažejo večino proti", relevance: 0.8, confidence: 0.9 };
reply = { note: "Ninamedia's Vox Populi poll (16-18 Nov, published 2026-11-25) found 36.8% for and 48.3% against. A siol.net comparison of polls shows opposition ahead in all three polls since October.", derived: null, translation: null };
const rel = await pickRelated(market, claim, [claim, second, { ...second, sourceUrl: "https://x.com/z", supportsOutcomeIdx: 0 }, { ...second, sourceUrl: "https://agg.com/q", sourceType: "aggregator" }], true);
ok(rel.length === 1 && rel[0].sourceDomain === "siol.net", "related pick: same direction, different source, non-aggregator");
const p4 = await packageEvidence(market, claim, rel);
ok(p4.links.length === 2 && /Source 2: https:\/\/siol\.net\/novice\/primerjava/.test(p4.note) && !!p4.style?.includes("bundled"), "bundled: second link and 'Source 2' line");
ok(checkSubmitGuards({ marketId: "m-guard", outcomeIdx: 1, packaged: p4 as any, dryRun: true }).ok, "bundled note + 2 links passes the guards (3 items)");
ok(!checkSubmitGuards({ marketId: "m-guard", outcomeIdx: 1, packaged: { ...p4, links: [...p4.links, { url: "https://c.com/z", publishedAt: "2026-11-25" }] } as any, dryRun: true }).ok, "note + 3 links refused (more than 3 items)");
ok(!checkSubmitGuards({ marketId: "m-guard", outcomeIdx: 1, packaged: { ...p4, files: ["a.png"] } as any, dryRun: true }).ok, "note + 2 links + 1 file refused");
process.env.EVIDENCE_BUNDLE = "false";
ok((await pickRelated(market, claim, [claim, second], true)).length === 0, "EVIDENCE_BUNDLE=false disables bundling");
console.log("done"); process.exit(process.exitCode ?? 0);

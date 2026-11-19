/** Offline end-to-end check with mocked search/pages/Gemini. Run: npx tsx src/evidence/e2e.mock.ts */
process.env.EVIDENCE_LLM_ORDER = "gemini";
process.env.GEMINI_API_KEY = "x";
process.env.SERPER_API_KEY = "x";
process.env.SEARCH_PROVIDERS = "serper";
process.env.SEARCH_FANOUT = "1";
process.env.EVIDENCE_MOCK_MARKETS = "true";
process.env.EVIDENCE_AUTO_CHECKPOINT = "false";
process.env.EVIDENCE_PER_DOMAIN_DELAY_MS = "0";
process.env.EVIDENCE_MAX_MARKETS_PER_CYCLE = "5";

const PAGE_TEXT = "The Federal Open Market Committee said on 12 November 2026 that it voted 9-3 to hold the target range steady and signalled no cut in December. " .repeat(1) + "Officials cited sticky services inflation above 3 percent in the latest CPI release. ".repeat(6);
const html = (d: string) => `<html><head><title>FOMC statement</title><meta property="article:published_time" content="${d}"></head><body><article><p>${PAGE_TEXT}</p></article></body></html>`;
let n = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private", { status: 200 });
  if (url.includes("serper.dev")) {
    const k = ++n;
    return Response.json({ organic: [{ link: `https://www.federalreserve.gov/news/${k}`, title: "FOMC statement", snippet: "s", date: "2 days ago" }] });
  }
  if (url.includes("federalreserve.gov")) return new Response(html(new Date(Date.now() - 2*86400e3).toISOString()), { status: 200, headers: { "content-type": "text/html" } });
  if (url.includes("generativelanguage")) {
    const body = JSON.parse(init.body); const prompt: string = body.contents[0].parts[0].text;
    let out: any;
    if (prompt.includes("PAGE TEXT")) out = { claims: [{ claim: "FOMC voted 9-3 on 12 Nov 2026 to hold rates and signalled no December cut.", eventDate: "2026-11-12", sourceType: "primary", relevance: 0.9, confidence: 0.9, supportsOutcomeIdx: 1, supportRationale: "No cut signalled.", quote: "voted 9-3 to hold the target range steady and signalled no cut in December" }, { claim: "fabricated", eventDate: "2026-11-12", sourceType: "primary", relevance: 0.9, confidence: 0.9, supportsOutcomeIdx: 0, supportRationale: "x", quote: "this quote is not on the page at all" }] };
    else if (prompt.includes("CANDIDATE EVIDENCE")) out = { frontierLikelyKnows: 0.2, tightToResolution: 0.9, primaryStrength: 0.9, isRestatement: false, isSpeculation: false, privateOrConfidential: false, directionOk: true, rationale: "fresh primary" };
    else out = { note: "The FOMC voted 9-3 on 12 November 2026 to hold rates and signalled no cut in December, citing sticky services inflation. The Federal Reserve statement is the primary source. This points toward a No on a December cut." };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
  }
  return realFetch(input, init);
}) as any;

const { runEvidenceCycle } = await import("./loop.js");
const J = await import("./evidenceJournal.js");
const G = await import("./guards.js");
const assert = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

const s1 = await runEvidenceCycle(undefined);
const att = J.readAttempts();
const sub = att.filter(a => a.status === "submitted");
assert(!!s1 && s1.submitted >= 1, `cycle submitted ${s1?.submitted}`);
assert(sub.every(a => a.packaged!.note.includes("Source: https://www.federalreserve.gov")), "note carries deterministic source link + date");
assert(att.every(a => a.extractedClaims.every(c => c.claim !== "fabricated")) && sub.every(a => a.extractedClaims.length >= 1), "fabricated-quote claim dropped (anti-fabrication)");
assert(sub.every(a => a.receipt?.id.startsWith("dry-") && a.dryRun), "dry-run receipt, flagged dryRun");
assert(att.every(a => a.queriesRun !== undefined && a.sourcesFetched !== undefined), "journal has queries/sources on every attempt");

// guard: second cycle -> cooldown blocks immediate re-research
const s2 = await runEvidenceCycle(undefined);
assert(s2!.marketsTried === 0, "market cooldown prevents immediate re-research");

// guard: polarity + cap
const m = sub[0].marketId;
const fake = sub[0].packaged!;
assert(!G.checkSubmitGuards({ marketId: m, outcomeIdx: 0, packaged: fake, dryRun: true }).ok, "opposite polarity refused (both sides cancel)");
assert(G.checkSubmitGuards({ marketId: m, outcomeIdx: 1, packaged: fake, dryRun: true }).ok, "same polarity allowed");
assert(G.checkSubmitGuards({ marketId: m, outcomeIdx: 1, packaged: fake, dryRun: false }).ok, "dry-run slots don't eat live slots");
assert(!G.checkSubmitGuards({ marketId: m, outcomeIdx: null, packaged: fake, dryRun: true }).ok, "null polarity refused");
assert(!G.checkSubmitGuards({ marketId: m, outcomeIdx: 1, packaged: { ...fake, links: [] }, dryRun: true }).ok, "no link refused");
assert(!G.checkSubmitGuards({ marketId: m, outcomeIdx: 1, packaged: { ...fake, files: ["a","b","c","d"] }, dryRun: true }).ok, "4 files refused");

// robots + helpers
const F = await import("./fetchExtract.js");
const rules = F.parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok", "PringlesAgent");
assert(!F.robotsAllows(rules, "/private/x") && F.robotsAllows(rules, "/private/ok") && F.robotsAllows(rules, "/pub"), "robots longest-match");
const N = await import("./novelty.js");
assert(N.isNearDuplicate("FOMC voted 9-3 to hold rates, no December cut", ["The FOMC voted 9-3 on Nov 12 to hold rates and no December cut"]), "near-duplicate detection");
const Q = await import("./queryTemplates.js");
console.log(Q.buildQueries(J.readAttempts().length ? { id:"x", question:"Will the Federal Reserve cut interest rates at its December 2026 meeting?", outcomes:["Yes","No"], resolvesAt:null } : null as any, 4));
console.log(J.floorStatus());

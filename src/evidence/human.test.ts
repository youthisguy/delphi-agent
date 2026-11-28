/** Human Desk test: real routes + real human.js in jsdom, mocked network/LLM. Run: npx tsx src/evidence/human.test.ts */
import fs from "node:fs";
import { JSDOM } from "jsdom";
process.env.EVIDENCE_LLM_ORDER = "gemini"; process.env.GEMINI_API_KEY = "x";
process.env.SERPER_API_KEY = "x"; process.env.SEARCH_PROVIDERS = "serper"; process.env.SEARCH_FANOUT = "1";
process.env.EVIDENCE_AUTO_CHECKPOINT = "false"; process.env.EVIDENCE_PER_DOMAIN_DELAY_MS = "0";
process.env.EVIDENCE_JOURNAL_PATH = "data/ht.jsonl"; process.env.EVIDENCE_STATUS_PATH = "data/ht-status.json";
for (const f of ["data/ht.jsonl", "data/ht-status.json", "data/evidence-holds.json"]) fs.rmSync(f, { force: true });
fs.rmSync("data/evidence-files", { recursive: true, force: true });

const PAGE = "The Federal Open Market Committee said on 12 November 2026 that it voted 9-3 to hold the target range steady and signalled no cut in December. " + "Officials cited sticky services inflation above 3 percent in the latest CPI release. ".repeat(6);
const iso = new Date(Date.now() - 2 * 86400e3).toISOString();
const realFetch = globalThis.fetch;
let polishCalls = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
  if (url.includes("serper.dev")) return Response.json({ organic: [{ link: "https://www.federalreserve.gov/news/a", title: "FOMC statement", snippet: "Rates held", date: "2 days ago" }, { link: "https://x.com/someone/status/1", title: "tweet", snippet: "thread", date: "1 day ago" }] });
  if (url.includes("federalreserve.gov")) return new Response(`<html><head><title>FOMC statement</title><meta property="article:published_time" content="${iso}"></head><body><article><p>${PAGE}</p></article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.includes("generativelanguage")) {
    const prompt: string = JSON.parse(init.body).contents[0].parts[0].text;
    let out: any;
    if (prompt.includes("PAGE TEXT")) out = { claims: [{ claim: "FOMC voted 9-3 on 12 Nov 2026 to hold rates and signalled no December cut.", eventDate: "2026-11-12", sourceType: "primary", relevance: 0.9, confidence: 0.9, supportsOutcomeIdx: 1, supportRationale: "no cut", quote: "voted 9-3 to hold the target range steady and signalled no cut in December" }] };
    else { polishCalls++; out = { note: "The FOMC voted 9-3 on 12 November 2026 to hold the target range and signalled no cut in December, per the Federal Reserve statement of that date. A hold removes the cut that a Yes needs." }; }
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
  }
  return realFetch(input, init);
}) as any;

// board the loop would have written
fs.writeFileSync("data/ht-status.json", JSON.stringify({ marketBoard: [
  { id: "m1", question: "Will the Fed cut rates in December 2026?", outcomes: ["Yes", "No"], category: "economics", resolvesAt: null, resolutionCriteria: "Fed target range after the Dec meeting" },
  { id: "m2", question: "Will BTC close above 100k on 30 Nov?", outcomes: ["Yes", "No"], category: "crypto", resolvesAt: null },
] }));

const H = await import("./human.js");
const R = await import("./humanRoutes.js");
const P = await import("./prioritizer.js");
const J = await import("./evidenceJournal.js");
const assert = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// ---- fake express app
const routes = new Map<string, Function>();
const app = { get: (p: string, _g: any, h: Function) => routes.set("GET " + p, h), post: (p: string, _g: any, h: Function) => routes.set("POST " + p, h) };
R.registerHumanRoutes(app, (_q: any, _s: any, n: any) => n());
async function call(method: string, path: string, body?: any): Promise<{ code: number; json: any }> {
  const h = routes.get(method + " " + path)!;
  let code = 200, json: any;
  const res = { status(c: number) { code = c; return res; }, json(v: any) { json = v; return res; } };
  await h({ body }, res);
  return { code, json };
}

// ---- logic: checks
const good = { marketId: "m1", outcomeIdx: 1, note: "The FOMC voted 9-3 on 12 November 2026 to hold the target range and signalled no cut in December.", links: [{ url: "https://www.federalreserve.gov/news/a", publishedAt: iso.slice(0, 10) }] };
assert(H.checkHuman(good, true).ok, "valid human draft passes checks");
assert(H.checkHuman(good, true).note.includes("Source: https://www.federalreserve.gov"), "source line appended to the note automatically");
assert(!H.checkHuman({ ...good, links: [{ url: "https://www.federalreserve.gov/news/a" }] }, true).ok, "no dated link is refused");
assert(!H.checkHuman({ ...good, outcomeIdx: -1 }, true).ok, "missing outcome refused");
assert(!H.checkHuman({ ...good, marketId: "nope" }, true).ok, "unknown market refused");
assert(H.checkHuman({ ...good, marketId: "new1", market: { question: "Q?", outcomes: ["A", "B"] } }, true).ok, "hand-entered market accepted");
const x = H.checkHuman({ ...good, links: [{ url: "https://x.com/a/status/1", publishedAt: iso.slice(0, 10) }] }, true);
assert(x.warnings.some((w) => /screenshot/.test(w)), "X link warns: paste text + attach screenshot");
const xf = H.checkHuman({ ...good, links: [{ url: "https://x.com/a/status/1", publishedAt: iso.slice(0, 10) }], files: [{ name: "s.png", mime: "image/png", dataBase64: "aGk=" }] }, true);
assert(!xf.warnings.some((w) => /screenshot/.test(w)), "screenshot attached silences the warning");
assert(!H.checkHuman({ ...good, files: [{ name: "a.exe", mime: "application/x-msdownload", dataBase64: "aGk=" }] }, true).ok, "bad file type refused");
assert(!H.checkHuman({ ...good, files: [1, 2, 3, 4].map((i) => ({ name: i + ".png", mime: "image/png", dataBase64: "aGk=" })) }, true).ok, "4 files refused");

// ---- routes: search / fetch / draft
const s = await call("POST", "/api/evidence/human/search", { query: "fed december rate decision", marketId: "m1" });
assert(s.code === 200 && s.json.results.length === 2 && s.json.results[1].judgeMayNotFetch === true, "search returns results and flags X as judge-unfriendly");
assert((await call("POST", "/api/evidence/human/search", { query: "x" })).code === 400, "short query rejected");
const f = await call("POST", "/api/evidence/human/fetch", { marketId: "m1", url: "https://www.federalreserve.gov/news/a" });
assert(f.json.ok && f.json.claims.length === 1 && f.json.claims[0].supportsOutcomeIdx === 1, "fetch+extract returns a verified claim");
const fp = await call("POST", "/api/evidence/human/fetch", { marketId: "m1", url: "https://paywalled.example/a", text: PAGE, publishedAt: "2026-11-12" });
assert(fp.json.ok && fp.json.doc.method === "snippet" && fp.json.claims.length === 1, "pasted text path works for blocked pages");
const d = await call("POST", "/api/evidence/human/draft", { marketId: "m1", outcomeIdx: 1, note: "fed held 9-3 on nov 12 no dec cut", links: good.links });
assert(d.json.llm === true && polishCalls === 1, "AI polish returns a rewritten note");

// ---- submit: cap, polarity, duplicates, files, shared journal
const sub = (o: any) => call("POST", "/api/evidence/human/submit", { ...good, ...o });
const a = await sub({ files: [{ name: "shot 1.png", mime: "image/png", dataBase64: Buffer.from("png").toString("base64") }] });
assert(a.code === 200 && a.json.dryRun && a.json.receipt.id.startsWith("dry-") && fs.existsSync(a.json.files[0]), "submit records in dry-run and saves the file");
const att = J.readAttempts().find((x) => x.attemptId === a.json.attemptId)!;
assert(att.origin === "human" && att.status === "submitted" && att.polarity === 1, "journal shows a human submitted attempt with polarity");
assert(/Relevance: this fact points toward the outcome "No"\./.test(att.submissionPayload?.note ?? "") && ((att.submissionPayload?.note ?? "").match(/Relevance:/g) ?? []).length === 1, "sent note states the direction once (the API has no outcome field)");
assert(H.checkHuman(good, true).note === H.checkHuman({ ...good, note: H.checkHuman(good, true).note }, true).note, "preview note is stable: Relevance line is never added twice");
assert((await sub({})).code === 422, "same note again blocked as duplicate");
assert((await sub({ outcomeIdx: 0, note: "A totally different claim about CPI hitting 3.4 percent on 10 Nov 2026 per BLS.", links: [{ url: "https://www.bls.gov/x", publishedAt: iso.slice(0, 10) }] })).code === 422, "opposite outcome blocked (both sides cancel)");
const b = await sub({ note: "BLS CPI for October 2026 printed 3.4 percent, above the 3 percent threshold the Fed cited.", links: [{ url: "https://www.bls.gov/cpi", publishedAt: iso.slice(0, 10) }] });
const c = await sub({ note: "Fed Chair press conference on 12 Nov 2026 said the committee sees no case for a cut before March.", links: [{ url: "https://www.federalreserve.gov/pc", publishedAt: iso.slice(0, 10) }] });
assert(b.code === 200 && c.code === 200, "second and third submissions accepted");
const dd = await sub({ note: "Fourth distinct note: Treasury yields rose 12 bps on 13 Nov 2026 after the decision.", links: [{ url: "https://www.treasury.gov/y", publishedAt: iso.slice(0, 10) }] });
assert(dd.code === 422 && /cap|max|3/i.test(dd.json.error), "fourth submission blocked by the shared 3-per-market cap");
const mk = await call("GET", "/api/evidence/human/markets");
assert(mk.json.markets.find((m: any) => m.id === "m1").submissions === 3 && mk.json.markets.find((m: any) => m.id === "m1").lockedOutcome === 1, "market list reports 3/3 used, locked to outcome 1");

// ---- holds keep the agent off the market
const mkt = { id: "m2", question: "q", outcomes: ["Yes", "No"], resolvesAt: new Date(Date.now() + 5 * 86400e3).toISOString(), category: "crypto" } as any;
const before = P.scoreMarket(mkt, true);
await call("POST", "/api/evidence/human/hold", { marketId: "m2", on: true });
const held = P.scoreMarket(mkt, true);
await call("POST", "/api/evidence/human/hold", { marketId: "m2", on: false });
assert(before > 0 && held === 0 && P.scoreMarket(mkt, true) === before, "hold zeroes the agent's priority for that market, release restores it");

// ---- UI in jsdom against the same handlers
const html = fs.readFileSync("/mnt/user-data/outputs/public/dashboard.html", "utf8");
const panel = html.slice(html.indexOf('<div class="panel hd"'), html.indexOf('<div class="grid cols-3">'));
const dom = new JSDOM(`<body>${panel}</body>`, { runScripts: "outside-only", url: "http://localhost/" });
const w: any = dom.window;
w.confirm = () => true;
w.eval(`window.esc=(s)=>(s??"").toString().replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); window.j=async (u,o={})=>window.__call(o.method||"GET",u.split("?")[0],o.body?JSON.parse(o.body):undefined);`);
w.__call = async (m: string, p: string, b: any) => { const r = await call(m, p, b); if (r.code >= 400) throw new Error(`${p} -> ${r.code}: ${r.json.error}`); return r.json; };
w.eval(fs.readFileSync("/mnt/user-data/outputs/public/human.js", "utf8"));
const $ = (id: string) => w.document.getElementById(id);
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
await wait();
assert($("hdMarket").options.length === 2 && /3\/3 used/.test($("hdMarketInfo").textContent) && /locked to outcome 1/.test($("hdMarketInfo").textContent), "UI lists markets; m1 shows 3/3 used and its outcome lock");
$("hdMarket").value = "m2"; $("hdMarket").dispatchEvent(new w.Event("change")); await wait();
assert(/0\/3 used/.test($("hdMarketInfo").textContent), "UI shows 0/3 used for m2");
$("hdQuery").value = "btc price 30 nov"; $("hdSearchBtn").click(); await wait(200);
assert($("hdResults").querySelectorAll(".res").length === 2 && /judge may not be able/.test($("hdResults").textContent), "UI shows search results with the judge-fetch warning");
$("hdResults").querySelector("button[data-read]").click(); await wait(300);
assert($("hdClaims").querySelectorAll("button[data-use]").length === 1, "UI shows extracted claim");
$("hdClaims").querySelector("button[data-use]").click(); await wait();
assert($("hdNote").value.includes("FOMC voted 9-3") && $("hdOutcome").value === "1" && $("hdExcerpt").value.length > 10 && $("hdLinks").querySelectorAll("input[data-f=url]")[0].value.includes("federalreserve"), "Use-in-note fills note, outcome, excerpt and link+date");
$("hdCheckBtn").click(); await wait(200);
assert(/PASSES CHECKS/.test($("hdOut").textContent) && /Key excerpt:/.test($("hdOut").textContent), "UI check passes and shows the final note with excerpt");
$("hdSubmitBtn").click(); await wait(300);
assert(/RECORDED \(dry-run\)/.test($("hdOut").textContent) && $("hdNote").value === "", "UI submit records and clears the form");
assert(J.submissionsFor("m2", true).length === 1 && J.submissionsFor("m2", true)[0].origin === "human", "UI submission landed in the shared journal");
console.log("done"); process.exit(process.exitCode ?? 0);

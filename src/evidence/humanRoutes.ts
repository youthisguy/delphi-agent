import { EV, COMPETITION_RULES } from "./evidenceConfig.js";
import { searchAll, domainOf } from "./search.js";
import { fetchDocument, type FetchedDoc } from "./fetchExtract.js";
import { browserFetch } from "./browserFallback.js";
import { extractClaims } from "./extract.js";
import { usedUrls, normUrl, submissionsFor } from "./evidenceJournal.js";
import { effectiveDryRun } from "./loop.js";
import { createSubmitter, ensureLiveReady } from "./submit.js";
import { readHolds, setHold } from "./holds.js";
import { readBoard, findMarket, checkHuman, submitHuman, polishNote, lockedOutcomeFor, type HumanDraft } from "./human.js";

const HOSTILE = /(^|\.)(x\.com|twitter\.com|reddit\.com|facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|wsj\.com|ft\.com|nytimes\.com|bloomberg\.com|economist\.com)$/i;
const bad = (res: any, msg: string, code = 400) => res.status(code).json({ error: msg });

/** Human Desk API. Every route sits behind the dashboard password (when DASHBOARD_PASSWORD is set). */
export function registerHumanRoutes(app: any, guard: (req: any, res: any, next: any) => void): void {
  app.get("/api/evidence/human/markets", guard, async (_req: any, res: any) => {
    await ensureLiveReady().catch(() => {});
    const dry = effectiveDryRun();
    const holds = new Set(readHolds());
    res.json({
      dryRun: dry,
      cap: COMPETITION_RULES.maxSubmissionsPerMarket,
      markets: readBoard().map((m) => ({
        id: m.id, question: m.question, outcomes: m.outcomes ?? ["Yes", "No"], category: m.category ?? null, topic: m.topic, resolvesAt: m.resolvesAt,
        resolutionCriteria: m.resolutionCriteria ?? null, held: holds.has(m.id), submissions: submissionsFor(m.id, dry).length, lockedOutcome: lockedOutcomeFor(m.id, dry),
      })),
    });
  });

  app.post("/api/evidence/human/hold", guard, (req: any, res: any) => {
    const { marketId, on } = req.body ?? {};
    if (typeof marketId !== "string" || typeof on !== "boolean") return bad(res, "body must be { marketId: string, on: boolean }");
    res.json({ holds: setHold(marketId, on) });
  });

  app.post("/api/evidence/human/search", guard, async (req: any, res: any) => {
    try {
      const { query, days, marketId } = req.body ?? {};
      if (typeof query !== "string" || query.trim().length < 3 || query.length > 300) return bad(res, "query must be 3–300 characters");
      const found = await searchAll(query.trim(), { recencyDays: Math.min(Math.max(Number(days) || 30, 1), 365), limit: 10 });
      const used = typeof marketId === "string" ? usedUrls(marketId, effectiveDryRun()) : new Set<string>();
      res.json({
        results: found.slice(0, 20).map((r) => ({
          url: r.url, title: r.title, snippet: r.snippet.slice(0, 300), publishedAt: r.publishedAt, domain: r.domain, provider: r.provider,
          used: used.has(normUrl(r.url)), judgeMayNotFetch: HOSTILE.test(r.domain),
        })),
      });
    } catch (err) {
      bad(res, err instanceof Error ? err.message : String(err), 502);
    }
  });

  /** Read a URL (or pasted text) and extract dated, quoted claims for a market — the same extractor the agent uses. */
  app.post("/api/evidence/human/fetch", guard, async (req: any, res: any) => {
    try {
      const { marketId, url, text, publishedAt, title, market: custom } = req.body ?? {};
      const market = typeof marketId === "string" ? findMarket(marketId, custom) : null;
      if (!market) return bad(res, "unknown market");
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return bad(res, "a valid http(s) url is required (it is still cited even if you paste the text)");

      let doc: FetchedDoc | null = null;
      if (typeof text === "string" && text.trim().length >= 80) {
        doc = { url, finalUrl: url, domain: domainOf(url), title: typeof title === "string" ? title : "", publishedAt: typeof publishedAt === "string" && publishedAt ? new Date(publishedAt).toISOString() : null, text: text.trim().slice(0, EV.maxDocChars), method: "snippet" };
      } else {
        let out = await fetchDocument(url);
        if (!out.ok && out.needsBrowser && EV.playwrightEnabled) out = await browserFetch(url);
        if (!out.ok) {
          return res.json({ ok: false, error: out.error, hint: "The judge's basic fetch will probably fail on this too. Paste the key text below and attach a screenshot showing the URL and date." });
        }
        doc = out.doc;
      }
      const { claims, diag } = await extractClaims(market, [doc]);
      res.json({ ok: true, doc: { title: doc.title, domain: doc.domain, publishedAt: doc.publishedAt, method: doc.method, chars: doc.text.length, preview: doc.text.slice(0, 3500) }, claims, diag });
    } catch (err) {
      bad(res, err instanceof Error ? err.message : String(err), 502);
    }
  });

  app.post("/api/evidence/human/draft", guard, async (req: any, res: any) => {
    try {
      const b = req.body ?? {};
      if (typeof b.marketId !== "string" || !Number.isInteger(b.outcomeIdx) || typeof b.note !== "string") return bad(res, "marketId, outcomeIdx and note are required");
      res.json(await polishNote({ marketId: b.marketId, outcomeIdx: b.outcomeIdx, note: b.note, links: Array.isArray(b.links) ? b.links : [], excerpt: typeof b.excerpt === "string" ? b.excerpt : undefined, market: b.market }));
    } catch (err) {
      bad(res, err instanceof Error ? err.message : String(err), 500);
    }
  });

  app.post("/api/evidence/human/check", guard, async (req: any, res: any) => {
    const d = req.body as HumanDraft;
    if (!d || typeof d.marketId !== "string" || typeof d.note !== "string") return bad(res, "marketId and note are required");
    await ensureLiveReady(d.marketId).catch(() => {});
    res.json(checkHuman({ ...d, links: d.links ?? [] }, effectiveDryRun()));
  });

  app.post("/api/evidence/human/submit", guard, async (req: any, res: any) => {
    const d = req.body as HumanDraft;
    if (!d || typeof d.marketId !== "string" || typeof d.note !== "string") return bad(res, "marketId and note are required");
    try {
      await ensureLiveReady(d.marketId);
      const dry = effectiveDryRun();
      res.json(await submitHuman({ ...d, links: d.links ?? [] }, createSubmitter(dry), dry));
    } catch (err) {
      bad(res, err instanceof Error ? err.message : String(err), 422);
    }
  });
}

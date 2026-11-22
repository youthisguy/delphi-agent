import { EV } from "./evidenceConfig.js";
import { buildQueries } from "./queryTemplates.js";
import { searchAll, domainOf, type SearchResult } from "./search.js";
import { fetchDocument, type FetchedDoc } from "./fetchExtract.js";
import { browserFetch } from "./browserFallback.js";
import { normUrl } from "./evidenceJournal.js";
import type { EvidenceMarket, SourceRef } from "./types.js";

export interface ResearchResult {
  queries: string[];
  sources: SourceRef[];
  docs: FetchedDoc[];
}

function rank(r: SearchResult, now: number = Date.now()): number {
  const age = r.publishedAt ? (now - new Date(r.publishedAt).getTime()) / 86400e3 : 30;
  const recency = Math.max(0, 1 - age / Math.max(EV.recencyDays, 1));
  const gov = /\.(gov|edu|int|mil)(\.|$)/i.test(r.domain) ? 0.3 : 0;
  return recency + gov + (r.content ? 0.1 : 0) + (r.publishedAt ? 0.1 : 0);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

export async function gatherSources(market: EvidenceMarket, exclude: Set<string>): Promise<ResearchResult> {
  const queries = buildQueries(market, EV.queriesPerMarket);
  const pooled = new Map<string, SearchResult>();
  const cut = market.asOf ? Date.parse(market.asOf) : null;
  const nowMs = cut ?? Date.now();
  const leaks = (iso: string | null | undefined) => cut !== null && (!iso || Date.parse(iso) > cut);

  for (const q of queries) {
    try {
      for (const r of await searchAll(q, market.asOf ? { asOf: market.asOf } : undefined)) {
        const key = normUrl(r.url);
        const d = domainOf(r.url);
        if (exclude.has(key)) continue;
        if (EV.blockedDomains.some((b) => d === b || d.endsWith("." + b))) continue;
        if (!pooled.has(key)) pooled.set(key, r);
      }
    } catch (err) {
      console.warn(`  [research] search failed for "${q}":`, err instanceof Error ? err.message : err);
    }
  }

  const extra = (market.sourceUrls ?? [])
    .filter((u) => !exclude.has(normUrl(u)))
    .map((u) => ({ url: u, domain: domainOf(u), title: undefined, publishedAt: null, content: undefined }) as unknown as SearchResult);
  const extraKeys = new Set(extra.map((e) => normUrl(e.url)));
  const ranked = [...pooled.values()].filter((r) => !extraKeys.has(normUrl(r.url))).sort((a, b) => rank(b, nowMs) - rank(a, nowMs));
  const top = [...extra, ...ranked].slice(0, EV.maxDocsPerMarket + extra.length);
  const sources: SourceRef[] = [];
  const docs: FetchedDoc[] = [];

  await pool(top, EV.fetchConcurrency, async (r) => {
    let out = await fetchDocument(r.url);
    let method: SourceRef["fetchMethod"] = "fetch";
    if (!out.ok && out.needsBrowser && EV.playwrightEnabled) {
      out = await browserFetch(r.url);
      method = "playwright";
    }
    if (out.ok) {
      const doc = { ...out.doc, publishedAt: out.doc.publishedAt ?? r.publishedAt };
      if (leaks(doc.publishedAt)) {
        sources.push({ url: r.url, domain: doc.domain, title: doc.title, publishedAt: doc.publishedAt, fetchMethod: out.doc.method, ok: false, error: "after asOf / undated" });
        return;
      }
      docs.push(doc);
      sources.push({ url: r.url, domain: doc.domain, title: doc.title, publishedAt: doc.publishedAt, fetchMethod: out.doc.method, ok: true });
      return;
    }
    // Last resort: provider-supplied full text (Tavily/Exa) — still real page content.
    if (r.content && r.content.length > 400 && !leaks(r.publishedAt)) {
      const doc: FetchedDoc = {
        url: r.url, finalUrl: r.url, domain: r.domain, title: r.title,
        publishedAt: r.publishedAt, text: r.content.slice(0, EV.maxDocChars), method: "snippet",
      };
      docs.push(doc);
      sources.push({ url: r.url, domain: r.domain, title: r.title, publishedAt: r.publishedAt, fetchMethod: "snippet", ok: true });
      return;
    }
    sources.push({ url: r.url, domain: r.domain, title: r.title, publishedAt: r.publishedAt, fetchMethod: method, ok: false, error: out.error });
  });

  return { queries, sources, docs };
}

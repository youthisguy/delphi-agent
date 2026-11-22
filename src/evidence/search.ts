import { fetchWithTimeout } from "../fetchWithTimeout.js";
import { EV } from "./evidenceConfig.js";
import { normUrl } from "./evidenceJournal.js";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  content?: string; // full/long text when the provider returns it
  publishedAt: string | null;
  domain: string;
  provider: string;
}

export interface SearchOpts {
  recencyDays: number;
  limit: number;
  /** Backtest cutoff (ISO). Nothing published after this may be returned. */
  asOf?: string;
}

interface Provider {
  name: string;
  enabled(): boolean;
  search(query: string, o: SearchOpts): Promise<SearchResult[]>;
}

const rr: Record<string, number> = {};
/** Supports comma-separated key lists (TAVILY_API_KEYS=a,b) with round-robin. */
function pickKey(name: string, ...envs: string[]): string | null {
  const keys = envs.flatMap((k) => (process.env[k] ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  if (!keys.length) return null;
  rr[name] = ((rr[name] ?? -1) + 1) % keys.length;
  return keys[rr[name]];
}

export function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function toIso(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const rel = s.match(/^(\d+)\s*(minute|hour|day|week|month)s?\s+ago$/i);
  if (rel) {
    const unit = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[rel[2].toLowerCase() as "day"];
    return new Date(Date.now() - Number(rel[1]) * unit).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const mdy = (ms: number) => { const d = new Date(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; };
function win(o: SearchOpts) {
  const end = o.asOf ? Date.parse(o.asOf) : Date.now();
  return { end, start: end - o.recencyDays * 86400e3 };
}

const bucket = (d: number) => (d <= 1 ? "day" : d <= 7 ? "week" : d <= 31 ? "month" : "year");

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    20_000
  );
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

const tavily: Provider = {
  name: "tavily",
  enabled: () => Boolean(pickKey("probe", "TAVILY_API_KEYS", "TAVILY_API_KEY")),
  async search(q, o) {
    const key = pickKey("tavily", "TAVILY_API_KEYS", "TAVILY_API_KEY")!;
    const w = win(o);
    const body: any = { query: q, topic: "news", max_results: o.limit, include_raw_content: "text" };
    if (o.asOf) { body.start_date = ymd(w.start); body.end_date = ymd(w.end); } else body.days = o.recencyDays;
    const d = await postJson("https://api.tavily.com/search", { Authorization: `Bearer ${key}` }, body);
    return (d.results ?? []).map((r: any) => ({
      url: r.url, title: r.title ?? "", snippet: r.content ?? "",
      content: typeof r.raw_content === "string" ? r.raw_content : undefined,
      publishedAt: toIso(r.published_date), domain: domainOf(r.url), provider: "tavily",
    }));
  },
};

const serper: Provider = {
  name: "serper",
  enabled: () => Boolean(pickKey("probe", "SERPER_API_KEYS", "SERPER_API_KEY")),
  async search(q, o) {
    const key = pickKey("serper", "SERPER_API_KEYS", "SERPER_API_KEY")!;
    const w = win(o);
    const tbs = o.asOf
      ? `cdr:1,cd_min:${mdy(w.start)},cd_max:${mdy(w.end)}`
      : { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[bucket(o.recencyDays)];
    const d = await postJson("https://google.serper.dev/search", { "X-API-KEY": key }, { q, num: o.limit, tbs });
    return (d.organic ?? []).map((r: any) => ({
      url: r.link, title: r.title ?? "", snippet: r.snippet ?? "",
      publishedAt: toIso(r.date), domain: domainOf(r.link), provider: "serper",
    }));
  },
};

const exa: Provider = {
  name: "exa",
  enabled: () => Boolean(pickKey("probe", "EXA_API_KEYS", "EXA_API_KEY")),
  async search(q, o) {
    const key = pickKey("exa", "EXA_API_KEYS", "EXA_API_KEY")!;
    const w = win(o);
    const start = new Date(w.start).toISOString();
    const d = await postJson("https://api.exa.ai/search", { "x-api-key": key }, {
      query: q, numResults: o.limit, startPublishedDate: start,
      ...(o.asOf ? { endPublishedDate: new Date(w.end).toISOString() } : {}),
      contents: { text: { maxCharacters: 12000 } },
    });
    return (d.results ?? []).map((r: any) => ({
      url: r.url, title: r.title ?? "", snippet: (r.text ?? "").slice(0, 300),
      content: r.text, publishedAt: toIso(r.publishedDate), domain: domainOf(r.url), provider: "exa",
    }));
  },
};

const brave: Provider = {
  name: "brave",
  enabled: () => Boolean(pickKey("probe", "BRAVE_API_KEYS", "BRAVE_API_KEY")),
  async search(q, o) {
    const key = pickKey("brave", "BRAVE_API_KEYS", "BRAVE_API_KEY")!;
    const w = win(o);
    const fresh = o.asOf
      ? `${ymd(w.start)}to${ymd(w.end)}`
      : { day: "pd", week: "pw", month: "pm", year: "py" }[bucket(o.recencyDays)];
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${o.limit}&freshness=${fresh}`;
    const res = await fetchWithTimeout(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" } }, 20_000);
    if (!res.ok) throw new Error(`brave HTTP ${res.status}`);
    const d: any = await res.json();
    return (d.web?.results ?? []).map((r: any) => ({
      url: r.url, title: r.title ?? "", snippet: r.description ?? "",
      publishedAt: toIso(r.page_age ?? r.age), domain: domainOf(r.url), provider: "brave",
    }));
  },
};

const ALL: Record<string, Provider> = { tavily, serper, exa, brave };

export function enabledProviders(): string[] {
  return EV.searchProviders.filter((n) => ALL[n]?.enabled());
}

/**
 * Query up to SEARCH_FANOUT providers (in configured order) in parallel; if fewer
 * than that succeed, fall through to the next ones. Merged + de-duplicated by URL.
 */
export async function searchAll(query: string, o?: Partial<SearchOpts>): Promise<SearchResult[]> {
  const opts: SearchOpts = { recencyDays: o?.recencyDays ?? EV.recencyDays, limit: o?.limit ?? EV.resultsPerQuery, asOf: o?.asOf };
  const cut = opts.asOf ? Date.parse(opts.asOf) : null;
  const order = EV.searchProviders.map((n) => ALL[n]).filter((p) => p?.enabled());
  if (!order.length) throw new Error("no search provider configured (set TAVILY_API_KEY / SERPER_API_KEY / EXA_API_KEY / BRAVE_API_KEY)");

  const merged = new Map<string, SearchResult>();
  let ok = 0;
  let i = 0;
  while (ok < EV.searchFanout && i < order.length) {
    const batch = order.slice(i, i + (EV.searchFanout - ok));
    i += batch.length;
    const settled = await Promise.allSettled(batch.map((p) => p.search(query, opts)));
    settled.forEach((s, k) => {
      if (s.status === "fulfilled") {
        ok++;
        for (const r of s.value) {
          if (!r.url) continue;
          if (cut !== null && (!r.publishedAt || Date.parse(r.publishedAt) > cut)) continue;
          const key = normUrl(r.url);
          const prev = merged.get(key);
          if (!prev || (!prev.content && r.content)) merged.set(key, { ...r, publishedAt: r.publishedAt ?? prev?.publishedAt ?? null });
        }
      } else {
        console.warn(`  [search:${batch[k].name}] failed: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
      }
    });
  }
  return [...merged.values()];
}

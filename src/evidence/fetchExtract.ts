import { fetchWithTimeout } from "../fetchWithTimeout.js";
import { EV } from "./evidenceConfig.js";
import { domainOf, toIso } from "./search.js";
import type { SourceRef } from "./types.js";

export interface FetchedDoc {
  url: string;
  finalUrl: string;
  domain: string;
  title: string;
  publishedAt: string | null;
  text: string;
  method: SourceRef["fetchMethod"];
}

export type FetchOutcome =
  | { ok: true; doc: FetchedDoc }
  | { ok: false; error: string; needsBrowser: boolean };

// ---------- politeness: robots.txt + per-domain rate limit ----------

const robotsCache = new Map<string, { at: number; rules: { allow: boolean; path: string }[] | "disallow-all" | "allow-all" }>();

export function parseRobots(txt: string, uaToken: string) {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else if ((k === "allow" || k === "disallow") && cur) {
      lastWasAgent = false;
      if (v) cur.rules.push({ allow: k === "allow", path: v });
    } else lastWasAgent = false;
  }
  const tok = uaToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && tok.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

export function robotsAllows(rules: { allow: boolean; path: string }[], pathAndQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pat = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    if (new RegExp("^" + pat).test(pathAndQuery)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? best.allow : true;
}

export async function checkRobots(url: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const origin = u.origin;
  let ent = robotsCache.get(origin);
  if (!ent || Date.now() - ent.at > 3600e3) {
    let rules: NonNullable<typeof ent>["rules"] = "allow-all";
    try {
      const res = await fetchWithTimeout(origin + "/robots.txt", { headers: { "User-Agent": EV.userAgent } }, 8000);
      if (res.status >= 500) rules = "disallow-all"; // RFC 9309: server error => assume disallowed
      else if (res.ok) rules = parseRobots(await res.text(), "PringlesAgent");
    } catch { rules = "allow-all"; }
    ent = { at: Date.now(), rules };
    robotsCache.set(origin, ent);
  }
  if (ent.rules === "disallow-all") return false;
  if (ent.rules === "allow-all") return true;
  return robotsAllows(ent.rules, u.pathname + u.search);
}

const nextSlot = new Map<string, number>();
export async function politeDelay(domain: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(domain) ?? 0);
  nextSlot.set(domain, at + EV.perDomainDelayMs);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

// ---------- extraction ----------

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”", "&ndash;": "–", "&mdash;": "—" };
const decode = (s: string) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENT[m.toLowerCase()] ?? m);

export function stripHtml(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function extractPublishedDate(html: string): string | null {
  const pats: RegExp[] = [
    /<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:article:published_time|pubdate|publishdate|date|dc\.date\.issued|dc\.date|parsely-pub-date|datepublished|sailthru\.date)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["'](?:article:published_time|pubdate|date|datepublished)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];
  for (const re of pats) {
    const m = html.match(re);
    const iso = m ? toIso(m[1]) : null;
    if (iso && new Date(iso).getTime() <= Date.now() + 86400e3) return iso;
  }
  return null;
}

function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decode((og?.[1] ?? t?.[1] ?? "").replace(/\s+/g, " ").trim());
}

async function readabilityText(html: string, url: string): Promise<{ title?: string; text: string } | null> {
  try {
    // dynamic + variable specifiers: optional deps, no hard failure if not installed
    const jsdomMod = "jsdom", rdMod = "@mozilla/readability";
    const { JSDOM, VirtualConsole } = (await import(jsdomMod)) as any;
    const { Readability } = (await import(rdMod)) as any;
    const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
    const art = new Readability(dom.window.document).parse();
    if (!art?.textContent) return null;
    return { title: art.title, text: String(art.textContent).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim() };
  } catch {
    return null;
  }
}

export async function extractFromHtml(html: string, url: string, finalUrl: string, method: FetchedDoc["method"]): Promise<FetchedDoc | null> {
  const rd = await readabilityText(html, finalUrl);
  const text = (rd && rd.text.length > 300 ? rd.text : stripHtml(html)).slice(0, EV.maxDocChars);
  if (text.length < 200) return null;
  return {
    url, finalUrl, domain: domainOf(finalUrl),
    title: rd?.title || extractTitle(html),
    publishedAt: extractPublishedDate(html),
    text, method,
  };
}

/** Plain HTTP fetch + cleanup. Flags `needsBrowser` when the page looks JS-rendered / bot-walled. */
export async function fetchDocument(url: string): Promise<FetchOutcome> {
  const domain = domainOf(url);
  if (EV.blockedDomains.some((d) => domain === d || domain.endsWith("." + d))) return { ok: false, error: "blocked domain", needsBrowser: false };
  if (!(await checkRobots(url))) return { ok: false, error: "disallowed by robots.txt", needsBrowser: false };
  await politeDelay(domain);
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": EV.userAgent, Accept: "text/html,application/xhtml+xml" }, redirect: "follow" },
      20_000
    );
    if (res.status === 429) return { ok: false, error: "HTTP 429 (rate limited) — backing off, not retrying", needsBrowser: false };
    if (res.status === 403 || res.status === 451) return { ok: false, error: `HTTP ${res.status}`, needsBrowser: res.status === 403 };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, needsBrowser: false };
    const ct = res.headers.get("content-type") ?? "";
    if (!/html|xml|text/i.test(ct)) return { ok: false, error: `unsupported content-type ${ct}`, needsBrowser: false };
    const html = (await res.text()).slice(0, 2_000_000);
    const doc = await extractFromHtml(html, url, res.url || url, "fetch");
    if (!doc) {
      const jsHeavy = (html.match(/<script/gi) ?? []).length > 8 || /enable javascript|please turn on javascript/i.test(html);
      return { ok: false, error: "too little text extracted", needsBrowser: jsHeavy };
    }
    return { ok: true, doc };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), needsBrowser: false };
  }
}

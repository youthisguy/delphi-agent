import type { EvidenceMarket } from "./types.js";

export type Topic = "politics" | "macro" | "sports" | "crypto" | "tech" | "current_events";

const TOPIC_RULES: [Topic, RegExp][] = [
  ["crypto", /\b(bitcoin|btc|ethereum|eth|solana|crypto|token|etf|stablecoin|defi|binance|coinbase)\b/i],
  ["macro", /\b(fed|federal reserve|fomc|interest rates?|central bank|cpi|inflation|gdp|unemployment|jobs report|rate cut|rate hike|treasury|yield|ecb|boe|boj|tariff|recession|payrolls)\b/i],
  ["sports", /\b(nba|nfl|mlb|nhl|premier league|champions league|world cup|f1|grand prix|tennis|ufc|olympic|match|game \d|playoff|finals|score)\b/i],
  ["politics", /\b(election|president|senate|congress|parliament|prime minister|vote|poll|bill|law|supreme court|sanction|ceasefire|treaty|minister|governor|referendum)\b/i],
  ["tech", /\b(openai|anthropic|google|apple|microsoft|nvidia|meta|tesla|spacex|launch|release|model|gpu|chip|ai\b|iphone|software|app store)\b/i],
];

export function classifyTopic(m: Pick<EvidenceMarket, "question" | "category">): Topic {
  const hay = `${m.category ?? ""} ${m.question}`;
  for (const [t, re] of TOPIC_RULES) if (re.test(hay)) return t;
  return "current_events";
}

const TEMPLATES: Record<Topic, string[]> = {
  politics: ["{s} official statement", "{s} poll OR ruling OR vote {my}", "{s} government announcement"],
  macro: ["{s} data release {my}", "{s} central bank statement", "{s} official statistics"],
  sports: ["{s} injury report OR lineup {my}", "{s} official league announcement", "{s} latest result"],
  crypto: ["{s} on-chain data {my}", "{s} SEC OR regulator filing", "{s} official announcement"],
  tech: ["{s} official blog OR press release {my}", "{s} filing OR regulatory", "{s} announcement date"],
  current_events: ["{s} latest {my}", "{s} official statement", "{s} press release"],
};

/** "Will X happen by Dec 31?" -> "X happen" (keeps it search-friendly). */
export function cleanQuestion(q: string): string {
  return q
    .replace(/\?+$/g, "")
    .replace(/^(will|does|did|is|are|can|could|would|should|has|have)\s+/i, "")
    .replace(/\b(by|before|on|until|in)\s+(the\s+)?(end of\s+)?([A-Z][a-z]+\.?\s+\d{1,2}(,\s*\d{4})?|\d{4}|Q[1-4]\s*\d{4})\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function entities(q: string): string[] {
  const out = new Set<string>();
  const re = /\b([A-Z][\w&.-]+(?:\s+[A-Z][\w&.-]+){0,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const e = m[1].trim();
    if (e.length > 2 && !/^(Will|Does|Did|Is|Are|Can|Could|Would|Should|Has|Have|The|By|Before|On|In)$/.test(e)) out.add(e);
  }
  return [...out].slice(0, 2);
}

export function buildQueries(m: EvidenceMarket, max: number, now = new Date()): string[] {
  const my = `${now.toLocaleString("en-US", { month: "long" })} ${now.getFullYear()}`;
  const s = cleanQuestion(m.question);
  const topic = classifyTopic(m);
  const qs: string[] = [`${s} latest news`];
  for (const t of TEMPLATES[topic]) qs.push(t.replace("{s}", s).replace("{my}", my));
  for (const e of entities(m.question)) qs.push(`${e} ${my}`);
  if (m.resolutionCriteria) qs.push(`${cleanQuestion(m.resolutionCriteria).slice(0, 120)} official source`);
  const seen = new Set<string>();
  return qs.map((q) => q.trim()).filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase())).slice(0, max);
}

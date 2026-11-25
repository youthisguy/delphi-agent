import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { EV } from "./evidenceConfig.js";
import type { EvidenceMarket } from "./types.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

const MOCK: Omit<EvidenceMarket, "resolvesAt">[] = [
  { id: "mock-fed", question: "Will the Federal Reserve cut interest rates at its December 2026 meeting?", outcomes: ["Yes", "No"], category: "macro" },
  { id: "mock-btc", question: "Will Bitcoin close above $120,000 on 31 December 2026?", outcomes: ["Yes", "No"], category: "crypto" },
  { id: "mock-nvda", question: "Will Nvidia announce a new data-center GPU architecture before 15 December 2026?", outcomes: ["Yes", "No"], category: "tech" },
  { id: "mock-epl", question: "Will Arsenal be top of the Premier League table on 1 December 2026?", outcomes: ["Yes", "No"], category: "sports" },
  { id: "mock-eu", question: "Will the EU formally adopt its next sanctions package against Russia by 11 December 2026?", outcomes: ["Yes", "No"], category: "politics" },
];

export function mockMarkets(): EvidenceMarket[] {
  const soon = (d: number) => new Date(Date.now() + d * 86400e3).toISOString();
  return MOCK.map((m, i) => ({ ...m, resolvesAt: soon(10 + i * 4) }));
}

/** Official resolution sources: URLs in dataSources (strings or {url}) plus any URL written into the criteria text. */
export function officialSourceUrls(m: any): string[] {
  const out: string[] = [];
  const add = (u: unknown) => {
    if (typeof u !== "string") return;
    const x = u.trim().replace(/[)\].,;]+$/, "");
    if (/^https?:\/\/\S+$/i.test(x) && !out.includes(x)) out.push(x);
  };
  for (const d of Array.isArray(m?.dataSources) ? m.dataSources : []) add(typeof d === "string" ? d : d?.url ?? d?.link);
  for (const t of [m?.resolutionCriteria, m?.description, m?.metadata?.description, m?.metadata?.resolutionCriteria]) {
    if (typeof t === "string") for (const u of t.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) add(u);
  }
  return out.slice(0, 4);
}

/**
 * Market discovery. Live: the competition list (a top-level JSON array). Mock: EVIDENCE_MOCK_MARKETS=true.
 * Outcomes are always ["Yes","No"] (index 0 = Yes, 1 = No); the market id is the contract address.
 */
const COMPETITION_URL = "https://competition.delphi.fyi/markets.json";

export async function listEvidenceMarkets(_client?: DelphiClient): Promise<EvidenceMarket[]> {
  if (EV.mockMarkets) return mockMarkets();
  const res = await fetchWithTimeout(COMPETITION_URL, { headers: { Accept: "application/json" } }, 15_000);
  if (!res.ok) throw new Error(`markets.json HTTP ${res.status}`);
  const body: any = await res.json();
  const list: any[] = Array.isArray(body) ? body : body?.markets ?? [];
  const now = Date.now();
  return list
    .filter((m) => (m.status ?? "open") === "open" && m.address && m.question)
    .filter((m) => !m.evidenceCutoffAt || new Date(m.evidenceCutoffAt).getTime() > now)
    .map((m): EvidenceMarket => {
      const yes = Number(m.odds?.yes), no = Number(m.odds?.no);
      return {
        id: String(m.address),
        question: m.question,
        outcomes: ["Yes", "No"],
        category: m.category,
        resolvesAt: m.closesAt ?? null,
        evidenceCutoffAt: m.evidenceCutoffAt ?? null,
        odds: Number.isFinite(yes) && Number.isFinite(no) ? [yes, no] : undefined,
        tier: m.marketTier,
        resolutionCriteria: m.resolutionCriteria,
        sourceUrls: officialSourceUrls(m),
        rewardPot: m.pots?.judgement ? Number(m.pots.judgement) / 1e6 : undefined,
        url: m.delphiUrl,
      };
    });
}

import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { CONFIG } from "../config.js";
import { withDelphiRetry } from "../delphiRetry.js";
import { extractResolvesAt, extractAppMarketId } from "../marketFields.js";
import { EV } from "./evidenceConfig.js";
import type { EvidenceMarket } from "./types.js";

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

/**
 * Market discovery. Until 23 Nov this lists ordinary open Delphi markets (or mocks).
 * SWAP POINT: when the competition market list/endpoint is published, replace the
 * listMarkets call below — everything downstream consumes EvidenceMarket only.
 */
export async function listEvidenceMarkets(client?: DelphiClient): Promise<EvidenceMarket[]> {
  if (EV.mockMarkets || !client) return mockMarkets();
  const { markets } = await withDelphiRetry(
    () => client.listMarkets({ status: "open" as any, limit: CONFIG.maxMarketsPerLoop } as any),
    { label: "listMarkets(evidence)", maxRetries: 2 }
  );
  return (markets ?? [])
    .map((m: any): EvidenceMarket => ({
      id: String(m.id),
      question: m.question ?? m.metadata?.question ?? "",
      outcomes: m.outcomes ?? m.metadata?.outcomes ?? ["Yes", "No"],
      category: m.category,
      resolvesAt: extractResolvesAt(m),
      resolutionCriteria: m.resolutionCriteria ?? m.description ?? m.metadata?.description ?? (Array.isArray(m.dataSources) ? m.dataSources.join("; ") : undefined),
      rewardPot: typeof m.rewardPot === "number" ? m.rewardPot : undefined,
      url: extractAppMarketId(m) ? `https://competition.delphi.fyi/markets/${m.id}` : undefined,
    }))
    .filter((m) => m.question);
}

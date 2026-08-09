import "dotenv/config";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { withDelphiRetry } from "./delphiRetry.js";

const client = new DelphiClient();
const { markets } = await withDelphiRetry(
  () =>
    client.listMarkets({
      limit: 3,
      pricesAndImpliedProbabilities: true,
    }),
  { label: "listMarkets(rawprices)" }
);

for (const m of markets ?? []) {
  console.log({
    id: m.id,
    spotPrices: m.spotPrices,
    spotImpliedProbabilities: m.spotImpliedProbabilities,
    typeofFirstProb: typeof m.spotImpliedProbabilities?.[0],
  });
}
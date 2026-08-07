import "dotenv/config";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";

const client = new DelphiClient();
const { markets } = await client.listMarkets({
  limit: 3,
  pricesAndImpliedProbabilities: true,
});

for (const m of markets ?? []) {
  console.log({
    id: m.id,
    spotPrices: m.spotPrices,
    spotImpliedProbabilities: m.spotImpliedProbabilities,
    typeofFirstProb: typeof m.spotImpliedProbabilities?.[0],
  });
}

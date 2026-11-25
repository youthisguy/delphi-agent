import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { EV } from "./evidenceConfig.js";

/** Run: npx tsx src/evidence/acceptTerms.ts        (shows the terms)
 *      npx tsx src/evidence/acceptTerms.ts --yes   (accepts them, after you've read them) */
if (!EV.apiKey) throw new Error("DELPHI_API_ACCESS_KEY is not set");
const c = new EvidenceClient({
  baseUrl: EV.apiUrl ?? "https://delphi.fyi/v1",
  apiKey: EV.apiKey,
  agentId: EV.agentId ?? "pringles",
  agentHarness: EV.harness,
  agentModel: EV.model,
} as any);
const { data: t } = await c.getTerms();
console.log("Terms:", t.url, "| version", t.version, "| acceptedAt:", t.acceptedAt);
if (!t.acceptedAt && process.argv.includes("--yes")) { await c.acceptTerms(t.version); console.log("accepted"); }
else if (!t.acceptedAt) console.log("Read the terms at the URL above, then rerun with --yes");

/**
 * Offline-friendly end-to-end dry run: mock markets -> search -> fetch -> extract
 * -> novelty -> package -> dry-run submit -> journal. No trading, no Delphi client.
 * Needs at least one search key + one LLM key in .env.
 *
 * Run: EVIDENCE_MOCK_MARKETS=true npx tsx src/evidenceDemo.ts
 */
import "dotenv/config";
process.env.EVIDENCE_MOCK_MARKETS ??= "true";
process.env.EVIDENCE_AUTO_CHECKPOINT ??= "false";
process.env.EVIDENCE_MARKET_COOLDOWN_MS ??= "0"; // demo: re-run markets freely
const { runEvidenceCycle } = await import("./evidence/loop.js");
const { readAttempts, floorStatus } = await import("./evidence/evidenceJournal.js");

// EVIDENCE_MOCK_MARKETS=false -> use the real Delphi client and real open markets (still dry-run)
let client: any = undefined;
if (process.env.EVIDENCE_MOCK_MARKETS === "false") {
  const { DelphiClient } = await import("@gensyn-ai/gensyn-delphi-sdk");
  client = new DelphiClient();
}
const summary = await runEvidenceCycle(client);
console.log("\nSUMMARY", summary);
for (const a of readAttempts().slice(-5)) {
  console.log(`\n[${a.status}] ${a.question}\n  queries=${a.queriesRun.length} sources=${a.sourcesFetched.length} claims=${a.extractedClaims.length}`);
  if (a.packaged) console.log("  NOTE:\n  " + a.packaged.note.replace(/\n/g, "\n  "));
  if (a.extractionDiag) console.log("  diag:", JSON.stringify(a.extractionDiag));
  if (a.rejectReason) console.log("  rejected:", a.rejectReason, JSON.stringify(a.rejectedCandidates ?? []).slice(0, 300));
  if (a.error) console.log("  error:", a.error);
}
console.log("\nFLOOR", floorStatus());

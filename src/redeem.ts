import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { readReceipts, patchReceiptExecution, type Receipt } from "./journal.js";

/**
 * On settlement:
 *  - If we're on the WINNING side, we must call the SDK's redeem/liquidate
 *    step or the win never gets counted toward PnL / collateral balance.
 *  - If we're on the LOSING side, there's nothing to do — losing shares
 *    are simply worthless, no on-chain action required.
 *
 * NOTE ON SDK METHOD NAMES: the redeem/liquidate call still assumes a
 * shape like `client.redeemWinningShares({ marketAddress, outcomeIdx })`
 * returning `{ transactionHash, amount }` — that one's still unverified
 * against @gensyn-ai/gensyn-delphi-sdk's actual exports (marked TODO
 * below). getMarket() itself is now confirmed: it takes an options
 * object (`{ id }`), not a bare address string.
 */

export interface RedeemResult {
  marketId: string;
  redeemed: boolean;
  txHash?: string;
  amount?: string;
  reason?: string;
}

export async function checkAndRedeemSettledPositions(
  client: DelphiClient,
  dryRun: boolean
): Promise<RedeemResult[]> {
  const receipts = await readReceipts();

  // Only our own executed trades can have anything to redeem.
  const openTrades = receipts.filter(
    (r) => r.decision === "trade" && r.execution?.txHash && !r.execution?.redeemedTxHash
  );

  if (openTrades.length === 0) return [];

  const results: RedeemResult[] = [];

  for (const receipt of openTrades) {
    let market: Market | undefined;
    try {
      // getMarket() takes an options object (not a bare address string) —
      // same shape as listMarkets(). Confirmed against SDK docs.
      market = await client.getMarket({ id: receipt.marketId } as any);
    } catch (err) {
      console.warn(`  [redeem] couldn't fetch market ${receipt.marketId}:`, err);
      continue;
    }
    if (!market) continue;

    const status = (market as any).status;
    if (status !== "settled") continue; // still open, nothing to do yet

    const winningOutcomeIdx = (market as any).winningOutcomeIdx;
    if (winningOutcomeIdx === null || winningOutcomeIdx === undefined) continue; // failed/void market

    const weWon = Number(winningOutcomeIdx) === receipt.outcomeIdx;

    if (!weWon) {
      results.push({ marketId: receipt.marketId, redeemed: false, reason: "losing side, no action needed" });
      patchReceiptExecution(receipt.marketId, { resolved: true, won: false, redeemedAmount: "0" });
      continue;
    }

    if (dryRun) {
      console.log(`  [redeem] DRY RUN: would redeem winning position on ${receipt.marketId}`);
      results.push({ marketId: receipt.marketId, redeemed: false, reason: "dry-run, skipped on-chain call" });
      continue;
    }

    try {
      // TODO: replace with the actual SDK redeem/liquidate call, e.g.:
      //   const result = await client.redeemWinningShares({
      //     marketAddress: receipt.marketId as `0x${string}`,
      //     outcomeIdx: receipt.outcomeIdx!,
      //   });
      const result = await (client as any).redeemWinningShares?.({
        marketAddress: receipt.marketId,
        outcomeIdx: receipt.outcomeIdx,
      });

      if (!result) {
        results.push({
          marketId: receipt.marketId,
          redeemed: false,
          reason: "SDK redeem method not found — check redeem.ts TODO and wire up the real call",
        });
        continue;
      }

      patchReceiptExecution(receipt.marketId, {
        resolved: true,
        won: true,
        redeemedTxHash: result.transactionHash,
        redeemedAmount: String(result.amount ?? ""),
      });
      
      console.log(`  [redeem] WON ${receipt.marketId}: redeemed, tx=${result.transactionHash}`);
      results.push({
        marketId: receipt.marketId,
        redeemed: true,
        txHash: result.transactionHash,
        amount: String(result.amount ?? ""),
      });
    } catch (err) {
      console.error(`  [redeem] redemption failed for ${receipt.marketId}:`, err instanceof Error ? err.message : err);
      results.push({ marketId: receipt.marketId, redeemed: false, reason: "redeem call threw, see logs" });
    }
  }

  return results;
}
import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { readReceipts, patchReceiptExecution, type Receipt } from "./journal.js";

/**
 * On settlement:
 *  - WINNING side → redeemMarket() or the win never gets counted toward
 *    PnL / collateral balance.
 *  - LOSING side → nothing to do; losing shares are simply worthless.
 *  - FAILED/void market (no single winning outcome) → liquidate() burns
 *    shares across every outcome index and returns whatever collateral
 *    is still recoverable.
 *
 * SDK methods confirmed against @gensyn-ai/gensyn-delphi-sdk's docs:
 *  - getMarket({ id }) — options object, not a bare address string.
 *  - redeemMarket({ marketAddress }) — redeems whatever winning shares
 *    the signer wallet holds in that market; no outcomeIdx param.
 *    Returns { transactionHash, sharesIn, tokensOut }.
 *  - liquidate({ marketAddress, outcomeIndices }) — for status "failed"
 *    markets. Returns { transactionHash, sharesIn, totalTokensOut }.
 *
 * Liquidated failed markets are patched with execution.void = true —
 * journal.ts's recomputeSummary excludes those from the accuracy
 * denominator entirely, since a void market was never a right-or-wrong
 * forecast in the first place.
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

    // Void/failed markets have no single winning outcome, so redeemMarket()
    // doesn't apply — liquidate() burns the wallet's shares across every
    // outcome index and returns whatever collateral is still recoverable.
    if (status === "failed") {
      const outcomes: string[] =
        (market as any).outcomes ?? (market as any).metadata?.outcomes ?? [];
      const outcomeIndices =
        outcomes.length > 0
          ? outcomes.map((_, i) => i)
          : [receipt.outcomeIdx as number]; // fallback if outcomes list is unavailable

      if (dryRun) {
        console.log(`  [redeem] DRY RUN: would liquidate failed market ${receipt.marketId}`);
        results.push({ marketId: receipt.marketId, redeemed: false, reason: "dry-run, skipped on-chain liquidate call" });
        continue;
      }

      try {
        const result = await client.liquidate({
          marketAddress: receipt.marketId as `0x${string}`,
          outcomeIndices,
        });

        // Not a win or a loss — the market never resolved to an outcome,
        // so this shouldn't count toward forecast accuracy either way.
        // `void: true` tells journal.ts's recomputeSummary to exclude
        // this receipt from the accuracy denominator entirely, not just
        // from the `correct` count. Still marks `resolved: true` so it
        // drops out of open exposure.
        patchReceiptExecution(receipt.marketId, {
          resolved: true,
          void: true,
          redeemedTxHash: result.transactionHash,
          redeemedAmount: String(result.totalTokensOut ?? ""),
        });

        console.log(
          `  [redeem] FAILED market liquidated ${receipt.marketId}: tx=${result.transactionHash}, tokensOut=${result.totalTokensOut}`
        );
        results.push({
          marketId: receipt.marketId,
          redeemed: true,
          txHash: result.transactionHash,
          amount: String(result.totalTokensOut ?? ""),
          reason: "failed/void market — liquidated for recoverable collateral",
        });
      } catch (err) {
        console.error(`  [redeem] liquidation failed for ${receipt.marketId}:`, err instanceof Error ? err.message : err);
        results.push({ marketId: receipt.marketId, redeemed: false, reason: "liquidate call threw, see logs" });
      }
      continue;
    }

    if (status !== "settled") continue; // still open, nothing to do yet

    const winningOutcomeIdx = (market as any).winningOutcomeIdx;
    if (winningOutcomeIdx === null || winningOutcomeIdx === undefined) continue; // no winner attached yet

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
      // redeemMarket() takes just the market address — it redeems whatever
      // winning shares the signer wallet holds in that market, no
      // outcomeIdx param needed (confirmed against SDK docs).
      const result = await client.redeemMarket({
        marketAddress: receipt.marketId as `0x${string}`,
      });

      patchReceiptExecution(receipt.marketId, {
        resolved: true,
        won: true,
        redeemedTxHash: result.transactionHash,
        redeemedAmount: String(result.tokensOut ?? ""),
      });

      console.log(`  [redeem] WON ${receipt.marketId}: redeemed, tx=${result.transactionHash}, tokensOut=${result.tokensOut}`);
      results.push({
        marketId: receipt.marketId,
        redeemed: true,
        txHash: result.transactionHash,
        amount: String(result.tokensOut ?? ""),
      });
    } catch (err) {
      console.error(`  [redeem] redemption failed for ${receipt.marketId}:`, err instanceof Error ? err.message : err);
      results.push({ marketId: receipt.marketId, redeemed: false, reason: "redeem call threw, see logs" });
    }
  }

  return results;
}
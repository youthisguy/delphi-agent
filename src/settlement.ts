import type { DelphiClient, Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { readReceipts, patchReceiptSettlement, type Receipt, type ReceiptSettlement } from "./journal.js";
import { extractWinningIdx } from "./backtest.js";

/**
 * Ground-truth settlement pass — walks every receipt (trade AND skip,
 * live AND dry-run) that hasn't been settled yet, checks whether its
 * market has resolved, and records win/loss/void + P&L uniformly.
 */
export async function checkSettledOutcomes(
  client: DelphiClient
): Promise<{ checked: number; settled: number }> {
  const receipts = await readReceipts();
  const unsettled = receipts.filter((r) => !r.settlement);
  if (unsettled.length === 0) return { checked: 0, settled: 0 };

  // Dedupe market lookups — the same marketId can show up on several
  // receipts (a market skipped a few cycles running, then traded once;
  // or just re-evaluated every loop tick while still open).
  const marketCache = new Map<string, Market | null>();
  let settledCount = 0;

  for (const r of unsettled) {
    let market = marketCache.get(r.marketId);
    if (market === undefined) {
      try {
        market = (await client.getMarket({ id: r.marketId } as any)) ?? null;
      } catch (err) {
        console.warn(
          `  [settlement] couldn't fetch market ${r.marketId}:`,
          err instanceof Error ? err.message : err
        );
        market = null;
      }
      marketCache.set(r.marketId, market);
    }
    if (!market) continue;

    const status = (market as any).status;
    const isVoid = status === "failed";
    const winningOutcomeIdx = isVoid ? null : extractWinningIdx(market);
    if (!isVoid && winningOutcomeIdx === null) continue; // still open, or winner not attached yet

    const settlement = buildSettlement(r, { isVoid, winningOutcomeIdx });
    patchReceiptSettlement(r.marketId, settlement);
    settledCount++;
  }

  return { checked: unsettled.length, settled: settledCount };
}

function argmax(probs: number[]): number {
  let best = -1;
  let bestP = -Infinity;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > bestP) {
      bestP = probs[i];
      best = i;
    }
  }
  return best;
}

function buildSettlement(
  r: Receipt,
  outcome: { isVoid: boolean; winningOutcomeIdx: number | null }
): ReceiptSettlement {
  const { isVoid, winningOutcomeIdx } = outcome;
  const settledAt = new Date().toISOString();

  if (r.decision === "skip") {
    // No capital was ever risked on a skip — nothing to P&L. What IS
    // worth recording for calibration: would the model's own favorite
    // outcome (argmax of the blend) have been right, had it traded
    // anyway? This is a retroactive signal, not a claim the bot "should"
    // have traded it — the whole point of the skip thresholds is that a
    // favorite without enough edge/too much disagreement isn't a bet
    // worth making even when it happens to land right later.
    const impliedIdx = r.blendedProbs?.length ? argmax(r.blendedProbs) : -1;
    const correct = isVoid || impliedIdx === -1 ? null : impliedIdx === winningOutcomeIdx;
    return { settledAt, winningOutcomeIdx, void: isVoid, correct, pnl: null };
  }

  // decision === "trade"
  const outcomeIdx = r.outcomeIdx;
  const correct = isVoid || outcomeIdx === null ? null : outcomeIdx === winningOutcomeIdx;
  const size = r.size ?? 0;

  // Live trade already redeemed/liquidated by redeem.ts — trust that
  // figure rather than re-deriving win/loss/pnl here, so this pass and
  // redeem.ts can never disagree about the same trade.
  //
  // UNVERIFIED (same caveat flagged in index.ts's tradeOnMarket): whether
  // execution.redeemedAmount is already human-scaled tokens or needs
  // dividing by the token's decimals depends on what the SDK's
  // redeemMarket()/liquidate() actually return. Treat totalPnl on live
  // trades as a rough sanity-check figure until that's confirmed against
  // a real settled trade.
  if (r.execution?.resolved) {
    const redeemed = Number(r.execution?.redeemedAmount ?? 0);
    const pnl = Number.isFinite(redeemed) ? redeemed - size : null;
    return { settledAt, winningOutcomeIdx, void: isVoid, correct, pnl };
  }

  // Dry-run trade (no on-chain redemption ever happened). Void markets
  // have no reliable dry-run recovery estimate absent an actual
  // liquidate() call, so leave pnl null rather than guess.
  if (isVoid || outcomeIdx === null) {
    return { settledAt, winningOutcomeIdx, void: isVoid, correct, pnl: null };
  }

  // Same entry-price fallback convention as backtest.ts / positions.ts:
  // synthetic (empty) book at decision time → priced against 0.5.
  const entryPrice = r.syntheticPrice || !r.rawPrice ? 0.5 : (r.rawPrice[outcomeIdx] ?? 0.5);
  const shares = size / Math.max(entryPrice, 0.01);
  const pnl = correct ? shares - size : -size;

  return { settledAt, winningOutcomeIdx, void: isVoid, correct, pnl };
}

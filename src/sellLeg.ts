import type { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { withDelphiRetry } from "./delphiRetry.js";
import { patchReceiptExecution } from "./journal.js";
import { markLegClosed, type CloseReason } from "./closedLegs.js";

/**
 * Shared "close this leg" path: quoteSell() -> sellShares() with a
 * slippage buffer, then journal + closed-legs bookkeeping. Extracted so
 * scripts/sell-positions.ts (manual) and positionWatcher.ts (confirmed
 * auto-exit) share one implementation instead of two copies that could
 * drift out of sync — the exact failure mode chainRead.ts's
 * resolveWalletAddress() and checkpoint.ts's runCheckpointScript() were
 * already extracted to avoid for their own callers.
 *
 * On a real fill: patches the receipt (same shape scripts/sell-positions.ts
 * already writes — resolved:true, redeemedTxHash, redeemedAmount) AND
 * permanently marks the leg closed via closedLegs.ts, so index.ts's
 * decide() never re-buys it. The closed-legs write happens unconditionally
 * after a successful sell, regardless of who or what triggered it.
 */

export interface SellLegResult {
  sold: boolean;
  txHash?: string;
  tokensOutHuman?: number;
  reason?: string;
}

export async function sellLeg(
  client: DelphiClient,
  params: {
    marketAddress: `0x${string}`;
    outcomeIdx: number;
    sharesIn: bigint;
    collateralDecimals: number;
    slippageBps?: bigint; // default 300 = 3%, same as scripts/sell-positions.ts
    dryRun?: boolean;
    closeReason: CloseReason;
    closeNote?: string;
    /** Passed straight through to closedLegs.ts's markLegClosed() for
     * display — see that function's doc comment. */
    question?: string;
    outcomeLabel?: string;
  }
): Promise<SellLegResult> {
  const slippageBps = params.slippageBps ?? 300n;

  let quotedTokensOut: bigint;
  try {
    const quote = await withDelphiRetry(
      () =>
        client.quoteSell({
          marketAddress: params.marketAddress,
          outcomeIdx: params.outcomeIdx,
          sharesIn: params.sharesIn,
        }),
      { label: `quoteSell(${params.marketAddress})` }
    );
    quotedTokensOut = quote.tokensOut;
  } catch (err) {
    return {
      sold: false,
      reason: `quoteSell failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  const tokensOutHuman =
    Number(quotedTokensOut) / 10 ** params.collateralDecimals;

  if (params.dryRun) {
    // Dry-run never touches closedLegs or the journal's execution block —
    // there's no real leg to close yet, only a simulated one.
    return {
      sold: false,
      reason: "dry-run — no on-chain sell sent",
      tokensOutHuman,
    };
  }

  const minTokensOut =
    quotedTokensOut - (quotedTokensOut * slippageBps) / 10_000n;

  try {
    const result = await withDelphiRetry(
      () =>
        client.sellShares({
          marketAddress: params.marketAddress,
          outcomeIdx: params.outcomeIdx,
          sharesIn: params.sharesIn,
          minTokensOut,
        }),
      { label: `sellShares(${params.marketAddress})` }
    );

    patchReceiptExecution(
      params.marketAddress,
      {
        resolved: true,
        redeemedTxHash: result.transactionHash,
        redeemedAmount: tokensOutHuman.toFixed(6),
        exitReason: params.closeReason,
        exitNote: params.closeNote,
      },
      params.outcomeIdx
    );

    // The permanent re-buy guard — see closedLegs.ts. Runs AFTER the sell
    // confirms, so a failed sell never blocks the leg for no reason.
    markLegClosed(
      params.marketAddress,
      params.outcomeIdx,
      params.closeReason,
      params.closeNote,
      {
        question: params.question,
        outcomeLabel: params.outcomeLabel,
      }
    );

    return { sold: true, txHash: result.transactionHash, tokensOutHuman };
  } catch (err) {
    return {
      sold: false,
      reason: `sellShares failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

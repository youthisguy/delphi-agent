/**
 * Buy into an open market via quoteBuy()/buyShares(), applying the same
 * spend-cap and price-impact-cap shrink-and-requote logic as index.ts's
 * tradeOnMarket() — so a manual buy can't silently eat a huge % on a thin
 * book the way the pre-fix SILSO/NSIDC/TCL trades did. On a real fill,
 * appends a manual-trade receipt to the journal so the position shows up
 * in the dashboard's Open Positions panel and redeem.ts picks it up
 * normally once the market settles.
 *
 *   npx tsx scripts/buy-position.ts --market 0xdcaabdc8f3e4eef25a4ffac567d118d8ab0a3081 --outcome no --amount 1390
 *   npx tsx scripts/buy-position.ts --market 0xabc... --outcome yes --amount 50 --buy
 *   npx tsx scripts/buy-position.ts --market 0xabc... --outcome yes --amount 50 --buy --dry-run
 *   npx tsx scripts/buy-position.ts --market 0xabc... --outcome yes --amount 50 --buy --slippage-bps 500
 *   npx tsx scripts/buy-position.ts --market 0xabc... --outcome yes --amount 50 --buy --max-impact-pct 0.08
 */

import "dotenv/config";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { resolveWalletAddress, getErc20Balance, getErc20Decimals } from "../src/chainRead.js";
import { withDelphiRetry } from "../src/delphiRetry.js";
import { appendReceipt, type Receipt } from "../src/journal.js";
import { CONFIG } from "../src/config.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const DO_BUY = process.argv.includes("--buy") || process.argv.includes("--execute");
const DRY_RUN = process.argv.includes("--dry-run");

const MARKET_ADDRESS = argValue("--market");
const OUTCOME_ARG = argValue("--outcome")?.toLowerCase() ?? null;

// Tokens to spend. Required — this script sizes off spend, same as
// tradeOnMarket()'s decision.tokensToSpend, not off a target share count.
const AMOUNT_TOKENS = argValue("--amount") ? Number(argValue("--amount")) : null;

const SLIPPAGE_BPS = BigInt(argValue("--slippage-bps") ?? "150"); // 1.5%, same default as tradeOnMarket()

// Same knob as config.ts's CONFIG.maxPriceImpactPct, overridable per-run
// without touching env — useful for a one-off manual buy on a market you
// know is thin and are deliberately willing to eat more impact on.
const MAX_IMPACT_PCT = argValue("--max-impact-pct")
  ? Number(argValue("--max-impact-pct"))
  : CONFIG.maxPriceImpactPct;

/** Shares are fixed at 18 decimals. */
const SHARES_DECIMALS = 18;

if (!MARKET_ADDRESS) {
  throw new Error("Missing --market 0x...");
}
if (!OUTCOME_ARG) {
  throw new Error("Missing --outcome <label> (e.g. --outcome yes)");
}
if (AMOUNT_TOKENS === null || !Number.isFinite(AMOUNT_TOKENS) || AMOUNT_TOKENS <= 0) {
  throw new Error("Missing/invalid --amount <tokens to spend>");
}
if (!Number.isFinite(MAX_IMPACT_PCT) || MAX_IMPACT_PCT <= 0) {
  throw new Error(`Invalid --max-impact-pct=${MAX_IMPACT_PCT}`);
}

const client = new DelphiClient();

async function getMarket(id: string): Promise<Market | null> {
  try {
    return (
      (await withDelphiRetry(
        () => client.getMarket({ id, pricesAndImpliedProbabilities: true } as any),
        { label: `getMarket(${id})`, maxRetries: 3 }
      )) ?? null
    );
  } catch (err) {
    console.warn(`  getMarket(${id}) failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Same shrink-safe quoteBuy wrapper as index.ts's safeQuoteBuy() — a
 * revert here (e.g. below the contract's minimum trade size) is a normal
 * "this specific size doesn't work" outcome, not a bug to crash on. */
async function safeQuoteBuy(params: {
  marketAddress: `0x${string}`;
  outcomeIdx: number;
  sharesOut: bigint;
  label: string;
}): Promise<{ ok: true; quote: Awaited<ReturnType<typeof client.quoteBuy>> } | { ok: false; reason: string }> {
  try {
    const quote = await withDelphiRetry(
      () =>
        client.quoteBuy({
          marketAddress: params.marketAddress,
          outcomeIdx: params.outcomeIdx,
          sharesOut: params.sharesOut,
        }),
      { label: params.label, maxRetries: 2 }
    );
    return { ok: true, quote };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [quoteBuy] ${params.label} reverted:`, msg);
    return { ok: false, reason: `quote reverted on-chain: ${msg.slice(0, 200)}` };
  }
}

async function main() {
  console.log(
    `buy-position market=${MARKET_ADDRESS} outcome=${OUTCOME_ARG} amount=${AMOUNT_TOKENS} ` +
      `buy=${DO_BUY} dryRun=${DRY_RUN} slippageBps=${SLIPPAGE_BPS} maxImpactPct=${(MAX_IMPACT_PCT * 100).toFixed(1)}%\n`
  );

  const wallet = await resolveWalletAddress(client);
  if (!wallet) {
    throw new Error("Could not resolve wallet — set WALLET_ADDRESS or configure the Delphi signer.");
  }
  console.log(`Wallet: ${wallet}\n`);

  const tokenAddress = process.env.COMPETITION_TOKEN_ADDRESS ?? null;
  if (!tokenAddress) {
    throw new Error("COMPETITION_TOKEN_ADDRESS not set — refusing to size a live buy against an unconfirmed token.");
  }

  const market = await getMarket(MARKET_ADDRESS!);
  if (!market) {
    throw new Error(`Market ${MARKET_ADDRESS} not found or unreachable.`);
  }

  const status = (market as any).status;
  if (status !== "open") {
    throw new Error(`Market status is "${status}", not "open" — refusing to buy.`);
  }

  const outcomes: string[] = (market as any).outcomes ?? (market as any).metadata?.outcomes ?? ["Yes", "No"];
  const outcomeIdx = outcomes.findIndex((o) => o.toLowerCase() === OUTCOME_ARG);
  if (outcomeIdx === -1) {
    throw new Error(`Outcome "${OUTCOME_ARG}" not found. Available: ${JSON.stringify(outcomes)}`);
  }

  const question = (market as any).question ?? (market as any).metadata?.question ?? "";
  console.log(`${question}`);
  console.log(`  outcome: ${outcomes[outcomeIdx]} (idx ${outcomeIdx})\n`);

  const rawProbs = (market as any).spotImpliedProbabilities as unknown[] | undefined;
  let entryPrice = 0.5;
  if (rawProbs && rawProbs[outcomeIdx] !== undefined) {
    const n = Number(rawProbs[outcomeIdx]);
    if (Number.isFinite(n)) entryPrice = n > 1.5 ? n / 1e18 : n;
  }
  entryPrice = Math.max(entryPrice, 0.01);
  console.log(`  current implied price: ${(entryPrice * 100).toFixed(2)}%\n`);

  const decimals = CONFIG.competitionTokenDecimals ?? (await getErc20Decimals(tokenAddress));
  const maxTokensIn = BigInt(Math.floor(AMOUNT_TOKENS! * 10 ** decimals));

  const rawBalance = await getErc20Balance(tokenAddress, wallet);
  if (maxTokensIn > rawBalance) {
    throw new Error(
      `Insufficient balance: want to spend ${AMOUNT_TOKENS} tokens, wallet holds ${
        Number(rawBalance) / 10 ** decimals
      }.`
    );
  }

  const desiredShares = AMOUNT_TOKENS! / entryPrice;
  const sharesOut = BigInt(Math.floor(desiredShares * 1e18));

  const quoteResult = await safeQuoteBuy({
    marketAddress: MARKET_ADDRESS as `0x${string}`,
    outcomeIdx,
    sharesOut,
    label: `quoteBuy(${MARKET_ADDRESS})`,
  });
  if (!quoteResult.ok) {
    console.error(`  ${quoteResult.reason}`);
    return;
  }

  let finalQuote = quoteResult.quote;
  let finalSharesOut = sharesOut;

  const impactPctFor = (q: { tokensIn: bigint }, shares: bigint): number => {
    const costPerShare = Number(q.tokensIn) / 10 ** decimals / (Number(shares) / 1e18);
    return entryPrice > 0 ? (costPerShare - entryPrice) / entryPrice : 0;
  };

  // --- spend-cap resize (same pattern as tradeOnMarket()) ---
  if (finalQuote.tokensIn > maxTokensIn) {
    const scale = Number(maxTokensIn) / Number(finalQuote.tokensIn);
    const scaledShares = BigInt(Math.floor(Number(sharesOut) * scale * 0.98));

    if (scaledShares <= 0n) {
      console.error(`  quoted cost exceeds max spend (${AMOUNT_TOKENS} tokens) even at minimal size — declining.`);
      return;
    }

    const retry = await safeQuoteBuy({
      marketAddress: MARKET_ADDRESS as `0x${string}`,
      outcomeIdx,
      sharesOut: scaledShares,
      label: `quoteBuy(retry:${MARKET_ADDRESS})`,
    });
    if (!retry.ok) {
      console.error(`  ${retry.reason}`);
      return;
    }
    finalQuote = retry.quote;
    finalSharesOut = scaledShares;

    if (finalQuote.tokensIn > maxTokensIn) {
      console.error(`  quoted cost still exceeds max spend after resize — declining.`);
      return;
    }
  }

  // --- price-impact cap (same pattern as tradeOnMarket()) ---
  let impactPct = impactPctFor(finalQuote, finalSharesOut);

  if (impactPct > MAX_IMPACT_PCT) {
    const scale = MAX_IMPACT_PCT / impactPct;
    const shrunkShares = BigInt(Math.floor(Number(finalSharesOut) * scale * 0.98));
    const minSharesFixedPoint = BigInt(Math.floor(CONFIG.minTradeShares * 1e18));

    if (shrunkShares <= 0n || shrunkShares < minSharesFixedPoint) {
      console.error(
        `  price impact ${(impactPct * 100).toFixed(1)}% exceeds ${(MAX_IMPACT_PCT * 100).toFixed(0)}% cap ` +
          `even at minimal size — declining.`
      );
      return;
    }

    const retry = await safeQuoteBuy({
      marketAddress: MARKET_ADDRESS as `0x${string}`,
      outcomeIdx,
      sharesOut: shrunkShares,
      label: `quoteBuy(impact-retry:${MARKET_ADDRESS})`,
    });
    if (!retry.ok) {
      console.error(`  ${retry.reason}`);
      return;
    }

    const shrunkImpactPct = impactPctFor(retry.quote, shrunkShares);
    if (shrunkImpactPct > MAX_IMPACT_PCT || retry.quote.tokensIn > maxTokensIn) {
      console.error(
        `  price impact still ${(shrunkImpactPct * 100).toFixed(1)}% after resize, exceeds ` +
          `${(MAX_IMPACT_PCT * 100).toFixed(0)}% cap — declining.`
      );
      return;
    }

    finalQuote = retry.quote;
    finalSharesOut = shrunkShares;
    impactPct = shrunkImpactPct;
    console.log(`  ⚠ resized down to fit ${(MAX_IMPACT_PCT * 100).toFixed(0)}% impact cap\n`);
  }

  const quotedTokensHuman = Number(finalQuote.tokensIn) / 10 ** decimals;
  const sharesHuman = Number(finalSharesOut) / 1e18;

  console.log(`  quote: ${quotedTokensHuman.toFixed(6)} tokens for ${sharesHuman.toFixed(6)} shares`);
  console.log(`  price impact: ${(impactPct * 100).toFixed(2)}% (cap ${(MAX_IMPACT_PCT * 100).toFixed(0)}%)\n`);

  if (!DO_BUY) {
    console.log("  → view only, would buy at the quote above. Re-run with --buy to execute.");
    return;
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] buyShares ${MARKET_ADDRESS} sharesOut=${finalSharesOut} — no on-chain call made.`);
    return;
  }

  const maxTokensInWithSlippageRaw =
    finalQuote.tokensIn + (finalQuote.tokensIn * SLIPPAGE_BPS) / 10000n;
  const maxTokensInWithSlippage =
    maxTokensInWithSlippageRaw > maxTokensIn ? maxTokensIn : maxTokensInWithSlippageRaw;

  console.log("  executing buy:");
  console.log(`    sharesOut(raw): ${finalSharesOut}`);
  console.log(`    quote(raw):     ${finalQuote.tokensIn}`);
  console.log(`    maxIn(raw):     ${maxTokensInWithSlippage}\n`);

  await withDelphiRetry(
    () =>
      client.ensureTokenApproval({
        marketAddress: MARKET_ADDRESS as `0x${string}`,
        minimumAmount: maxTokensInWithSlippage,
      }),
    { label: `ensureTokenApproval(${MARKET_ADDRESS})` }
  );

  const result = await withDelphiRetry(
    () =>
      client.buyShares({
        marketAddress: MARKET_ADDRESS as `0x${string}`,
        outcomeIdx,
        sharesOut: finalSharesOut,
        maxTokensIn: maxTokensInWithSlippage,
      }),
    { label: `buyShares(${MARKET_ADDRESS})` }
  );

  console.log(`  BOUGHT tx=${result.transactionHash}`);

  const costPerShare = quotedTokensHuman / sharesHuman;
  const priceImpactPct = entryPrice > 0 ? Number(impactPct.toFixed(4)) : null;

  // Manual-trade receipt so this position shows up in the dashboard's
  // Open Positions panel (positions.ts aggregates from the journal) and
  // redeem.ts picks it up like any other trade once the market settles.
  // signals are all null / confidence 0 — this was a manual call, not a
  // forecasted decision, and calibrationByConfidenceBucket/perCategory in
  // journal.ts's recomputeSummary already handle a 0-confidence bucket
  // gracefully rather than needing a special case.
  const receipt: Receipt = {
    ts: new Date().toISOString(),
    marketId: MARKET_ADDRESS!,
    question,
    category: (market as any).category ?? undefined,
    outcomes,
    rawPrice: rawProbs ? outcomes.map((_, i) => {
      const n = Number(rawProbs[i]);
      return Number.isFinite(n) ? (n > 1.5 ? n / 1e18 : n) : 0.5;
    }) : null,
    syntheticPrice: !rawProbs,
    signals: { llm: null, gemini: null, polymarket: null },
    disagreement: null,
    blendedProbs: outcomes.map((_, i) => (i === outcomeIdx ? 1 : 0)),
    confidence: 0,
    decision: "trade",
    outcomeIdx,
    edge: 0,
    thresholdUsed: 0,
    size: quotedTokensHuman,
    execution: {
      txHash: result.transactionHash,
      quotedTokensIn: quotedTokensHuman,
      sharesOut: finalSharesOut.toString(),
      priceImpactPct,
    },
    skipReason: "manual buy via scripts/buy-position.ts",
  };

  appendReceipt(receipt);
  console.log(`  journal: appended manual-trade receipt (impact=${((priceImpactPct ?? 0) * 100).toFixed(1)}%)\n`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

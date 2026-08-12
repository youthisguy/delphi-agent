/**
 * Sell open (not-yet-settled) positions back into the LMSR via
 * quoteSell()/sellShares(), and mark the corresponding journal receipt
 * as resolved+redeemed so it drops off the dashboard's Open Positions
 * panel and redeem.ts never tries to redeem it later.
 *
 *   npx tsx scripts/sell-positions.ts
 *   npx tsx scripts/sell-positions.ts --market 0xabc...
 *   npx tsx scripts/sell-positions.ts --market 0xabc... --outcome no
 *   npx tsx scripts/sell-positions.ts --sell
 *   npx tsx scripts/sell-positions.ts --sell --dry-run
 *   npx tsx scripts/sell-positions.ts --sell --slippage-bps 500
 */

import "dotenv/config";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { resolveWalletAddress } from "../src/chainRead.js";
import { withDelphiRetry } from "../src/delphiRetry.js";
import { patchReceiptExecution } from "../src/journal.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const DO_SELL =
  process.argv.includes("--sell") || process.argv.includes("--execute");

const DRY_RUN = process.argv.includes("--dry-run");

const MARKET_FILTER =
  argValue("--market")?.toLowerCase() ?? null;

// Filter by outcome label (e.g. "yes" / "no"), case-insensitive.
// Lets you target a single leg of a market (e.g. sell only the
// losing side) instead of every position in that market.
const OUTCOME_FILTER =
  argValue("--outcome")?.toLowerCase() ?? null;

const SLIPPAGE_BPS =
  BigInt(argValue("--slippage-bps") ?? "300"); // 3%

/**
 * Shares are fixed at 18 decimals.
 */
const SHARES_DECIMALS = 18;

const COLLATERAL_TOKEN_DECIMALS = Number(
  process.env.COMPETITION_TOKEN_DECIMALS ?? "6"
);

if (
  !Number.isInteger(COLLATERAL_TOKEN_DECIMALS) ||
  COLLATERAL_TOKEN_DECIMALS < 0 ||
  COLLATERAL_TOKEN_DECIMALS > 36
) {
  throw new Error(
    `Invalid COMPETITION_TOKEN_DECIMALS=${COLLATERAL_TOKEN_DECIMALS}`
  );
}

const client = new DelphiClient();

interface SellablePosition {
  marketProxy: string;
  question: string;
  outcomeIdx: number;
  outcomeLabel: string;
  sharesRaw: bigint;
  sharesHuman: number;
  status: string;
  currentImpliedProb: number | null;
}

function rawToHuman(
  raw: string | bigint,
  decimals: number
): number {
  try {
    return Number(BigInt(raw)) / 10 ** decimals;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n / 10 ** decimals : 0;
  }
}

function sharesToHuman(raw: string | bigint): number {
  return rawToHuman(raw, SHARES_DECIMALS);
}

function collateralToHuman(raw: string | bigint): number {
  return rawToHuman(raw, COLLATERAL_TOKEN_DECIMALS);
}

async function getMarket(id: string): Promise<Market | null> {
  try {
    // pricesAndImpliedProbabilities must be requested explicitly.
    return (
      (await withDelphiRetry(
        () =>
          client.getMarket({
            id,
            pricesAndImpliedProbabilities: true,
          } as any),
        {
          label: `getMarket(${id})`,
          maxRetries: 3,
        }
      )) ?? null
    );
  } catch (err) {
    console.warn(
      `  getMarket(${id}) failed:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function loadAllPositions(wallet: string): Promise<any[]> {
  const all: any[] = [];
  let skip = 0;
  const limit = 50;

  for (;;) {
    const res = await withDelphiRetry(
      () =>
        client.listPositions({
          wallet,
          redeemedOrLiquidated: false,
          skip,
          limit,
        } as any),
      {
        label: `listPositions(skip=${skip})`,
        maxRetries: 3,
      }
    );

    const batch =
      (res as any)?.positions ??
      (Array.isArray(res) ? res : []);

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    all.push(...batch);

    if (batch.length < limit) {
      break;
    }

    skip += limit;
  }

  return all;
}

async function main() {
  console.log(
    `sell-positions sell=${DO_SELL} dryRun=${DRY_RUN} slippageBps=${SLIPPAGE_BPS}`
  );

  if (MARKET_FILTER) {
    console.log(`marketFilter=${MARKET_FILTER}`);
  }

  if (OUTCOME_FILTER) {
    console.log(`outcomeFilter=${OUTCOME_FILTER}`);
  }

  console.log(
    `sharesDecimals=${SHARES_DECIMALS} collateralDecimals=${COLLATERAL_TOKEN_DECIMALS}\n`
  );

  const wallet = await resolveWalletAddress(client);

  if (!wallet) {
    throw new Error(
      "Could not resolve wallet — set WALLET_ADDRESS or configure the Delphi signer."
    );
  }

  console.log(`Wallet: ${wallet}\n`);

  console.log(
    "Fetching positions via listPositions({ wallet })…"
  );

  const rawPositions = await loadAllPositions(wallet);

  console.log(
    `  API returned ${rawPositions.length} row(s)\n`
  );

  const sellable: SellablePosition[] = [];

  for (const p of rawPositions) {
    const sharesRaw = BigInt(String(p.shares ?? "0"));

    if (sharesRaw === 0n) {
      continue;
    }

    const marketProxy = String(
      p.marketProxy ??
        p.marketId ??
        p.marketAddress ??
        p.market ??
        ""
    );

    if (!marketProxy) {
      continue;
    }

    if (
      MARKET_FILTER &&
      marketProxy.toLowerCase() !== MARKET_FILTER
    ) {
      continue;
    }

    const status = String(
      p.marketStatus ?? p.status ?? "unknown"
    );

    // Only sell positions on markets that haven't resolved.
    if (
      status !== "open" &&
      status !== "awaiting_settlement"
    ) {
      console.log(
        `  skipping ${marketProxy} — status=${status} ` +
          `(use recover-onchain.ts for settled/failed markets)`
      );

      continue;
    }

    const outcomeIdx = Number(p.outcomeIdx ?? 0);

    const market = await getMarket(marketProxy);

    const outcomes: string[] =
      (market as any)?.outcomes ??
      (market as any)?.metadata?.outcomes ??
      ["Yes", "No"];

    const question =
      (market as any)?.question ??
      (market as any)?.metadata?.question ??
      "";

    const rawProbs =
      (market as any)?.spotImpliedProbabilities as
        | unknown[]
        | undefined;

    let currentImpliedProb: number | null = null;

    if (
      rawProbs &&
      rawProbs[outcomeIdx] !== undefined
    ) {
      const n = Number(rawProbs[outcomeIdx]);

      if (Number.isFinite(n)) {
        currentImpliedProb =
          n > 1.5 ? n / 1e18 : n;
      }
    }

    const outcomeLabel =
      outcomes[outcomeIdx] ?? `#${outcomeIdx}`;

    // Filter by outcome label if --outcome was passed. Matches
    // against the resolved label (e.g. "Yes" / "No") case-insensitively.
    if (
      OUTCOME_FILTER &&
      outcomeLabel.toLowerCase() !== OUTCOME_FILTER
    ) {
      continue;
    }

    sellable.push({
      marketProxy,
      question,
      outcomeIdx,
      outcomeLabel,
      sharesRaw,
      sharesHuman: sharesToHuman(sharesRaw),
      status,
      currentImpliedProb,
    });
  }

  if (sellable.length === 0) {
    console.log(
      "No sellable (still-open) positions found matching the given filters."
    );

    return;
  }

  console.log(
    `Found ${sellable.length} sellable position(s):\n`
  );

  for (const pos of sellable) {
    const q = pos.question.slice(0, 72);

    console.log(`• ${pos.marketProxy}`);

    console.log(
      `  ${q}${pos.question.length > 72 ? "…" : ""}`
    );

    console.log(
      `  side=${pos.outcomeLabel} ` +
        `shares≈${pos.sharesHuman.toFixed(4)} ` +
        `status=${pos.status}`
    );

    console.log(
      `  current odds: ${
        pos.currentImpliedProb !== null
          ? (pos.currentImpliedProb * 100).toFixed(2) + "%"
          : "unavailable"
      }`
    );

    let quotedTokensOut: bigint;

    try {
      const quote = await withDelphiRetry(
        () =>
          client.quoteSell({
            marketAddress:
              pos.marketProxy as `0x${string}`,
            outcomeIdx: pos.outcomeIdx,
            sharesIn: pos.sharesRaw,
          }),

        {
          label: `quoteSell(${pos.marketProxy})`,
        }
      );

      quotedTokensOut = quote.tokensOut;


      const quotedHuman =
        collateralToHuman(quotedTokensOut);

      console.log(
        `  quote: ${quotedHuman.toFixed(6)} tokens ` +
          `(raw: ${quotedTokensOut})`
      );

      if (quotedHuman < 0.0001) {
        console.log(
          `  ⚠ quote is near-zero — check "current odds" above. ` +
            `If odds look reasonable but the quote is near-zero, ` +
            `investigate liquidity/market state before executing.`
        );
      }
    } catch (err) {
      console.error(
        `  quoteSell failed:`,
        err instanceof Error ? err.message : err
      );

      console.log("");
      continue;
    }

    if (!DO_SELL) {
      console.log(
        "  → view only, would sell at the quote above\n"
      );

      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  [dry-run] sellShares ` +
          `${pos.marketProxy} ` +
          `sharesIn=${pos.sharesRaw}\n`
      );

      continue;
    }

    const minTokensOut =
      quotedTokensOut -
      (quotedTokensOut * SLIPPAGE_BPS) /
        10_000n;

    console.log(
      `  executing sell:`
    );

    console.log(
      `    sharesIn(raw): ${pos.sharesRaw}`
    );

    console.log(
      `    sharesIn:      ${pos.sharesHuman.toFixed(6)}`
    );

    console.log(
      `    quote(raw):    ${quotedTokensOut}`
    );

    console.log(
      `    quote:         ${collateralToHuman(
        quotedTokensOut
      ).toFixed(6)} tokens`
    );

    console.log(
      `    minOut(raw):   ${minTokensOut}`
    );

    console.log(
      `    minOut:        ${collateralToHuman(
        minTokensOut
      ).toFixed(6)} tokens`
    );

    try {
      const result = await withDelphiRetry(
        () =>
          client.sellShares({
            marketAddress:
              pos.marketProxy as `0x${string}`,

            outcomeIdx: pos.outcomeIdx,
            sharesIn: pos.sharesRaw,
            minTokensOut,
          }),

        {
          label: `sellShares(${pos.marketProxy})`,
        }
      );

      console.log(
        `  SOLD tx=${result.transactionHash}`
      );
      const exitAmountHuman =
        collateralToHuman(quotedTokensOut);

      patchReceiptExecution(
        pos.marketProxy,
        {
          resolved: true,
          redeemedTxHash:
            result.transactionHash,
          redeemedAmount:
            exitAmountHuman.toFixed(6),
        }
      );

      console.log(
        `  journal: marked resolved, silent ` +
          `(no pnl/settlement recorded)\n`
      );
    } catch (err) {
      console.error(
        `  sell failed ${pos.marketProxy}:`,
        err instanceof Error ? err.message : err
      );

      console.log("");
    }
  }

  console.log(
    DO_SELL
      ? "Done."
      : "View only. Re-run with --sell to execute " +
          "(add --dry-run to preview without sending transactions)."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
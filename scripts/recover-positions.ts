/**
 * Discover positions via SDK listPositions({ wallet }), print them,
 * optionally redeem winners / liquidate failed|expired markets.
 *
 *   npx tsx scripts/recover-onchain.ts
 *   npx tsx scripts/recover-onchain.ts --redeem
 *   npx tsx scripts/recover-onchain.ts --redeem --dry-run
 */
import "dotenv/config";
import { DelphiClient, type Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { resolveWalletAddress } from "../src/chainRead.js";
import { withDelphiRetry } from "../src/delphiRetry.js";

const DO_REDEEM =
  process.argv.includes("--redeem") || process.argv.includes("--execute");
const DRY_RUN = process.argv.includes("--dry-run");

const client = new DelphiClient();

type PosRow = {
  marketProxy: string;
  question: string;
  outcomeIdx: number;
  outcomeLabel: string;
  shares: number;
  sharesRaw: string;
  status: string;
  winningOutcomeIdx: number | null;
  weWin: boolean | null;
  redeemedOrLiquidated?: boolean;
};

function sharesHuman(raw: string | number | bigint): number {
  try {
    return Number(BigInt(String(raw))) / 1e18;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
}

async function getMarket(id: string): Promise<Market | null> {
  try {
    return (
      (await withDelphiRetry(
        () => client.getMarket({ id } as any),
        { label: `getMarket(${id})`, maxRetries: 3 }
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
      { label: `listPositions(skip=${skip})`, maxRetries: 3 }
    );

    const batch = (res as any)?.positions ?? (Array.isArray(res) ? res : []);
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);
    if (batch.length < limit) break;
    skip += limit;
  }

  return all;
}

async function main() {
  console.log(`recover-onchain  redeem=${DO_REDEEM}  dryRun=${DRY_RUN}\n`);

  const wallet = await resolveWalletAddress(client);
  if (!wallet) {
    throw new Error(
      "Could not resolve wallet — set WALLET_ADDRESS or configure the Delphi signer."
    );
  }
  console.log(`Wallet: ${wallet}\n`);

  console.log("Fetching positions via listPositions({ wallet })…");
  const rawPositions = await loadAllPositions(wallet);
  console.log(`  API returned ${rawPositions.length} row(s)\n`);

  const positions: PosRow[] = [];

  for (const p of rawPositions) {
    const sharesRaw = String(p.shares ?? "0");
    if (BigInt(sharesRaw) === 0n) continue; // fully exited — skip

    const marketProxy = String(
      p.marketProxy ?? p.marketId ?? p.marketAddress ?? p.market ?? ""
    );
    if (!marketProxy) continue;

    const outcomeIdx = Number(p.outcomeIdx ?? p.outcome ?? 0);
    const shares = sharesHuman(sharesRaw);

    const market = await getMarket(marketProxy);
    const outcomes: string[] =
      (market as any)?.outcomes ??
      (market as any)?.metadata?.outcomes ??
      ["Yes", "No"];
    const status =
      ((market as any)?.status as string) ??
      (p.status as string) ??
      "unknown";
    const winningOutcomeIdxRaw = (market as any)?.winningOutcomeIdx;
    const winningOutcomeIdx =
      winningOutcomeIdxRaw === null || winningOutcomeIdxRaw === undefined
        ? null
        : Number(winningOutcomeIdxRaw);
    const weWin =
      winningOutcomeIdx === null ? null : winningOutcomeIdx === outcomeIdx;

    positions.push({
      marketProxy,
      question:
        (market as any)?.question ??
        (market as any)?.metadata?.question ??
        "",
      outcomeIdx,
      outcomeLabel: outcomes[outcomeIdx] ?? `#${outcomeIdx}`,
      shares,
      sharesRaw,
      status,
      winningOutcomeIdx,
      weWin,
      redeemedOrLiquidated: Boolean(p.redeemedOrLiquidated),
    });
  }

  if (positions.length === 0) {
    console.log("No non-zero share positions found for this wallet.");
    return;
  }

  console.log(`Found ${positions.length} open position(s):\n`);

  const wins: PosRow[] = [];
  const losses: PosRow[] = [];
  const voids: PosRow[] = [];
  const open: PosRow[] = [];

  for (const p of positions) {
    const q = p.question.slice(0, 72);
    console.log(`• ${p.marketProxy}`);
    console.log(`  ${q}${p.question.length > 72 ? "…" : ""}`);
    console.log(
      `  side=${p.outcomeLabel}  shares≈${p.shares.toFixed(4)}  status=${p.status}`
    );

    if (p.status === "failed" || p.status === "expired") {
      voids.push(p);
      console.log(`  → ${p.status.toUpperCase()} — liquidate`);
    } else if (p.status === "settled") {
      if (p.weWin === true) {
        wins.push(p);
        console.log(`  → WIN — redeem`);
      } else if (p.weWin === false) {
        losses.push(p);
        console.log(`  → LOSS — nothing to redeem`);
      } else {
        open.push(p);
        console.log(`  → settled but winner unknown`);
      }
    } else {
      open.push(p);
      console.log(`  → still open`);
    }
    console.log("");
  }

  console.log("── Summary ──");
  console.log(`  open:                ${open.length}`);
  console.log(`  wins to redeem:      ${wins.length}`);
  console.log(`  losses:              ${losses.length}`);
  console.log(`  failed/expired void: ${voids.length}`);

  if (!DO_REDEEM) {
    console.log("\nView only. Re-run with --redeem to execute.");
    return;
  }

  // Dedupe by market for redeem/liquidate (one call per market)
  const winMarkets = [...new Set(wins.map((p) => p.marketProxy))];
  const voidMarkets = [...new Set(voids.map((p) => p.marketProxy))];

  for (const marketProxy of winMarkets) {
    if (DRY_RUN) {
      console.log(`  [dry-run] redeemMarket ${marketProxy}`);
      continue;
    }
    try {
      const result = await withDelphiRetry(
        () =>
          client.redeemMarket({
            marketAddress: marketProxy as `0x${string}`,
          }),
        { label: `redeemMarket(${marketProxy})` }
      );
      console.log(
        `  REDEEMED ${marketProxy} tx=${result.transactionHash} tokensOut=${result.tokensOut}`
      );
    } catch (err) {
      console.error(
        `  redeem failed ${marketProxy}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  for (const marketProxy of voidMarkets) {
    if (DRY_RUN) {
      console.log(`  [dry-run] liquidate ${marketProxy}`);
      continue;
    }
    const held = voids
      .filter((p) => p.marketProxy === marketProxy)
      .map((p) => p.outcomeIdx);
    const outcomeIndices = held.length > 0 ? held : [0, 1];

    try {
      const result = await withDelphiRetry(
        () =>
          client.liquidate({
            marketAddress: marketProxy as `0x${string}`,
            outcomeIndices,
          }),
        { label: `liquidate(${marketProxy})` }
      );
      console.log(
        `  LIQUIDATED ${marketProxy} tx=${result.transactionHash} tokensOut=${(result as any).totalTokensOut}`
      );
    } catch (err) {
      console.error(
        `  liquidate failed ${marketProxy}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
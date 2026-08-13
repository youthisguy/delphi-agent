import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { CONFIG, getDryRun, setDryRun, getCompetitionTokenAddress, setCompetitionTokenAddress } from "./config.js";
import { readReceipts, readPinnedSummary, recomputeSummary } from "./journal.js";
import { runBacktest, listBacktestRuns, readBacktestRun } from "./backtest.js";
import { getAllNodesView, getPoolSummary, runHealthCheck } from "./keyPool.js";
import { getNativeBalance, getErc20Balance, getErc20Decimals, hasContractCode, getChainId, resolveWalletAddress } from "./chainRead.js";
import { getOpenPositions } from "./positions.js";
import { checkSettledOutcomes } from "./settlement.js";
import { runCheckpointScript } from "./checkpoint.js";
import { appendReceipt, type Receipt } from "./journal.js";
import {
  extractLiquidity,
  extractVolume,
  extractResolvesAt,
  extractSettlesAt,
  extractTradingFeePct,
  extractDataSources,
  extractMarketUrl,
  extractAppMarketId,
  msUntilResolve,
} from "./marketFields.js";
import { withDelphiRetry } from "./delphiRetry.js";

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

const client = new DelphiClient();

// --- password gate (write actions only) -------------------------------
//
// Simplest viable version: one shared password from env, checked via a
// header. Quote endpoints (read-only, no funds move) stay open — only
// the two routes that actually execute an on-chain trade are gated.
// If DASHBOARD_PASSWORD isn't set, the gate is a no-op (fine for local
// dev; set it once this is exposed anywhere else).
function requireDashboardPassword(req: any, res: any, next: any) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return next(); // gate not configured — don't lock people out
  const supplied = req.header("x-dashboard-password");
  if (supplied !== expected) {
    return res.status(401).json({ error: "wrong password" });
  }
  next();
}

// --- status / config health ---------------------------------------------

app.get("/api/status", (_req:any, res:any) => {
  let loopStatus = null;
  if (fs.existsSync(CONFIG.loopStatusPath)) {
    try {
      loopStatus = JSON.parse(fs.readFileSync(CONFIG.loopStatusPath, "utf8"));
    } catch {
      loopStatus = null;
    }
  }
  const configHealth = {
    openaiKey: Boolean(process.env.OPENAI_API_KEY),
    geminiKey: CONFIG.geminiEnabled,
    delphiConfigured: Boolean(process.env.DELPHI_RPC_URL || process.env.DELPHI_PRIVATE_KEY),
  };
  res.json({ dryRun: getDryRun(), loopStatus, configHealth });
});

app.post("/api/dryrun", (req, res) => {
  const { dryRun } = req.body ?? {};
  if (typeof dryRun !== "boolean") {
    return res.status(400).json({ error: "body must be { dryRun: boolean }" });
  }
  res.json(setDryRun(dryRun));
});

app.get("/api/balances", async (_req: any, res: any) => {
  const result: Record<string, unknown> = {};

  try {
    const { balance, decimals } = await withDelphiRetry(() => client.getErc20BalanceWithDecimals(), {
      label: "getErc20BalanceWithDecimals",
      maxRetries: 2,
    });
    result.sdkToken = { balance: balance.toString(), decimals, human: Number(balance) / 10 ** decimals };
  } catch (err) {
    result.sdkToken = { error: err instanceof Error ? err.message : String(err) };
  }

  const walletAddress = await resolveWalletAddress(client);
  result.walletAddress = walletAddress;

  try {
    const wei: bigint = await withDelphiRetry(() => (client as any).getEthBalance(), {
      label: "getEthBalance",
      maxRetries: 2,
    });
    result.gas = { wei: wei.toString(), human: Number(wei) / 1e18 };
  } catch (sdkErr) {
    if (walletAddress && process.env.DELPHI_RPC_URL) {
      try {
        const gas = await getNativeBalance(walletAddress);
        result.gas = { wei: gas.wei.toString(), human: gas.human };
      } catch (err) {
        result.gas = { error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      result.gas = {
        error: `client.getEthBalance() failed (${sdkErr instanceof Error ? sdkErr.message : sdkErr}) and no DELPHI_RPC_URL fallback configured`,
      };
    }
  }

  const tokenAddress = getCompetitionTokenAddress();
  result.competitionTokenAddress = tokenAddress;
  if (tokenAddress) {
    if (!walletAddress) {
      result.competitionToken = { error: "wallet address unresolved" };
    } else if (!process.env.DELPHI_RPC_URL) {
      result.competitionToken = {
        error: "DELPHI_RPC_URL not configured — needed to read an arbitrary token contract's balance",
      };
    } else {
      try {
        const codeExists = await hasContractCode(tokenAddress);
        if (!codeExists) {
          const chainId = await getChainId().catch(() => null);
          result.competitionToken = {
            error:
              `no contract found at ${tokenAddress} on chainId=${chainId ?? "unknown"} — ` +
              `DELPHI_RPC_URL is likely pointing at a different network than where this token lives. ` +
              `Compare it against the network MetaMask shows a balance for this token on.`,
            noContractOnThisChain: true,
          };
        } else {
          const [raw, onChainDecimals] = await Promise.all([
            getErc20Balance(tokenAddress, walletAddress),
            CONFIG.competitionTokenDecimals !== null ? Promise.resolve(null) : getErc20Decimals(tokenAddress),
          ]);
          const decimals = CONFIG.competitionTokenDecimals ?? onChainDecimals ?? 18;
          result.competitionToken = {
            balance: raw.toString(),
            decimals,
            human: Number(raw) / 10 ** decimals,
            decimalsSource: CONFIG.competitionTokenDecimals !== null ? "env override" : "on-chain",
          };
        }
      } catch (err) {
        result.competitionToken = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  res.json(result);
});

app.get("/api/token-address", (_req: any, res: any) => {
  res.json({ address: getCompetitionTokenAddress() });
});

app.post("/api/token-address", (req: any, res: any) => {
  const { address } = req.body ?? {};
  const isValidAddress = typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address);
  if (address !== null && !isValidAddress) {
    return res
      .status(400)
      .json({ error: "body must be { address: '0x' + 40 hex chars } or { address: null } to clear" });
  }
  res.json(setCompetitionTokenAddress(address));
});

// --- key pool / nodes -------------------------------------------------------

app.get("/api/nodes", (_req: any, res: any) => {
  res.json({ nodes: getAllNodesView(), summary: getPoolSummary() });
});

app.post("/api/nodes/health-check", async (_req: any, res: any) => {
  try {
    const result = await runHealthCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- positions (mark-to-market) --------------------------------------------

app.get("/api/positions", async (_req: any, res: any) => {
  try {
    const positions = await getOpenPositions(client);
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
    res.json({ positions, count: positions.length, totalUnrealizedPnl });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Same 3% default as scripts/sell-positions.ts. Hardcoded rather than
// client-supplied — a slippage tolerance is a safety parameter, not
// something a button click should be able to override.
const SELL_SLIPPAGE_BPS = 300n;

app.post("/api/positions/quote-sell", async (req: any, res: any) => {
  try {
    const { marketId, outcomeIdx, sharesIn } = req.body ?? {};
    if (typeof marketId !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(marketId)) {
      return res.status(400).json({ error: "marketId must be a 0x… address" });
    }
    if (!Number.isInteger(outcomeIdx) || outcomeIdx < 0) {
      return res.status(400).json({ error: "outcomeIdx must be a non-negative integer" });
    }
    let sharesInRaw: bigint;
    try {
      sharesInRaw = BigInt(String(sharesIn));
    } catch {
      return res.status(400).json({ error: "sharesIn must be a bigint-parseable string" });
    }
    if (sharesInRaw <= 0n) {
      return res.status(400).json({ error: "sharesIn must be > 0" });
    }

    const quote = await withDelphiRetry(
      () =>
        client.quoteSell({
          marketAddress: marketId as `0x${string}`,
          outcomeIdx,
          sharesIn: sharesInRaw,
        }),
      { label: `quoteSell(${marketId})`, maxRetries: 2 }
    );

    const decimals = CONFIG.competitionTokenDecimals ?? 6;

    res.json({
      tokensOut: quote.tokensOut.toString(),
      tokensOutHuman: Number(quote.tokensOut) / 10 ** decimals,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/positions/sell", requireDashboardPassword, async (req: any, res: any) => {
  try {
    const { marketId, outcomeIdx, sharesIn } = req.body ?? {};
    if (typeof marketId !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(marketId)) {
      return res.status(400).json({ error: "marketId must be a 0x… address" });
    }
    if (!Number.isInteger(outcomeIdx) || outcomeIdx < 0) {
      return res.status(400).json({ error: "outcomeIdx must be a non-negative integer" });
    }

    let sharesInRaw: bigint;
    try {
      sharesInRaw = BigInt(String(sharesIn));
    } catch {
      return res.status(400).json({ error: "sharesIn must be a bigint-parseable string" });
    }

    if (sharesInRaw <= 0n) {
      return res.status(400).json({ error: "sharesIn must be > 0" });
    }

    // Re-quote fresh at execute time rather than trusting a quote the
    // client may have fetched a few seconds ago — the book can move
    // between "show me a quote" and "confirm". minTokensOut is derived
    // from THIS quote, slippage applied server-side.
    const quote = await withDelphiRetry(
      () =>
        client.quoteSell({
          marketAddress: marketId as `0x${string}`,
          outcomeIdx,
          sharesIn: sharesInRaw,
        }),
      { label: `quoteSell(sell:${marketId})`, maxRetries: 2 }
    );

    const minTokensOut =
      quote.tokensOut - (quote.tokensOut * SELL_SLIPPAGE_BPS) / 10_000n;

    const result = await withDelphiRetry(
      () =>
        client.sellShares({
          marketAddress: marketId as `0x${string}`,
          outcomeIdx,
          sharesIn: sharesInRaw,
          minTokensOut,
        }),
      { label: `sellShares(${marketId})`, maxRetries: 1 }
    );

    const decimals = CONFIG.competitionTokenDecimals ?? 6;

    res.json({
      transactionHash: result.transactionHash,
      tokensOut: quote.tokensOut.toString(),
      tokensOutHuman: Number(quote.tokensOut) / 10 ** decimals,
      minTokensOut: minTokensOut.toString(),
      minTokensOutHuman: Number(minTokensOut) / 10 ** decimals,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- markets: quote/buy -----------------------------------------------

// Same defaults as scripts/buy-position.ts.
const BUY_SLIPPAGE_BPS = 150n; // 1.5%

/**
 * Shrink-to-spend-cap + shrink-to-impact-cap quoteBuy wrapper, ported
 * from buy-position.ts's inline logic in main() — lives here so it's one
 * implementation shared by both the quote and execute paths instead of
 * duplicated in dashboard JS.
 */
async function safeQuoteBuy(params: {
  marketAddress: `0x${string}`;
  outcomeIdx: number;
  sharesOut: bigint;
  label: string;
}): Promise<
  | { ok: true; quote: Awaited<ReturnType<typeof client.quoteBuy>> }
  | { ok: false; reason: string }
> {
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
    return { ok: false, reason: `quote reverted on-chain: ${msg.slice(0, 200)}` };
  }
}

async function computeBuyQuote(params: {
  marketId: string;
  outcomeIdx: number;
  amountTokens: number;
}): Promise<
  | {
      ok: true;
      entryPrice: number;
      decimals: number;
      sharesOut: bigint;
      tokensIn: bigint;
      impactPct: number;
      question: string;
      outcomes: string[];
    }
  | { ok: false; reason: string }
> {
  const { marketId, outcomeIdx, amountTokens } = params;

  const market = await withDelphiRetry(
    () => client.getMarket({ id: marketId, pricesAndImpliedProbabilities: true } as any),
    { label: `getMarket(${marketId})`, maxRetries: 2 }
  );
  if (!market) return { ok: false, reason: "market not found" };

  const status = (market as any).status;
  if (status !== "open") return { ok: false, reason: `market status is "${status}", not "open"` };

  const outcomes: string[] = (market as any).outcomes ?? (market as any).metadata?.outcomes ?? ["Yes", "No"];
  if (outcomeIdx < 0 || outcomeIdx >= outcomes.length) {
    return { ok: false, reason: `outcomeIdx ${outcomeIdx} out of range for ${outcomes.length} outcomes` };
  }
  const question = (market as any).question ?? (market as any).metadata?.question ?? "";

  const rawProbs = (market as any).spotImpliedProbabilities as unknown[] | undefined;
  let entryPrice = 0.5;
  if (rawProbs && rawProbs[outcomeIdx] !== undefined) {
    const n = Number(rawProbs[outcomeIdx]);
    if (Number.isFinite(n)) entryPrice = n > 1.5 ? n / 1e18 : n;
  }
  entryPrice = Math.max(entryPrice, 0.01);

  const decimals = CONFIG.competitionTokenDecimals ?? 6;
  const maxTokensIn = BigInt(Math.floor(amountTokens * 10 ** decimals));
  const maxImpactPct = CONFIG.maxPriceImpactPct;

  const desiredShares = amountTokens / entryPrice;
  const sharesOut = BigInt(Math.floor(desiredShares * 1e18));

  const quoteResult = await safeQuoteBuy({
    marketAddress: marketId as `0x${string}`,
    outcomeIdx,
    sharesOut,
    label: `quoteBuy(${marketId})`,
  });
  if (!quoteResult.ok) return { ok: false, reason: quoteResult.reason };

  let finalQuote = quoteResult.quote;
  let finalSharesOut = sharesOut;

  const impactPctFor = (q: { tokensIn: bigint }, shares: bigint): number => {
    const costPerShare = Number(q.tokensIn) / 10 ** decimals / (Number(shares) / 1e18);
    return entryPrice > 0 ? (costPerShare - entryPrice) / entryPrice : 0;
  };

  // — spend-cap resize —
  if (finalQuote.tokensIn > maxTokensIn) {
    const scale = Number(maxTokensIn) / Number(finalQuote.tokensIn);
    const scaledShares = BigInt(Math.floor(Number(sharesOut) * scale * 0.98));
    if (scaledShares <= 0n) {
      return { ok: false, reason: `quoted cost exceeds spend cap (${amountTokens} tokens) even at minimal size` };
    }
    const retry = await safeQuoteBuy({
      marketAddress: marketId as `0x${string}`,
      outcomeIdx,
      sharesOut: scaledShares,
      label: `quoteBuy(retry:${marketId})`,
    });
    if (!retry.ok) return { ok: false, reason: retry.reason };
    finalQuote = retry.quote;
    finalSharesOut = scaledShares;
    if (finalQuote.tokensIn > maxTokensIn) {
      return { ok: false, reason: "quoted cost still exceeds spend cap after resize" };
    }
  }

  // — price-impact cap —
  let impactPct = impactPctFor(finalQuote, finalSharesOut);
  if (impactPct > maxImpactPct) {
    const scale = maxImpactPct / impactPct;
    const shrunkShares = BigInt(Math.floor(Number(finalSharesOut) * scale * 0.98));
    const minSharesFixedPoint = BigInt(Math.floor(CONFIG.minTradeShares * 1e18));
    if (shrunkShares <= 0n || shrunkShares < minSharesFixedPoint) {
      return {
        ok: false,
        reason: `price impact ${(impactPct * 100).toFixed(1)}% exceeds ${(maxImpactPct * 100).toFixed(0)}% cap even at minimal size`,
      };
    }
    const retry = await safeQuoteBuy({
      marketAddress: marketId as `0x${string}`,
      outcomeIdx,
      sharesOut: shrunkShares,
      label: `quoteBuy(impact-retry:${marketId})`,
    });
    if (!retry.ok) return { ok: false, reason: retry.reason };
    const shrunkImpactPct = impactPctFor(retry.quote, shrunkShares);
    if (shrunkImpactPct > maxImpactPct || retry.quote.tokensIn > maxTokensIn) {
      return { ok: false, reason: `price impact still ${(shrunkImpactPct * 100).toFixed(1)}% after resize, exceeds cap` };
    }
    finalQuote = retry.quote;
    finalSharesOut = shrunkShares;
    impactPct = shrunkImpactPct;
  }

  return {
    ok: true,
    entryPrice,
    decimals,
    sharesOut: finalSharesOut,
    tokensIn: finalQuote.tokensIn,
    impactPct,
    question,
    outcomes,
  };
};

app.post("/api/markets/quote-buy", async (req: any, res: any) => {
  try {
    const { marketId, outcomeIdx, amountTokens } = req.body ?? {};
    if (typeof marketId !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(marketId)) {
      return res.status(400).json({ error: "marketId must be a 0x… address" });
    }
    if (!Number.isInteger(outcomeIdx) || outcomeIdx < 0) {
      return res.status(400).json({ error: "outcomeIdx must be a non-negative integer" });
    }
    const amount = Number(amountTokens);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amountTokens must be a positive number" });
    }

    const result = await computeBuyQuote({ marketId, outcomeIdx, amountTokens: amount });
    if (!result.ok) return res.status(422).json({ error: result.reason });

    res.json({
      sharesOut: result.sharesOut.toString(),
      tokensIn: result.tokensIn.toString(),
      tokensInHuman: Number(result.tokensIn) / 10 ** result.decimals,
      impactPct: result.impactPct,
      entryPrice: result.entryPrice,
      question: result.question,
      outcomeLabel: result.outcomes[outcomeIdx] ?? `#${outcomeIdx}`,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/markets/buy", requireDashboardPassword, async (req: any, res: any) => {
  try {
    const { marketId, outcomeIdx, amountTokens } = req.body ?? {};
    if (typeof marketId !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(marketId)) {
      return res.status(400).json({ error: "marketId must be a 0x… address" });
    }
    if (!Number.isInteger(outcomeIdx) || outcomeIdx < 0) {
      return res.status(400).json({ error: "outcomeIdx must be a non-negative integer" });
    }
    const amount = Number(amountTokens);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amountTokens must be a positive number" });
    }

    // Re-derive the same shrink-capped quote fresh at execute time
    // rather than trusting a quote the client fetched a moment earlier.
    const quoted = await computeBuyQuote({ marketId, outcomeIdx, amountTokens: amount });
    if (!quoted.ok) return res.status(422).json({ error: quoted.reason });

    const walletAddress = await resolveWalletAddress(client);
    if (!walletAddress) {
      return res.status(500).json({ error: "could not resolve wallet address" });
    }
    const tokenAddress = getCompetitionTokenAddress();
    if (!tokenAddress) {
      return res.status(400).json({ error: "competition token address not configured — set it in Config first" });
    }
    const rawBalance = await getErc20Balance(tokenAddress, walletAddress);
    if (quoted.tokensIn > rawBalance) {
      return res.status(422).json({
        error: `insufficient balance: quote wants ${Number(quoted.tokensIn) / 10 ** quoted.decimals} tokens, wallet holds ${Number(rawBalance) / 10 ** quoted.decimals}`,
      });
    }

    const maxTokensInRaw = quoted.tokensIn + (quoted.tokensIn * BUY_SLIPPAGE_BPS) / 10_000n;
    const spendCapRaw = BigInt(Math.floor(amount * 10 ** quoted.decimals));
    const maxTokensIn = maxTokensInRaw > spendCapRaw ? spendCapRaw : maxTokensInRaw;

    await withDelphiRetry(
      () =>
        client.ensureTokenApproval({
          marketAddress: marketId as `0x${string}`,
          minimumAmount: maxTokensIn,
        }),
      { label: `ensureTokenApproval(${marketId})`, maxRetries: 2 }
    );

    const result = await withDelphiRetry(
      () =>
        client.buyShares({
          marketAddress: marketId as `0x${string}`,
          outcomeIdx,
          sharesOut: quoted.sharesOut,
          maxTokensIn,
        }),
      { label: `buyShares(${marketId})`, maxRetries: 1 }
    );

    const quotedTokensHuman = Number(quoted.tokensIn) / 10 ** quoted.decimals;
    const sharesHuman = Number(quoted.sharesOut) / 1e18;

    // Manual-trade receipt so this shows up in the dashboard's Open
    // Positions panel and redeem.ts picks it up like any other trade —
    // same shape as scripts/buy-position.ts builds.
    const receipt: Receipt = {
      ts: new Date().toISOString(),
      marketId,
      question: quoted.question,
      category: undefined,
      outcomes: quoted.outcomes,
      rawPrice: quoted.outcomes.map((_, i) => (i === outcomeIdx ? quoted.entryPrice : 0.5)),
      syntheticPrice: false,
      signals: { llm: null, gemini: null, polymarket: null },
      disagreement: null,
      blendedProbs: quoted.outcomes.map((_, i) => (i === outcomeIdx ? 1 : 0)),
      confidence: 0,
      decision: "trade",
      outcomeIdx,
      edge: 0,
      thresholdUsed: 0,
      size: quotedTokensHuman,
      execution: {
        txHash: result.transactionHash,
        quotedTokensIn: quotedTokensHuman,
        sharesOut: quoted.sharesOut.toString(),
        priceImpactPct: quoted.impactPct,
      },
      skipReason: "manual buy via dashboard",
    };
    appendReceipt(receipt);

    res.json({
      transactionHash: result.transactionHash,
      sharesOut: quoted.sharesOut.toString(),
      tokensIn: quoted.tokensIn.toString(),
      sharesHuman,
      tokensInHuman: quotedTokensHuman,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- markets --------------------------------------------------------------

app.get("/api/markets/open", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const { markets } = await withDelphiRetry(
      () =>
        client.listMarkets({
          status: "open" as any,
          limit,
          orderBy: "liquidity" as any,
          pricesAndImpliedProbabilities: true,
        }),
      { label: "listMarkets(open)", maxRetries: 2 }
    );
    const list = markets ?? [];

    const thinCutoff = Math.ceil(list.length * (1 - CONFIG.thinLiquidityBottomFraction));
    const withLiquidity = list.map((m: any, i: number) => ({
      ...m,
      liquidityRank: i + 1,
      liquidityRankOf: list.length,
      isThinMarket: list.length > 0 && i >= thinCutoff,
      // Confirmed absent from this API version (see marketFields.ts) —
      // kept for forward compatibility, always null on this build.
      liquidityTokens: extractLiquidity(m),
      volumeTokens: extractVolume(m),
      // New fields
      resolvesAt: extractResolvesAt(m),
      settlesAt: extractSettlesAt(m),
      msUntilResolve: msUntilResolve(m),
      tradingFeePct: extractTradingFeePct(m),
      dataSources: extractDataSources(m),
      marketUrl: `https://competition.delphi.fyi/markets/${m.id}`,
      appMarketId: extractAppMarketId(m),
    }));

    res.json({ markets: withLiquidity });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- receipts / summary ----------------------------------------------------

app.get("/api/receipts", async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const type = req.query.type as string | undefined;
  let receipts = await readReceipts(limit * 3);
  if (type === "trade" || type === "skip") {
    receipts = receipts.filter((r) => r.decision === type);
  }
  res.json({ receipts: receipts.slice(0, limit) });
});

app.get("/api/summary", (_req, res) => {
  res.json(readPinnedSummary() ?? { note: "no summary yet — run the loop or a backtest first" });
});

app.post("/api/settlement/check", async (_req: any, res: any) => {
  try {
    const result = await checkSettledOutcomes(client);
    const summary = await recomputeSummary();
    res.json({ ...result, summary });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- backtest ---------------------------------------------------------------

app.post("/api/backtest/run", async (req, res) => {
  try {
    const maxMarkets = Number(req.body?.maxMarkets ?? 10);
    const result = await runBacktest({ maxMarkets });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/backtest/history", (_req, res) => {
  res.json({ runs: listBacktestRuns(30) });
});

app.get("/api/backtest/history/:file", (req, res) => {
  const run = readBacktestRun(req.params.file);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json(run);
});

// --- checkpoint (persist data/ across redeploys) ---------------------------

app.post("/api/checkpoint", async (req: any, res: any) => {
  const expected = process.env.CHECKPOINT_SECRET;
  if (expected && req.header("x-checkpoint-secret") !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const result = await runCheckpointScript();
  if (!result.ok) {
    console.error("[checkpoint] failed:", result.output);
    return res.status(500).json({ ok: false, error: "checkpoint script failed", output: result.output });
  }
  res.json({ ok: true, output: result.output });
});

app.listen(CONFIG.port, () => {
  console.log(`Lazy Falcon dashboard API listening on http://localhost:${CONFIG.port}`);
  console.log(`Dashboard: http://localhost:${CONFIG.port}/dashboard.html`);
});
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
      marketUrl: extractMarketUrl(m),
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
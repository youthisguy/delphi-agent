import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { CONFIG, getDryRun, setDryRun, getCompetitionTokenAddress, setCompetitionTokenAddress } from "./config.js";
import { readReceipts, readPinnedSummary } from "./journal.js";
import { runBacktest, listBacktestRuns, readBacktestRun } from "./backtest.js";
import { getAllNodesView, getPoolSummary, runHealthCheck } from "./keyPool.js";
import { getNativeBalance, getErc20Balance, getErc20Decimals } from "./chainRead.js";

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

const client = new DelphiClient();

/**
 * NOTE ON SDK FIELD NAME: the exact property the SDK exposes the trading
 * wallet's address under wasn't included in what you shared, so this
 * tries a few common shapes and falls back to an explicit WALLET_ADDRESS
 * env var. Same caveat as redeem.ts's TODO on the SDK's redeem method —
 * check @gensyn-ai/gensyn-delphi-sdk's actual exports and, if none of
 * these match, just set WALLET_ADDRESS in .env.
 */
function resolveWalletAddress(): string | null {
  const fromClient =
    (client as any).walletAddress ??
    (client as any).address ??
    (client as any).account?.address ??
    (client as any).signer?.address ??
    null;
  return process.env.WALLET_ADDRESS || fromClient || null;
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
    delphiConfigured: Boolean(process.env.DELPHI_RPC_URL || process.env.DELPHI_PRIVATE_KEY), // adjust to whatever env vars the SDK actually needs
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

  // SDK's own token (the test/competition token it's currently wired to).
  // Kept as-is so nothing breaks before the real CA is known.
  try {
    const { balance, decimals } = await client.getErc20BalanceWithDecimals();
    result.sdkToken = { balance: balance.toString(), decimals, human: Number(balance) / 10 ** decimals };
  } catch (err) {
    result.sdkToken = { error: err instanceof Error ? err.message : String(err) };
  }

  const walletAddress = resolveWalletAddress();
  result.walletAddress = walletAddress;

  if (!walletAddress) {
    result.gas = { error: "wallet address unresolved — set WALLET_ADDRESS in .env" };
  } else if (!process.env.DELPHI_RPC_URL) {
    result.gas = { error: "DELPHI_RPC_URL not configured" };
  } else {
    try {
      const gas = await getNativeBalance(walletAddress);
      result.gas = { wei: gas.wei.toString(), human: gas.human };
    } catch (err) {
      result.gas = { error: err instanceof Error ? err.message : String(err) };
    }

    const tokenAddress = getCompetitionTokenAddress();
    result.competitionTokenAddress = tokenAddress;
    if (tokenAddress) {
      try {
        const [raw, decimals] = await Promise.all([
          getErc20Balance(tokenAddress, walletAddress),
          getErc20Decimals(tokenAddress),
        ]);
        result.competitionToken = { balance: raw.toString(), decimals, human: Number(raw) / 10 ** decimals };
      } catch (err) {
        result.competitionToken = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  res.json(result);
});

// Competition token contract address isn't known yet — this lets you set
// it from the dashboard the moment it's announced, no redeploy needed.
// GET returns the currently configured address (or null if unset).
app.get("/api/token-address", (_req: any, res: any) => {
  res.json({ address: getCompetitionTokenAddress() });
});

// POST { address: "0x..." } to set it, or { address: null } to clear back
// to "unknown" (e.g. if the CA changes mid-competition).
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

// Current status of every configured OpenAI/Gemini key ("node"), as last
// updated by live forecast calls or the manual health check below.
app.get("/api/nodes", (_req: any, res: any) => {
  res.json({ nodes: getAllNodesView(), summary: getPoolSummary() });
});

// Manual / periodic verification: actively pings every node so the
// dashboard reflects reality even for nodes that haven't been used by a
// live forecast recently. Does not affect runtime rotation directly —
// that happens automatically on every forecast call via keyPool.ts.
app.post("/api/nodes/health-check", async (_req: any, res: any) => {
  try {
    const result = await runHealthCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- markets --------------------------------------------------------------

app.get("/api/markets/open", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const { markets } = await client.listMarkets({
      status: "open" as any,
      limit,
      pricesAndImpliedProbabilities: true,
    });
    res.json({ markets: markets ?? [] });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- receipts / summary ----------------------------------------------------

app.get("/api/receipts", async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const type = req.query.type as string | undefined; // "trade" | "skip"
  let receipts = await readReceipts(limit * 3); // over-fetch a bit before filtering
  if (type === "trade" || type === "skip") {
    receipts = receipts.filter((r) => r.decision === type);
  }
  res.json({ receipts: receipts.slice(0, limit) });
});

app.get("/api/summary", (_req, res) => {
  res.json(readPinnedSummary() ?? { note: "no summary yet — run the loop or a backtest first" });
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

app.listen(CONFIG.port, () => {
  console.log(`Lazy Falcon dashboard API listening on http://localhost:${CONFIG.port}`);
  console.log(`Dashboard: http://localhost:${CONFIG.port}/dashboard.html`);
});
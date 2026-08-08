import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { CONFIG, getDryRun, setDryRun, getCompetitionTokenAddress, setCompetitionTokenAddress } from "./config.js";
import { readReceipts, readPinnedSummary } from "./journal.js";
import { runBacktest, listBacktestRuns, readBacktestRun } from "./backtest.js";
import { getAllNodesView, getPoolSummary, runHealthCheck } from "./keyPool.js";
import { getNativeBalance, getErc20Balance, getErc20Decimals, hasContractCode, getChainId } from "./chainRead.js";

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

const client = new DelphiClient();

/**
 * Wallet address resolution. check-setup.ts shows the SDK exposes
 * client.getSigner() -> { address, ... } directly — prefer that. The old
 * guesswork against (client as any).walletAddress/.address/etc. is kept
 * only as a last-resort fallback in case getSigner() isn't available on
 * whatever SDK version is installed, plus an explicit WALLET_ADDRESS env
 * override for manual pinning.
 */
async function resolveWalletAddress(): Promise<string | null> {
  if (process.env.WALLET_ADDRESS) return process.env.WALLET_ADDRESS;
  try {
    const signer = await (client as any).getSigner?.();
    if (signer?.address) return signer.address;
  } catch {
    /* fall through to legacy guesses */
  }
  const fromClient =
    (client as any).walletAddress ??
    (client as any).address ??
    (client as any).account?.address ??
    (client as any).signer?.address ??
    null;
  return fromClient;
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

  const walletAddress = await resolveWalletAddress();
  result.walletAddress = walletAddress;

  // Gas (native ETH) — per check-setup.ts, client.getEthBalance() works
  // straight out of the SDK's own RPC connection, no separate
  // DELPHI_RPC_URL needed. Only fall back to the raw JSON-RPC path in
  // chainRead.ts if that SDK method isn't available for some reason.
  try {
    const wei: bigint = await (client as any).getEthBalance();
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

  // Competition token, once its CA is known. The SDK's
  // getErc20BalanceWithDecimals() only reads whatever token it's
  // internally wired to (no address param) — reading an arbitrary CA
  // still requires a raw eth_call, which needs DELPHI_RPC_URL.
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
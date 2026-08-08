/**
 * Minimal read-only JSON-RPC helpers, used for two things the Delphi SDK
 * doesn't expose directly:
 *  - native gas (ETH) balance of the trading wallet
 *  - balance/decimals of the competition token, once its contract address
 *    is known (see config.ts's competitionTokenAddress)
 */
import { fetchWithTimeout } from "./fetchWithTimeout.js";

/**
 * Resolves the trading wallet's address, trying the explicit env override
 * first, then falling back to whatever the SDK client exposes. Shared by
 * server.ts (dashboard balance display) and index.ts (live sizing/budget
 * checks against the competition token) so both read the same address.
 */
export async function resolveWalletAddress(client: any): Promise<string | null> {
  if (process.env.WALLET_ADDRESS) return process.env.WALLET_ADDRESS;
  try {
    const signer = await client.getSigner?.();
    if (signer?.address) return signer.address;
  } catch {
    /* fall through to legacy guesses */
  }
  return (
    client.walletAddress ??
    client.address ??
    client.account?.address ??
    client.signer?.address ??
    null
  );
}

const RPC_URL = process.env.DELPHI_RPC_URL;

async function rpcCall(method: string, params: unknown[]): Promise<any> {
  if (!RPC_URL) throw new Error("DELPHI_RPC_URL not configured");
  const res = await fetchWithTimeout(
    RPC_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    15_000
  );
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const data: any = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error?.message ?? JSON.stringify(data.error)}`);
  return data.result;
}

export async function getChainId(): Promise<number> {
  const hex = await rpcCall("eth_chainId", []);
  return parseInt(hex, 16);
}

export async function getNativeBalance(address: string): Promise<{ wei: bigint; human: number }> {
  const hex = await rpcCall("eth_getBalance", [address, "latest"]);
  const wei = BigInt(hex);
  return { wei, human: Number(wei) / 1e18 };
}

/**
 * Checks whether an address has contract bytecode deployed. eth_call
 * against an address with no code doesn't revert — it just returns empty
 * bytes, which balanceOf()/decimals() below silently read as "0". This
 * makes it possible to tell "confirmed zero balance" apart from
 * "this CA has no contract deployed yet" (e.g. a competition token
 * address announced ahead of launch, before it's actually live).
 */
export async function hasContractCode(address: string): Promise<boolean> {
  const code = await rpcCall("eth_getCode", [address, "latest"]);
  return typeof code === "string" && code !== "0x" && code.length > 2;
}

function encodeAddressParam(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** balanceOf(address) — selector 0x70a08231 */
export async function getErc20Balance(tokenAddress: string, walletAddress: string): Promise<bigint> {
  const data = "0x70a08231" + encodeAddressParam(walletAddress);
  const result = await rpcCall("eth_call", [{ to: tokenAddress, data }, "latest"]);
  if (!result || result === "0x") {
    const hasCode = await hasContractCode(tokenAddress).catch(() => null);
    if (hasCode === false) {
      const chainId = await rpcCall("eth_chainId", []).catch(() => null);
      throw new Error(
        `no contract found at ${tokenAddress} on chainId=${chainId ?? "unknown"} — ` +
          `DELPHI_RPC_URL is likely pointing at a different network than the one this token ` +
          `lives on. Check DELPHI_RPC_URL's chain against the network MetaMask is showing the balance on.`
      );
    }
    return 0n; // contract confirmed present, balance genuinely 0
  }
  return BigInt(result);
}

/** decimals() — selector 0x313ce567. Falls back to 18 (the overwhelming
 * norm) if the call fails, but logs it — a silent fallback here previously
 * masked real decimals mismatches (e.g. a 6-decimal token silently read
 * as 18, understating the balance by a factor of 10^12). */
export async function getErc20Decimals(tokenAddress: string): Promise<number> {
  try {
    const result = await rpcCall("eth_call", [{ to: tokenAddress, data: "0x313ce567" }, "latest"]);
    if (!result || result === "0x") {
      console.warn(`[chainRead] decimals() on ${tokenAddress} returned empty — falling back to 18`);
      return 18;
    }
    return parseInt(result, 16);
  } catch (err) {
    console.warn(
      `[chainRead] decimals() call failed on ${tokenAddress} — falling back to 18:`,
      err instanceof Error ? err.message : err
    );
    return 18;
  }
}
/**
 * Minimal read-only JSON-RPC helpers, used for two things the Delphi SDK
 * doesn't expose directly:
 *  - native gas (ETH) balance of the trading wallet
 *  - balance/decimals of the competition token, once its contract address
 *    is known (it isn't yet — see config.ts's competitionTokenAddress)
 */

const RPC_URL = process.env.DELPHI_RPC_URL;

async function rpcCall(method: string, params: unknown[]): Promise<any> {
  if (!RPC_URL) throw new Error("DELPHI_RPC_URL not configured");
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const data: any = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error?.message ?? JSON.stringify(data.error)}`);
  return data.result;
}

export async function getNativeBalance(address: string): Promise<{ wei: bigint; human: number }> {
  const hex = await rpcCall("eth_getBalance", [address, "latest"]);
  const wei = BigInt(hex);
  return { wei, human: Number(wei) / 1e18 };
}

function encodeAddressParam(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** balanceOf(address) — selector 0x70a08231 */
export async function getErc20Balance(tokenAddress: string, walletAddress: string): Promise<bigint> {
  const data = "0x70a08231" + encodeAddressParam(walletAddress);
  const result = await rpcCall("eth_call", [{ to: tokenAddress, data }, "latest"]);
  if (!result || result === "0x") return 0n;
  return BigInt(result);
}

/** decimals() — selector 0x313ce567. Falls back to 18 (the overwhelming
 * norm) if the call fails rather than blowing up the whole balances panel. */
export async function getErc20Decimals(tokenAddress: string): Promise<number> {
  try {
    const result = await rpcCall("eth_call", [{ to: tokenAddress, data: "0x313ce567" }, "latest"]);
    if (!result || result === "0x") return 18;
    return parseInt(result, 16);
  } catch {
    return 18;
  }
}

/**
 * check-setup.ts
 *
 * Sanity-checks your Delphi Agent Arena config before you write any trading
 * logic. Verifies:
 *   1. .env is loaded and required vars are present
 *   2. The signer resolves to a wallet address
 *   3. Gas (ETH) balance
 *   4. Competition token balance
 *   5. A round-trip call to listMarkets() against the API
 *
 * Run with: npm run check-setup
 */
import "dotenv/config";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";

const REQUIRED_ENV_VARS = [
  "DELPHI_NETWORK",
  "DELPHI_SIGNER_TYPE",
  "WALLET_PRIVATE_KEY",
  "DELPHI_API_ACCESS_KEY",
];

function checkEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("Missing required environment variables:");
    for (const key of missing) console.error(`  - ${key}`);
    console.error("\nCopy .env.example to .env and fill in your values.");
    process.exit(1);
  }
}

async function main() {
  console.log("Checking Delphi Agent Arena setup...\n");
  checkEnv();

  const client = new DelphiClient();

  // 1. Signer / wallet address
  const signer = await client.getSigner();
  console.log(`Wallet address:      ${signer.address}`);

  // 2. Gas balance
  const ethBalance = await client.getEthBalance();
  console.log(`ETH (gas) balance:   ${ethBalance.toString()} wei`);
  if (ethBalance === 0n) {
    console.warn(
      "  Warning: zero ETH balance. You'll need gas before you can trade.\n" +
        "  Use the Alchemy Gensyn Testnet faucet or bridge Sepolia ETH."
    );
  }

  // 3. Competition token (collateral) balance
  const { balance, decimals } = await client.getErc20BalanceWithDecimals();
  const human = Number(balance) / 10 ** decimals;
  console.log(`Collateral balance:  ${human} (raw: ${balance.toString()})`);

  // 4. Round-trip API check: list markets
  console.log("\nFetching markets...");
  const { markets } = await client.listMarkets({ limit: 5 });
  if (!markets || markets.length === 0) {
    console.log(
      "  No markets returned yet. That's expected before the Competition App\n" +
        "  opens on August 10 — this still confirms your API key and network work."
    );
  } else {
    console.log(`  Found ${markets.length} market(s):`);
    for (const m of markets) {
      console.log(`  - [${m.category}] ${m.id} (status: ${m.status})`);
    }
  }

  console.log("\nSetup check complete. Signer, RPC, and API key are wired up correctly.");
}

main().catch((err) => {
  console.error("\nSetup check failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

# delphi-agent

Starter project for the Delphi Agent Arena competition (Gensyn), verified against
`@gensyn-ai/gensyn-delphi-sdk` v2.1.0.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Var | Value |
|---|---|
| `WALLET_PRIVATE_KEY` | Private key of the wallet you registered on DoraHacks |
| `DELPHI_API_ACCESS_KEY` | Generate at https://delphi-api-access.gensyn.ai/ |
| `DELPHI_NETWORK` / `DELPHI_SIGNER_TYPE` | Already set correctly (`competition-testnet` / `private_key`) |

Then verify the wiring:

```bash
npm run check-setup
```

Prints your wallet address, ETH (gas) balance, collateral token balance, and
attempts to list markets — a full round-trip check of signer + RPC + API key.

**Note:** markets will likely return empty until the Competition App opens on
**August 10** — that's expected, not a bug. Everything else should resolve.

## Project layout

```
check-setup.ts   — one-off wiring/sanity check (npm run check-setup)
src/index.ts     — the actual trading loop skeleton (npm start)
```

## Writing your strategy

All the logic you need to change lives in `decide()` in `src/index.ts`. It
receives a `Market` (with `spotPrices` / `spotImpliedProbabilities` when
`pricesAndImpliedProbabilities: true` is requested) and returns either a
`TradeDecision` or `null` to skip. Everything downstream (quoting, approval,
execution) is already wired up.

The share-sizing logic in `tradeOnMarket()` is intentionally simple (a 1:1
trial-share guess scaled by your quote) — swap in your own sizing/slippage
logic once you have a real strategy.

## Gotchas already handled here

- The SDK is **ESM-only** — `package.json` has `"type": "module"` set, or
  Node's module resolution breaks.
- Config env var names are exactly: `DELPHI_NETWORK`, `DELPHI_SIGNER_TYPE`,
  `WALLET_PRIVATE_KEY`, `DELPHI_API_ACCESS_KEY` (verified against the SDK's
  own source, not just the docs).
- `npm audit` will flag a moderate/high vuln in `@coinbase/cdp-sdk` (via
  `axios`) — that's a peer dependency only used for CDP wallet signing, which
  this project doesn't use (private-key signing instead). Safe to ignore for
  the competition; `npm audit fix` isn't necessary.

## Useful SDK methods (from the installed v2.1.0 types)

- `listMarkets({ status, category, limit, pricesAndImpliedProbabilities })`
- `getMarket({ id })`
- `quoteBuy` / `quoteSell` — dry-run pricing, no gas
- `buyShares` / `sellShares` — actual trades
- `ensureTokenApproval({ marketAddress, minimumAmount })` — handles ERC-20
  approval before a buy
- `listPositions({ wallet })`
- `quoteRedeem` / `redeemMarket` / `redeemPositions` — for settled markets
- `quoteLiquidate` / `liquidate` — for expired (unsettled) markets
- `getEthBalance()` / `getErc20BalanceWithDecimals()`

Full docs: https://docs.gensyn.ai/tech/delphi-sdk

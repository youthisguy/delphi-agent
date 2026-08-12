import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

/**
 * Central, hot-reloadable config. Most values come from env, but `dryRun`
 * can also be flipped at runtime via the dashboard (POST /api/dryrun),
 * which writes to data/runtime-config.json. That file wins over env
 * on every read so the dashboard toggle survives loop iterations without
 * a restart.
 */

const DATA_DIR = path.resolve(process.cwd(), "data");
const RUNTIME_CONFIG_PATH = path.join(DATA_DIR, "runtime-config.json");

export interface RuntimeConfig {
  dryRun: boolean;
  /**
   * Contract address of the trding competition token
   */
  competitionTokenAddress: string | null;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readRuntimeConfig(): RuntimeConfig {
  ensureDataDir();
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
    const initial: RuntimeConfig = {
      dryRun: process.env.DRY_RUN !== "false",
      competitionTokenAddress: process.env.COMPETITION_TOKEN_ADDRESS || null,
    };
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    return {
      dryRun: typeof parsed.dryRun === "boolean" ? parsed.dryRun : true,
      competitionTokenAddress:
        typeof parsed.competitionTokenAddress === "string" ? parsed.competitionTokenAddress : null,
    };
  } catch {
    return { dryRun: true, competitionTokenAddress: null };
  }
}

export function getDryRun(): boolean {
  return readRuntimeConfig().dryRun;
}

/** Merges onto the existing file rather than overwriting it — dryRun and
 * competitionTokenAddress now share runtime-config.json, so a write from
 * one must not blow away the other. */
export function setDryRun(value: boolean): RuntimeConfig {
  ensureDataDir();
  const cfg: RuntimeConfig = { ...readRuntimeConfig(), dryRun: value };
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

export function getCompetitionTokenAddress(): string | null {
  return readRuntimeConfig().competitionTokenAddress;
}

/** Pass null to clear back to "unknown" (e.g. if you swap CAs mid-competition). */
export function setCompetitionTokenAddress(address: string | null): RuntimeConfig {
  ensureDataDir();
  const cfg: RuntimeConfig = { ...readRuntimeConfig(), competitionTokenAddress: address };
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

export const CONFIG = {
  loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS ?? 5 * 60 * 1000),
  maxTokensPerTrade: Number(process.env.MAX_TOKENS_PER_TRADE ?? 100),
  maxMarketsPerLoop: Number(process.env.MAX_MARKETS_PER_LOOP ?? 75),

  // Server
  port: Number(process.env.PORT ?? 8787),

  // Gemini backup forecaster — enabled if either a single key or a pool is set.
  // The actual key(s) used at call time come from keyPool.ts, not this field.
  geminiEnabled: Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS),
  geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",

  // Agreement / disagreement rules for blending LLM + Gemini + Polymarket
  disagreementSoftThreshold: Number(process.env.DISAGREEMENT_SOFT ?? 0.15), // raise edge bar
  disagreementHardThreshold: Number(process.env.DISAGREEMENT_HARD ?? 0.20), // skip entirely
  disagreementEdgeMultiplier: Number(process.env.DISAGREEMENT_EDGE_MULT ?? 1.5),

  // --- Bankroll-based position sizing ---
  // Base slice of *remaining* cycle budget a single signal is allowed to
  // claim before conviction scaling. 0.05 = 5%. Kept deliberately small —
  // convictionScore below can multiply it up to ~3x for strong signals,
  // and maxTokensPerTrade is still a hard ceiling per trade.
  bankrollFractionPerTrade: Number(process.env.BANKROLL_FRACTION_PER_TRADE ?? 0.15),
  // Upper multiplier on bankrollFractionPerTrade for a maximally-confident,
  // maximally-over-threshold signal (edge/minEdge capped at this value).
  maxConvictionMultiplier: Number(process.env.MAX_CONVICTION_MULTIPLIER ?? 4),
  // Tokens always left undeployed as a buffer (gas, slippage, redemption
  // timing) — never counted as available capital for sizing.
  bankrollReserveTokens: Number(process.env.BANKROLL_RESERVE_TOKENS ?? 1),
  // Only used in dryRun when a live on-chain balance can't be read (e.g.
  // no wallet configured yet in early testing) — lets sizing logic still
  // exercise realistically instead of silently sizing against 0.
  dryRunVirtualBankroll: Number(process.env.DRY_RUN_VIRTUAL_BANKROLL ?? 1000),

  // A trade sized under this many TOKENS is skipped outright, before it
  // ever reaches a quote. This is separate from (and checked before)
  // minTradeShares below: minTradeShares exists purely to dodge the
  // contract's on-chain revert, but a trade can clear that floor in
  // share-count terms and still be a bad idea — small token amounts eat
  // disproportionate price impact on this market regardless of whether
  // the contract accepts them. Default 5 tokens; raise/lower via
  // MIN_TOKENS_PER_TRADE.
  minTokensPerTrade: Number(process.env.MIN_TOKENS_PER_TRADE ?? 1),

  // The market proxy contract enforces its own minimum trade size on-chain
  // (confirmed via a live revert: SharesOutBelowMinDelta(sharesOut,
  // minDelta) reverted with minDelta=10000000000000000 — i.e. 0.01 shares
  // in 1e18 fixed-point). A signal that only clears a sliver of a shrinking
  // per-cycle budget (common once several previously-frozen markets are
  // all competing for the same remainingBudget in one cycle) can size down
  // to a fraction of a share and revert on quoteBuyExactOut instead of
  // failing gracefully. decide() now checks estimated shares against this
  // floor BEFORE returning a trade decision, so it skips cleanly with a
  // real reason instead of reaching tradeOnMarket() and reverting.
  // Deliberately set slightly above the observed 0.01 on-chain minimum so
  // legitimate float/rounding noise doesn't sit right on the boundary.
  minTradeShares: Number(process.env.MIN_TRADE_SHARES ?? 0.012),

  // Previously ANY market with an open position was hard-skipped every
  // cycle — a real fix for a real bug (repeated same-side buys on a
  // stale, unmoving signal could otherwise silently pyramid exposure
  // with no visibility into total committed capital — see the SpaceX
  // journal/on-chain drift incident). But it also means idle capital
  // sits unused whenever the loop's freshest candidates happen to be
  // markets already held, which is common late in a competition window
  // when few genuinely NEW markets are opening.
  //
  // This replaces the all-or-nothing skip with a per-market ceiling: a
  // held market can still receive additional capital on a fresh
  // qualifying signal, but never past this total. Default is
  // conservative (2x the default per-trade cap) — raise it
  // deliberately, not by accident, since this is the knob that controls
  // how concentrated a single bad call can get.
  maxExposurePerMarket: Number(process.env.MAX_EXPOSURE_PER_MARKET ?? 200),

  // Markets can still show status "open" via the listMarkets API after
  // their on-chain resolution window has actually passed — the market
  // proxy contract itself starts reverting quoteBuyExactOut/buyShares at
  // that point (see the 0x5fca91fa incident: 4 previously-frozen markets
  // all reverted the moment the per-market exposure ceiling let fresh
  // signals reach them again). decide() now skips a market outright once
  // msUntilResolve is inside this buffer, before spending an LLM/Gemini
  // call or attempting an on-chain quote that's going to revert anyway.
  // Default 10 min — comfortably longer than one loop tick so a market
  // doesn't slip through right before closing and revert mid-cycle.
  resolutionSafetyBufferMs: Number(process.env.RESOLUTION_SAFETY_BUFFER_MS ?? 10 * 60 * 1000),

  // --- Forecast cache ---
  // How long an LLM/Gemini forecast for a given market stays valid before
  // it's re-fetched, even if the loop re-evaluates that market again
  // (e.g. a small open-market pool getting re-scanned every cycle).
  // Default 20 min — comfortably longer than the 5 min loopIntervalMs
  // default, so a market only gets re-forecast every ~4th cycle instead
  // of every single one, unless its price actually moves.
  forecastCacheTtlMs: Number(process.env.FORECAST_CACHE_TTL_MS ?? 20 * 60 * 1000),
  // Absolute implied-probability movement (0-1 scale) on any outcome that
  // forces a re-forecast even within the TTL — a real price move is new
  // information the cached forecast never saw.
  forecastCachePriceMoveThreshold: Number(process.env.FORECAST_CACHE_PRICE_MOVE_THRESHOLD ?? 0.03),

  // Optional manual override for the competition token's decimals. The
  // on-chain decimals() call (see chainRead.ts) silently falls back to 18
  // on any failure — fine for a normal 18-decimal token, but if the real
  // token uses something else (e.g. 6) and the call fails for any reason
  // on this chain, that fallback silently produces a balance that's off
  // by a factor of 10^12. Set this once you know the real value and it's
  // used directly instead of trusting the on-chain call.
  competitionTokenDecimals: process.env.COMPETITION_TOKEN_DECIMALS
    ? Number(process.env.COMPETITION_TOKEN_DECIMALS)
    : null,

  // --- Liquidity monitor ---
  // listMarkets() already defaults to orderBy: "liquidity" (best-liquidity
  // first), so the fetched order is itself a liquidity ranking. This just
  // controls how much of the bottom of that ranking gets flagged "thin" in
  // the dashboard — a relative, per-batch heuristic rather than an
  // absolute liquidity unit, since Market doesn't expose a guaranteed
  // stable liquidity field to threshold against directly. 0.3 = bottom 30%
  // of whatever batch was fetched gets flagged.
  thinLiquidityBottomFraction: Number(process.env.THIN_LIQUIDITY_BOTTOM_FRACTION ?? 0.3),

  // Fire scripts/checkpoint.sh (commit + push data/) once at the end of
  // any cycle that entered at least one trade (live or dry-run) — so a
  // receipt is never more than one loop tick away from being safe on
  // the remote, not sitting on Render's ephemeral disk waiting on a
  // manual trigger. Best-effort: a failed checkpoint is logged and added
  // to that cycle's errors, but never aborts the cycle — the trade
  // already happened and its receipt is already on local disk either
  // way. On by default; set AUTO_CHECKPOINT_ON_TRADE=false to disable.
  autoCheckpointOnTrade: process.env.AUTO_CHECKPOINT_ON_TRADE !== "false",

  dataDir: DATA_DIR,
  journalPath: path.join(DATA_DIR, "journal.jsonl"),
  summaryPath: path.join(DATA_DIR, "summary.json"),
  loopStatusPath: path.join(DATA_DIR, "loop-status.json"),
  backtestLogDir: path.join(DATA_DIR, "backtests"),
};

ensureDataDir();
if (!fs.existsSync(CONFIG.backtestLogDir)) {
  fs.mkdirSync(CONFIG.backtestLogDir, { recursive: true });
}
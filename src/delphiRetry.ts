interface RateLimitInfo {
  isRateLimit: boolean;
  retryAfterSec: number | null;
}

/** The SDK's HTTP errors show up as `Error: API request failed (429): {...json...}`.
 * This pulls the embedded JSON body out (if present) and checks both the
 * error object's own possible .status property and the body's
 * status/error_category/error_code fields, since it isn't confirmed which
 * shape the SDK actually throws — better to check all of them than miss
 * a rate limit because of a property-name mismatch. */
function parseRateLimitInfo(err: unknown): RateLimitInfo {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  const message = err instanceof Error ? err.message : String(err);

  let isRateLimit = status === 429 || status === 1015;
  let retryAfterSec: number | null =
    typeof (err as any)?.retry_after === "number" ? (err as any).retry_after : null;

  const jsonStart = message.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const body = JSON.parse(message.slice(jsonStart));
      if (body.status === 429 || body.error_category === "rate_limit" || body.error_code === 1015) {
        isRateLimit = true;
      }
      if (retryAfterSec === null && typeof body.retry_after === "number") {
        retryAfterSec = body.retry_after;
      }
    } catch {
      /* message wasn't parseable JSON after that point — fall through to
       * the plain-text checks below */
    }
  }

  if (!isRateLimit) {
    isRateLimit = /\b429\b/.test(message) || /rate.?limit/i.test(message);
  }

  return { isRateLimit, retryAfterSec };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Process-wide: the epoch ms until which every Delphi call should wait
// before even trying, once any call has observed a 429. 0 = no known
// active rate-limit window.
let rateLimitedUntil = 0;

// Only log once per distinct window instead of once per waiting caller.
// With N positions polled in parallel (positions.ts), all N used to log
// their own "waiting Xs" line on every single tick — that's what was
// filling the logs with hundreds of near-identical lines per second.
let lastLoggedWindowEnd = 0;

async function waitOutKnownWindow(label: string): Promise<void> {
  const windowEnd = rateLimitedUntil;
  const waitMs = windowEnd - Date.now();
  if (waitMs > 0) {
    if (windowEnd !== lastLoggedWindowEnd) {
      lastLoggedWindowEnd = windowEnd;
      console.warn(
        `  [delphi-retry] ${label} (+others) waiting ${(waitMs / 1000).toFixed(0)}s — inside a rate-limit window another call already hit`
      );
    }
    // Jitter avoids every parallel caller waking up on the exact same
    // millisecond and re-triggering the SAME rate limit together
    // (thundering herd) — spreads re-attempts over ~1.5s instead.
    await sleep(waitMs + Math.random() * 1500);
  }
}

export interface DelphiRetryOptions {
  /** Shown in console warnings so a stalled/retrying call is identifiable
   * in the logs (e.g. "listMarkets(open)", "getMarket(0xabc…)"). */
  label?: string;
  /** API's own guidance: 5. */
  maxRetries?: number;
  /** API's own guidance: 30s, doubling each retry — only used as a
   * fallback when the response doesn't include its own retry_after. */
  baseDelayMs?: number;
}

export async function withDelphiRetry<T>(
  fn: () => Promise<T>,
  opts: DelphiRetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 30_000;
  const label = opts.label ?? "delphi call";

  let attempt = 0;
  for (;;) {
    await waitOutKnownWindow(label);
    try {
      return await fn();
    } catch (err) {
      const { isRateLimit, retryAfterSec } = parseRateLimitInfo(err);
      if (!isRateLimit || attempt >= maxRetries) throw err;

      const delayMs = retryAfterSec !== null ? retryAfterSec * 1000 : baseDelayMs * 2 ** attempt;
      rateLimitedUntil = Date.now() + delayMs; // let every other call (already in flight or about to start) know too
      attempt++;
      console.warn(
        `  [delphi-retry] ${label} rate-limited (429) — waiting ${(delayMs / 1000).toFixed(0)}s before retry ${attempt}/${maxRetries}`
      );
      await sleep(delayMs);
    }
  }
}
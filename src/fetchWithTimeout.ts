/**
 * Plain fetch() never times out on its own — a stalled connection (server
 * accepts the socket but never responds) hangs the calling await forever.
 * This wraps fetch with an AbortController-based deadline so every caller
 * gets a bounded worst case instead of wedging the whole loop.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

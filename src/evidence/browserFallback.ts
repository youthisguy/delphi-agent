import { EV } from "./evidenceConfig.js";
import { checkRobots, politeDelay, extractFromHtml, type FetchOutcome } from "./fetchExtract.js";
import { domainOf } from "./search.js";

/**
 * Playwright fallback — ONLY for JS-heavy / light-interaction pages that plain fetch
 * can't read. Off by default (PLAYWRIGHT_ENABLED=true to enable). Rules baked in:
 * robots.txt + per-domain delay still apply, one short session at a time, images/
 * fonts/media blocked, NO logins, NO consumer chat UIs, no form submission.
 *
 * Render build step needed:  npx playwright install --with-deps chromium
 */

const FORBIDDEN_HOSTS = /(^|\.)(chatgpt\.com|openai\.com\/chat|gemini\.google\.com|claude\.ai|perplexity\.ai|copilot\.microsoft\.com|chat\.mistral\.ai)$/i;

let queue: Promise<unknown> = Promise.resolve();

export function browserFetch(url: string): Promise<FetchOutcome> {
  const job = queue.then(() => run(url), () => run(url));
  queue = job.catch(() => undefined);
  return job;
}

async function run(url: string): Promise<FetchOutcome> {
  if (!EV.playwrightEnabled) return { ok: false, error: "playwright disabled", needsBrowser: false };
  const domain = domainOf(url);
  if (FORBIDDEN_HOSTS.test(domain)) return { ok: false, error: "consumer chat interfaces are off-limits", needsBrowser: false };
  if (!(await checkRobots(url))) return { ok: false, error: "disallowed by robots.txt", needsBrowser: false };
  await politeDelay(domain);

  let browser: any;
  try {
    const mod = "playwright";
    const { chromium } = (await import(mod)) as any;
    browser = await chromium.launch({
      headless: true,
      ...(EV.playwrightProxy ? { proxy: { server: EV.playwrightProxy } } : {}),
    });
    const ctx = await browser.newContext({ userAgent: EV.userAgent, javaScriptEnabled: true });
    await ctx.route("**/*", (route: any) =>
      ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue()
    );
    const page = await ctx.newPage();
    page.setDefaultTimeout(EV.playwrightTimeoutMs);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    const html: string = await page.content();
    const doc = await extractFromHtml(html, url, page.url(), "playwright");
    return doc ? { ok: true, doc } : { ok: false, error: "too little text after render", needsBrowser: false };
  } catch (err) {
    return { ok: false, error: `playwright: ${err instanceof Error ? err.message : String(err)}`, needsBrowser: false };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

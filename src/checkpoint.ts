import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CheckpointResult {
  ok: boolean;
  output: string;
}

/**
 * Runs scripts/checkpoint.sh (commit + push data/) and returns its
 * combined stdout/stderr. Shared by server.ts's POST /api/checkpoint
 * route and index.ts's post-trade auto-checkpoint hook, so there's one
 * place that knows how to invoke the script instead of duplicated
 * execFile plumbing that could drift out of sync.
 *
 * Always resolves (never throws) — callers decide what a failure means
 * for them. In particular the trading loop must never treat a
 * checkpoint failure as fatal: the trade already executed and its
 * receipt is already on local disk either way.
 */
export async function runCheckpointScript(): Promise<CheckpointResult> {
  const scriptPath = path.resolve(process.cwd(), "scripts/checkpoint.sh");
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], { timeout: 60_000 });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err: any) {
    const output = String((err?.stdout ?? "") + (err?.stderr ?? "")).trim();
    return {
      ok: false,
      output: output || (err instanceof Error ? err.message : String(err)),
    };
  }
}

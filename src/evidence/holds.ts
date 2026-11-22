import fs from "node:fs";
import path from "node:path";
import { EV } from "./evidenceConfig.js";

/** Markets a human is working on by hand: the agent skips them so it doesn't burn the shared 3-per-market budget. */
export function readHolds(): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(EV.holdsPath, "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const isHeld = (marketId: string): boolean => readHolds().includes(marketId);

export function setHold(marketId: string, on: boolean): string[] {
  const set = new Set(readHolds());
  if (on) set.add(marketId);
  else set.delete(marketId);
  const out = [...set];
  fs.mkdirSync(path.dirname(EV.holdsPath), { recursive: true });
  fs.writeFileSync(EV.holdsPath, JSON.stringify(out));
  return out;
}

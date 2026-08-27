// Small, genuinely mechanical helpers shared across orchestrator-style loops (four-category
// expansion). Pure-function extraction only -- orchestrator.ts keeps its own private copies
// rather than being touched again beyond the Day 3 execution-logic extraction; new category
// orchestrators use these instead of re-deriving them a third/fourth time.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";

export function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
  }
  return value;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Next `{filePrefix}-NNNN.json` id in `dir`, creating it if it doesn't exist yet. */
export function nextArchiveId(dir: string, filePrefix: string): number {
  mkdirSync(dir, { recursive: true });
  const pattern = new RegExp(`^${filePrefix}-(\\d+)\\.json$`);
  const existing = readdirSync(dir)
    .map((f) => pattern.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

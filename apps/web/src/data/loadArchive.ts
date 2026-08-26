// Runtime access to the archived JSON that was bundled at build time by
// scripts/generateArchiveManifest.ts (see that file for the aggregation rules). The manifest
// itself is a build-time JS import (inlined into the bundle, cannot 404, cannot drift from what
// the generator actually computed); the full round/run records are fetched at runtime from
// public/data/ -- same origin as the deployed site, no CORS, no external dependency.

import manifest from "../generated/archiveManifest.json";
import type { ArchiveManifest, ArenaRound, AgentArenaRun, ResumedMintAmendment } from "./types";

export const archiveManifest: ArchiveManifest = manifest as ArchiveManifest;

function dataUrl(...parts: string[]): string {
  return `${import.meta.env.BASE_URL}data/${parts.join("/")}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function loadArenaRound(roundId: number): Promise<ArenaRound> {
  const padded = String(roundId).padStart(4, "0");
  return fetchJson<ArenaRound>(dataUrl("arena-rounds-v2", `round-${padded}.json`));
}

export function loadAgentArenaRun(entrySourceFile: string): Promise<AgentArenaRun> {
  return fetchJson<AgentArenaRun>(dataUrl("agent-arena-runs-v2", entrySourceFile));
}

export function loadResumedMintAmendment(amendmentSourceFile: string): Promise<ResumedMintAmendment> {
  return fetchJson<ResumedMintAmendment>(dataUrl("agent-arena-runs-v2", amendmentSourceFile));
}

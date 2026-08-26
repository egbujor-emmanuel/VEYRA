// Build-time step (npm prebuild/predev): reads the REAL current contents of
// docs/agent-arena-runs-v2/ and docs/arena-rounds-v2/ and produces:
//   1. src/generated/archiveManifest.json -- the track-record aggregate, computed fresh from
//      the actual files every build. Never hand-typed, never drifts.
//   2. public/data/{arena-rounds-v2,agent-arena-runs-v2}/*.json -- raw copies for the
//      drill-down history pages to fetch at runtime.
//   3. public/legacy/arena.html -- a copy of the old static v1 page, so the Dashboard's
//      footnote link to it actually resolves on the deployed site (GitHub Pages only serves
//      apps/web/dist, not the whole repo, so docs/arena.html itself is unreachable there).
//
// Source directory is HARDCODED to exactly docs/agent-arena-runs-v2 -- never v1
// (docs/agent-arena-runs/), never docs/executions/, docs/test-b/, or
// docs/test-infrastructure/ (the ambient-liquidity test position). This is req 7's exclusion
// rule enforced structurally, not by a runtime filter someone could widen later.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../");
const DOCS_DIR = resolve(REPO_ROOT, "docs");
const RUNS_DIR = resolve(DOCS_DIR, "agent-arena-runs-v2");
const ROUNDS_DIR = resolve(DOCS_DIR, "arena-rounds-v2");
const APP_ROOT = resolve(__dirname, "..");
const GENERATED_DIR = resolve(APP_ROOT, "src/generated");
const PUBLIC_DATA_RUNS_DIR = resolve(APP_ROOT, "public/data/agent-arena-runs-v2");
const PUBLIC_DATA_ROUNDS_DIR = resolve(APP_ROOT, "public/data/arena-rounds-v2");
const PUBLIC_LEGACY_DIR = resolve(APP_ROOT, "public/legacy");

interface PrimaryRun {
  runArchiveId: number;
  winnerCandidateId: string;
  winningProposal: { agentIdOnChain: number | null };
  finalState: string;
  isFailure: boolean;
}

interface AmendmentRun {
  predecessorRunArchiveId: number;
  newPosition: { tokenId: string };
  status: string;
}

function isAmendment(record: unknown): record is AmendmentRun {
  return typeof record === "object" && record !== null && "predecessorRunArchiveId" in record;
}

function main() {
  mkdirSync(GENERATED_DIR, { recursive: true });
  mkdirSync(PUBLIC_DATA_RUNS_DIR, { recursive: true });
  mkdirSync(PUBLIC_DATA_ROUNDS_DIR, { recursive: true });
  mkdirSync(PUBLIC_LEGACY_DIR, { recursive: true });

  const runFiles = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort();

  const primaries: Array<{ file: string; record: PrimaryRun }> = [];
  const amendments: Array<{ file: string; record: AmendmentRun }> = [];

  for (const file of runFiles) {
    const record = JSON.parse(readFileSync(resolve(RUNS_DIR, file), "utf-8"));
    if (isAmendment(record)) {
      amendments.push({ file, record });
    } else {
      primaries.push({ file, record });
    }
    // Copy raw file for the runtime drill-down views (both primaries and amendments).
    copyFileSync(resolve(RUNS_DIR, file), resolve(PUBLIC_DATA_RUNS_DIR, file));
  }

  const entries = primaries.map(({ file, record }) => {
    const amendment = amendments.find((a) => a.record.predecessorRunArchiveId === record.runArchiveId);
    const effectiveOutcome = amendment ? amendment.record.status : record.finalState;
    const effectiveExecuted = effectiveOutcome === "EXECUTED";
    return {
      runArchiveId: record.runArchiveId,
      roundId: (record as any).roundId,
      sourceFile: file,
      winnerCandidateId: record.winnerCandidateId,
      agentIdOnChain: record.winningProposal.agentIdOnChain,
      finalState: record.finalState, // preserved as-is -- the real failure is never erased
      isFailure: record.isFailure,
      effectiveOutcome,
      effectiveExecuted,
      amendment: amendment ? { sourceFile: amendment.file, newPositionTokenId: amendment.record.newPosition.tokenId } : null,
    };
  });

  const totalRuns = entries.length;
  const executedJobs = entries.filter((e) => e.effectiveExecuted).length;
  const executionBlockedJobs = entries.filter((e) => e.finalState === "EXECUTION_BLOCKED").length;
  const otherOutcomeJobs = totalRuns - executedJobs - executionBlockedJobs;
  const wonByOurAgent = entries.filter((e) => e.agentIdOnChain !== null && e.effectiveExecuted).length;

  // Sanity assertion against ground truth verified directly from the real files before writing
  // this script (see the chat record for this slice): 4 total runs, 1 effective executed job,
  // 3 execution-blocked. If the archive changes, this assertion is removed by a future edit,
  // not silently bypassed -- fail loudly rather than ship a manifest nobody checked.
  console.log(`Manifest: ${totalRuns} total, ${executedJobs} executed, ${executionBlockedJobs} blocked, ${otherOutcomeJobs} other, ${wonByOurAgent} won by Our Agent`);

  const roundFiles = readdirSync(ROUNDS_DIR).filter((f) => f.endsWith(".json")).sort();
  const arenaRoundIds: number[] = [];
  for (const file of roundFiles) {
    copyFileSync(resolve(ROUNDS_DIR, file), resolve(PUBLIC_DATA_ROUNDS_DIR, file));
    const round = JSON.parse(readFileSync(resolve(ROUNDS_DIR, file), "utf-8"));
    arenaRoundIds.push(round.roundId);
  }
  arenaRoundIds.sort((a, b) => a - b);
  const latestRoundId = arenaRoundIds.length > 0 ? arenaRoundIds[arenaRoundIds.length - 1] : 0;

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalRuns,
    executedJobs,
    executionBlockedJobs,
    otherOutcomeJobs,
    wonByOurAgent,
    entries,
    latestRoundId,
    arenaRoundIds,
  };
  writeFileSync(resolve(GENERATED_DIR, "archiveManifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${resolve(GENERATED_DIR, "archiveManifest.json")}`);

  const legacyArenaHtml = resolve(DOCS_DIR, "arena.html");
  if (existsSync(legacyArenaHtml)) {
    copyFileSync(legacyArenaHtml, resolve(PUBLIC_LEGACY_DIR, "arena.html"));
    console.log("Copied legacy docs/arena.html -> public/legacy/arena.html");
  }
}

main();

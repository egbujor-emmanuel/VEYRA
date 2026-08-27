// Yield Optimisation's real agent loop -- recommendation-only, by explicit design (see
// yieldSnapshot.ts / evaluatorYield.ts). Observes real pools, evaluates a real recommendation,
// archives it. Never calls authorizeExecution, never builds a transaction, never touches a
// signer -- there is no execution path in this category in this scope, not an oversight.

import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PublicClient, Address } from "viem";
import { evaluateYield, yieldOptimiserStrategy, baselineHoldYieldStrategy, VEYRA_AGENT_ID_ON_CHAIN, type YieldOptimisationJobSpec } from "@veyra/core";
import { readYieldObservation, type CandidatePoolInput } from "./yieldPositionReader.js";
import { bigintsToStrings, sha256, nextArchiveId } from "./archiveUtils.js";

export interface RunYieldOrchestratorLoopOpts {
  client: PublicClient;
  currentPool: CandidatePoolInput & { fee: number };
  candidatePools: (CandidatePoolInput & { fee: number })[];
  ownerWallet: Address;
  docsDir: string;
}

export interface YieldOrchestratorLoopResult {
  runId: string;
  roundId: number;
  winnerCandidateId: string;
  recommendation: "hold" | "recommend-migrate";
  outPath: string;
}

export async function runYieldOrchestratorLoop(opts: RunYieldOrchestratorLoopOpts): Promise<YieldOrchestratorLoopResult> {
  const yieldRoundsDir = resolve(opts.docsDir, "yield-rounds");
  const runId = randomUUID();

  // --- OBSERVE ---
  const snapshot = await readYieldObservation(opts.client, opts.currentPool, opts.candidatePools);

  const job: YieldOptimisationJobSpec = {
    jobId: `yield-loop-${runId}`,
    createdAt: new Date().toISOString(),
    ownerWallet: opts.ownerWallet,
    category: "yield-optimisation",
    target: {
      protocol: "pancakeswap-v3",
      network: "bsc-testnet",
      candidatePools: [opts.currentPool, ...opts.candidatePools].map((p) => ({ poolAddress: p.poolAddress, label: p.label })),
    },
    constraints: { maxSpendWei: 0n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 0n },
    status: "evaluating",
    erc8183JobId: null,
  };

  // --- EVALUATE ---
  const proposals = await Promise.all([yieldOptimiserStrategy(job, snapshot), baselineHoldYieldStrategy(job, snapshot)]);
  const evaluationResult = evaluateYield(job, snapshot, proposals);
  const winner = evaluationResult.winner;

  const roundId = nextArchiveId(yieldRoundsDir, "round");

  // --- ARCHIVE (no PLAN/SIMULATE/execute phase -- recommendation-only, by design) ---
  const recordContent = {
    kind: "YIELD_OPTIMISATION_RECOMMENDATION",
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: opts.ownerWallet,
    observed: bigintsToStrings(snapshot),
    job: bigintsToStrings(job),
    proposals: evaluationResult.scored.map((s) => ({
      ...(bigintsToStrings(s.proposal) as Record<string, unknown>),
      metrics: bigintsToStrings(s.metrics),
      score: s.score,
      isWinner: s.isWinner,
    })),
    winnerCandidateId: winner.proposal.candidateId,
    winningProposal: winner.proposal,
    status: winner.proposal.proposedAction.kind === "recommend-migrate" ? "RECOMMENDATION_NOT_EXECUTED" : "HOLD",
    generatedAt: new Date().toISOString(),
  };
  const artifactHash = sha256(JSON.stringify(recordContent));
  mkdirSync(yieldRoundsDir, { recursive: true });
  const outPath = resolve(yieldRoundsDir, `round-${String(roundId).padStart(4, "0")}.json`);
  writeFileSync(outPath, JSON.stringify({ roundId, artifactHash, ...recordContent }, null, 2));

  return {
    runId,
    roundId,
    winnerCandidateId: winner.proposal.candidateId,
    recommendation: winner.proposal.proposedAction.kind === "recommend-migrate" ? "recommend-migrate" : "hold",
    outPath,
  };
}

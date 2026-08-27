// Health Factor Monitoring's real agent loop -- recommendation-only, by explicit design (see
// healthFactorSnapshot.ts / evaluatorHealthFactor.ts). Observes a real Venus account, evaluates a
// real recommendation, archives it. Never calls authorizeExecution, never builds a repay
// transaction -- there is no execution path in this category in this scope.

import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PublicClient, Address } from "viem";
import { evaluateHealthFactor, healthFactorMonitorStrategy, baselineHoldHealthFactorStrategy, VEYRA_AGENT_ID_ON_CHAIN, type HealthFactorJobSpec } from "@veyra/core";
import { readVenusAccountObservation } from "./healthFactorReader.js";
import { bigintsToStrings, sha256, nextArchiveId } from "./archiveUtils.js";

export interface RunHealthFactorOrchestratorLoopOpts {
  client: PublicClient;
  comptrollerAddress: Address;
  borrowedVTokenAddress: Address;
  account: Address;
  docsDir: string;
}

export interface HealthFactorOrchestratorLoopResult {
  runId: string;
  roundId: number;
  winnerCandidateId: string;
  recommendation: "hold" | "recommend-repay" | "recommend-add-collateral";
  outPath: string;
}

export async function runHealthFactorOrchestratorLoop(opts: RunHealthFactorOrchestratorLoopOpts): Promise<HealthFactorOrchestratorLoopResult> {
  const healthFactorRoundsDir = resolve(opts.docsDir, "health-factor-rounds");
  const runId = randomUUID();

  // --- OBSERVE ---
  const snapshot = await readVenusAccountObservation({
    client: opts.client,
    comptrollerAddress: opts.comptrollerAddress,
    borrowedVTokenAddress: opts.borrowedVTokenAddress,
    account: opts.account,
  });

  const job: HealthFactorJobSpec = {
    jobId: `health-factor-loop-${runId}`,
    createdAt: new Date().toISOString(),
    ownerWallet: opts.account,
    category: "health-factor-monitoring",
    target: { protocol: "venus", network: "bsc-testnet", account: opts.account },
    constraints: { maxSpendWei: 0n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 0n },
    status: "evaluating",
    erc8183JobId: null,
  };

  // --- EVALUATE ---
  const proposals = await Promise.all([healthFactorMonitorStrategy(job, snapshot), baselineHoldHealthFactorStrategy(job, snapshot)]);
  const evaluationResult = evaluateHealthFactor(job, snapshot, proposals);
  const winner = evaluationResult.winner;

  const roundId = nextArchiveId(healthFactorRoundsDir, "round");

  // --- ARCHIVE (recommendation-only, no PLAN/SIMULATE/execute phase) ---
  const recordContent = {
    kind: "HEALTH_FACTOR_MONITORING_RECOMMENDATION",
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: opts.account,
    observed: bigintsToStrings(snapshot),
    job: bigintsToStrings(job),
    proposals: evaluationResult.scored.map((s) => ({
      ...(bigintsToStrings(s.proposal) as Record<string, unknown>),
      metrics: bigintsToStrings(s.metrics),
      score: s.score,
      isWinner: s.isWinner,
    })),
    winnerCandidateId: winner.proposal.candidateId,
    winningProposal: bigintsToStrings(winner.proposal),
    status: winner.proposal.proposedAction.kind === "hold" ? "HOLD" : "RECOMMENDATION_NOT_EXECUTED",
    generatedAt: new Date().toISOString(),
  };
  const artifactHash = sha256(JSON.stringify(recordContent));
  mkdirSync(healthFactorRoundsDir, { recursive: true });
  const outPath = resolve(healthFactorRoundsDir, `round-${String(roundId).padStart(4, "0")}.json`);
  writeFileSync(outPath, JSON.stringify({ roundId, artifactHash, ...recordContent }, null, 2));

  const recommendation =
    winner.proposal.proposedAction.kind === "recommend-repay"
      ? "recommend-repay"
      : winner.proposal.proposedAction.kind === "recommend-add-collateral"
        ? "recommend-add-collateral"
        : "hold";

  return { runId, roundId, winnerCandidateId: winner.proposal.candidateId, recommendation, outPath };
}

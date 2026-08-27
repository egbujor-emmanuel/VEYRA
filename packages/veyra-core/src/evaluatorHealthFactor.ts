// Health Factor Monitoring evaluator. Recommendation-only in this scope (see
// healthFactorOrchestrator.ts) -- estimatedGasWei is always 0 and executionFeasible is always
// true, mirroring evaluatorYield.ts's own reasoning: nothing here is ever executed.

import type { HealthFactorMarketSnapshot } from "./healthFactorSnapshot.js";
import { scoreProposals } from "./evaluatorKernel.js";
import type { HealthFactorJobSpec, ProposalMetrics, StrategyProposal } from "./types.js";

export function computeMetricsHealthFactor(_job: HealthFactorJobSpec, snapshot: HealthFactorMarketSnapshot, proposal: StrategyProposal): ProposalMetrics {
  const action = proposal.proposedAction;
  // riskScore is the real, observed borrowToCapacityRatio for a HOLD proposal (staying at the
  // current risk level); a repay recommendation is scored as reducing risk to 0 -- the point of
  // the recommendation, whether or not it's ever actually executed.
  const riskScore = action.kind === "hold" ? snapshot.borrowToCapacityRatio : 0;
  const estimatedFeeEfficiency = 100 - riskScore; // inverse of risk, same convention as the other categories (higher is better)

  return {
    estimatedGasWei: 0n, // never executed in this scope
    estimatedFeeEfficiency,
    estimatedSlippageBps: 0,
    riskScore,
    executionFeasible: true,
  };
}

export interface HealthFactorEvaluationResult {
  jobId: string;
  snapshot: HealthFactorMarketSnapshot;
  scored: ReturnType<typeof scoreProposals<ProposalMetrics>>["scored"];
  winner: ReturnType<typeof scoreProposals<ProposalMetrics>>["winner"];
}

export function evaluateHealthFactor(job: HealthFactorJobSpec, snapshot: HealthFactorMarketSnapshot, proposals: StrategyProposal[]): HealthFactorEvaluationResult {
  const metrics = proposals.map((p) => computeMetricsHealthFactor(job, snapshot, p));
  const { scored, winner } = scoreProposals(job, proposals, metrics);
  return { jobId: job.jobId, snapshot, scored, winner };
}

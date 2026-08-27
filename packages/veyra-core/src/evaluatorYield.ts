// Yield Optimisation evaluator. Recommendation-only in this scope (see yieldOrchestrator.ts) --
// estimatedGasWei is always 0 and executionFeasible is always true, since nothing here is ever
// executed; the evaluator's job is purely to pick which RECOMMENDATION is best-supported by the
// real, observed fee-growth data.

import { cumulativeFeeGrowthScore, type YieldMarketSnapshot } from "./yieldSnapshot.js";
import { scoreProposals } from "./evaluatorKernel.js";
import type { YieldOptimisationJobSpec, ProposalMetrics, StrategyProposal } from "./types.js";

export function computeMetricsYield(_job: YieldOptimisationJobSpec, snapshot: YieldMarketSnapshot, proposal: StrategyProposal): ProposalMetrics {
  const action = proposal.proposedAction;
  const targetPoolAddress = action.kind === "recommend-migrate" ? action.toPool : snapshot.currentPoolAddress;
  const targetPool = snapshot.pools.find((p) => p.poolAddress.toLowerCase() === targetPoolAddress.toLowerCase());
  if (!targetPool) {
    throw new Error(`computeMetricsYield: pool ${targetPoolAddress} not found in snapshot.pools`);
  }

  const score = cumulativeFeeGrowthScore(targetPool);
  const maxScore = snapshot.pools.reduce((max, p) => {
    const s = cumulativeFeeGrowthScore(p);
    return s > max ? s : max;
  }, 0n);

  const estimatedFeeEfficiency = maxScore === 0n ? 100 : Number((score * 100n) / maxScore);
  const riskScore = 100 - estimatedFeeEfficiency;

  return {
    estimatedGasWei: 0n, // never executed in this scope
    estimatedFeeEfficiency,
    estimatedSlippageBps: 0,
    riskScore,
    executionFeasible: true, // recommendation-only; nothing to be infeasible about
  };
}

export interface YieldEvaluationResult {
  jobId: string;
  snapshot: YieldMarketSnapshot;
  scored: ReturnType<typeof scoreProposals<ProposalMetrics>>["scored"];
  winner: ReturnType<typeof scoreProposals<ProposalMetrics>>["winner"];
}

export function evaluateYield(job: YieldOptimisationJobSpec, snapshot: YieldMarketSnapshot, proposals: StrategyProposal[]): YieldEvaluationResult {
  const metrics = proposals.map((p) => computeMetricsYield(job, snapshot, p));
  const { scored, winner } = scoreProposals(job, proposals, metrics);
  return { jobId: job.jobId, snapshot, scored, winner };
}

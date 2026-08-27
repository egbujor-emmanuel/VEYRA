// Grid Trading evaluator. Reuses v2's per-range formulas (widthDrivenMetric, positioningScore)
// unmodified, applied once per grid slot, then averaged -- the same discipline as v1/v2: a
// candidate never scores itself, every metric comes from the same formula for every candidate.

import { widthDrivenMetric, PLACEHOLDER_REBALANCE_GAS_WEI } from "./evaluator.js";
import { positioningScore } from "./evaluatorV2.js";
import { scoreProposals } from "./evaluatorKernel.js";
import type { GridTradingJobSpec, ProposalMetrics, StrategyProposal } from "./types.js";
import type { GridMarketSnapshot } from "./gridSnapshot.js";

export function computeMetricsGrid(
  job: GridTradingJobSpec,
  snapshot: GridMarketSnapshot,
  proposal: StrategyProposal,
): ProposalMetrics {
  const action = proposal.proposedAction;
  const numAdjustments = action.kind === "grid-rebalance" ? action.slotAdjustments.length : 0;

  const perSlot = snapshot.slots.map((slot, i) => {
    const adjustment = action.kind === "grid-rebalance" ? action.slotAdjustments.find((a) => a.slotIndex === i) : undefined;
    const range = adjustment ? adjustment.newRange : slot.currentRange;
    const widthTicks = range.tickUpper - range.tickLower;
    return {
      widthEff: widthDrivenMetric(widthTicks, slot.tickSpacing),
      posScore: positioningScore(range.tickLower, range.tickUpper, slot.currentTick),
    };
  });

  const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const avgWidthEff = avg(perSlot.map((s) => s.widthEff));
  const avgPosScore = avg(perSlot.map((s) => s.posScore));

  const estimatedFeeEfficiency = 0.5 * avgWidthEff + 0.5 * avgPosScore;
  const riskScore = 0.5 * avgWidthEff + 0.5 * (100 - avgPosScore);
  const estimatedGasWei = BigInt(numAdjustments) * PLACEHOLDER_REBALANCE_GAS_WEI;
  // Same documented MVP gap as v1/v2 -- slots recenter on the current tick, no ratio-fixing swap leg modeled.
  const estimatedSlippageBps = 0;
  const executionFeasible = estimatedGasWei <= job.constraints.maxSpendWei && estimatedSlippageBps <= job.constraints.maxSlippageBps;

  return { estimatedGasWei, estimatedFeeEfficiency, estimatedSlippageBps, riskScore, executionFeasible };
}

export interface GridEvaluationResult {
  jobId: string;
  snapshot: GridMarketSnapshot;
  scored: ReturnType<typeof scoreProposals<ProposalMetrics>>["scored"];
  winner: ReturnType<typeof scoreProposals<ProposalMetrics>>["winner"];
}

export function evaluateGrid(job: GridTradingJobSpec, snapshot: GridMarketSnapshot, proposals: StrategyProposal[]): GridEvaluationResult {
  const metrics = proposals.map((p) => computeMetricsGrid(job, snapshot, p));
  const { scored, winner } = scoreProposals(job, proposals, metrics);
  return { jobId: job.jobId, snapshot, scored, winner };
}

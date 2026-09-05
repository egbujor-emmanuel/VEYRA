// Grid Trading evaluator. Reuses v2's widthDrivenMetric unmodified, applied once per grid slot and
// averaged -- the same discipline as v1/v2: a candidate never scores itself, every metric comes
// from the same formula for every candidate.
//
// It does NOT reuse v2's positioningScore. That measures centeredness and returns 0 whenever the
// price is outside the range, which is every grid slot by construction. See gridPlacementScore.

import { widthDrivenMetric, PLACEHOLDER_REBALANCE_GAS_WEI } from "./evaluator.js";
import { scoreProposals } from "./evaluatorKernel.js";
import type { GridTradingJobSpec, ProposalMetrics, StrategyProposal } from "./types.js";
import type { GridMarketSnapshot } from "./gridSnapshot.js";

/**
 * How well a grid slot is placed, which is NOT how well an LP range is centered.
 *
 * v2's positioningScore rewards a range for containing the current price, and this evaluator used
 * it directly. That is exactly backwards for a grid. A grid slot is a resting one-sided order: it
 * sits entirely above or entirely below the price by design, so positioningScore returns 0 for
 * every slot no matter how well or badly placed it is. Once slots became strictly one-sided, every
 * candidate scored identically on fee efficiency and risk, the only remaining difference was gas,
 * and holding won every round by construction. The grid agent could not act at all.
 *
 * What actually matters for a resting order is how close it sits to the price -- near enough to be
 * filled, rather than stranded far out where it earns nothing. Distance is measured against the
 * slot's OWN width, so the metric needs no knowledge of any particular ladder geometry and grades
 * every candidate by the same rule.
 */
export function gridPlacementScore(
  range: { tickLower: number; tickUpper: number },
  currentTick: number,
): number {
  const width = range.tickUpper - range.tickLower;
  if (width <= 0) return 0;
  // Inside its own range, a slot is actively converting and earning fees.
  if (currentTick >= range.tickLower && currentTick < range.tickUpper) return 100;
  const gap = currentTick < range.tickLower ? range.tickLower - currentTick : currentTick - range.tickUpper + 1;
  // A slot one full width away from the price is worth nothing as a resting order.
  return Math.max(0, Math.min(100, 100 * (1 - gap / width)));
}

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
      posScore: gridPlacementScore(range, slot.currentTick),
    };
  });

  const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const avgWidthEff = avg(perSlot.map((s) => s.widthEff));
  const avgPosScore = avg(perSlot.map((s) => s.posScore));

  const estimatedFeeEfficiency = 0.5 * avgWidthEff + 0.5 * avgPosScore;
  // Risk here is capital sitting idle: a slot parked far from the price will not be reached, so it
  // earns nothing while still being committed. Same shape as the other categories, read for what a
  // grid actually risks.
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

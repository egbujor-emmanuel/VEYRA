// VEYRA Core evaluator (docs/AGENT_ARENA_ARCHITECTURE.md section 3).
//
// Deliberately simple, v1, equal-weighted, no invented precision. Computes every metric
// uniformly for every proposal from the same formulas -- no candidate self-reports its own score.

import type {
  EvaluationResult,
  JobSpec,
  MarketSnapshot,
  ProposalMetrics,
  ScoreBreakdown,
  ScoredProposal,
  StrategyProposal,
} from "./types.js";

// Placeholder until the execution-integration slice wires in a live eth_estimateGas call.
// Exported so execution.ts's per-step gas placeholders sum to exactly this same figure --
// one placeholder value for "a rebalance costs about this much gas," not two independently
// invented numbers that happen to coincide.
export const PLACEHOLDER_REBALANCE_GAS_WEI = 3_000_000_000_000_000n; // ~0.003 BNB-equivalent, round number
const REFERENCE_WIDTH_MULTIPLIER = 40; // "wide/safe" reference range, in units of tickSpacing

function actionRange(
  proposal: StrategyProposal,
  snapshot: MarketSnapshot,
): { tickLower: number; tickUpper: number } {
  return proposal.proposedAction.kind === "rebalance"
    ? proposal.proposedAction.newRange
    : snapshot.currentRange;
}

// Both feeEfficiency and riskScore are driven by the same range-width signal, by construction:
// narrower ranges concentrate liquidity (more fees while price stays in range) AND carry more
// risk of exiting the range. This is the standard concentrated-liquidity width/risk tradeoff --
// not two independently invented models. See architecture doc section 3.
function widthDrivenMetric(widthTicks: number, tickSpacing: number): number {
  const referenceWidthTicks = REFERENCE_WIDTH_MULTIPLIER * tickSpacing;
  const ratio = referenceWidthTicks / widthTicks;
  return Math.max(0, Math.min(100, 100 * ratio));
}

export function computeMetrics(
  job: JobSpec,
  snapshot: MarketSnapshot,
  proposal: StrategyProposal,
): ProposalMetrics {
  const range = actionRange(proposal, snapshot);
  const widthTicks = range.tickUpper - range.tickLower;

  const estimatedFeeEfficiency = widthDrivenMetric(widthTicks, snapshot.tickSpacing);
  const riskScore = widthDrivenMetric(widthTicks, snapshot.tickSpacing);

  const estimatedGasWei = proposal.proposedAction.kind === "hold" ? 0n : PLACEHOLDER_REBALANCE_GAS_WEI;

  // MVP strategies always center the new range on the current tick, so no ratio-fixing swap
  // leg is needed. An off-center rebalance would need real slippage modeling here.
  const estimatedSlippageBps = 0;

  const executionFeasible =
    estimatedGasWei <= job.constraints.maxSpendWei && estimatedSlippageBps <= job.constraints.maxSlippageBps;

  return { estimatedGasWei, estimatedFeeEfficiency, estimatedSlippageBps, riskScore, executionFeasible };
}

function normalize(values: number[], higherIsBetter: boolean): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 100); // no candidate is worse than another on this axis
  return values.map((v) => {
    const frac = (v - min) / (max - min);
    return 100 * (higherIsBetter ? frac : 1 - frac);
  });
}

function weightsFor(job: JobSpec): ScoreBreakdown["weights"] {
  // The one documented, non-invented weight rule (architecture doc section 3): low risk
  // tolerance shifts weight toward risk avoidance. No other per-job customization exists.
  if (job.constraints.riskTolerance === "low") {
    return { feeEfficiency: 0.1, risk: 0.4, gas: 0.25, feasibility: 0.25 };
  }
  return { feeEfficiency: 0.25, risk: 0.25, gas: 0.25, feasibility: 0.25 };
}

export function evaluate(
  job: JobSpec,
  snapshot: MarketSnapshot,
  proposals: StrategyProposal[],
): EvaluationResult {
  const metrics = proposals.map((p) => computeMetrics(job, snapshot, p));
  const weights = weightsFor(job);

  const feeEffNorm = normalize(
    metrics.map((m) => m.estimatedFeeEfficiency),
    true,
  );
  const riskNorm = normalize(
    metrics.map((m) => m.riskScore),
    false, // lower risk is better
  );
  const gasNorm = normalize(
    metrics.map((m) => Number(m.estimatedGasWei)),
    false, // lower gas is better
  );
  const feasibilityNorm = metrics.map((m) => (m.executionFeasible ? 100 : 0));

  const scored: ScoredProposal[] = proposals.map((proposal, i) => {
    const normalized = {
      feeEfficiency: feeEffNorm[i],
      risk: riskNorm[i],
      gas: gasNorm[i],
      feasibility: feasibilityNorm[i],
    };
    const totalScore =
      weights.feeEfficiency * normalized.feeEfficiency +
      weights.risk * normalized.risk +
      weights.gas * normalized.gas +
      weights.feasibility * normalized.feasibility;

    return {
      proposal,
      metrics: metrics[i],
      score: { weights, normalized, totalScore },
      isWinner: false, // set below
    };
  });

  const winner = scored.reduce((best, current) => {
    if (current.score.totalScore > best.score.totalScore) return current;
    if (current.score.totalScore === best.score.totalScore) {
      return current.metrics.estimatedGasWei < best.metrics.estimatedGasWei ? current : best;
    }
    return best;
  });
  winner.isWinner = true;

  return { jobId: job.jobId, snapshot, scored, winner };
}

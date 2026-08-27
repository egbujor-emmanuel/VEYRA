// VEYRA Core evaluator, v2 ("v2-market-aware") -- docs/AGENT_ARENA_ARCHITECTURE.md section 3,
// revised. v1 (evaluator.ts) is UNCHANGED and remains the record of what actually produced
// Rounds #1-#7 -- this file does not modify it, only reuses its exported pure helpers
// (actionRange, widthDrivenMetric, normalize, weightsFor).
//
// ROOT CAUSE THIS FIXES (found empirically, not theoretically, before writing a line of this
// file): in v1, estimatedFeeEfficiency and riskScore were computed by calling the exact same
// width-only function. For any candidate v, that makes feeEfficiency_norm(v) + riskScore_norm(v)
// == 100 ALWAYS -- a mathematical identity, not a coincidence -- so these two metrics
// contribute an IDENTICAL amount to every candidate's total score in every round, regardless of
// market conditions. The ranking was therefore decided by gas + feasibility alone, and Hold's
// gas is always 0. No real price movement, of any size, could ever change the outcome. Verified
// empirically: price unchanged, price at the range edge, and price completely outside the
// range all produced the identical 75/100/75 split in v1.
//
// THE FIX: stop computing feeEfficiency and riskScore from the same single width signal. Add a
// genuine market-state-sensitive signal -- positioningScore, how well the CANDIDATE'S OWN
// proposed range (current range for hold, new range for rebalance) sits relative to the
// OBSERVED current tick, using ONLY fields already in MarketSnapshot. A candidate is not
// rewarded for "being a rebalance" -- it is rewarded for actually placing liquidity where the
// market currently is. Hold gets evaluated on ITS OWN (possibly now-stale) range exactly like
// every other candidate; if the market hasn't moved, hold's positioning is still 100 and it can
// still legitimately win. No rebalance bonus, no candidate-identity branching anywhere in this
// file -- same structural guarantee as v1 and as executionPolicy.ts.

import { actionRange, widthDrivenMetric, PLACEHOLDER_REBALANCE_GAS_WEI } from "./evaluator.js";
import { scoreProposals } from "./evaluatorKernel.js";
import type { JobSpec, MarketSnapshot, ScoreBreakdown, StrategyProposal } from "./types.js";

export interface ProposalMetricsV2 {
  estimatedGasWei: bigint;
  estimatedFeeEfficiency: number; // 0-100, BLENDED: 50% width-efficiency + 50% positioningScore (see below)
  estimatedSlippageBps: number;
  riskScore: number; // 0-100, BLENDED: 50% width-efficiency (narrower = riskier) + 50% (100 - positioningScore) (near/outside edge = riskier)
  executionFeasible: boolean;
  // Sub-components exposed for full transparency/audit -- not separately weighted, just so
  // "why did this score come out this way" never requires re-deriving the blend by hand.
  widthEfficiency: number; // 0-100, the same width-ratio heuristic v1 used alone
  positioningScore: number; // 0-100, how well the candidate's OWN range is centered on the OBSERVED current tick; 0 if the tick sits outside that range entirely
}

export interface ScoredProposalV2 {
  proposal: StrategyProposal;
  metrics: ProposalMetricsV2;
  score: ScoreBreakdown;
  isWinner: boolean;
}

export interface EvaluationResultV2 {
  evaluatorPolicy: "v2-market-aware";
  jobId: string;
  snapshot: MarketSnapshot;
  scored: ScoredProposalV2[];
  winner: ScoredProposalV2;
}

/**
 * How well [tickLower, tickUpper) is centered on currentTick, as a pure function of OBSERVED
 * inputs -- no history, no projection. 100 = currentTick exactly at the range's center; 0 =
 * currentTick at (or past) an edge, i.e. the range is currently earning zero real fees.
 */
export function positioningScore(tickLower: number, tickUpper: number, currentTick: number): number {
  if (currentTick < tickLower || currentTick >= tickUpper) return 0;
  const halfWidth = (tickUpper - tickLower) / 2;
  const center = (tickLower + tickUpper) / 2;
  const distanceFromCenter = Math.abs(currentTick - center);
  const centeredness = 1 - distanceFromCenter / halfWidth;
  return Math.max(0, Math.min(100, centeredness * 100));
}

export function computeMetricsV2(job: JobSpec, snapshot: MarketSnapshot, proposal: StrategyProposal): ProposalMetricsV2 {
  const range = actionRange(proposal, snapshot);
  const widthTicks = range.tickUpper - range.tickLower;

  const widthEfficiency = widthDrivenMetric(widthTicks, snapshot.tickSpacing);
  const posScore = positioningScore(range.tickLower, range.tickUpper, snapshot.currentTick);

  const estimatedFeeEfficiency = 0.5 * widthEfficiency + 0.5 * posScore;
  const riskScore = 0.5 * widthEfficiency + 0.5 * (100 - posScore);

  const estimatedGasWei = proposal.proposedAction.kind === "hold" ? 0n : PLACEHOLDER_REBALANCE_GAS_WEI;
  // Same documented gap as v1 -- an off-center rebalance requiring a ratio-fixing swap leg
  // would need real slippage modeling here; MVP strategies always center on the current tick.
  const estimatedSlippageBps = 0;
  const executionFeasible = estimatedGasWei <= job.constraints.maxSpendWei && estimatedSlippageBps <= job.constraints.maxSlippageBps;

  return { estimatedGasWei, estimatedFeeEfficiency, estimatedSlippageBps, riskScore, executionFeasible, widthEfficiency, positioningScore: posScore };
}

/** Same weighting rule as v1 (weightsFor is reused, not reimplemented) -- only the metrics feeding it changed. */
export function evaluateV2(job: JobSpec, snapshot: MarketSnapshot, proposals: StrategyProposal[]): EvaluationResultV2 {
  const metrics = proposals.map((p) => computeMetricsV2(job, snapshot, p));
  const { scored, winner } = scoreProposals(job, proposals, metrics);
  return { evaluatorPolicy: "v2-market-aware", jobId: job.jobId, snapshot, scored, winner };
}

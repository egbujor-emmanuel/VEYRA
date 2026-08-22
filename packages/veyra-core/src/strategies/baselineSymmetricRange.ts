import type { StrategyFn, StrategyProposal } from "../types.js";
import { roundToTickSpacing } from "../tickMath.js";

// Naive fixed-width symmetric range around current price. No volatility awareness, no LLM
// involvement at all -- a deliberately simple, deterministic reference point.
const FIXED_HALF_WIDTH_SPACINGS = 20;

export const baselineSymmetricRangeStrategy: StrategyFn = async (
  _job,
  snapshot,
): Promise<StrategyProposal> => {
  const halfWidthTicks = snapshot.tickSpacing * FIXED_HALF_WIDTH_SPACINGS;
  const tickLower = roundToTickSpacing(snapshot.currentTick - halfWidthTicks, snapshot.tickSpacing);
  const tickUpper = roundToTickSpacing(snapshot.currentTick + halfWidthTicks, snapshot.tickSpacing);

  return {
    candidateId: "baseline-symmetric-range",
    displayLabel: "Baseline Strategy",
    agentIdOnChain: null,
    proposedAction: { kind: "rebalance", newRange: { tickLower, tickUpper } },
    rationale: `Fixed ${FIXED_HALF_WIDTH_SPACINGS * 2}-tick-spacing-wide symmetric range around current price, no volatility adjustment.`,
  };
};

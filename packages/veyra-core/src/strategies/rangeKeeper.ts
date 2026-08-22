import type { JobSpec, MarketSnapshot, StrategyFn, StrategyProposal } from "../types.js";
import { roundToTickSpacing } from "../tickMath.js";

// VEYRA Agent's real strategy: deterministic, volatility-aware range width, centered on the
// current tick. The number is a formula output, not an LLM guess -- `rationale` may narrate it,
// but the tick math below is what actually produces `proposedAction`.
const BASE_HALF_WIDTH_SPACINGS = 20; // half-width in units of tickSpacing at zero observed volatility

export const AGENT_ID_ON_CHAIN_PLACEHOLDER = null; // set to the real registered agentId once §5 registration lands

export const rangeKeeperStrategy: StrategyFn = async (
  job: JobSpec,
  snapshot: MarketSnapshot,
): Promise<StrategyProposal> => {
  const volatilityFactor = 1 + snapshot.recentVolatilityBps / 10_000;
  const halfWidthTicks = snapshot.tickSpacing * BASE_HALF_WIDTH_SPACINGS * volatilityFactor;

  const tickLower = roundToTickSpacing(snapshot.currentTick - halfWidthTicks, snapshot.tickSpacing);
  const tickUpper = roundToTickSpacing(snapshot.currentTick + halfWidthTicks, snapshot.tickSpacing);

  return {
    candidateId: "rangekeeper-v1",
    displayLabel: "Our Agent",
    agentIdOnChain: AGENT_ID_ON_CHAIN_PLACEHOLDER,
    proposedAction: { kind: "rebalance", newRange: { tickLower, tickUpper } },
    rationale:
      `Centered a ${(halfWidthTicks * 2).toFixed(0)}-tick-wide range on the current tick, ` +
      `widened for recent volatility of ${snapshot.recentVolatilityBps} bps (risk tolerance: ${job.constraints.riskTolerance}).`,
  };
};

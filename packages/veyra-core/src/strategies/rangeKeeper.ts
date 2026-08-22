import type { JobSpec, MarketSnapshot, StrategyFn, StrategyProposal } from "../types.js";
import { roundToTickSpacing } from "../tickMath.js";

// VEYRA Agent's real strategy: deterministic, volatility-aware range width, centered on the
// current tick. The number is a formula output, not an LLM guess -- `rationale` may narrate it,
// but the tick math below is what actually produces `proposedAction`.
const BASE_HALF_WIDTH_SPACINGS = 20; // half-width in units of tickSpacing at zero observed volatility

// Registered on BSC testnet 2026-08-22 via packages/veyra-chain/scripts/registerVeyraAgent.ts.
// tx 0x121ddee38632fdd2dfba550d7735c8432d06ae9225dbf53c34fa3016f63d2aaf, owner-verified via
// an independent ownerOf(1890) read against the registry (0x8004A818...4BD9e).
export const VEYRA_AGENT_ID_ON_CHAIN = 1890;

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
    agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
    proposedAction: { kind: "rebalance", newRange: { tickLower, tickUpper } },
    rationale:
      `Centered a ${(halfWidthTicks * 2).toFixed(0)}-tick-wide range on the current tick, ` +
      `widened for recent volatility of ${snapshot.recentVolatilityBps} bps (risk tolerance: ${job.constraints.riskTolerance}).`,
  };
};

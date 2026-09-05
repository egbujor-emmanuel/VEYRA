import type { JobSpec, MarketSnapshot, StrategyFn, StrategyProposal } from "../types.js";
import { roundToTickSpacing } from "../tickMath.js";
import { positioningScore } from "../evaluatorV2.js";

// VEYRA Agent's real strategy: deterministic, volatility-aware range width, centered on the
// current tick. The number is a formula output, not an LLM guess -- `rationale` may narrate it,
// but the tick math below is what actually produces `proposedAction`.
const BASE_HALF_WIDTH_SPACINGS = 20; // half-width in units of tickSpacing at zero observed volatility

/**
 * Below this centeredness, a position is worth repositioning; at or above it, it is not.
 *
 * Why this exists at all: for seven recorded rounds this strategy proposed a byte-identical range
 * to baseline-symmetric-range and tied it on every scored axis. That was not a weakness in the
 * scoring -- the two were literally the same function. Both computed
 * `tickSpacing * 20` half-width centered on the current tick, and the one thing that was supposed
 * to separate them, a volatility multiplier, is exactly 1 whenever volatility is unobserved. On a
 * pool whose oracle cardinality is 1, it is always unobserved. So "our agent" was a naive
 * symmetric baseline wearing a different name.
 *
 * A real strategy has to differ in what it DOES, not only in how wide it draws. This one declines
 * to pay for a reposition that buys little: a position whose price still sits in the middle half
 * of its range is working, and moving it costs a full decrease/collect/swap/mint cycle to gain a
 * few points of centeredness. That is the same principle the grid ladder applies to slot drift.
 */
const HOLD_WHEN_CENTEREDNESS_AT_LEAST = 50;

/**
 * How far the price has overshot the range, as a fraction of that range's half-width.
 *
 * This is the strategy's one genuinely OBSERVED input, and it exists because the input it was
 * supposed to use is not observable here. `recentVolatilityBps` is supplied by the caller, and
 * every caller in this repo supplies 0 -- the archives label it SUPPLIED_NOT_OBSERVED, honestly.
 * It cannot be filled in from the pool either: these pools carry observationCardinality 1, so
 * `observe()` returns the current tick for every window and there is no history to measure. With
 * that multiplier pinned at 1, the width formula collapsed to `tickSpacing * 20` -- byte-identical
 * to baseline-symmetric-range.
 *
 * Overshoot is different: it is right there in the snapshot, read from chain. A price that has
 * pushed far past its range is evidence of a larger move than one that has just slipped over the
 * edge, and drawing a wider range in response is the standard reaction to that evidence. It is a
 * deterministic function of observed state, not a guess, and it is capped so a single violent move
 * cannot widen the range without limit.
 */
const MAX_OVERSHOOT_WIDENING = 1.0; // at most double the base half-width

function overshootWidening(snapshot: MarketSnapshot): { factor: number; overshootTicks: number } {
  const { tickLower, tickUpper } = snapshot.currentRange;
  const overshootTicks =
    snapshot.currentTick < tickLower
      ? tickLower - snapshot.currentTick
      : snapshot.currentTick >= tickUpper
        ? snapshot.currentTick - tickUpper + 1
        : 0;
  const halfWidth = (tickUpper - tickLower) / 2;
  if (halfWidth <= 0 || overshootTicks <= 0) return { factor: 1, overshootTicks: 0 };
  return { factor: 1 + Math.min(overshootTicks / halfWidth, MAX_OVERSHOOT_WIDENING), overshootTicks };
}

// Registered on BSC testnet 2026-08-22 via packages/veyra-chain/scripts/registerVeyraAgent.ts.
// tx 0x121ddee38632fdd2dfba550d7735c8432d06ae9225dbf53c34fa3016f63d2aaf, owner-verified via
// an independent ownerOf(1890) read against the registry (0x8004A818...4BD9e).
export const VEYRA_AGENT_ID_ON_CHAIN = 1890;

export const rangeKeeperStrategy: StrategyFn = async (
  job: JobSpec,
  snapshot: MarketSnapshot,
): Promise<StrategyProposal> => {
  const centeredness = positioningScore(
    snapshot.currentRange.tickLower,
    snapshot.currentRange.tickUpper,
    snapshot.currentTick,
  );

  if (centeredness >= HOLD_WHEN_CENTEREDNESS_AT_LEAST) {
    return {
      candidateId: "rangekeeper-v1",
      displayLabel: "Our Agent",
      agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
      proposedAction: { kind: "hold" },
      rationale:
        `Price sits at ${centeredness.toFixed(0)}% centeredness within the existing range ` +
        `[${snapshot.currentRange.tickLower}, ${snapshot.currentRange.tickUpper}) -- still in the middle half. ` +
        `Repositioning would cost a full decrease/collect/swap/mint cycle to buy a few points of ` +
        `centeredness, so the range is left where it is.`,
    };
  }

  const volatilityFactor = 1 + snapshot.recentVolatilityBps / 10_000;
  const { factor: driftFactor, overshootTicks } = overshootWidening(snapshot);
  const halfWidthTicks = snapshot.tickSpacing * BASE_HALF_WIDTH_SPACINGS * volatilityFactor * driftFactor;

  const tickLower = roundToTickSpacing(snapshot.currentTick - halfWidthTicks, snapshot.tickSpacing);
  const tickUpper = roundToTickSpacing(snapshot.currentTick + halfWidthTicks, snapshot.tickSpacing);

  return {
    candidateId: "rangekeeper-v1",
    displayLabel: "Our Agent",
    agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
    proposedAction: { kind: "rebalance", newRange: { tickLower, tickUpper } },
    rationale:
      `Price is at ${centeredness.toFixed(0)}% centeredness in the existing range -- outside the middle half, ` +
      `so the position is no longer working hard enough to leave alone. ` +
      `Centered a ${(halfWidthTicks * 2).toFixed(0)}-tick-wide range on the current tick, ` +
      `widened ${((driftFactor - 1) * 100).toFixed(0)}% for an observed ${overshootTicks}-tick overshoot past the old range ` +
      `and ${snapshot.recentVolatilityBps} bps of supplied volatility (risk tolerance: ${job.constraints.riskTolerance}).`,
  };
};

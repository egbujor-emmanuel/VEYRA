import type { GridRebalanceAction, ProposedAction } from "../types.js";
import type { GridMarketSnapshot, GridStrategyFn } from "../gridSnapshot.js";
import { roundToTickSpacing } from "../tickMath.js";
import { VEYRA_AGENT_ID_ON_CHAIN } from "./rangeKeeper.js";

// Grid Trading strategy: a fixed ladder of narrow slots tiled around the current tick, each
// SLOT_STEP_SPACINGS*tickSpacing apart -- not one wide range like rangeKeeper. Only slots that
// are BOTH currently out-of-range AND drifted from where the ladder would now place them get
// re-centered; an in-range slot is left alone even if the ladder shifted slightly, the same way a
// real grid bot doesn't cancel-and-replace an order that hasn't been touched by price.
const SLOT_HALF_WIDTH_SPACINGS = 4; // narrow per-slot band -- a grid trades on frequent small moves
const SLOT_STEP_SPACINGS = 8; // center-to-center spacing between adjacent slots, in tickSpacing units

export const gridKeeperStrategy: GridStrategyFn = async (
  _job,
  snapshot: GridMarketSnapshot,
): Promise<import("../types.js").StrategyProposal> => {
  const n = snapshot.slots.length;
  const tickSpacing = snapshot.slots[0]!.tickSpacing;
  const currentTick = snapshot.slots[0]!.currentTick; // one pool -- every slot observes the same tick

  const slotAdjustments: GridRebalanceAction["slotAdjustments"] = [];

  for (let i = 0; i < n; i++) {
    const offsetSlots = i - (n - 1) / 2;
    const center = currentTick + offsetSlots * SLOT_STEP_SPACINGS * tickSpacing;
    const halfWidthTicks = SLOT_HALF_WIDTH_SPACINGS * tickSpacing;
    const targetLower = roundToTickSpacing(center - halfWidthTicks, tickSpacing);
    const targetUpper = roundToTickSpacing(center + halfWidthTicks, tickSpacing);

    const slot = snapshot.slots[i]!;
    const currentlyOutOfRange = currentTick < slot.currentRange.tickLower || currentTick >= slot.currentRange.tickUpper;
    const driftedFromTarget = slot.currentRange.tickLower !== targetLower || slot.currentRange.tickUpper !== targetUpper;

    if (currentlyOutOfRange && driftedFromTarget) {
      slotAdjustments.push({ slotIndex: i, newRange: { tickLower: targetLower, tickUpper: targetUpper } });
    }
  }

  const proposedAction: ProposedAction =
    slotAdjustments.length > 0 ? { kind: "grid-rebalance", slotAdjustments } : { kind: "hold" };

  return {
    candidateId: "gridkeeper-v1",
    displayLabel: "Our Agent",
    agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
    proposedAction,
    rationale:
      slotAdjustments.length > 0
        ? `${slotAdjustments.length} of ${n} grid slot(s) drifted out of range around current tick ${currentTick}; recentering.`
        : `All ${n} grid slots remain in range around current tick ${currentTick}; no action needed.`,
  };
};

/** Baseline candidate: never adjusts anything -- mirrors baselineHoldStrategy's role for rebalancing. */
export const baselineHoldGridStrategy: GridStrategyFn = async (): Promise<import("../types.js").StrategyProposal> => ({
  candidateId: "baseline-hold-grid",
  displayLabel: "Baseline Strategy",
  agentIdOnChain: null,
  proposedAction: { kind: "hold" },
  rationale: "Baseline: never adjusts the grid, regardless of market conditions.",
});

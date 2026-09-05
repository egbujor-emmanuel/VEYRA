import type { GridRebalanceAction, ProposedAction } from "../types.js";
import type { GridMarketSnapshot, GridStrategyFn } from "../gridSnapshot.js";
import { floorToTickSpacing } from "../tickMath.js";
import { VEYRA_AGENT_ID_ON_CHAIN } from "./rangeKeeper.js";

// Grid Trading strategy: a fixed ladder of narrow slots tiled around the current tick, each
// SLOT_STEP_SPACINGS*tickSpacing apart -- not one wide range like rangeKeeper. Only slots that
// are BOTH currently out-of-range AND drifted from where the ladder would now place them get
// re-centered; an in-range slot is left alone even if the ladder shifted slightly, the same way a
// real grid bot doesn't cancel-and-replace an order that hasn't been touched by price.
const SLOT_HALF_WIDTH_SPACINGS = 4; // narrow per-slot band -- a grid trades on frequent small moves
const SLOT_STEP_SPACINGS = 8; // center-to-center spacing between adjacent slots, in tickSpacing units

/**
 * Every slot is placed strictly on ONE side of the current tick, never straddling it.
 *
 * This is what a grid is: each slot is a resting one-sided order. A slot entirely below the
 * current tick holds only token1; entirely above, only token0. Keeping that property is not a
 * cosmetic nicety -- it is what makes a slot mintable from the proceeds of unwinding it, with no
 * swap in between.
 *
 * It was not always kept. The bounds were rounded to NEAREST spacing, which could push a lower
 * slot's upper bound past the current tick and turn it into a straddling, two-token range. That
 * forced the executor into a ratio-fixing swap, and against this pool -- thin enough that the swap
 * moved the price out from under the plan -- the post-swap ratio check correctly refused to mint.
 * The result, observed in production on 2026-09-04, was slot 0 left decreased, collected, and
 * unminted. Rounding away from the current tick removes the swap from the path entirely.
 */
/**
 * Which token a range holds, given where the price is. A V3 range entirely above the current tick
 * is unfilled token0; entirely below, it has been fully converted to token1.
 */
function sideOf(tickLower: number, tickUpper: number, currentTick: number): "token0" | "token1" | "both" {
  if (currentTick >= tickUpper) return "token1";
  if (currentTick < tickLower) return "token0";
  return "both";
}

function oneSidedRange(
  centerTick: number,
  halfWidthTicks: number,
  currentTick: number,
  tickSpacing: number,
): { tickLower: number; tickUpper: number } {
  const boundary = floorToTickSpacing(currentTick, tickSpacing);
  if (centerTick < currentTick) {
    // Below: clamp the upper bound to at most the boundary at/below the current tick, so
    // currentTick >= tickUpper and the position is entirely token1.
    const tickUpper = Math.min(floorToTickSpacing(centerTick + halfWidthTicks, tickSpacing), boundary);
    return { tickLower: floorToTickSpacing(centerTick - halfWidthTicks, tickSpacing), tickUpper };
  }
  // Above: the range is half-open [lower, upper), so the position is entirely token0 exactly when
  // currentTick < tickLower -- one spacing past the boundary, never equal to it.
  const tickLower = Math.max(floorToTickSpacing(centerTick - halfWidthTicks, tickSpacing), boundary + tickSpacing);
  return { tickLower, tickUpper: floorToTickSpacing(centerTick + halfWidthTicks, tickSpacing) + tickSpacing };
}

export const gridKeeperStrategy: GridStrategyFn = async (
  _job,
  snapshot: GridMarketSnapshot,
): Promise<import("../types.js").StrategyProposal> => {
  const n = snapshot.slots.length;
  const tickSpacing = snapshot.slots[0]!.tickSpacing;
  const currentTick = snapshot.slots[0]!.currentTick; // one pool -- every slot observes the same tick

  const slotAdjustments: GridRebalanceAction["slotAdjustments"] = [];
  /** Slots that drifted but whose repositioning would have required a swap -- see below. */
  const skippedForSwap: number[] = [];

  for (let i = 0; i < n; i++) {
    // Half-integer offsets, so the current price falls in the GAP between two slots rather than
    // inside one. With an odd slot count a perfectly symmetric ladder would put one slot centered
    // on the price -- which is the one placement a grid should never make, since it is neither a
    // resting bid nor a resting ask. Odd ladders therefore lean one slot to the buy side, which is
    // a deliberate asymmetry rather than an accident of rounding.
    const offsetSlots = i - (n - 1) / 2 - (n % 2 === 1 ? 0.5 : 0);
    const center = currentTick + offsetSlots * SLOT_STEP_SPACINGS * tickSpacing;
    const halfWidthTicks = SLOT_HALF_WIDTH_SPACINGS * tickSpacing;
    const { tickLower: targetLower, tickUpper: targetUpper } = oneSidedRange(
      center,
      halfWidthTicks,
      currentTick,
      tickSpacing,
    );

    const slot = snapshot.slots[i]!;
    const currentlyOutOfRange = currentTick < slot.currentRange.tickLower || currentTick >= slot.currentRange.tickUpper;

    // Drift has to be MEANINGFUL, not merely nonzero.
    //
    // The ladder is recomputed from the live tick, so its bounds shift by one tickSpacing for
    // every tickSpacing the price moves. Comparing for exact inequality therefore proposed a
    // recentering on essentially any price movement at all -- paying a full decrease/collect/mint
    // cycle to shift a slot by a single spacing. A slot has to be at least half a ladder step away
    // from where it belongs before moving it is worth the gas.
    const driftTicks = Math.max(
      Math.abs(slot.currentRange.tickLower - targetLower),
      Math.abs(slot.currentRange.tickUpper - targetUpper),
    );
    const driftedFromTarget = driftTicks >= (SLOT_STEP_SPACINGS * tickSpacing) / 2;

    // Never propose a move that would need a token swap to complete.
    //
    // Unwinding a slot returns whichever token it currently holds; minting the target consumes
    // whichever the target needs. When those differ, the executor has to swap in between -- and
    // against a pool this thin the swap moves the price out from under the plan, so the post-swap
    // ratio check refuses to mint and the capital is left sitting unminted. That is not
    // hypothetical: it happened to slot 0 on 2026-09-04.
    //
    // Holding is the right answer here rather than attempting it and hoping. The slot stays where
    // it is, still holding its capital, and the rationale says why it was skipped.
    const holds = sideOf(slot.currentRange.tickLower, slot.currentRange.tickUpper, currentTick);
    const needs = sideOf(targetLower, targetUpper, currentTick);
    const wouldNeedSwap = holds !== "both" && needs !== "both" && holds !== needs;

    if (currentlyOutOfRange && driftedFromTarget) {
      if (wouldNeedSwap) {
        skippedForSwap.push(i);
      } else {
        slotAdjustments.push({ slotIndex: i, newRange: { tickLower: targetLower, tickUpper: targetUpper } });
      }
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
      (slotAdjustments.length > 0
        ? `${slotAdjustments.length} of ${n} grid slot(s) drifted out of range around current tick ${currentTick}; recentering.`
        : `No grid slot needs repositioning around current tick ${currentTick}.`) +
      (skippedForSwap.length > 0
        ? ` Slot(s) ${skippedForSwap.join(", ")} drifted but were left alone: repositioning them would need a token swap, and this pool is too thin to swap through without moving the price out from under the mint.`
        : ""),
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

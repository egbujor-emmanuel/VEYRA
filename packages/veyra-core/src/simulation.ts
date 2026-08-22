// Pure simulation checks (architecture doc's Slice 2): everything here is deterministic math
// over already-OBSERVED/already-PLANNED inputs. No RPC call, no signer, no transaction --
// live eth_estimateGas validity for decreaseLiquidity/collect is a SEPARATE concern that lives
// in @veyra/chain (it needs a network client; this module must not).
//
// Three separate responsibilities, kept separate on purpose (per the instruction that produced
// this file): the EVALUATOR decides what looks best; the PLANNER (execution.ts) determines
// what would have to happen; THIS module determines whether that plan is actually safe/valid
// enough to execute. A high-scoring proposal and an executable transaction plan are not the
// same claim.

import { getAmountsForLiquidity, getLiquidityForAmounts } from "./tickMath.js";
import type { ExecutionPlan } from "./execution.js";

const MIN_TICK = -887272;
const MAX_TICK = 887272;

// Policy constant, not a discovered truth: how much of either token may go unused/refunded by
// mint() before we call the ratio mismatch a real problem rather than integer-rounding noise.
// 1% is a deliberately conservative, clearly-labeled choice -- there is no "correct" answer
// without knowing the actual capital amounts involved, which MVP does not have (see execution.ts).
export const RATIO_MISMATCH_THRESHOLD = 0.01;

export type StepStatus = "VALID" | "INVALID" | "NOT_APPLICABLE" | "NOT_ATTEMPTED";

export interface RangeValidityCheck {
  status: StepStatus;
  detail: string;
}

export interface RatioAdjustmentCheck {
  status: "NOT_IMPLEMENTED" | "NOT_APPLICABLE";
  strandedAmount0: bigint;
  strandedAmount1: bigint;
  strandedFraction0: number; // 0..1, stranded relative to amount0Desired (0 when amount0Desired is 0)
  strandedFraction1: number;
  ratioFixRequired: boolean; // true when either stranded fraction exceeds RATIO_MISMATCH_THRESHOLD
  detail: string;
}

export interface SlippageProtectionCheck {
  status: StepStatus;
  detail: string;
}

export interface PureSimulationResult {
  jobId: string;
  candidateId: string;
  positionTokenId: number;
  action: "HOLD" | "REBALANCE";
  oldRange: { tickLower: number; tickUpper: number } | null;
  targetRange: { tickLower: number; tickUpper: number } | null;
  targetRangeValidity: RangeValidityCheck;
  mintStructuralValidity: RangeValidityCheck;
  ratioAdjustment: RatioAdjustmentCheck;
  slippageProtection: SlippageProtectionCheck;
  // Pure-only executability: does NOT reflect live decreaseLiquidity/collect gas simulation --
  // @veyra/chain's simulate.ts ANDs this with its own live-RPC checks before reporting a final
  // executable verdict. This field is deliberately allowed to say true while the live layer
  // still says false (e.g. an RPC-only revert this module cannot see) -- never the reverse
  // silently: nothing downstream may flip an INVALID pure check back to true.
  pureExecutable: boolean;
  pureExecutableReasons: string[];
  status: "SIMULATED";
}

export interface SimulatePlanOpts {
  plan: ExecutionPlan;
  currentSqrtPriceX96: bigint;
  tickSpacing: number;
}

function isDivisibleByTickSpacing(tick: number, tickSpacing: number): boolean {
  return tick % tickSpacing === 0;
}

function checkTargetRangeValidity(
  targetRange: { tickLower: number; tickUpper: number } | null,
  tickSpacing: number,
): RangeValidityCheck {
  if (targetRange === null) {
    return { status: "NOT_APPLICABLE", detail: "hold proposes no new range" };
  }
  const reasons: string[] = [];
  if (targetRange.tickLower >= targetRange.tickUpper) {
    reasons.push(`tickLower ${targetRange.tickLower} >= tickUpper ${targetRange.tickUpper}`);
  }
  if (targetRange.tickLower < MIN_TICK || targetRange.tickUpper > MAX_TICK) {
    reasons.push(`range [${targetRange.tickLower}, ${targetRange.tickUpper}) exceeds [${MIN_TICK}, ${MAX_TICK}]`);
  }
  if (!isDivisibleByTickSpacing(targetRange.tickLower, tickSpacing)) {
    reasons.push(`tickLower ${targetRange.tickLower} is not a multiple of tickSpacing ${tickSpacing}`);
  }
  if (!isDivisibleByTickSpacing(targetRange.tickUpper, tickSpacing)) {
    reasons.push(`tickUpper ${targetRange.tickUpper} is not a multiple of tickSpacing ${tickSpacing}`);
  }
  return reasons.length === 0
    ? { status: "VALID", detail: `[${targetRange.tickLower}, ${targetRange.tickUpper}) is a valid, tick-spacing-aligned range` }
    : { status: "INVALID", detail: reasons.join("; ") };
}

function checkMintStructuralValidity(plan: ExecutionPlan): RangeValidityCheck {
  const mintStep = plan.steps.find((s) => s.kind === "mint");
  if (!mintStep) {
    return { status: "NOT_APPLICABLE", detail: "hold proposes no mint" };
  }
  const mint = mintStep as Extract<ExecutionPlan["steps"][number], { kind: "mint" }>;
  const reasons: string[] = [];
  if (mint.token0.toLowerCase() >= mint.token1.toLowerCase()) {
    reasons.push(`token0 ${mint.token0} must sort strictly before token1 ${mint.token1} (Uniswap V3 pool-key ordering)`);
  }
  if (mint.amount0Desired === 0n && mint.amount1Desired === 0n) {
    reasons.push("both amount0Desired and amount1Desired are zero -- nothing to mint");
  }
  return reasons.length === 0
    ? { status: "VALID", detail: "token ordering and non-zero amounts confirmed" }
    : { status: "INVALID", detail: reasons.join("; ") };
}

/**
 * Quantifies the ratio-fixing swap gap already documented in execution.ts: how much of the
 * decreased position's token0/token1 would actually go unused (refunded, per real mint()
 * behavior) if minted into the target range at the current price with NO intervening swap.
 * Real math (the same formula the contract runs), not a guess -- see tickMath.ts.
 */
function checkRatioAdjustment(
  plan: ExecutionPlan,
  currentSqrtPriceX96: bigint,
): RatioAdjustmentCheck {
  if (plan.targetRange === null) {
    return {
      status: "NOT_APPLICABLE",
      strandedAmount0: 0n,
      strandedAmount1: 0n,
      strandedFraction0: 0,
      strandedFraction1: 0,
      ratioFixRequired: false,
      detail: "hold proposes no re-mint, so no ratio to fix",
    };
  }

  const { amount0: desired0, amount1: desired1 } = plan.expectedAmounts;
  const achievableLiquidity = getLiquidityForAmounts(
    currentSqrtPriceX96,
    plan.targetRange.tickLower,
    plan.targetRange.tickUpper,
    desired0,
    desired1,
  );
  const consumed = getAmountsForLiquidity(
    currentSqrtPriceX96,
    plan.targetRange.tickLower,
    plan.targetRange.tickUpper,
    achievableLiquidity,
  );

  const stranded0 = desired0 - consumed.amount0;
  const stranded1 = desired1 - consumed.amount1;
  const fraction0 = desired0 === 0n ? 0 : Number(stranded0) / Number(desired0);
  const fraction1 = desired1 === 0n ? 0 : Number(stranded1) / Number(desired1);
  const ratioFixRequired = fraction0 > RATIO_MISMATCH_THRESHOLD || fraction1 > RATIO_MISMATCH_THRESHOLD;

  return {
    status: "NOT_IMPLEMENTED", // VEYRA never implements the ratio-fixing swap in this slice -- always state that plainly
    strandedAmount0: stranded0,
    strandedAmount1: stranded1,
    strandedFraction0: fraction0,
    strandedFraction1: fraction1,
    ratioFixRequired,
    detail: ratioFixRequired
      ? `without a ratio-fixing swap, ~${(fraction0 * 100).toFixed(1)}% of token0 and ~${(fraction1 * 100).toFixed(1)}% of token1 would be stranded/refunded by mint() -- the held ratio does not match what [${plan.targetRange.tickLower}, ${plan.targetRange.tickUpper}) needs at the current price`
      : `held ratio is close enough to what the target range needs at the current price (both stranded fractions <= ${RATIO_MISMATCH_THRESHOLD * 100}%)`,
  };
}

function checkSlippageProtection(plan: ExecutionPlan): SlippageProtectionCheck {
  const decreaseStep = plan.steps.find((s) => s.kind === "decreaseLiquidity");
  if (!decreaseStep) {
    return { status: "NOT_APPLICABLE", detail: "hold has nothing to protect against slippage" };
  }
  const decrease = decreaseStep as Extract<ExecutionPlan["steps"][number], { kind: "decreaseLiquidity" }>;
  const mint = plan.steps.find((s) => s.kind === "mint") as Extract<ExecutionPlan["steps"][number], { kind: "mint" }> | undefined;

  const reasons: string[] = [];
  if (decrease.amount0Min === 0n && plan.expectedAmounts.amount0 > 0n) {
    reasons.push("decreaseLiquidity.amount0Min is zero despite a nonzero expected amount0 -- no floor protection");
  }
  if (decrease.amount1Min === 0n && plan.expectedAmounts.amount1 > 0n) {
    reasons.push("decreaseLiquidity.amount1Min is zero despite a nonzero expected amount1 -- no floor protection");
  }
  if (mint && mint.amount0Min === 0n && mint.amount0Desired > 0n) {
    reasons.push("mint.amount0Min is zero despite a nonzero amount0Desired -- no floor protection");
  }
  if (mint && mint.amount1Min === 0n && mint.amount1Desired > 0n) {
    reasons.push("mint.amount1Min is zero despite a nonzero amount1Desired -- no floor protection");
  }
  return reasons.length === 0
    ? { status: "VALID", detail: "amount0Min/amount1Min are nonzero wherever a nonzero amount is expected" }
    : { status: "INVALID", detail: reasons.join("; ") };
}

export function simulatePlan(opts: SimulatePlanOpts): PureSimulationResult {
  const { plan, currentSqrtPriceX96, tickSpacing } = opts;

  if (plan.targetRange === null) {
    // Hold: a genuine no-op simulation. Every check is NOT_APPLICABLE -- this is not a
    // manufactured success, there is simply nothing to validate.
    return {
      jobId: plan.jobId,
      candidateId: plan.candidateId,
      positionTokenId: plan.positionTokenId,
      action: "HOLD",
      oldRange: plan.currentRange,
      targetRange: null,
      targetRangeValidity: { status: "NOT_APPLICABLE", detail: "hold proposes no new range" },
      mintStructuralValidity: { status: "NOT_APPLICABLE", detail: "hold proposes no mint" },
      ratioAdjustment: checkRatioAdjustment(plan, currentSqrtPriceX96),
      slippageProtection: { status: "NOT_APPLICABLE", detail: "hold has nothing to protect against slippage" },
      pureExecutable: true,
      pureExecutableReasons: [],
      status: "SIMULATED",
    };
  }

  const targetRangeValidity = checkTargetRangeValidity(plan.targetRange, tickSpacing);
  const mintStructuralValidity = checkMintStructuralValidity(plan);
  const ratioAdjustment = checkRatioAdjustment(plan, currentSqrtPriceX96);
  const slippageProtection = checkSlippageProtection(plan);

  const pureExecutableReasons: string[] = [];
  if (targetRangeValidity.status === "INVALID") pureExecutableReasons.push(`target range invalid: ${targetRangeValidity.detail}`);
  if (mintStructuralValidity.status === "INVALID") pureExecutableReasons.push(`mint structurally invalid: ${mintStructuralValidity.detail}`);
  if (slippageProtection.status === "INVALID") pureExecutableReasons.push(`slippage protection missing: ${slippageProtection.detail}`);
  if (ratioAdjustment.ratioFixRequired) {
    pureExecutableReasons.push(
      `ratio-fixing swap required but not implemented: ${ratioAdjustment.detail}`,
    );
  }
  if (!plan.feasible) pureExecutableReasons.push(...plan.feasibilityReasons);

  return {
    jobId: plan.jobId,
    candidateId: plan.candidateId,
    positionTokenId: plan.positionTokenId,
    action: "REBALANCE",
    oldRange: plan.currentRange,
    targetRange: plan.targetRange,
    targetRangeValidity,
    mintStructuralValidity,
    ratioAdjustment,
    slippageProtection,
    pureExecutable: pureExecutableReasons.length === 0,
    pureExecutableReasons,
    status: "SIMULATED",
  };
}

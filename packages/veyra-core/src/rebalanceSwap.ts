// Ratio-fixing swap requirement (closes the gap Test B exposed, RECON/architecture doc's
// documented limitation since Slice 2). Pure function: no RPC call, no quote, no signer -- just
// the closed-form math for "how much of which token needs to move so the collected amounts can
// actually fund the target range." @veyra/chain is responsible for turning this into a REAL
// quote (QuoterV2) and a REAL amountOutMinimum before ever signing anything; nothing in this
// file's output should be used directly as an on-chain slippage floor.
//
// Math: ignores the swap's own price impact (a first-order approximation -- solving for the
// swap that exactly zeroes out price impact too is a harder, iterative problem this MVP does
// not attempt). This is deliberately NOT the last word on safety: the caller MUST re-validate
// the ACTUAL post-swap balances (not this estimate) against the same stranded-fraction check
// before minting, and refuse to mint if they're still outside tolerance. This function's
// `projected*` fields are a planning-time preview of that same check, not a substitute for it.

import { getAmountsForLiquidity, getLiquidityForAmounts } from "./tickMath.js";
import { RATIO_MISMATCH_THRESHOLD } from "./simulation.js";

export type SwapDirection = "NO_SWAP_REQUIRED" | "SWAP_TOKEN0_FOR_TOKEN1" | "SWAP_TOKEN1_FOR_TOKEN0";

export interface RebalanceSwapRequirement {
  direction: SwapDirection;
  amountIn: bigint; // 0n when NO_SWAP_REQUIRED
  // Pre-quote estimate ONLY (ignores pool fee and price impact) -- @veyra/chain must replace
  // this with a real QuoterV2 quote before sizing amountOutMinimum for an actual transaction.
  estimatedAmountOut: bigint;
  projectedAmount0AfterSwap: bigint;
  projectedAmount1AfterSwap: bigint;
  projectedStrandedFraction0: number;
  projectedStrandedFraction1: number;
  // Whether THIS estimate projects a mint that would clear the ratio-mismatch threshold. Not a
  // guarantee -- the real post-swap balances must be re-checked before mint is actually sent.
  projectedMintExecutable: boolean;
  detail: string;
}

const UNIT_LIQUIDITY = 10n ** 18n; // arbitrary but large -- only the amount0:amount1 RATIO it yields is used, which is liquidity-independent
const Q192 = 1n << 192n;
const DUST_THRESHOLD_WEI = 1_000n; // policy constant: swaps smaller than this are not worth the gas/complexity, not a safety boundary

function strandedFractionsFor(
  amount0: bigint,
  amount1: bigint,
  tickLower: number,
  tickUpper: number,
  sqrtPriceX96: bigint,
): { fraction0: number; fraction1: number } {
  const achievableLiquidity = getLiquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1);
  const consumed = getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, achievableLiquidity);
  const stranded0 = amount0 - consumed.amount0;
  const stranded1 = amount1 - consumed.amount1;
  return {
    fraction0: amount0 === 0n ? 0 : Number(stranded0) / Number(amount0),
    fraction1: amount1 === 0n ? 0 : Number(stranded1) / Number(amount1),
  };
}

function buildResult(
  direction: SwapDirection,
  amountIn: bigint,
  estimatedAmountOut: bigint,
  projectedAmount0: bigint,
  projectedAmount1: bigint,
  tickLower: number,
  tickUpper: number,
  sqrtPriceX96: bigint,
  detail: string,
): RebalanceSwapRequirement {
  const { fraction0, fraction1 } = strandedFractionsFor(projectedAmount0, projectedAmount1, tickLower, tickUpper, sqrtPriceX96);
  return {
    direction,
    amountIn,
    estimatedAmountOut,
    projectedAmount0AfterSwap: projectedAmount0,
    projectedAmount1AfterSwap: projectedAmount1,
    projectedStrandedFraction0: fraction0,
    projectedStrandedFraction1: fraction1,
    projectedMintExecutable: fraction0 <= RATIO_MISMATCH_THRESHOLD && fraction1 <= RATIO_MISMATCH_THRESHOLD,
    detail,
  };
}

/**
 * Determines what swap (if any) is needed so (collectedAmount0, collectedAmount1) can actually
 * fund a mint into [targetTickLower, targetTickUpper) at the current price, and previews the
 * result. Three cases, matching getAmountsForLiquidity's own branches:
 *  - current price at/below the target range: the range wants 100% token0 -- swap ALL token1.
 *  - current price at/above the target range: the range wants 100% token1 -- swap ALL token0.
 *  - current price inside the range: solve the closed-form ratio-matching swap amount.
 */
export function computeRebalanceSwapRequirement(
  collectedAmount0: bigint,
  collectedAmount1: bigint,
  targetTickLower: number,
  targetTickUpper: number,
  currentSqrtPriceX96: bigint,
): RebalanceSwapRequirement {
  const { amount0: unit0, amount1: unit1 } = getAmountsForLiquidity(currentSqrtPriceX96, targetTickLower, targetTickUpper, UNIT_LIQUIDITY);

  // Case: price outside the range entirely -- only one token is wanted at all.
  if (unit0 === 0n) {
    // Range wants 100% token1; token0 is entirely excess.
    if (collectedAmount0 <= DUST_THRESHOLD_WEI) {
      return buildResult("NO_SWAP_REQUIRED", 0n, 0n, collectedAmount0, collectedAmount1, targetTickLower, targetTickUpper, currentSqrtPriceX96, "target range is entirely above current price and wants only token1; collected token0 is already dust");
    }
    const estimatedOut = (collectedAmount0 * (currentSqrtPriceX96 * currentSqrtPriceX96)) / Q192;
    return buildResult(
      "SWAP_TOKEN0_FOR_TOKEN1",
      collectedAmount0,
      estimatedOut,
      0n,
      collectedAmount1 + estimatedOut,
      targetTickLower,
      targetTickUpper,
      currentSqrtPriceX96,
      "target range is entirely above current price -- swapping ALL collected token0 for token1",
    );
  }
  if (unit1 === 0n) {
    // Range wants 100% token0; token1 is entirely excess.
    if (collectedAmount1 <= DUST_THRESHOLD_WEI) {
      return buildResult("NO_SWAP_REQUIRED", 0n, 0n, collectedAmount0, collectedAmount1, targetTickLower, targetTickUpper, currentSqrtPriceX96, "target range is entirely below current price and wants only token0; collected token1 is already dust");
    }
    const estimatedOut = (collectedAmount1 * Q192) / (currentSqrtPriceX96 * currentSqrtPriceX96);
    return buildResult(
      "SWAP_TOKEN1_FOR_TOKEN0",
      collectedAmount1,
      estimatedOut,
      collectedAmount0 + estimatedOut,
      0n,
      targetTickLower,
      targetTickUpper,
      currentSqrtPriceX96,
      "target range is entirely below current price -- swapping ALL collected token1 for token0",
    );
  }

  // Case: price inside the range. Closed-form ratio-matching swap (ignores the swap's own
  // price impact -- see module doc comment). Derivation kept in the chat record for this
  // slice; verified independently by this file's tests, not trusted on derivation alone.
  //
  // r = unit1/unit0 (the amount1:amount0 ratio the range wants, independent of liquidity size)
  // P = priceNum/Q192 (current price, token1 per token0)
  // s = (a0*r - a1) / (P + r)  -- signed amount of token0 to swap into token1; negative means
  //                                swap token1 into token0 instead.
  const priceNum = currentSqrtPriceX96 * currentSqrtPriceX96;
  const numerator = (collectedAmount0 * unit1 - collectedAmount1 * unit0) * Q192;
  const denominator = priceNum * unit0 + unit1 * Q192;
  const s = numerator / denominator; // BigInt division truncates toward zero -- fine, sign is preserved

  if (s > DUST_THRESHOLD_WEI) {
    const estimatedOut = (s * priceNum) / Q192;
    return buildResult(
      "SWAP_TOKEN0_FOR_TOKEN1",
      s,
      estimatedOut,
      collectedAmount0 - s,
      collectedAmount1 + estimatedOut,
      targetTickLower,
      targetTickUpper,
      currentSqrtPriceX96,
      `closed-form ratio match: swap ${s} token0 for an estimated ${estimatedOut} token1`,
    );
  }
  if (s < -DUST_THRESHOLD_WEI) {
    const amountIn = -s; // token1 to swap
    const estimatedOut = (amountIn * Q192) / priceNum;
    return buildResult(
      "SWAP_TOKEN1_FOR_TOKEN0",
      amountIn,
      estimatedOut,
      collectedAmount0 + estimatedOut,
      collectedAmount1 - amountIn,
      targetTickLower,
      targetTickUpper,
      currentSqrtPriceX96,
      `closed-form ratio match: swap ${amountIn} token1 for an estimated ${estimatedOut} token0`,
    );
  }
  return buildResult(
    "NO_SWAP_REQUIRED",
    0n,
    0n,
    collectedAmount0,
    collectedAmount1,
    targetTickLower,
    targetTickUpper,
    currentSqrtPriceX96,
    "held ratio already matches what the target range needs at the current price (within dust)",
  );
}

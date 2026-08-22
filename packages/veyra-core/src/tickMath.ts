// Minimal tick-spacing helpers for PancakeSwap V3 (fork of Uniswap V3 -- same fee-tier/tickSpacing
// mapping). This is standard, publicly documented protocol constants, not something derived or guessed.

export const TICK_SPACING_BY_FEE: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
};

export function roundToTickSpacing(tick: number, tickSpacing: number): number {
  return Math.round(tick / tickSpacing) * tickSpacing;
}

// ---- Exact tick <-> sqrtPriceX96 conversion -----------------------------------------------
// A direct BigInt port of Uniswap V3 core's TickMath.getSqrtRatioAtTick (PancakeSwap V3 is a
// straight fork and uses the identical algorithm/constants). This is NOT a float approximation
// -- it is the same fixed-point bit-manipulation the AMM contract itself runs, which matters
// because amount0Min/amount1Min execution-plan floors (see execution.ts) must not drift from
// what the contract will actually compute.
const MAX_TICK = 887272;
const Q32 = 1n << 32n;
const UINT256_MAX = (1n << 256n) - 1n;

export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < -MAX_TICK || tick > MAX_TICK) {
    throw new Error(`tick out of range: ${tick}`);
  }
  const absTick = BigInt(tick < 0 ? -tick : tick);

  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = UINT256_MAX / ratio;

  // Q128.128 -> Q64.96, rounding up.
  const shifted = ratio >> 32n;
  const remainder = ratio % Q32;
  return remainder === 0n ? shifted : shifted + 1n;
}

/** amount0 a position of `liquidity` holds when the current price is BELOW the whole range. */
function amount0ForLiquidity(sqrtRatioLowerX96: bigint, sqrtRatioUpperX96: bigint, liquidity: bigint, q96: bigint): bigint {
  return (liquidity * q96 * (sqrtRatioUpperX96 - sqrtRatioLowerX96)) / sqrtRatioUpperX96 / sqrtRatioLowerX96;
}

/** amount1 a position of `liquidity` holds when the current price is ABOVE the whole range. */
function amount1ForLiquidity(sqrtRatioLowerX96: bigint, sqrtRatioUpperX96: bigint, liquidity: bigint, q96: bigint): bigint {
  return (liquidity * (sqrtRatioUpperX96 - sqrtRatioLowerX96)) / q96;
}

export interface TokenAmounts {
  amount0: bigint;
  amount1: bigint;
}

/**
 * Standard Uniswap V3 LiquidityAmounts.getAmountsForLiquidity: the (amount0, amount1) a
 * position of `liquidity` over [tickLower, tickUpper) represents at the given current price.
 * Pure math over already-OBSERVED inputs (current sqrtPriceX96, the position's own ticks and
 * liquidity) -- not a model, not an estimate; this is the same formula the AMM itself uses.
 */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): TokenAmounts {
  const Q96 = 1n << 96n;
  const sqrtRatioLowerX96 = getSqrtRatioAtTick(tickLower);
  const sqrtRatioUpperX96 = getSqrtRatioAtTick(tickUpper);

  if (sqrtPriceX96 <= sqrtRatioLowerX96) {
    // Current price below the range: the position is entirely token0.
    return { amount0: amount0ForLiquidity(sqrtRatioLowerX96, sqrtRatioUpperX96, liquidity, Q96), amount1: 0n };
  }
  if (sqrtPriceX96 < sqrtRatioUpperX96) {
    // Current price inside the range: the position holds both tokens.
    return {
      amount0: amount0ForLiquidity(sqrtPriceX96, sqrtRatioUpperX96, liquidity, Q96),
      amount1: amount1ForLiquidity(sqrtRatioLowerX96, sqrtPriceX96, liquidity, Q96),
    };
  }
  // Current price above the range: the position is entirely token1.
  return { amount0: 0n, amount1: amount1ForLiquidity(sqrtRatioLowerX96, sqrtRatioUpperX96, liquidity, Q96) };
}

function liquidityForAmount0(sqrtRatioLowerX96: bigint, sqrtRatioUpperX96: bigint, amount0: bigint, q96: bigint): bigint {
  const intermediate = (sqrtRatioLowerX96 * sqrtRatioUpperX96) / q96;
  return (amount0 * intermediate) / (sqrtRatioUpperX96 - sqrtRatioLowerX96);
}

function liquidityForAmount1(sqrtRatioLowerX96: bigint, sqrtRatioUpperX96: bigint, amount1: bigint, q96: bigint): bigint {
  return (amount1 * q96) / (sqrtRatioUpperX96 - sqrtRatioLowerX96);
}

/**
 * The exact inverse of {@link getAmountsForLiquidity}: the MAXIMUM liquidity mintable at
 * [tickLower, tickUpper) given available (amount0, amount1) at the current price -- i.e. what
 * `mint()` actually deploys when the held ratio doesn't exactly match what the range wants.
 * Uniswap's own mint() uses the SMALLER of what each token alone would support and refunds the
 * rest; this function is that same rule, so it can be used to quantify exactly how much of a
 * mismatched deposit would be stranded/refunded (see execution/simulation's ratio-adjustment
 * check) -- not a guess, the same formula the contract runs.
 */
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const Q96 = 1n << 96n;
  const sqrtRatioLowerX96 = getSqrtRatioAtTick(tickLower);
  const sqrtRatioUpperX96 = getSqrtRatioAtTick(tickUpper);

  if (sqrtPriceX96 <= sqrtRatioLowerX96) {
    return liquidityForAmount0(sqrtRatioLowerX96, sqrtRatioUpperX96, amount0, Q96);
  }
  if (sqrtPriceX96 < sqrtRatioUpperX96) {
    const liquidity0 = liquidityForAmount0(sqrtPriceX96, sqrtRatioUpperX96, amount0, Q96);
    const liquidity1 = liquidityForAmount1(sqrtRatioLowerX96, sqrtPriceX96, amount1, Q96);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return liquidityForAmount1(sqrtRatioLowerX96, sqrtRatioUpperX96, amount1, Q96);
}

export interface SwapAmountEstimate {
  zeroForOne: boolean; // true = swap token0 in (price decreases); false = swap token1 in (price increases)
  amountIn: bigint;
}

/**
 * Estimate the input amount needed to move a pool's price from sqrtPriceX96Current to
 * sqrtPriceX96Target, ASSUMING constant liquidity across that whole span (i.e. no other
 * initialized tick is crossed) and IGNORING the pool's swap fee. This is a planning estimate
 * for a deliberate, controlled test swap -- not a claim about the exact amount a real swap will
 * consume. Real swaps need somewhat more input than this to also cover the fee; callers driving
 * an actual transaction should size amountIn generously and rely on the transaction's own
 * `sqrtPriceLimitX96` (not this estimate) to bound how far the price actually moves.
 */
export function estimateSwapAmountForPriceMove(
  sqrtPriceX96Current: bigint,
  sqrtPriceX96Target: bigint,
  liquidity: bigint,
): SwapAmountEstimate {
  const Q96 = 1n << 96n;
  if (sqrtPriceX96Target < sqrtPriceX96Current) {
    // Price decreasing: swap token0 in. Same math as amount0ForLiquidity over [target, current].
    return { zeroForOne: true, amountIn: amount0ForLiquidity(sqrtPriceX96Target, sqrtPriceX96Current, liquidity, Q96) };
  }
  if (sqrtPriceX96Target > sqrtPriceX96Current) {
    // Price increasing: swap token1 in. Same math as amount1ForLiquidity over [current, target].
    return { zeroForOne: false, amountIn: amount1ForLiquidity(sqrtPriceX96Current, sqrtPriceX96Target, liquidity, Q96) };
  }
  return { zeroForOne: true, amountIn: 0n };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { getSqrtRatioAtTick, getAmountsForLiquidity, getLiquidityForAmounts, estimateSwapAmountForPriceMove } from "../src/index.js";

const Q96 = 1n << 96n;

// Independent, directly-derived closed-form inverses of the constant-liquidity swap formula --
// NOT calls into estimateSwapAmountForPriceMove -- used to cross-check it rather than trust it
// circularly. Derived from amount0 = L*Q96*(Pa-Pb)/(Pa*Pb) and amount1 = L*(Pb-Pa)/Q96.
function nextSqrtPriceFromAmount0In(sqrtPa: bigint, liquidity: bigint, amount0: bigint): bigint {
  return (liquidity * Q96 * sqrtPa) / (amount0 * sqrtPa + liquidity * Q96);
}
function nextSqrtPriceFromAmount1In(sqrtPa: bigint, liquidity: bigint, amount1: bigint): bigint {
  return sqrtPa + (amount1 * Q96) / liquidity;
}

test("getSqrtRatioAtTick(0) is exactly 2^96 (price ratio 1:1, the known reference point)", () => {
  assert.equal(getSqrtRatioAtTick(0), 1n << 96n);
});

test("getSqrtRatioAtTick is strictly increasing with tick (price increases monotonically)", () => {
  const ticks = [-887272, -100000, -57041, -50, 0, 50, 100000, 887272];
  const ratios = ticks.map(getSqrtRatioAtTick);
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(ratios[i]! > ratios[i - 1]!, `ratio at tick ${ticks[i]} should exceed ratio at tick ${ticks[i - 1]}`);
  }
});

test("getSqrtRatioAtTick(-tick) and getSqrtRatioAtTick(tick) are reciprocal around 2^96 (within integer rounding)", () => {
  // sqrtRatio(-t) * sqrtRatio(t) should be very close to (2^96)^2 -- exact equality isn't
  // guaranteed by the rounding-up step, but the product must land within a tiny relative error.
  const t = 12345;
  const product = getSqrtRatioAtTick(-t) * getSqrtRatioAtTick(t);
  const reference = (1n << 96n) * (1n << 96n);
  const diff = product > reference ? product - reference : reference - product;
  const relativeError = Number(diff) / Number(reference);
  assert.ok(relativeError < 1e-6, `relative error too large: ${relativeError}`);
});

test("getAmountsForLiquidity: current price BELOW the range -> entirely token0", () => {
  const tickLower = 100;
  const tickUpper = 200;
  const belowRangeSqrtPrice = getSqrtRatioAtTick(tickLower) - 1n;
  const { amount0, amount1 } = getAmountsForLiquidity(belowRangeSqrtPrice, tickLower, tickUpper, 1_000_000n);
  assert.ok(amount0 > 0n);
  assert.equal(amount1, 0n);
});

test("getAmountsForLiquidity: current price ABOVE the range -> entirely token1", () => {
  const tickLower = 100;
  const tickUpper = 200;
  const aboveRangeSqrtPrice = getSqrtRatioAtTick(tickUpper) + 1n;
  const { amount0, amount1 } = getAmountsForLiquidity(aboveRangeSqrtPrice, tickLower, tickUpper, 1_000_000n);
  assert.equal(amount0, 0n);
  assert.ok(amount1 > 0n);
});

test("getAmountsForLiquidity: current price INSIDE the range -> both tokens present", () => {
  const tickLower = -59050;
  const tickUpper = -55050;
  const currentSqrtPrice = getSqrtRatioAtTick(-57041); // Position #37058's real observed current tick
  const { amount0, amount1 } = getAmountsForLiquidity(currentSqrtPrice, tickLower, tickUpper, 3_624_304_981_691_222_991n);
  assert.ok(amount0 > 0n, "expected a nonzero token0 amount for an in-range position");
  assert.ok(amount1 > 0n, "expected a nonzero token1 amount for an in-range position");
});

test("getLiquidityForAmounts is the exact inverse of getAmountsForLiquidity (round-trip, real Position #37058 fixture)", () => {
  const tickLower = -59050;
  const tickUpper = -55050;
  const sqrtPrice = getSqrtRatioAtTick(-57041);
  const originalLiquidity = 3_624_304_981_691_222_991n;

  const { amount0, amount1 } = getAmountsForLiquidity(sqrtPrice, tickLower, tickUpper, originalLiquidity);
  const recoveredLiquidity = getLiquidityForAmounts(sqrtPrice, tickLower, tickUpper, amount0, amount1);

  // Integer division in both directions can lose a few units of precision -- recovered
  // liquidity must be extremely close to, and never exceed, the original.
  assert.ok(recoveredLiquidity <= originalLiquidity, "recovered liquidity must not exceed the original (that would mean minting more than the tokens support)");
  const relativeError = Number(originalLiquidity - recoveredLiquidity) / Number(originalLiquidity);
  assert.ok(relativeError < 1e-9, `round-trip liquidity drifted too much: ${relativeError}`);
});

test("getLiquidityForAmounts returns the SMALLER of what each token alone supports when the ratio is mismatched", () => {
  // A deliberately lopsided deposit: plenty of token0, almost no token1, for a range that
  // needs both. The achievable liquidity must be capped by the scarce token.
  const tickLower = -1000;
  const tickUpper = 1000;
  const sqrtPrice = getSqrtRatioAtTick(0); // dead center of the range
  const abundantAmount0 = 1_000_000_000_000_000_000n;
  const scarceAmount1 = 1_000n;

  const achievable = getLiquidityForAmounts(sqrtPrice, tickLower, tickUpper, abundantAmount0, scarceAmount1);
  const { amount1: consumed1 } = getAmountsForLiquidity(sqrtPrice, tickLower, tickUpper, achievable);

  assert.ok(consumed1 <= scarceAmount1, "must not consume more of the scarce token than is actually available");
  assert.ok(achievable > 0n && achievable < 10_000_000n, "achievable liquidity should be small, bottlenecked by the scarce token1");
});

test("estimateSwapAmountForPriceMove: price decreasing swaps token0 in, and the amount reproduces the target price via an independently-derived inverse formula", () => {
  const liquidity = 7_039_210_414_078_688_290n; // Position #37059's real liquidity
  const sqrtPCurrent = getSqrtRatioAtTick(-57041);
  const sqrtPTarget = getSqrtRatioAtTick(-58050); // toward the LOWER edge -- price must decrease

  const estimate = estimateSwapAmountForPriceMove(sqrtPCurrent, sqrtPTarget, liquidity);
  assert.equal(estimate.zeroForOne, true);
  assert.ok(estimate.amountIn > 0n);

  const reproducedPrice = nextSqrtPriceFromAmount0In(sqrtPCurrent, liquidity, estimate.amountIn);
  const diff = reproducedPrice > sqrtPTarget ? reproducedPrice - sqrtPTarget : sqrtPTarget - reproducedPrice;
  const relativeError = Number(diff) / Number(sqrtPTarget);
  assert.ok(relativeError < 1e-9, `reproduced price drifted from target: relativeError=${relativeError}`);
});

test("estimateSwapAmountForPriceMove: price increasing swaps token1 in, and the amount reproduces the target price via an independently-derived inverse formula", () => {
  const liquidity = 7_039_210_414_078_688_290n;
  const sqrtPCurrent = getSqrtRatioAtTick(-57041);
  const sqrtPTarget = getSqrtRatioAtTick(-55950); // past the UPPER edge -- price must increase

  const estimate = estimateSwapAmountForPriceMove(sqrtPCurrent, sqrtPTarget, liquidity);
  assert.equal(estimate.zeroForOne, false);
  assert.ok(estimate.amountIn > 0n);

  const reproducedPrice = nextSqrtPriceFromAmount1In(sqrtPCurrent, liquidity, estimate.amountIn);
  const diff = reproducedPrice > sqrtPTarget ? reproducedPrice - sqrtPTarget : sqrtPTarget - reproducedPrice;
  const relativeError = Number(diff) / Number(sqrtPTarget);
  assert.ok(relativeError < 1e-9, `reproduced price drifted from target: relativeError=${relativeError}`);
});

test("estimateSwapAmountForPriceMove returns zero input when target price equals current price", () => {
  const sqrtP = getSqrtRatioAtTick(-57041);
  const estimate = estimateSwapAmountForPriceMove(sqrtP, sqrtP, 7_039_210_414_078_688_290n);
  assert.equal(estimate.amountIn, 0n);
});

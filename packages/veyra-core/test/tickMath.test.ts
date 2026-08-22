import { test } from "node:test";
import assert from "node:assert/strict";
import { getSqrtRatioAtTick, getAmountsForLiquidity } from "../src/index.js";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRebalanceSwapRequirement, getLiquidityForAmounts, getAmountsForLiquidity } from "../src/index.js";

// Real, chain-observed fixture: exactly what Test B produced (docs/test-b/test-b-0001.json,
// docs/agent-arena-runs-v2/run-0001.json). The old position [-58050,-56050) is now fully below
// the current price -58150, so decreasing it yields 100% token0 -- and RangeKeeper's target
// range [-59150,-57150) is centered ON that same current price, so it needs a real mix of both
// tokens. This is the exact scenario the safety gate correctly blocked before this swap existed.
const REAL_SQRT_PRICE_X96 = 4_327_444_522_482_208_127_659_911_293n; // tick -58150
const REAL_COLLECTED_AMOUNT0 = 12_202_427_296_506_771_186n;
const REAL_COLLECTED_AMOUNT1 = 0n;
const REAL_TARGET_LOWER = -59150;
const REAL_TARGET_UPPER = -57150;

test("REAL Test B scenario: holding 100% token0, target range wants a mix -- computes a real ratio-fixing swap that actually works", () => {
  const result = computeRebalanceSwapRequirement(REAL_COLLECTED_AMOUNT0, REAL_COLLECTED_AMOUNT1, REAL_TARGET_LOWER, REAL_TARGET_UPPER, REAL_SQRT_PRICE_X96);

  assert.equal(result.direction, "SWAP_TOKEN0_FOR_TOKEN1");
  assert.ok(result.amountIn > 0n && result.amountIn < REAL_COLLECTED_AMOUNT0, "must swap SOME but not more than what's held");
  assert.ok(result.estimatedAmountOut > 0n);
  assert.equal(result.projectedAmount0AfterSwap, REAL_COLLECTED_AMOUNT0 - result.amountIn);
  assert.equal(result.projectedAmount1AfterSwap, result.estimatedAmountOut);

  // The whole point: this projection must clear the ratio-mismatch threshold that blocked
  // execution in docs/agent-arena-runs-v2/run-0001.json (which had NO swap and was ~100%
  // stranded on token0).
  assert.equal(result.projectedMintExecutable, true, `expected the fix to work; got fractions ${result.projectedStrandedFraction0}/${result.projectedStrandedFraction1}`);
  assert.ok(result.projectedStrandedFraction0 <= 0.01);
  assert.ok(result.projectedStrandedFraction1 <= 0.01);
});

test("without any swap, the same real numbers reproduce the original ~100% stranded finding (sanity check that the fixture matches the archived run)", () => {
  // Not calling computeRebalanceSwapRequirement here -- directly re-deriving via the same
  // simulation.ts math the archived run used, to confirm this test's fixture is faithful to
  // what actually happened on-chain, not a number invented for the test.
  const achievable = getLiquidityForAmounts(REAL_SQRT_PRICE_X96, REAL_TARGET_LOWER, REAL_TARGET_UPPER, REAL_COLLECTED_AMOUNT0, REAL_COLLECTED_AMOUNT1);
  const consumed = getAmountsForLiquidity(REAL_SQRT_PRICE_X96, REAL_TARGET_LOWER, REAL_TARGET_UPPER, achievable);
  const strandedFraction0 = Number(REAL_COLLECTED_AMOUNT0 - consumed.amount0) / Number(REAL_COLLECTED_AMOUNT0);
  assert.ok(strandedFraction0 > 0.9, `expected ~100% stranded without a swap, got ${strandedFraction0}`);
});

test("target range entirely ABOVE current price (currentTick below the whole range): wants 100% token0, so swaps ALL held token1 for token0", () => {
  // currentTick is -58150; a range at [-50000, -48000) sits entirely ABOVE it, meaning current
  // price is BELOW the whole range -- per getAmountsForLiquidity's own convention that wants
  // 100% token0. Any held token1 is entirely excess.
  const farAboveLower = -50000;
  const farAboveUpper = -48000;
  const result = computeRebalanceSwapRequirement(0n, 1_000_000_000_000_000_000n, farAboveLower, farAboveUpper, REAL_SQRT_PRICE_X96);
  assert.equal(result.direction, "SWAP_TOKEN1_FOR_TOKEN0");
  assert.equal(result.amountIn, 1_000_000_000_000_000_000n);
  assert.equal(result.projectedAmount1AfterSwap, 0n);
});

test("target range entirely BELOW current price (currentTick above the whole range): wants 100% token1, so swaps ALL held token0 for token1", () => {
  // A range at [-70000, -68000) sits entirely BELOW currentTick -58150, meaning current price
  // is ABOVE the whole range -- wants 100% token1. Any held token0 is entirely excess.
  const farBelowLower = -70000;
  const farBelowUpper = -68000;
  const result = computeRebalanceSwapRequirement(1_000_000_000_000_000_000n, 0n, farBelowLower, farBelowUpper, REAL_SQRT_PRICE_X96);
  assert.equal(result.direction, "SWAP_TOKEN0_FOR_TOKEN1");
  assert.equal(result.amountIn, 1_000_000_000_000_000_000n);
  assert.equal(result.projectedAmount0AfterSwap, 0n);
});

test("an already-balanced deposit requires no swap and is trivially mint-executable", () => {
  // Center the target range on the current tick and ask for exactly the ratio getAmountsForLiquidity
  // itself would produce -- by construction, nothing should need to move.
  const tickLower = -59150;
  const tickUpper = -57150;
  // Reuse the already-tested tickMath helper at some arbitrary liquidity to build a
  // self-consistent "already balanced" fixture.
  const { amount0: balanced0, amount1: balanced1 } = getAmountsForLiquidity(REAL_SQRT_PRICE_X96, tickLower, tickUpper, 5_000_000_000_000_000_000n);

  const result = computeRebalanceSwapRequirement(balanced0, balanced1, tickLower, tickUpper, REAL_SQRT_PRICE_X96);
  assert.equal(result.direction, "NO_SWAP_REQUIRED");
  assert.equal(result.amountIn, 0n);
  assert.equal(result.projectedMintExecutable, true);
});

// REGRESSION FIXTURE for a real, confirmed bug (found live resuming a blocked mint, this
// session): holding EXCESS token1 relative to the target range at the current price is the
// s<0 branch (SWAP_TOKEN1_FOR_TOKEN0) -- the only branch none of the tests above exercised
// with a realistic "price inside range" case, which is exactly why this went undetected. The
// old code treated `-s` (a token0-denominated quantity) as a token1 amount and converted it
// the wrong direction, inflating a real ~0.54 token0 correction into an attempt to spend 0.54
// token1 -- when only ~0.018 token1 was actually held. Exact real numbers from
// docs/agent-arena-runs-v2/run-0004.json's swap output (mintAmount0/mintAmount1) and the pool's
// real post-swap sqrtPriceX96.
const NEGATIVE_S_SQRT_PRICE_X96 = 4_308_080_754_748_429_504_989_982_581n; // real post-swap price, tick -58240
const NEGATIVE_S_AMOUNT0 = 6_106_591_060_789_784_897n; // ~6.11 token0 -- fully consumed by the range (0% stranded)
const NEGATIVE_S_AMOUNT1 = 18_091_222_668_332_013n; // ~0.0181 token1 -- 16.26% of this is excess
const NEGATIVE_S_TARGET_LOWER = -59150;
const NEGATIVE_S_TARGET_UPPER = -57150;

test("REGRESSION (real bug, this session): excess token1 relative to the range computes a swap that is actually AFFORDABLE and correctly sized", () => {
  const result = computeRebalanceSwapRequirement(NEGATIVE_S_AMOUNT0, NEGATIVE_S_AMOUNT1, NEGATIVE_S_TARGET_LOWER, NEGATIVE_S_TARGET_UPPER, NEGATIVE_S_SQRT_PRICE_X96);

  assert.equal(result.direction, "SWAP_TOKEN1_FOR_TOKEN0");
  // The old, buggy version computed amountIn=540863749913142387 -- MORE than the entire
  // NEGATIVE_S_AMOUNT1 held (18091222668332013). The bug, stated as an invariant: a
  // ratio-fixing swap can never need to spend more of a token than is actually held.
  assert.ok(result.amountIn > 0n && result.amountIn < NEGATIVE_S_AMOUNT1, `amountIn ${result.amountIn} must be less than what's held (${NEGATIVE_S_AMOUNT1}) -- the old bug violated this`);
  assert.ok(result.estimatedAmountOut > 0n);
  assert.equal(result.projectedAmount0AfterSwap, NEGATIVE_S_AMOUNT0 + result.estimatedAmountOut);
  assert.equal(result.projectedAmount1AfterSwap, NEGATIVE_S_AMOUNT1 - result.amountIn);
  assert.ok(result.projectedAmount1AfterSwap >= 0n, "must never project a negative balance");

  assert.equal(result.projectedMintExecutable, true, `expected the fix to work; got fractions ${result.projectedStrandedFraction0}/${result.projectedStrandedFraction1}`);
  assert.ok(result.projectedStrandedFraction0 <= 0.01);
  assert.ok(result.projectedStrandedFraction1 <= 0.01);
});

test("zero collected amounts on both sides is a degenerate no-op, not a crash", () => {
  const result = computeRebalanceSwapRequirement(0n, 0n, REAL_TARGET_LOWER, REAL_TARGET_UPPER, REAL_SQRT_PRICE_X96);
  assert.equal(result.direction, "NO_SWAP_REQUIRED");
  assert.equal(result.amountIn, 0n);
});

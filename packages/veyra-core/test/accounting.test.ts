import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCollectedAmounts } from "../src/index.js";

test("REGRESSION (execution-0001.json / execution-0002.json): the exact real incident numbers must yield the correct small delta, not the huge absolute balance", () => {
  // Real numbers from the actual bug: the wallet held a large pre-existing token0 balance
  // (VEYRA's own demo token, bulk-minted when the pool was first created) BEFORE this
  // operation ran. postCollectBalance0 is what execution-0001.json's original (buggy) code
  // read and incorrectly used directly as the mint amount -- it should instead resolve to
  // the small real yield, matching what execution-0002.json actually minted with.
  const postCollectBalance0 = 9_999_999_999_999_999_999_999n;
  const realCollectedAmount0 = 5_947_044_489_544_840_472n; // the position's own tokensOwed0, what collect() actually delivered for THIS operation
  const baselineBalance0 = postCollectBalance0 - realCollectedAmount0; // what the wallet already held, unrelated to this position

  const result = computeCollectedAmounts({
    baselineBalance0,
    baselineBalance1: 0n,
    postCollectBalance0,
    postCollectBalance1: 19_999_999_999_999_999n,
  });

  assert.equal(result.collectedAmount0, realCollectedAmount0);
  assert.equal(result.collectedAmount1, 19_999_999_999_999_999n);
  // The bug this regression test exists for: naively using postCollectBalance0 directly would
  // be off by six orders of magnitude from the correct answer.
  assert.notEqual(result.collectedAmount0, postCollectBalance0);
});

test("zero pre-existing balance: collected amount equals the full post-collect balance", () => {
  const result = computeCollectedAmounts({
    baselineBalance0: 0n,
    baselineBalance1: 0n,
    postCollectBalance0: 1_000_000n,
    postCollectBalance1: 2_000_000n,
  });
  assert.equal(result.collectedAmount0, 1_000_000n);
  assert.equal(result.collectedAmount1, 2_000_000n);
});

test("small pre-existing balance: delta correctly excludes it", () => {
  const result = computeCollectedAmounts({
    baselineBalance0: 100n,
    baselineBalance1: 50n,
    postCollectBalance0: 105n,
    postCollectBalance1: 80n,
  });
  assert.equal(result.collectedAmount0, 5n);
  assert.equal(result.collectedAmount1, 30n);
});

test("very large pre-existing balance dwarfing the collected amount: delta still correctly isolates the small real yield", () => {
  const result = computeCollectedAmounts({
    baselineBalance0: 10_000_000_000_000_000_000_000n,
    baselineBalance1: 0n,
    postCollectBalance0: 10_000_000_000_000_000_000_100n, // +100 from this operation
    postCollectBalance1: 7n,
  });
  assert.equal(result.collectedAmount0, 100n);
  assert.equal(result.collectedAmount1, 7n);
});

test("collected amount LARGER than the pre-existing balance (a mostly-empty wallet before this operation)", () => {
  const result = computeCollectedAmounts({
    baselineBalance0: 10n,
    baselineBalance1: 0n,
    postCollectBalance0: 1_000_000n,
    postCollectBalance1: 500_000n,
  });
  assert.equal(result.collectedAmount0, 999_990n);
  assert.equal(result.collectedAmount1, 500_000n);
});

test("collected amount SMALLER than the pre-existing balance (the actual shape of the real incident)", () => {
  const result = computeCollectedAmounts({
    baselineBalance0: 1_000_000n,
    baselineBalance1: 0n,
    postCollectBalance0: 1_000_010n,
    postCollectBalance1: 3n,
  });
  assert.equal(result.collectedAmount0, 10n);
  assert.equal(result.collectedAmount1, 3n);
  assert.ok(result.collectedAmount0 < 1_000_000n, "the delta, not the absolute balance, must be what's returned");
});

test("a balance that went DOWN between baseline and post-collect reads throws rather than returning a negative/nonsensical delta", () => {
  assert.throws(
    () =>
      computeCollectedAmounts({
        baselineBalance0: 1_000n,
        baselineBalance1: 0n,
        postCollectBalance0: 500n, // dropped -- something else moved funds concurrently
        postCollectBalance1: 0n,
      }),
    /balance went DOWN/,
  );
});

test("both deltas exactly zero is a valid (if unusual) result -- not itself an error from this function", () => {
  const result = computeCollectedAmounts({
    baselineBalance0: 500n,
    baselineBalance1: 500n,
    postCollectBalance0: 500n,
    postCollectBalance1: 500n,
  });
  assert.equal(result.collectedAmount0, 0n);
  assert.equal(result.collectedAmount1, 0n);
});

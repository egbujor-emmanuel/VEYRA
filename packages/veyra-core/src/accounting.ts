// Hard invariant, extracted so it can never be silently reintroduced (execution-0001.json's
// real incident, docs/executions/): the amount a rebalance operation "collected" must be
// computed as a DELTA against a balance baseline captured BEFORE the operation began -- never
// an absolute wallet balance read after the fact. An absolute balance can include funds that
// have nothing to do with this operation (VEYRA's wallet held a large pre-existing balance of
// its own demo token from when the pool was first created; using that absolute balance as the
// mint amount fed the contract a wildly wrong ratio and reverted with "Price slippage check").
//
// This is the ONE sanctioned way to answer "how much did this operation actually yield."

export interface CollectedAmounts {
  collectedAmount0: bigint;
  collectedAmount1: bigint;
}

export interface ComputeCollectedAmountsOpts {
  baselineBalance0: bigint;
  baselineBalance1: bigint;
  postCollectBalance0: bigint;
  postCollectBalance1: bigint;
}

/**
 * @throws if either balance went DOWN between the baseline read and the post-collect read --
 * that means something outside this operation moved funds out of the wallet concurrently, and
 * proceeding with a negative/nonsensical delta would be exactly the kind of silent bad-data
 * propagation this function exists to prevent.
 */
export function computeCollectedAmounts(opts: ComputeCollectedAmountsOpts): CollectedAmounts {
  const collectedAmount0 = opts.postCollectBalance0 - opts.baselineBalance0;
  const collectedAmount1 = opts.postCollectBalance1 - opts.baselineBalance1;

  if (collectedAmount0 < 0n || collectedAmount1 < 0n) {
    throw new Error(
      `computeCollectedAmounts: a balance went DOWN between baseline and post-collect reads ` +
        `(amount0 delta=${collectedAmount0}, amount1 delta=${collectedAmount1}) -- refusing to ` +
        `proceed with a negative collected amount`,
    );
  }

  return { collectedAmount0, collectedAmount1 };
}

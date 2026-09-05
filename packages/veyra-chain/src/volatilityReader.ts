// Realized volatility, read from a PancakeSwap V3 pool's own observation oracle.
//
// This exists to retire a long-standing dishonesty in the snapshot. `recentVolatilityBps` is an
// input to rangeKeeper's width formula, and every caller in this repo supplied 0 -- the archives
// label it SUPPLIED_NOT_OBSERVED, which was at least honest about being a placeholder. The effect
// was that rangeKeeper's volatility multiplier was permanently 1, collapsing it onto
// baseline-symmetric-range.
//
// The reader deliberately returns null rather than 0 when it cannot measure. Those are different
// claims: 0 asserts a calm market, null admits no measurement was possible. Substituting the
// former for the latter is exactly the bug this replaces.

import type { PublicClient, Address } from "viem";

const SLOT0_ABI = [
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint32" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

const OBSERVE_ABI = [
  {
    type: "function", name: "observe", stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128", type: "uint160[]" },
    ],
  },
] as const;

export interface VolatilityReading {
  /** Standard deviation of per-window mean ticks, in bps. Null when it could not be measured. */
  volatilityBps: number | null;
  /** OBSERVED when derived from real oracle history; otherwise why not. */
  provenance: "OBSERVED" | "INSUFFICIENT_HISTORY" | "ORACLE_UNAVAILABLE";
  /** Human-readable detail, carried into the archive so the record explains itself. */
  detail: string;
  observationCardinality: number;
  windowSeconds: number | null;
  samples: number;
}

/** Sub-interval boundaries, newest first. Six 10-minute buckets across the last hour. */
const BUCKET_SECONDS = 600;
const BUCKET_COUNT = 6;

/**
 * A tick IS a basis point, near enough: prices are 1.0001^tick, so a one-tick move is a 0.01%
 * move by construction. Converting a tick standard deviation to bps therefore needs no scaling
 * factor, which is worth stating explicitly rather than leaving as an unexplained 1:1.
 */
function tickStdDevToBps(ticks: number[]): number {
  const mean = ticks.reduce((a, b) => a + b, 0) / ticks.length;
  const variance = ticks.reduce((a, t) => a + (t - mean) ** 2, 0) / ticks.length;
  return Math.sqrt(variance);
}

export async function readRealizedVolatility(
  client: PublicClient,
  poolAddress: Address,
): Promise<VolatilityReading> {
  let cardinality = 0;
  try {
    const slot0 = await client.readContract({ address: poolAddress, abi: SLOT0_ABI, functionName: "slot0" });
    cardinality = Number(slot0[3]);
  } catch (err) {
    return {
      volatilityBps: null, provenance: "ORACLE_UNAVAILABLE",
      detail: `slot0 read failed: ${String((err as Error).message ?? err).slice(0, 120)}`,
      observationCardinality: 0, windowSeconds: null, samples: 0,
    };
  }

  // A single stored observation means observe() extrapolates the current tick for every window --
  // every bucket comes back identical and the standard deviation is a meaningless zero.
  if (cardinality < 2) {
    return {
      volatilityBps: null, provenance: "INSUFFICIENT_HISTORY",
      detail:
        `pool stores ${cardinality} observation(s); observe() would return the current tick for every ` +
        `window. Growing the buffer (increaseObservationCardinalityNext) allocates slots, but the pool ` +
        `only writes one per block containing a swap -- so this stays unmeasurable until there is flow.`,
      observationCardinality: cardinality, windowSeconds: null, samples: 0,
    };
  }

  const secondsAgos = Array.from({ length: BUCKET_COUNT + 1 }, (_, i) => (BUCKET_COUNT - i) * BUCKET_SECONDS);
  let tickCumulatives: readonly bigint[];
  try {
    const result = await client.readContract({
      address: poolAddress, abi: OBSERVE_ABI, functionName: "observe", args: [secondsAgos],
    });
    tickCumulatives = result[0];
  } catch (err) {
    // Uniswap/Pancake revert with "OLD" when the requested window predates stored history.
    return {
      volatilityBps: null, provenance: "INSUFFICIENT_HISTORY",
      detail:
        `observe() over ${BUCKET_COUNT * BUCKET_SECONDS}s reverted -- the oracle does not reach back that ` +
        `far yet: ${String((err as Error).message ?? err).slice(0, 100)}`,
      observationCardinality: cardinality, windowSeconds: BUCKET_COUNT * BUCKET_SECONDS, samples: 0,
    };
  }

  // Mean tick over each bucket = difference in cumulative ticks / bucket length.
  const meanTicks: number[] = [];
  for (let i = 0; i < tickCumulatives.length - 1; i++) {
    const delta = tickCumulatives[i + 1]! - tickCumulatives[i]!;
    meanTicks.push(Number(delta) / BUCKET_SECONDS);
  }

  const volatilityBps = tickStdDevToBps(meanTicks);

  // All buckets identical means the oracle is still extrapolating one observation, even though
  // cardinality claims otherwise. Report that instead of a confident zero.
  if (volatilityBps === 0) {
    return {
      volatilityBps: null, provenance: "INSUFFICIENT_HISTORY",
      detail:
        `every ${BUCKET_SECONDS}s bucket returned the same mean tick, which is what an oracle with no ` +
        `real movement recorded looks like. Treated as unmeasured rather than as zero volatility.`,
      observationCardinality: cardinality,
      windowSeconds: BUCKET_COUNT * BUCKET_SECONDS, samples: meanTicks.length,
    };
  }

  return {
    volatilityBps,
    provenance: "OBSERVED",
    detail: `standard deviation of ${meanTicks.length} x ${BUCKET_SECONDS}s mean ticks from the pool oracle`,
    observationCardinality: cardinality,
    windowSeconds: BUCKET_COUNT * BUCKET_SECONDS,
    samples: meanTicks.length,
  };
}

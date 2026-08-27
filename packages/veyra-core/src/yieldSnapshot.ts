// Yield Optimisation's market snapshot. Reads cumulative, all-time fee growth per unit of
// liquidity (feeGrowthGlobal0X128/1X128 -- Uniswap V3's own per-liquidity-unit accounting,
// already normalized by the pool itself) across the CURRENT pool VEYRA's capital sits in, plus
// candidate alternative pools. This is deliberately NOT presented as an APR: an annualized rate
// needs a time-normalized delta (two readings, a known elapsed period), which this project does
// not have any infrastructure to compute honestly (same class of gap as MarketSnapshot's own
// recentVolatilityBps -- see positionReader.ts's doc comment). What IS real and observable from a
// single snapshot: how much cumulative fee growth per unit liquidity each pool has actually
// generated so far. That's the signal used here, labeled precisely as what it is.

import type { StrategyProposal } from "./types.js";

export interface YieldPoolObservation {
  poolAddress: `0x${string}`;
  label: string;
  fee: number;
  currentLiquidity: bigint;
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
}

export interface YieldMarketSnapshot {
  /** Which pool VEYRA's capital is actually in right now. Must match one entry in `pools`. */
  currentPoolAddress: `0x${string}`;
  /** The current pool plus every candidate alternative -- all real, on-chain-read observations. */
  pools: YieldPoolObservation[];
}

export interface YieldOptimisationJobSpecTarget {
  protocol: "pancakeswap-v3";
  network: "bsc-testnet";
  candidatePools: { poolAddress: `0x${string}`; label: string }[];
}

export type YieldStrategyFn = (
  job: import("./types.js").YieldOptimisationJobSpec,
  snapshot: YieldMarketSnapshot,
) => Promise<StrategyProposal>;

/**
 * Deliberately simple, v1-style, no invented precision (same discipline as evaluator.ts's own
 * header comment): a combined score summing both tokens' cumulative fee growth per unit
 * liquidity. This is NOT a rigorous cross-token-normalized figure -- feeGrowthGlobal0X128 and
 * feeGrowthGlobal1X128 are denominated in different tokens at different price scales, and summing
 * them is a rough heuristic, not a precise combined yield. Documented here rather than hidden
 * behind a more impressive-looking formula that wouldn't actually be more honest.
 */
export function cumulativeFeeGrowthScore(pool: YieldPoolObservation): bigint {
  return pool.feeGrowthGlobal0X128 + pool.feeGrowthGlobal1X128;
}

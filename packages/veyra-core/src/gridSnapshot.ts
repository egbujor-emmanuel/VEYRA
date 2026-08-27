// Grid Trading's market snapshot (four-category expansion). A grid is N adjacent, narrow-tick-range
// V3 positions on ONE pool -- so every slot shares the same pool-level facts (currentTick,
// tickSpacing, recentVolatilityBps) and differs only in its own currentRange/currentLiquidity.
// Each slot IS a MarketSnapshot (the existing, unmodified type) so every existing per-range formula
// (widthDrivenMetric, positioningScore) runs unmodified, once per slot -- no new tick math.

import type { GridTradingJobSpec, MarketSnapshot, StrategyProposal } from "./types.js";

export interface GridMarketSnapshot {
  poolAddress: `0x${string}`;
  slots: MarketSnapshot[];
}

export type GridStrategyFn = (job: GridTradingJobSpec, snapshot: GridMarketSnapshot) => Promise<StrategyProposal>;

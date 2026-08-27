// Live read for Yield Optimisation's category detail page. Thin wrapper around @veyra/chain's
// already-tested readYieldObservation.

import { readYieldObservation } from "@veyra/chain/yieldPositionReader";
import type { YieldMarketSnapshot } from "@veyra/core";
import { publicClient } from "./client";
import { YIELD_CURRENT_POOL, YIELD_CANDIDATE_POOLS } from "../constants";

export interface LiveYieldState {
  snapshot: YieldMarketSnapshot;
  fetchedAt: string;
}

export async function fetchLiveYieldState(): Promise<LiveYieldState> {
  const snapshot = await readYieldObservation(publicClient, YIELD_CURRENT_POOL, [...YIELD_CANDIDATE_POOLS]);
  return { snapshot, fetchedAt: new Date().toISOString() };
}

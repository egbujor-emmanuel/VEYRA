// Live read for Grid Trading's category detail page. Thin wrapper around @veyra/chain's
// already-tested readGridObservation -- no reimplemented RPC logic, mirrors liveReads.ts's own
// discipline for the main Dashboard.

import { readGridObservation, toGridMarketSnapshot } from "@veyra/chain/gridPositionReader";
import type { GridMarketSnapshot } from "@veyra/core";
import { publicClient } from "./client";
import { GRID_POSITION_TOKEN_IDS } from "../constants";

export interface LiveGridState {
  snapshot: GridMarketSnapshot;
  fetchedAt: string;
}

export async function fetchLiveGridState(): Promise<LiveGridState> {
  const slots = await readGridObservation(publicClient, GRID_POSITION_TOKEN_IDS);
  const snapshot = toGridMarketSnapshot(slots, { recentVolatilityBps: 0 });
  return { snapshot, fetchedAt: new Date().toISOString() };
}

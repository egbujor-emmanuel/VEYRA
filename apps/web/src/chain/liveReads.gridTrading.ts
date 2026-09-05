// Live read for Grid Trading's category detail page. Thin wrapper around @veyra/chain's
// already-tested readGridObservation -- no reimplemented RPC logic, mirrors liveReads.ts's own
// discipline for the main Dashboard.

import { readGridObservation, toGridMarketSnapshot } from "@veyra/chain/gridPositionReader";
import type { GridMarketSnapshot } from "@veyra/core";
import { publicClient } from "./client";
import { resolveGridPositionTokenIds } from "@veyra/chain/positionDiscovery";
import { GRID_POSITION_TOKEN_IDS, GRID_TRADING_POOL_ADDRESS, VEYRA_WALLET } from "../constants";

export interface LiveGridState {
  snapshot: GridMarketSnapshot;
  fetchedAt: string;
}

export async function fetchLiveGridState(): Promise<LiveGridState> {
  // Discovered, not hardcoded. Recentering a slot burns it and mints a new token id, so a literal
  // list goes stale precisely when the agent works -- #37091 became #37270 on 2026-09-05 and this
  // page would have gone on rendering a position with zero liquidity. The constant survives only
  // as a fallback for when discovery cannot reach the chain.
  let tokenIds: readonly bigint[] = GRID_POSITION_TOKEN_IDS;
  try {
    const discovered = await resolveGridPositionTokenIds(
      publicClient,
      VEYRA_WALLET,
      GRID_TRADING_POOL_ADDRESS,
    );
    if (discovered.length > 0) tokenIds = discovered;
  } catch {
    // Fall through to the configured ids rather than rendering an error over a transient RPC blip.
  }

  const slots = await readGridObservation(publicClient, tokenIds);
  const snapshot = toGridMarketSnapshot(slots, { recentVolatilityBps: 0 });
  return { snapshot, fetchedAt: new Date().toISOString() };
}

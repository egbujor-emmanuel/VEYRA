// Live read for Health Factor Monitoring's category detail page. Thin wrapper around
// @veyra/chain's already-tested readVenusAccountObservation.

import { readVenusAccountObservation } from "@veyra/chain/healthFactorReader";
import type { HealthFactorMarketSnapshot } from "@veyra/core";
import { publicClient } from "./client";
import { VENUS_COMPTROLLER_TESTNET, VENUS_VBTC_TESTNET, VEYRA_WALLET } from "../constants";

export interface LiveHealthFactorState {
  snapshot: HealthFactorMarketSnapshot;
  fetchedAt: string;
}

export async function fetchLiveHealthFactorState(): Promise<LiveHealthFactorState> {
  const snapshot = await readVenusAccountObservation({
    client: publicClient,
    comptrollerAddress: VENUS_COMPTROLLER_TESTNET,
    borrowedVTokenAddress: VENUS_VBTC_TESTNET,
    account: VEYRA_WALLET,
  });
  return { snapshot, fetchedAt: new Date().toISOString() };
}

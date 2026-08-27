// Live PancakeSwap V3 grid reader: reads N real positions (one per grid slot) and assembles a
// GridMarketSnapshot. Reuses readPositionObservation/toMarketSnapshot unmodified, once per slot
// -- a grid slot's on-chain state is read exactly the same way VEYRA's single position always
// has been.

import type { PublicClient, Address } from "viem";
import type { GridMarketSnapshot } from "@veyra/core";
import { readPositionObservation, toMarketSnapshot, type OnChainPositionObservation } from "./positionReader.js";
import { PANCAKE_V3_TESTNET } from "./testnetAddresses.js";

export interface GridSlotObservation {
  slotIndex: number;
  observation: OnChainPositionObservation;
}

/** Reads every grid slot's position. Throws if the slots don't all share one pool -- a grid is one pool, by definition. */
export async function readGridObservation(
  client: PublicClient,
  gridPositionTokenIds: readonly bigint[],
  nfpmAddress: Address = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address,
  factoryAddress: Address = PANCAKE_V3_TESTNET.factory as Address,
): Promise<GridSlotObservation[]> {
  const observations = await Promise.all(
    gridPositionTokenIds.map((tokenId) => readPositionObservation(client, tokenId, nfpmAddress, factoryAddress)),
  );
  const poolAddresses = new Set(observations.map((o) => o.poolAddress.toLowerCase()));
  if (poolAddresses.size > 1) {
    throw new Error(`readGridObservation: grid slots span more than one pool (${[...poolAddresses].join(", ")}) -- a grid must be one pool`);
  }
  return observations.map((observation, slotIndex) => ({ slotIndex, observation }));
}

export function toGridMarketSnapshot(slots: GridSlotObservation[], assumed: { recentVolatilityBps: number }): GridMarketSnapshot {
  return {
    poolAddress: slots[0]!.observation.poolAddress,
    slots: slots.map(({ observation }) => toMarketSnapshot(observation, assumed)),
  };
}

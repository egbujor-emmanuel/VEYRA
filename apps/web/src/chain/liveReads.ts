// Thin wrapper around @veyra/chain's already-tested live-read functions -- no reimplemented
// RPC logic here, just orchestration for the browser. This is the ONLY module that produces
// data for the Dashboard's hero section; nothing else in this app may populate that section.

import { readPositionObservation, isTickInRange, type OnChainPositionObservation } from "@veyra/chain/positionReader";
import { NFPM_ABI } from "@veyra/chain/abis";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";
import { publicClient } from "./client";
import { VEYRA_POSITION_TOKEN_ID, VEYRA_WALLET } from "../constants";

export interface LivePositionState {
  observation: OnChainPositionObservation;
  inRange: boolean;
  owner: `0x${string}`;
  ownershipVerified: boolean;
  fetchedAt: string; // ISO timestamp, client-side, when this read resolved
}

const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as `0x${string}`;

/** The one function that produces the Dashboard's live hero data. Throws on any RPC failure --
 * callers must render an explicit error+retry state, never fall back to archived data. */
export async function fetchLivePositionState(): Promise<LivePositionState> {
  const [observation, owner] = await Promise.all([
    readPositionObservation(publicClient, VEYRA_POSITION_TOKEN_ID),
    publicClient.readContract({
      address: NFPM_ADDRESS,
      abi: NFPM_ABI,
      functionName: "ownerOf",
      args: [VEYRA_POSITION_TOKEN_ID],
    }),
  ]);

  return {
    observation,
    inRange: isTickInRange(observation.currentTick, observation.tickLower, observation.tickUpper),
    owner,
    ownershipVerified: owner.toLowerCase() === VEYRA_WALLET.toLowerCase(),
    fetchedAt: new Date().toISOString(),
  };
}

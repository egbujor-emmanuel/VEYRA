// Live reader for Yield Optimisation: reads real, current liquidity + cumulative fee-growth for
// the current pool and every candidate pool. No new tick math -- just slot0/liquidity/fee-growth
// reads, same pattern as positionReader.ts.

import type { PublicClient, Address } from "viem";
import type { YieldMarketSnapshot, YieldPoolObservation } from "@veyra/core";
import { POOL_ABI } from "./abis.js";

export interface CandidatePoolInput {
  poolAddress: Address;
  label: string;
}

async function readOnePool(client: PublicClient, poolAddress: Address, label: string): Promise<YieldPoolObservation> {
  const [liquidity, feeGrowthGlobal0X128, feeGrowthGlobal1X128] = await Promise.all([
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "liquidity" }),
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
  ]);
  // fee tier isn't exposed by POOL_ABI's current fragment set -- callers already know it (they
  // chose which pools to compare), so it's passed in rather than re-read here.
  return { poolAddress, label, fee: 0, currentLiquidity: liquidity, feeGrowthGlobal0X128, feeGrowthGlobal1X128 };
}

export async function readYieldObservation(
  client: PublicClient,
  currentPool: CandidatePoolInput & { fee: number },
  candidatePools: (CandidatePoolInput & { fee: number })[],
): Promise<YieldMarketSnapshot> {
  const allPools = [currentPool, ...candidatePools];
  const observations = await Promise.all(
    allPools.map(async (p) => ({ ...(await readOnePool(client, p.poolAddress, p.label)), fee: p.fee })),
  );
  return { currentPoolAddress: currentPool.poolAddress, pools: observations };
}

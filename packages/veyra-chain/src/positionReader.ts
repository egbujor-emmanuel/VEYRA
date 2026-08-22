// Live PancakeSwap V3 position reader for BSC testnet (architecture doc §6, step 3: "Read
// phase (SOURCE only, no tx)"). Discovers a position and its pool entirely from chain, given
// only an NFPM address and a tokenId -- never from a saved verification document.
//
// Three explicit tiers, matched to the SOURCE/DERIVED/ASSUMED split in RECON_REPORT.md §11
// and the architecture doc's own on-chain/simulated ledger (§7):
//
//   OBSERVED  (OnChainPositionObservation) -- read verbatim from chain, never computed.
//   DERIVED   (toMarketSnapshot, isTickInRange) -- deterministic functions over OBSERVED data.
//   ASSUMED   (AssumedMarketInputs) -- cannot be derived from a single chain read at all;
//             the caller must supply it explicitly. No default is silently invented here --
//             see the recentVolatilityBps doc comment below for why.

import type { PublicClient, Address } from "viem";
import type { MarketSnapshot } from "@veyra/core";
import { PANCAKE_V3_TESTNET, TICK_SPACING_BY_FEE } from "./testnetAddresses.js";
import { NFPM_ABI, FACTORY_ABI, POOL_ABI, ERC20_ABI } from "./abis.js";

/** Everything read verbatim from chain for one position. Nothing here is computed. */
export interface OnChainPositionObservation {
  positionTokenId: bigint;
  blockNumber: bigint; // every field below was read AT this block -- pinned for determinism (see readPositionObservation)
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  positionLiquidity: bigint;
  token0Decimals: number;
  token1Decimals: number;
  poolAddress: Address;
  sqrtPriceX96: bigint;
  currentTick: number;
  poolLiquidity: bigint; // the POOL's total active liquidity -- distinct from positionLiquidity (this one position's own liquidity)
}

/**
 * Cannot be derived from a single chain read, full stop -- supplied explicitly by the
 * caller, never defaulted silently.
 *
 * `recentVolatilityBps` in particular: a pool minted minutes ago (as our BSC testnet demo
 * pool was) has no meaningful price history to compute a real volatility figure from. Passing
 * a plausible-looking number here would misrepresent it as an on-chain observation. Callers
 * without a real observation window must pass an explicit, clearly-labeled placeholder (e.g.
 * 0) rather than have this module invent one.
 */
export interface AssumedMarketInputs {
  recentVolatilityBps: number;
}

/** Throws on an unrecognized fee tier rather than silently returning `undefined`. */
export function tickSpacingForFee(fee: number): number {
  const spacing = TICK_SPACING_BY_FEE[fee];
  if (spacing === undefined) {
    throw new Error(`Unknown PancakeSwap V3 fee tier: ${fee}`);
  }
  return spacing;
}

/** Whether `tick` sits inside `[tickLower, tickUpper)` -- V3's own half-open range convention. */
export function isTickInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick >= tickLower && tick < tickUpper;
}

/**
 * Reads Position #{positionTokenId} and its pool from chain. All reads are pinned to the
 * same block (fetched once, passed to every subsequent call) so the observation is
 * internally consistent even if new blocks land mid-sequence -- required for a
 * "deterministic MarketSnapshot from the live reads", not just a nice-to-have.
 */
export async function readPositionObservation(
  client: PublicClient,
  positionTokenId: bigint,
  nfpmAddress: Address = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address,
  factoryAddress: Address = PANCAKE_V3_TESTNET.factory as Address,
): Promise<OnChainPositionObservation> {
  const blockNumber = await client.getBlockNumber();

  const position = await client.readContract({
    address: nfpmAddress,
    abi: NFPM_ABI,
    functionName: "positions",
    args: [positionTokenId],
    blockNumber,
  });
  const [, , token0, token1, fee, tickLower, tickUpper, positionLiquidity] = position;

  const poolAddress = await client.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "getPool",
    args: [token0, token1, fee],
    blockNumber,
  });

  const [slot0, poolLiquidity, token0Decimals, token1Decimals] = await Promise.all([
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "slot0", blockNumber }),
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "liquidity", blockNumber }),
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "decimals", blockNumber }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "decimals", blockNumber }),
  ]);

  return {
    positionTokenId,
    blockNumber,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    positionLiquidity,
    token0Decimals,
    token1Decimals,
    poolAddress,
    sqrtPriceX96: slot0[0],
    currentTick: slot0[1],
    poolLiquidity,
  };
}

/**
 * Maps an OBSERVED position into the MarketSnapshot @veyra/core's evaluator consumes.
 *
 * Deliberately lossy: `@veyra/core`'s current MarketSnapshot has no fields for token
 * addresses, decimals, or pool-wide liquidity, so `observation.token0`/`token1`/
 * `token0Decimals`/`token1Decimals`/`poolLiquidity`/`poolAddress` are captured by
 * `readPositionObservation` but dropped here. That's a real gap in MarketSnapshot, not an
 * oversight in this function -- see this slice's report for what it would take to close it
 * (amount-based fee-efficiency modeling would need decimals; a real volatility computation
 * would need price history this pool doesn't have yet).
 *
 * `currentLiquidity` in MarketSnapshot is the POSITION's own liquidity (paired with
 * `currentRange`, which is also the position's range) -- not the pool's total liquidity.
 */
export function toMarketSnapshot(
  observation: OnChainPositionObservation,
  assumed: AssumedMarketInputs,
): MarketSnapshot {
  return {
    currentTick: observation.currentTick,
    currentRange: { tickLower: observation.tickLower, tickUpper: observation.tickUpper },
    currentLiquidity: observation.positionLiquidity,
    tickSpacing: tickSpacingForFee(observation.fee),
    recentVolatilityBps: assumed.recentVolatilityBps,
  };
}

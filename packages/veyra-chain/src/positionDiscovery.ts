// Resolves which position VEYRA is actually managing, by asking the chain instead of trusting a
// constant.
//
// Why this exists: a successful rebalance burns the old position and mints a new token id. Any
// file holding that id hardcoded goes stale the moment the agent does its job. Run #4 executed on
// 2026-08-25, minted #37079 and drained #37059 -- and the arena evaluation script kept evaluating
// #37059 for another ten days, including two rounds that read a position holding nothing. The
// constant was not wrong when it was written; it went wrong because the agent worked.
//
// Discovery removes that whole class of bug: the live position is whichever one the wallet
// actually holds liquidity in.

import type { PublicClient, Address } from "viem";
import { PANCAKE_V3_TESTNET, VEYRA_LIVE_POSITION_TOKEN_ID } from "./testnetAddresses.js";

const NFPM = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;

const ENUM_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenOfOwnerByIndex", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const FACTORY_ABI = [
  {
    type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

const POSITIONS_ABI = [
  {
    type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" }, { name: "operator", type: "address" }, { name: "token0", type: "address" },
      { name: "token1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" }, { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" }, { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" }, { name: "tokensOwed1", type: "uint128" },
    ],
  },
] as const;

export interface LivePositionResolution {
  tokenId: bigint;
  /** discovered = read from chain; fallback = discovery was ambiguous or failed. */
  source: "discovered" | "fallback";
  detail: string;
  /** Every funded position the wallet holds, excluding the ones caller asked to ignore. */
  candidates: bigint[];
}

export interface ResolveLivePositionOpts {
  /** Positions that are managed separately and must not be mistaken for the rebalance position. */
  excludeTokenIds?: readonly bigint[];
  /**
   * Restrict to positions in one pool. More durable than listing ids to exclude: VEYRA's wallet
   * holds funded positions for three categories at once -- rebalance and the two grid slots in the
   * 0.25% VUSD/WBNB pool, and the yield positions in the 0.05% one -- so without this the answer
   * is ambiguous and grows more so with every category.
   */
  poolAddress?: Address;
  /**
   * Width bounds, in ticks. The rebalance position and the grid slots share one pool, so a pool
   * filter alone cannot separate them -- but their widths differ by construction: a grid slot is a
   * narrow resting band (8 tick-spacings) while the rebalance range is wide (40). Filtering on
   * width avoids both a hardcoded id list and the circular "exclude the grid to find the rebalance,
   * exclude the rebalance to find the grid".
   */
  minWidthTicks?: number;
  maxWidthTicks?: number;
}

/** Anything narrower than this in the shared pool is a grid slot, not the rebalance range. */
export const GRID_SLOT_MAX_WIDTH_TICKS = 1_000;

/**
 * Returns the position the wallet actually has liquidity in.
 *
 * Falls back to the compiled-in constant rather than throwing, and says which happened. A daemon
 * that refuses to start because discovery was ambiguous is worse than one that proceeds on the
 * last known id and says so in its log.
 */
export async function resolveLivePositionTokenId(
  client: PublicClient,
  owner: Address,
  opts: ResolveLivePositionOpts = {},
): Promise<LivePositionResolution> {
  const excluded = new Set((opts.excludeTokenIds ?? []).map((id) => id.toString()));

  let owned: bigint[];
  try {
    const count = await client.readContract({ address: NFPM, abi: ENUM_ABI, functionName: "balanceOf", args: [owner] });
    owned = [];
    for (let i = 0n; i < count; i++) {
      owned.push(
        await client.readContract({ address: NFPM, abi: ENUM_ABI, functionName: "tokenOfOwnerByIndex", args: [owner, i] }),
      );
    }
  } catch (err) {
    return {
      tokenId: VEYRA_LIVE_POSITION_TOKEN_ID, source: "fallback",
      detail: `could not enumerate positions: ${String((err as Error).message ?? err).slice(0, 120)}`,
      candidates: [],
    };
  }

  const wantPool = opts.poolAddress?.toLowerCase();
  const funded: bigint[] = [];
  for (const id of owned) {
    if (excluded.has(id.toString())) continue;
    try {
      const p = await client.readContract({ address: NFPM, abi: POSITIONS_ABI, functionName: "positions", args: [id] });
      if ((p[7] as bigint) === 0n) continue;
      if (wantPool) {
        const pool = await client.readContract({
          address: PANCAKE_V3_TESTNET.factory as Address, abi: FACTORY_ABI, functionName: "getPool",
          args: [p[2] as Address, p[3] as Address, Number(p[4])],
        });
        if ((pool as string).toLowerCase() !== wantPool) continue;
      }
      const widthTicks = Number(p[6]) - Number(p[5]);
      if (opts.minWidthTicks !== undefined && widthTicks < opts.minWidthTicks) continue;
      if (opts.maxWidthTicks !== undefined && widthTicks > opts.maxWidthTicks) continue;
      funded.push(id);
    } catch {
      // A position that cannot be read is not a candidate; keep going rather than failing the pass.
    }
  }

  if (funded.length === 1) {
    return { tokenId: funded[0]!, source: "discovered", detail: `sole funded position held by ${owner}`, candidates: funded };
  }
  if (funded.length === 0) {
    return {
      tokenId: VEYRA_LIVE_POSITION_TOKEN_ID, source: "fallback",
      detail: `wallet holds no funded positions outside the excluded set`, candidates: funded,
    };
  }

  // More than one is genuinely ambiguous -- prefer the compiled-in id if it is among them, since
  // that is the one every archive and page refers to, and say that a choice was made.
  const constantIsFunded = funded.some((id) => id === VEYRA_LIVE_POSITION_TOKEN_ID);
  return {
    tokenId: constantIsFunded ? VEYRA_LIVE_POSITION_TOKEN_ID : funded[0]!,
    source: "fallback",
    detail:
      `${funded.length} funded positions (${funded.join(", ")}); ` +
      (constantIsFunded ? `kept the configured ${VEYRA_LIVE_POSITION_TOKEN_ID}` : `took the first`),
    candidates: funded,
  };
}


/**
 * Every funded grid slot in the pool, ordered by price band.
 *
 * Grid slots go stale faster than anything else here: recentering one burns it and mints a new
 * token id, so a hardcoded list is wrong the moment the agent does its job. That happened twice in
 * one session -- #37092 became #37093, then #37091 became #37270 -- with the id written out in
 * three separate files each time.
 *
 * Returns them sorted by tickLower so slot ordering is positional and stable rather than depending
 * on mint order.
 */
export async function resolveGridPositionTokenIds(
  client: PublicClient,
  owner: Address,
  poolAddress: Address,
): Promise<bigint[]> {
  const resolution = await resolveLivePositionTokenId(client, owner, {
    poolAddress,
    maxWidthTicks: GRID_SLOT_MAX_WIDTH_TICKS,
  });
  // resolveLivePositionTokenId returns every match in `candidates`; for grid we want all of them,
  // not the single winner it picks.
  const ids = resolution.candidates.length > 0 ? resolution.candidates : [];

  const withRange = await Promise.all(
    ids.map(async (id) => {
      const p = await client.readContract({ address: NFPM, abi: POSITIONS_ABI, functionName: "positions", args: [id] });
      return { id, tickLower: Number(p[5]) };
    }),
  );
  return withRange.sort((a, b) => a.tickLower - b.tickLower).map((x) => x.id);
}

// Lets a visitor put real capital under VEYRA's management.
//
// Why this exists: a new passkey wallet holds a little tBNB and nothing else. It owns no
// PancakeSwap position, so even a perfectly working agent has nothing to manage -- "grant VEYRA a
// scoped key and let it run your position" was unreachable for anyone starting from zero.
//
// Why single-sided: the pool is VUSD/WBNB and the visitor has no VUSD. In Uniswap-V3-style
// concentrated liquidity a range that sits entirely on one side of the current price is funded by
// exactly one token -- and since WBNB is token1 here, a range with tickUpper <= currentTick needs
// only WBNB. So the visitor wraps some of their own tBNB and deposits it, with no swap and no
// second token required.
//
// That the position starts OUT OF RANGE is the point, not a flaw: it earns nothing where it sits,
// which is precisely the condition the rebalancing agent exists to notice and fix. The session
// they granted covers both the position manager and the swap router, which is what recentring
// needs.

import { encodeFunctionData, type Address } from "viem";
import { altanaClient, type UserWallet } from "./passkeyWallet";
import { publicClient } from "./client";

/** The pool VEYRA manages. VUSD is token0, WBNB is token1 -- orientation verified on-chain. */
export const MANAGED_POOL = {
  address: "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as Address,
  token0: "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d" as Address, // VUSD
  token1: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address, // WBNB
  fee: 2500,
  tickSpacing: 50,
};

const NFPM = "0x427bF5b37357632377eCbEC9de3626C71A5396c1" as Address;
const SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14" as Address;

/**
 * Pre-approval ceiling granted at deposit time, so the agent never needs approval rights.
 *
 * Rebalancing a position requires approving the position manager (to mint) and the swap router
 * (to fix the token ratio). Those are calls to the TOKEN contracts, deliberately outside VEYRA's
 * session scope -- an approval permission is the power to hand a balance to any spender, and
 * granting the agent that would undo the point of a narrow session.
 *
 * So the user grants them here, under their own signature, scoped to these two spenders only.
 * Not unbounded: PancakeSwap's own guidance is explicit that unbounded approvals are the wrong
 * default. This is sized to the deposit, which is the most the agent can ever need to recycle.
 */
function approvalCeiling(amountWei: bigint): bigint {
  return amountWei * 4n;
}

const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bool" }] },
] as const;

const WBNB_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const MINT_ABI = [
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
    { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
    { name: "amount0Desired", type: "uint256" }, { name: "amount1Desired", type: "uint256" },
    { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
    { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }] }],
    outputs: [{ name: "tokenId", type: "uint256" }, { name: "liquidity", type: "uint128" }, { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenOfOwnerByIndex", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "i", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

/** How many tick-spacings wide the deposited range is. Narrow enough to be a real position. */
const RANGE_WIDTH_SPACINGS = 20;

export interface DepositRange {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
}

/**
 * Computes a WBNB-only range: entirely below the current tick, aligned to tick spacing.
 *
 * The upper bound is pushed one spacing below the current tick rather than sitting exactly on it,
 * because a range whose upper edge equals the current tick can flip to needing both tokens on the
 * next block's price move, and the mint would then fail for want of VUSD.
 */
export async function computeDepositRange(): Promise<DepositRange> {
  const slot0 = await publicClient.readContract({ address: MANAGED_POOL.address, abi: POOL_ABI, functionName: "slot0" });
  const currentTick = Number(slot0[1]);
  const s = MANAGED_POOL.tickSpacing;
  const tickUpper = Math.floor((currentTick - s) / s) * s;
  return { currentTick, tickLower: tickUpper - s * RANGE_WIDTH_SPACINGS, tickUpper };
}

export async function readWbnbBalance(address: string): Promise<bigint> {
  return publicClient.readContract({
    address: MANAGED_POOL.token1, abi: WBNB_ABI, functionName: "balanceOf", args: [address as Address],
  }) as Promise<bigint>;
}

/** Position NFTs the visitor owns. Used to show what is already under management. */
export async function readOwnedPositions(address: string): Promise<bigint[]> {
  const count = (await publicClient.readContract({
    address: NFPM, abi: MINT_ABI, functionName: "balanceOf", args: [address as Address],
  })) as bigint;

  const ids: bigint[] = [];
  for (let i = 0n; i < count; i++) {
    ids.push((await publicClient.readContract({
      address: NFPM, abi: MINT_ABI, functionName: "tokenOfOwnerByIndex", args: [address as Address, i],
    })) as bigint);
  }
  return ids;
}

/**
 * Wraps native tBNB and mints a WBNB-only position, all signed by the visitor's own passkey.
 *
 * These are ADMIN-path calls on the user's own wallet, not session calls: wrapping and approving
 * touch WBNB, which is deliberately outside the scope granted to VEYRA. The agent can manage the
 * resulting position; it could never have created it, and could never wrap the user's BNB.
 */
export async function depositIntoManagedPosition(wallet: UserWallet, amountWei: bigint) {
  const range = await computeDepositRange();

  return altanaClient().execute({
    wallet,
    signer: wallet.signer,
    calls: [
      { to: MANAGED_POOL.token1, value: amountWei, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit", args: [] }) },
      // Approve both spenders, for both tokens, in the user's own name. The agent will need
      // these when it recentres the position; it cannot grant them itself, and the session
      // signer refuses to proceed rather than attempting an approval it has no right to make.
      { to: MANAGED_POOL.token1, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "approve", args: [NFPM, approvalCeiling(amountWei)] }) },
      { to: MANAGED_POOL.token1, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "approve", args: [SWAP_ROUTER, approvalCeiling(amountWei)] }) },
      { to: MANAGED_POOL.token0, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "approve", args: [NFPM, approvalCeiling(amountWei)] }) },
      { to: MANAGED_POOL.token0, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "approve", args: [SWAP_ROUTER, approvalCeiling(amountWei)] }) },
      {
        to: NFPM,
        data: encodeFunctionData({
          abi: MINT_ABI,
          functionName: "mint",
          args: [{
            token0: MANAGED_POOL.token0, token1: MANAGED_POOL.token1, fee: MANAGED_POOL.fee,
            tickLower: range.tickLower, tickUpper: range.tickUpper,
            amount0Desired: 0n, amount1Desired: amountWei,
            // Zero minimums are safe here only because this is a single-sided mint at a range we
            // just computed from the live tick: there is no swap and no second asset to be
            // sandwiched on. A two-sided mint would need real minimums.
            amount0Min: 0n, amount1Min: 0n,
            recipient: wallet.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
          }],
        }),
      },
    ],
  });
}

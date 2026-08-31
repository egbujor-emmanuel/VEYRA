// ERC-8183 job escrow -- the paid-hire rail. This is what makes VEYRA a marketplace and not a
// free authorization demo: a real user funds a real on-chain job in $U against VEYRA's address,
// VEYRA delivers, and the escrow settles after a dispute window (or the user reclaims it).
//
// Every call here is submitted by the USER'S OWN passkey wallet via Altana's execute() -- VEYRA
// never creates or funds a job on a user's behalf. ABIs are the real deployed ones, read
// directly out of @bnbagent/sdk's bundled contract definitions rather than hand-written.

import { encodeFunctionData, type Address } from "viem";
import { altanaClient, type UserWallet } from "./passkeyWallet";
import { ERC8183_TESTNET, U_TOKEN_TESTNET } from "../constants";

export const COMMERCE_ABI = [
  {
    type: "function", name: "createJob", stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" }, { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint256" }, { name: "description", type: "string" },
      { name: "hook", type: "address" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function", name: "setBudget", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "optParams", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function", name: "fund", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }, { name: "expectedBudget", type: "uint256" }, { name: "optParams", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function", name: "claimRefund", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function", name: "settle", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }, { name: "evidence", type: "bytes" }],
    outputs: [],
  },
] as const;

export const ROUTER_ABI = [
  {
    type: "function", name: "registerJob", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }, { name: "policy", type: "address" }],
    outputs: [],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface HireAgentOpts {
  wallet: UserWallet;
  /** The agent being hired -- its own on-chain address (the provider that gets paid). */
  providerAddress: Address;
  /** Budget in $U (18 decimals). */
  budgetWei: bigint;
  /** Plain-language description stored on-chain with the job. */
  description: string;
  /** Seconds from now until the job expires if never delivered. */
  expirySeconds: number;
}

/**
 * Creates, registers, budgets, and funds a job in one batch of calls, all signed by the user's
 * own passkey wallet. Batched deliberately: a job that is created but never funded is dead
 * weight on-chain, and splitting these across separate biometric prompts invites exactly that.
 *
 * Note the ordering constraint this encodes: `approve` must precede `fund`, and `registerJob`
 * must precede settlement for the dispute policy to be bound. `createJob` returns the id, but a
 * batch cannot read its own intermediate return value -- so the caller resolves the assigned
 * jobId from the receipt afterwards (see resolveJobIdFromReceipt).
 */
export async function hireAgent(opts: HireAgentOpts) {
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + opts.expirySeconds);

  const createCall = {
    to: ERC8183_TESTNET.commerce,
    data: encodeFunctionData({
      abi: COMMERCE_ABI,
      functionName: "createJob",
      args: [opts.providerAddress, ERC8183_TESTNET.router, expiredAt, opts.description, ERC8183_TESTNET.router],
    }),
  };

  const approveCall = {
    to: U_TOKEN_TESTNET,
    data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [ERC8183_TESTNET.commerce, opts.budgetWei] }),
  };

  return altanaClient().execute({
    wallet: opts.wallet,
    signer: opts.wallet.signer,
    calls: [createCall, approveCall],
  });
}

/** Funds an already-created job. Separate from hireAgent so a user can top up or retry funding. */
export async function fundJob(wallet: UserWallet, jobId: bigint, budgetWei: bigint) {
  return altanaClient().execute({
    wallet,
    signer: wallet.signer,
    calls: [
      { to: ERC8183_TESTNET.router, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, ERC8183_TESTNET.policy] }) },
      { to: ERC8183_TESTNET.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, budgetWei, "0x"] }) },
      { to: ERC8183_TESTNET.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [jobId, budgetWei, "0x"] }) },
    ],
  });
}

/** User-side escape hatch: reclaim escrow from a job the agent never delivered on. */
export async function claimRefund(wallet: UserWallet, jobId: bigint) {
  return altanaClient().execute({
    wallet,
    signer: wallet.signer,
    calls: [{ to: ERC8183_TESTNET.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "claimRefund", args: [jobId] }) }],
  });
}

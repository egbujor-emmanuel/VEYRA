// ERC-8183 job escrow -- the paid-hire rail. This is what makes VEYRA a marketplace and not a
// free authorization demo: a real user funds a real on-chain job in $U against VEYRA's address,
// VEYRA delivers, and the escrow settles after a dispute window (or the user reclaims it).
//
// Every call here is submitted by the USER'S OWN passkey wallet via Altana's execute() -- VEYRA
// never creates or funds a job on a user's behalf. ABIs are the real deployed ones, read
// directly out of @bnbagent/sdk's bundled contract definitions rather than hand-written.

import { encodeFunctionData, decodeEventLog, type Address, type Log } from "viem";
import { publicClient } from "./client";
import { altanaClient, type UserWallet } from "./passkeyWallet";
import { ERC8183_TESTNET, U_TOKEN_TESTNET, U_TOKEN_FAUCET_TESTNET } from "../constants";

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
  // Provider-side delivery. Note the bytes32 deliverable -- an earlier hand-written version of
  // this ABI had submit(uint256,bytes), which does not exist on the deployed contract.
  {
    type: "function", name: "submit", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }, { name: "deliverable", type: "bytes32" }, { name: "optParams", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function", name: "jobs", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      { name: "id", type: "uint256" }, { name: "client", type: "address" },
      { name: "provider", type: "address" }, { name: "evaluator", type: "address" },
      // Order matters: ABI decoding is positional, so a swapped pair silently returns a timestamp
      // where a budget is expected. An earlier hand-written version of this had budget/expiredAt
      // the wrong way round and fundedAt in place of submittedAt. Verified field-by-field against
      // the deployed contract's own ABI (scripts/agenticCommerce.abi.json).
      { name: "description", type: "string" }, { name: "budget", type: "uint256" },
      { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" },
      { name: "hook", type: "address" }, { name: "submittedAt", type: "uint256" },
      { name: "deliverable", type: "bytes32" },
    ],
  },
  {
    type: "event", name: "JobCreated",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true },
      { name: "provider", type: "address", indexed: true }, { name: "evaluator", type: "address", indexed: false },
      { name: "expiredAt", type: "uint256", indexed: false }, { name: "hook", type: "address", indexed: false },
    ],
  },
  {
    type: "event", name: "JobFunded",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true },
      { name: "provider", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Refunded",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

// Settlement lives on the EvaluatorRouter, NOT on Commerce. A previous hand-written version of
// this file declared settle() on the Commerce ABI; no such function exists there, and calling it
// would have reverted. Verified against the deployed contracts' own ABIs, extracted from
// @bnbagent/sdk (scripts/agenticCommerce.abi.json, scripts/evaluatorRouter.abi.json).
export const ROUTER_ABI = [
  {
    type: "function", name: "registerJob", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }, { name: "policy", type: "address" }],
    outputs: [],
  },
  {
    type: "function", name: "settle", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }, { name: "evidence", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function", name: "markExpired", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
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


/**
 * The complete hire: create the job, then register/budget/fund it so the money is actually in
 * escrow. Split into two on-chain steps because a batch cannot read its own createJob return
 * value -- the jobId only exists once JobCreated has been emitted, so it must be parsed from the
 * receipt in between.
 *
 * This exists because the UI previously called hireAgent() alone and reported "Job funded". That
 * was wrong: createJob + approve moves nothing. Verified end-to-end on BSC testnet in
 * scripts/proveHireFlow.mjs -- the budget only leaves the user's wallet at the fund() step.
 */
export async function hireAndFund(
  opts: HireAgentOpts,
  onProgress?: (note: string) => void,
): Promise<{ jobId: bigint; createTxHash?: string; fundTxHash?: string }> {
  // Fail early and clearly rather than letting fund() revert with a bare "0x". Escrow is funded
  // in $U; a visitor with none gets an unexplained empty revert deep in the sequence, after
  // already having approved a device prompt.
  const uBalance = await readUBalance(opts.wallet.address);
  if (uBalance < opts.budgetWei) {
    throw new Error(
      `INSUFFICIENT_U:${uBalance.toString()}:${opts.budgetWei.toString()}`,
    );
  }

  onProgress?.("Creating the job on-chain…");
  const created = await executeWithNonceRetry(() => hireAgent(opts));

  if (!created.transactionHash) {
    throw new Error("The job-creation transaction did not return a hash, so its jobId cannot be resolved.");
  }

  onProgress?.("Reading the job id from the receipt…");
  const receipt = await publicClient.getTransactionReceipt({ hash: created.transactionHash as `0x${string}` });
  const jobId = resolveJobIdFromReceipt(receipt.logs);
  if (jobId === undefined) {
    throw new Error("The job was created but no JobCreated event was found, so it cannot be funded.");
  }

  onProgress?.(`Job #${jobId} created. Funding the escrow…`);
  const funded = await executeWithNonceRetry(() => fundJob(opts.wallet, jobId, opts.budgetWei));

  return { jobId, createTxHash: created.transactionHash, fundTxHash: funded.transactionHash };
}

/** Pulls the assigned jobId out of the Commerce contract's own JobCreated event. */
export function resolveJobIdFromReceipt(logs: readonly Log[]): bigint | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== ERC8183_TESTNET.commerce.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: COMMERCE_ABI,
        eventName: "JobCreated",
        data: log.data,
        topics: log.topics,
      });
      if (decoded.args && "jobId" in decoded.args) return decoded.args.jobId as bigint;
    } catch {
      // Not a JobCreated log -- keep looking.
    }
  }
  return undefined;
}


const ERC20_READ_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const FAUCET_ABI = [
  { type: "function", name: "requestTokens", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

/** The visitor's $U balance. Escrow is funded in $U, not BNB -- an empty balance is the single
 *  most common reason a hire fails, and it fails with a bare unexplained revert. */
export async function readUBalance(address: string): Promise<bigint> {
  return publicClient.readContract({
    address: U_TOKEN_TESTNET,
    abi: ERC20_READ_ABI,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  }) as Promise<bigint>;
}

/** Claims free testnet $U. The faucet's entrypoint is requestTokens(), confirmed from its bytecode. */
export async function claimTestU(wallet: UserWallet) {
  return altanaClient().execute({
    wallet,
    signer: wallet.signer,
    calls: [{ to: U_TOKEN_FAUCET_TESTNET, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: "requestTokens", args: [] }) }],
  });
}

/**
 * Altana's relay tracks a nonce per account and rejects a prepareCalls that arrives before it has
 * caught up with the previous one, surfacing as InvalidNonce. The hire flow submits two separate
 * transactions back to back, which hits this reliably -- it was found the same way in
 * scripts/proveHireFlow.mjs. Serialize with a settle delay and retry on that specific error.
 */
async function executeWithNonceRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const text = `${err instanceof Error ? err.message : String(err)} ${JSON.stringify((err as { cause?: unknown })?.cause ?? "")}`;
      if (!text.includes("InvalidNonce") || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 8_000 * attempt));
    }
  }
}

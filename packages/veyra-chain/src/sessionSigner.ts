// Lets the proven rebalance execution path run through an Altana SESSION instead of an admin key.
//
// executeRebalanceForPosition() takes a Signer abstraction, so rather than writing a second copy
// of money-moving code for the autonomous path, this adapts a session to that same interface. The
// agent therefore runs the identical decrease -> collect -> swap -> mint -> verify sequence that
// has been exercised on-chain since the first real rebalance.
//
// The approval problem, and why it is solved this way
// --------------------------------------------------
// That sequence issues ERC-20 approvals on the pool's tokens (approve SwapRouter before a swap,
// approve the position manager before a mint). Those are calls to the TOKEN contracts, which are
// deliberately NOT in the session's allowlist -- VEYRA is granted the position manager and the
// swap router, nothing else.
//
// Widening the session to include the tokens would be the easy fix and the wrong one: an approval
// permission is the power to hand a user's balance to an arbitrary spender. Instead the user
// grants those approvals themselves, once, at deposit time, under their own signature and scoped
// to specific spenders.
//
// So this adapter does not silently skip approval steps -- it VERIFIES the allowance already
// covers the amount and throws if it does not. A missing approval is a real problem the operator
// must see, not something to paper over.

import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import type { Signer, TxRecord } from "./txSigner.js";
import { ERC20_ABI } from "./abis.js";

/** The subset of the Altana client this needs -- decoupled from the SDK's concrete type. */
export interface SessionExecutor {
  execute(opts: { session: unknown; calls: { to: Address; data: Hex; value?: bigint }[] }): Promise<{
    transactionHash?: Hex;
    status: string;
  }>;
}

export interface SessionSignerOpts {
  client: PublicClient;
  /** The Altana client (or anything exposing a compatible execute). */
  executor: SessionExecutor;
  /** The reconstructed Session object, holding the agent's private session key. */
  session: unknown;
  /** The account the session acts on -- the user's smart account. */
  walletAddress: Address;
  /** Spenders the user is expected to have pre-approved: the position manager and swap router. */
  expectedSpenders: Address[];
  /** Optional hook so callers can log each step without this module owning a logger. */
  onStep?: (step: string, detail: string) => void;
}

const APPROVE_SELECTOR = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: ["0x0000000000000000000000000000000000000000", 0n] }).slice(0, 10);

/**
 * Builds a Signer that routes every call through an Altana session.
 *
 * Note the address: it is the USER'S wallet, not the agent's. The session key signs, but the call
 * executes as the user's smart account, which is why the position manager sees the user as owner.
 */
export function createSessionSigner(opts: SessionSignerOpts): Signer {
  const { client, executor, session, walletAddress, expectedSpenders, onStep } = opts;

  async function sendAndWait(step: string, to: Address, data: Hex, value: bigint = 0n): Promise<TxRecord> {
    // Approvals are the user's to grant, not the agent's. Verify rather than attempt.
    if (data.slice(0, 10) === APPROVE_SELECTOR) {
      const spender = (`0x${data.slice(34, 74)}`) as Address;
      const amount = BigInt(`0x${data.slice(74, 138)}`);

      if (!expectedSpenders.some((s) => s.toLowerCase() === spender.toLowerCase())) {
        throw new Error(
          `[${step}] session refused: approval to ${spender}, which is not a spender the user pre-approved. ` +
            `VEYRA is not permitted to grant token approvals.`,
        );
      }

      const allowance = (await client.readContract({
        address: to,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [walletAddress, spender],
      })) as bigint;

      if (allowance < amount) {
        throw new Error(
          `[${step}] session cannot proceed: token ${to} allowance for ${spender} is ${allowance}, ` +
            `below the ${amount} this step needs. The user must approve it -- the agent has no ` +
            `permission to do so on their behalf.`,
        );
      }

      onStep?.(step, `already approved (allowance ${allowance} >= ${amount}) -- no transaction needed`);
      return {
        step: `${step}-preapproved`,
        hash: "0x" as Hex,
        gasUsed: "0",
        gasPriceWei: "0",
        status: "success",
        blockNumber: "0",
      };
    }

    const result = await executor.execute({ session, calls: [{ to, data, ...(value > 0n ? { value } : {}) }] });
    if (!result.transactionHash) {
      throw new Error(`[${step}] session execute returned no transaction hash (status ${result.status})`);
    }

    // Never trust the relay's own status alone -- read the receipt, same as the admin path.
    const receipt = await client.waitForTransactionReceipt({ hash: result.transactionHash, timeout: 120_000 });
    if (receipt.status !== "success") {
      throw new Error(`[${step}] transaction REVERTED (hash ${result.transactionHash})`);
    }

    onStep?.(step, result.transactionHash);
    return {
      step,
      hash: result.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: (receipt.effectiveGasPrice ?? 0n).toString(),
      status: "success",
      blockNumber: receipt.blockNumber.toString(),
    };
  }

  return { address: walletAddress, sendAndWait };
}

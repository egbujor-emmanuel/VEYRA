// Real execution for Health Factor Monitoring: repay Venus debt on BSC testnet.
//
// The critical property this module enforces: Venus is a Compound fork, so repayBorrow() returns
// a uint256 error code rather than reverting when it declines. A transaction can therefore be
// mined with receipt status "success" and change nothing at all. Every function here re-reads the
// borrow balance from chain afterwards and reports the DELTA, never the receipt, as the outcome.
// Same delta-based discipline the rebalance executor uses -- absolute balances are never trusted.

import type { PublicClient, Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import type { Signer, TxRecord } from "./txSigner.js";
import { VTOKEN_WRITE_ABI, ERC20_APPROVE_ABI, VTOKEN_UNDERLYING_ABI, VTOKEN_NATIVE_REPAY_ABI } from "./venusAbis.js";

export interface RepayResult {
  /** Debt before and after, in the underlying token's own units. */
  borrowBefore: bigint;
  borrowAfter: bigint;
  /** How much debt actually disappeared. This -- not the receipt -- is the proof of execution. */
  repaidAmount: bigint;
  txs: TxRecord[];
}

/** Reads the current stored borrow balance for an account. */
export async function readBorrowBalance(
  client: PublicClient,
  vToken: Address,
  account: Address,
): Promise<bigint> {
  return client.readContract({
    address: vToken,
    abi: VTOKEN_WRITE_ABI,
    functionName: "borrowBalanceStored",
    args: [account],
  }) as Promise<bigint>;
}

/**
 * Repays `amount` of the vToken's underlying debt.
 *
 * Approves exactly the repay amount rather than an unbounded allowance: this wallet's whole
 * purpose is to demonstrate scoped, minimal authority, and leaving an infinite approval to a
 * lending market would contradict that.
 */
export async function repayVenusBorrow(
  client: PublicClient,
  signer: Signer,
  vToken: Address,
  amount: bigint,
): Promise<RepayResult> {
  const account = signer.address;
  const txs: TxRecord[] = [];

  // Venus has two market shapes and they repay differently. An ERC-20 market exposes underlying()
  // and needs approve-then-repayBorrow(amount). The native market (vBNB) has no underlying at all
  // -- repayBorrow() is payable and takes the amount as msg.value. Calling the ERC-20 path there
  // reverts on the missing underlying(), so the shape has to be detected rather than assumed.
  let underlying: Address | null = null;
  try {
    underlying = (await client.readContract({
      address: vToken,
      abi: VTOKEN_UNDERLYING_ABI,
      functionName: "underlying",
    })) as Address;
  } catch {
    underlying = null; // native market
  }

  if (underlying === null) {
    const borrowBefore = await readBorrowBalance(client, vToken, account);
    if (borrowBefore === 0n) {
      throw new Error(`Account ${account} has no outstanding borrow on ${vToken} -- nothing to repay.`);
    }
    const held = await client.getBalance({ address: account });
    if (held < amount) {
      throw new Error(
        `Cannot repay ${amount} wei of native currency: wallet holds only ${held}. Repaying more ` +
          `than is held would revert.`,
      );
    }

    txs.push(
      await signer.sendAndWait(
        "repay-borrow-native",
        vToken,
        encodeFunctionData({ abi: VTOKEN_NATIVE_REPAY_ABI, functionName: "repayBorrow", args: [] }) as Hex,
        amount,
      ),
    );

    const borrowAfter = await readBorrowBalance(client, vToken, account);
    const repaidAmount = borrowBefore > borrowAfter ? borrowBefore - borrowAfter : 0n;
    if (repaidAmount === 0n) {
      throw new Error(
        `repayBorrow was mined but the debt did not change (still ${borrowAfter}). Venus returns an ` +
          `error code instead of reverting, so this is a silent refusal, not a success.`,
      );
    }
    return { borrowBefore, borrowAfter, repaidAmount, txs };
  }

  const borrowBefore = await readBorrowBalance(client, vToken, account);
  if (borrowBefore === 0n) {
    throw new Error(`Account ${account} has no outstanding borrow on ${vToken} -- nothing to repay.`);
  }

  const held = (await client.readContract({
    address: underlying,
    abi: ERC20_APPROVE_ABI,
    functionName: "balanceOf",
    args: [account],
  })) as bigint;
  if (held < amount) {
    throw new Error(
      `Cannot repay ${amount} units: wallet holds only ${held} of the underlying token. ` +
        `Repaying more than is held would revert.`,
    );
  }

  txs.push(
    await signer.sendAndWait(
      "approve-underlying-for-repay",
      underlying,
      encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [vToken, amount] }) as Hex,
    ),
  );

  txs.push(
    await signer.sendAndWait(
      "repay-borrow",
      vToken,
      encodeFunctionData({ abi: VTOKEN_WRITE_ABI, functionName: "repayBorrow", args: [amount] }) as Hex,
    ),
  );

  const borrowAfter = await readBorrowBalance(client, vToken, account);
  const repaidAmount = borrowBefore > borrowAfter ? borrowBefore - borrowAfter : 0n;

  // The Compound-fork failure mode: mined, "successful", and completely inert.
  if (repaidAmount === 0n) {
    throw new Error(
      `repayBorrow was mined but the debt did not change (still ${borrowAfter}). Venus returns an ` +
        `error code instead of reverting, so this is a silent refusal, not a success.`,
    );
  }

  return { borrowBefore, borrowAfter, repaidAmount, txs };
}

/**
 * Increases the borrow. Exists so the monitoring agent can be exercised against a genuinely
 * elevated-risk position rather than only ever observing a healthy one -- BSC testnet supplies no
 * organic borrower whose ratio drifts on its own. The added debt is real, and so is the risk it
 * creates, which is exactly why the caller must pass an explicit amount.
 */
export async function borrowMore(
  client: PublicClient,
  signer: Signer,
  vToken: Address,
  amount: bigint,
): Promise<{ borrowBefore: bigint; borrowAfter: bigint; txs: TxRecord[] }> {
  const borrowBefore = await readBorrowBalance(client, vToken, signer.address);

  const txs = [
    await signer.sendAndWait(
      "borrow",
      vToken,
      encodeFunctionData({ abi: VTOKEN_WRITE_ABI, functionName: "borrow", args: [amount] }) as Hex,
    ),
  ];

  const borrowAfter = await readBorrowBalance(client, vToken, signer.address);
  if (borrowAfter <= borrowBefore) {
    throw new Error(
      `borrow was mined but the debt did not increase (still ${borrowAfter}). Venus declined it ` +
        `with an error code rather than reverting -- likely insufficient collateral headroom.`,
    );
  }

  return { borrowBefore, borrowAfter, txs };
}

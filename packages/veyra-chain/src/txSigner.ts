// Reusable, safety-gated transaction signer -- extracted from Slice 3's
// runControlledTestnetExecution.ts so the orchestrator (and any future caller) shares ONE
// tested build/sign/broadcast/wait path instead of each script re-implementing it. The wallet's
// private key never leaves the WalletProvider's own encapsulation; this module only ever calls
// its public signTransaction() method.

import type { PublicClient, Address, Hex } from "viem";

const GAS_BUFFER_NUMERATOR = 120n; // +20%, matching the SDK's own documented gas-estimation convention
const GAS_BUFFER_DENOMINATOR = 100n;

export interface TxRecord {
  step: string;
  hash: Hex;
  gasUsed: string;
  gasPriceWei: string;
  status: "success" | "reverted";
  blockNumber: string;
}

/** Minimal shape this module needs from a wallet provider -- decoupled from the concrete SDK class. */
export interface SigningWallet {
  address: string;
  signTransaction(tx: { to: Address; data: Hex; value: bigint; gas: bigint; gasPrice: bigint; nonce: number; chainId: number }): Promise<{ rawTransaction: Hex }>;
}

export interface Signer {
  address: Address;
  /** Build, sign, broadcast, and wait for a transaction. Throws if the receipt's status is not "success". */
  sendAndWait(step: string, to: Address, data: Hex): Promise<TxRecord>;
}

export function createSigner(client: PublicClient, wallet: SigningWallet, chainId: number): Signer {
  const address = wallet.address as Address;

  async function sendAndWait(step: string, to: Address, data: Hex): Promise<TxRecord> {
    const [nonce, gasPriceWei, gasEstimate] = await Promise.all([
      client.getTransactionCount({ address, blockTag: "pending" }),
      client.getGasPrice(),
      client.estimateGas({ account: address, to, data, value: 0n }),
    ]);
    const gas = (gasEstimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;

    const signed = await wallet.signTransaction({ to, data, value: 0n, gas, gasPrice: gasPriceWei, nonce, chainId });
    const hash = await client.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });

    if (receipt.status !== "success") {
      throw new Error(`[${step}] transaction REVERTED (hash ${hash})`);
    }
    return {
      step,
      hash,
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: gasPriceWei.toString(),
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
    };
  }

  return { address, sendAndWait };
}

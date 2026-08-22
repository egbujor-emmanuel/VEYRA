// Resume-and-complete Execution #1 (docs/executions/execution-0001.json), which correctly
// completed decreaseLiquidity and collect but reverted on mint.
//
// ROOT CAUSE, found and fixed here: runControlledTestnetExecution.ts read the wallet's TOTAL
// post-collect token0 balance and used it as mint's amount0Desired. That balance included a
// large PRE-EXISTING token0 balance unrelated to this position (VEYRA's own demo token,
// minted in bulk to the wallet back when the pool was first created) -- not "what this
// operation yielded." The real amount collect() delivered for token0 was the position's
// tokensOwed0 read in Step 6 of execution-0001.json (5947044489544840472), not the wallet's
// full balance (9999999999999999999999). token1 had no pre-existing balance, so its number
// happened to be correct by coincidence, which is why only token0 triggered "Price slippage
// check" -- mint would have used far more token0 than the target range's price ratio allows,
// which the contract's own amountMin floor correctly rejected.
//
// This script performs ONLY the corrected mint (decreaseLiquidity/collect already succeeded
// and are verified on-chain; NFPM allowances from execution-0001 are already sufficient for
// both tokens -- confirmed live before writing this file, no new approve needed).

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, type Address, type Hex } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation } from "../src/positionReader.js";
import { NFPM_ABI, ERC20_ABI } from "../src/abis.js";
import { PANCAKE_V3_TESTNET } from "../src/testnetAddresses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const SMOKETEST_ROOT = resolve(REPO_ROOT, "smoketest");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const EXECUTIONS_DIR = resolve(REPO_ROOT, "docs/executions");
const PREDECESSOR_PATH = resolve(EXECUTIONS_DIR, "execution-0001.json");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const VEYRA_POSITION_TOKEN_ID = 37058n;
const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;
const CHAIN_ID = 97;
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;

// The REAL amounts collect() delivered (position's own tokensOwed, read in execution-0001's
// Step 6, BEFORE collect ran, i.e. this position's actual entitlement -- not the wallet's
// total post-collect balance, which is what caused the original revert).
const CORRECT_AMOUNT0_DESIRED = 5_947_044_489_544_840_472n;
const CORRECT_AMOUNT1_DESIRED = 19_999_999_999_999_999n;
const MAX_SLIPPAGE_BPS = 100; // matches execution-0001's job.constraints.maxSlippageBps
const TARGET_TICK_LOWER = -58050;
const TARGET_TICK_UPPER = -56050;

function readWalletPassword(): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WALLET_PASSWORD=")) return trimmed.slice("WALLET_PASSWORD=".length);
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}

function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
  }
  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  // Pre-flight: confirm the position really is empty and allowances really are sufficient --
  // do not trust the narrative comment above, verify live before signing anything.
  const pos = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "positions", args: [VEYRA_POSITION_TOKEN_ID] });
  if (pos[7] !== 0n) throw new Error(`expected position #37058 liquidity to be 0 (already decreased), got ${pos[7]}`);

  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  const [allowance0, allowance1] = await Promise.all([
    client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "allowance", args: [VEYRA_WALLET, NFPM_ADDRESS] }),
    client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "allowance", args: [VEYRA_WALLET, NFPM_ADDRESS] }),
  ]);
  if (allowance0 < CORRECT_AMOUNT0_DESIRED) throw new Error(`token0 allowance ${allowance0} is less than the amount to mint ${CORRECT_AMOUNT0_DESIRED}`);
  if (allowance1 < CORRECT_AMOUNT1_DESIRED) throw new Error(`token1 allowance ${allowance1} is less than the amount to mint ${CORRECT_AMOUNT1_DESIRED}`);
  console.log(`Pre-flight OK: position liquidity=0, allowance0=${allowance0} (>= ${CORRECT_AMOUNT0_DESIRED}), allowance1=${allowance1} (>= ${CORRECT_AMOUNT1_DESIRED})`);

  const { EVMWalletProvider } = await import("@bnbagent/sdk");
  const walletProvider = new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: KEYSTORE_DIR, persist: true });

  const amount0Min = (CORRECT_AMOUNT0_DESIRED * BigInt(10_000 - MAX_SLIPPAGE_BPS)) / 10_000n;
  const amount1Min = (CORRECT_AMOUNT1_DESIRED * BigInt(10_000 - MAX_SLIPPAGE_BPS)) / 10_000n;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const mintArgs = {
    token0: observation.token0,
    token1: observation.token1,
    fee: observation.fee,
    tickLower: TARGET_TICK_LOWER,
    tickUpper: TARGET_TICK_UPPER,
    amount0Desired: CORRECT_AMOUNT0_DESIRED,
    amount1Desired: CORRECT_AMOUNT1_DESIRED,
    amount0Min,
    amount1Min,
    recipient: VEYRA_WALLET,
    deadline: BigInt(deadline),
  };
  console.log(`mint args: ${JSON.stringify(bigintsToStrings(mintArgs))}`);

  const data = encodeFunctionData({ abi: NFPM_ABI, functionName: "mint", args: [mintArgs] });
  const [nonce, gasPriceWei, gasEstimate] = await Promise.all([
    client.getTransactionCount({ address: VEYRA_WALLET, blockTag: "pending" }),
    client.getGasPrice(),
    client.estimateGas({ account: VEYRA_WALLET, to: NFPM_ADDRESS, data, value: 0n }),
  ]);
  const gas = (gasEstimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
  console.log(`gas estimate succeeded (${gasEstimate} units, +20% buffer = ${gas}) -- the slippage fix is confirmed correct BEFORE signing`);

  const signed = await walletProvider.signTransaction({ to: NFPM_ADDRESS, data, value: 0n, gas, gasPrice: gasPriceWei, nonce, chainId: CHAIN_ID });
  const hash: Hex = await client.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
  console.log(`mint tx hash: ${hash} -- waiting for receipt...`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`receipt: status=${receipt.status}, block=${receipt.blockNumber}, gasUsed=${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error(`mint transaction reverted (hash ${hash})`);

  let newTokenId: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: NFPM_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "IncreaseLiquidity" && log.address.toLowerCase() === NFPM_ADDRESS.toLowerCase()) {
        newTokenId = (decoded.args as { tokenId: bigint }).tokenId;
        break;
      }
    } catch {
      // non-NFPM logs (ERC20 Transfer, etc.) don't decode against NFPM_ABI -- expected, skip
    }
  }
  if (newTokenId === null) throw new Error("mint succeeded but no IncreaseLiquidity event found in its receipt");
  console.log(`new tokenId: ${newTokenId}`);

  const newPositionObservation = await readPositionObservation(client, newTokenId);
  const newOwner = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "ownerOf", args: [newTokenId] });
  console.log(`ownerOf(${newTokenId}): ${newOwner}`);
  console.log(`range: [${newPositionObservation.tickLower}, ${newPositionObservation.tickUpper})`);
  console.log(`liquidity: ${newPositionObservation.positionLiquidity}`);

  const verified =
    newOwner.toLowerCase() === VEYRA_WALLET.toLowerCase() &&
    newPositionObservation.tickLower === TARGET_TICK_LOWER &&
    newPositionObservation.tickUpper === TARGET_TICK_UPPER &&
    newPositionObservation.fee === observation.fee &&
    newPositionObservation.token0.toLowerCase() === observation.token0.toLowerCase() &&
    newPositionObservation.token1.toLowerCase() === observation.token1.toLowerCase() &&
    newPositionObservation.positionLiquidity > 0n;
  console.log(`VERIFIED: ${verified}`);
  if (!verified) throw new Error("post-mint verification failed");

  const predecessor = JSON.parse(readFileSync(PREDECESSOR_PATH, "utf-8"));
  const contentRecord = {
    kind: "CONTROLLED_TESTNET_EXECUTION",
    label: "Controlled Testnet Execution -- completion of execution-0001 after a mint-amount bug fix. NOT autonomous.",
    generatedAt: new Date().toISOString(),
    network: "bsc-testnet",
    predecessorExecutionId: predecessor.executionId,
    predecessorArtifactHash: predecessor.artifactHash,
    rootCause:
      "execution-0001's mint used the wallet's TOTAL post-collect token0 balance (which included a large pre-existing balance unrelated to this position) instead of the amount this operation actually yielded (the position's own pre-collect tokensOwed0). Fixed by using the exact tokensOwed0/tokensOwed1 values already captured in execution-0001's Step 6, verified against the position's now-zero tokensOwed and sufficient existing NFPM allowances before signing.",
    veyraAgentId: predecessor.veyraAgentId,
    ownerWallet: VEYRA_WALLET,
    winningProposal: predecessor.winningProposal,
    mintArgs: bigintsToStrings(mintArgs),
    reusedFromPredecessor: {
      decreaseLiquidityTx: predecessor.transactions.find((t: any) => t.step === "decreaseLiquidity"),
      collectTx: predecessor.transactions.find((t: any) => t.step === "collect"),
      approveToken0Tx: predecessor.transactions.find((t: any) => t.step === "approve-token0"),
      approveToken1Tx: predecessor.transactions.find((t: any) => t.step === "approve-token1"),
    },
    mintTx: {
      step: "mint",
      hash,
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: gasPriceWei.toString(),
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
    },
    oldPosition: { tokenId: VEYRA_POSITION_TOKEN_ID.toString(), ...(predecessor.oldPosition as Record<string, unknown>) },
    newPosition: { tokenId: newTokenId.toString(), ...(bigintsToStrings(newPositionObservation) as Record<string, unknown>) },
    verified,
    status: "EXECUTED",
  };
  const artifactHash = sha256(JSON.stringify(contentRecord));
  const fullRecord = { executionId: 2, artifactHash, ...contentRecord };
  const outPath = resolve(EXECUTIONS_DIR, "execution-0002.json");
  writeFileSync(outPath, JSON.stringify(fullRecord, null, 2));
  console.log(`\nArchived: docs/executions/execution-0002.json`);
  console.log(`artifact hash: ${artifactHash}`);
}

main().catch((err) => {
  console.error("\nResume failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

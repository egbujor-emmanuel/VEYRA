// Grows the PancakeSwap V3 pool's observation buffer so realized volatility becomes measurable.
//
// Why this is needed: rangeKeeper's width formula takes recentVolatilityBps, and for the whole
// life of this project that input has been supplied as 0 and labelled SUPPLIED_NOT_OBSERVED in
// every archive. It could not be filled in from chain either -- the pool carried
// observationCardinality 1, meaning the oracle stores exactly one observation, so observe() over
// any window returns the current tick and every window looks identical. With the multiplier pinned
// at 1 the strategy collapsed onto baseline-symmetric-range.
//
// increaseObservationCardinalityNext is permissionless: anyone may pay to grow any pool's ring
// buffer. It does NOT create history. It allocates slots; the pool fills them one per block in
// which a swap occurs. On a testnet pool with little organic flow that will take a while, and
// until enough slots hold real timestamps the volatility reader must say so rather than
// substituting a number. See readRealizedVolatility.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { createSigner } from "@veyra/chain/txSigner";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.VEYRA_RPC ?? "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
/** The single pool behind position #37079 and grid slots #37091/#37093. */
const POOL = "0x61c17A2C050facFdf8651b576Bc898596f5223b9";
/**
 * 60 slots. Enough to hold a genuine multi-window sample once flow arrives, without paying for a
 * buffer this pool's activity will never fill -- each new slot is a real SSTORE.
 */
const TARGET_CARDINALITY = 60;

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

function readWalletPassword() {
  for (const line of readFileSync(resolve(REPO, "smoketest/.studio/.env.local"), "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

const SLOT0_ABI = [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
  { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "observationIndex", type: "uint16" },
  { name: "observationCardinality", type: "uint16" }, { name: "observationCardinalityNext", type: "uint16" },
  { name: "feeProtocol", type: "uint32" }, { name: "unlocked", type: "bool" }] }];
const GROW_ABI = [{ type: "function", name: "increaseObservationCardinalityNext", stateMutability: "nonpayable",
  inputs: [{ name: "observationCardinalityNext", type: "uint16" }], outputs: [] }];

const before = await client.readContract({ address: POOL, abi: SLOT0_ABI, functionName: "slot0" });
console.log(`pool ${POOL}`);
console.log(`  before: cardinality=${before[3]} cardinalityNext=${before[4]}`);

if (before[4] >= TARGET_CARDINALITY) {
  console.log(`  already at or above ${TARGET_CARDINALITY} -- nothing to do.`);
  process.exit(0);
}

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
  CHAIN_ID,
);

const data = encodeFunctionData({ abi: GROW_ABI, functionName: "increaseObservationCardinalityNext", args: [TARGET_CARDINALITY] });
const tx = await signer.sendAndWait("increase-observation-cardinality", POOL, data);
console.log(`  tx: ${tx.hash}`);

// Re-read rather than trusting the receipt.
const after = await client.readContract({ address: POOL, abi: SLOT0_ABI, functionName: "slot0" });
console.log(`  after:  cardinality=${after[3]} cardinalityNext=${after[4]}`);
if (after[4] < TARGET_CARDINALITY) throw new Error(`FAILED: cardinalityNext is ${after[4]}, expected ${TARGET_CARDINALITY}`);
console.log(`
Buffer grown. cardinality stays at ${after[3]} until the pool actually writes observations --
it advances one slot per block containing a swap. Volatility stays unobservable until then, and
readRealizedVolatility reports that rather than returning 0.`);

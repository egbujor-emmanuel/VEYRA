// Repairs grid slot 0 (#37091), drained by the first scheduled grid daemon pass.
//
// What happened: the slot was out of range and drifted, so the strategy proposed recentering it.
// The executor decreased and collected -- correctly -- and then the ratio-fixing swap step ended
// in SWAP_FAILED, leaving the position at zero liquidity with its capital sitting in the wallet
// and no new position minted.
//
// Why this repair takes the shape it does: #37091's range [-58650, -58250) sits entirely BELOW
// the pool's current tick, so a position there holds only token1 (WBNB). That means liquidity can
// be added back single-sided, with no swap at all -- avoiding the exact step that failed. It also
// restores the original position rather than minting a replacement, so the grid token ids that
// apps/web and the daemon both hardcode stay valid.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { createSigner } from "@veyra/chain/txSigner";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://data-seed-prebsc-1-s1.binance.org:8545";
const CHAIN_ID = 97;
const VEYRA = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const NFPM = "0x427bF5b37357632377eCbEC9de3626C71A5396c1";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"; // token1 of the grid pool
const TOKEN_ID = 37091n;

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

const POS_ABI = [{ type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
  { name: "nonce", type: "uint96" }, { name: "operator", type: "address" }, { name: "token0", type: "address" },
  { name: "token1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickLower", type: "int24" },
  { name: "tickUpper", type: "int24" }, { name: "liquidity", type: "uint128" }, { name: "f0", type: "uint256" },
  { name: "f1", type: "uint256" }, { name: "o0", type: "uint128" }, { name: "o1", type: "uint128" }] }];
const INC_ABI = [{ type: "function", name: "increaseLiquidity", stateMutability: "payable", inputs: [{ type: "tuple", components: [
  { name: "tokenId", type: "uint256" }, { name: "amount0Desired", type: "uint256" }, { name: "amount1Desired", type: "uint256" },
  { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" }, { name: "deadline", type: "uint256" }] }],
  outputs: [{ name: "liquidity", type: "uint128" }, { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }] }];
const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

const before = await client.readContract({ address: NFPM, abi: POS_ABI, functionName: "positions", args: [TOKEN_ID] });
console.log(`#${TOKEN_ID} before: range [${before[5]}, ${before[6]}) liquidity=${before[7]}`);
if (before[7] > 0n) {
  console.log("Position already holds liquidity -- nothing to repair. Exiting without acting.");
  process.exit(0);
}

const held = await client.readContract({ address: WBNB, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA] });
// Restore roughly what the slot held (~0.0039 WBNB), not the wallet's whole balance -- the rest
// predates this incident and is not the grid's.
const RESTORE = 4_000_000_000_000_000n; // 0.004 WBNB
if (held < RESTORE) throw new Error(`wallet holds ${held} WBNB, need ${RESTORE}`);
console.log(`restoring ${RESTORE} wei WBNB single-sided (wallet holds ${held})`);

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
  CHAIN_ID,
);

const approve = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM, RESTORE] });
console.log("approve:", (await signer.sendAndWait("approve-nfpm-wbnb", WBNB, approve)).hash);

const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
// amount0Desired is 0: the range is entirely below the current tick, so the pool takes token1 only.
const inc = encodeFunctionData({ abi: INC_ABI, functionName: "increaseLiquidity",
  args: [{ tokenId: TOKEN_ID, amount0Desired: 0n, amount1Desired: RESTORE, amount0Min: 0n, amount1Min: (RESTORE * 99n) / 100n, deadline }] });
console.log("increaseLiquidity:", (await signer.sendAndWait("increase-liquidity", NFPM, inc)).hash);

// Never trust the receipt -- re-read the position.
const after = await client.readContract({ address: NFPM, abi: POS_ABI, functionName: "positions", args: [TOKEN_ID] });
console.log(`#${TOKEN_ID} after:  range [${after[5]}, ${after[6]}) liquidity=${after[7]}`);
if (after[7] === 0n) throw new Error("REPAIR FAILED: position still holds zero liquidity");
console.log("slot 0 restored.");

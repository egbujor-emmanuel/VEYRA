// Makes the Yield Optimisation agent's candidate pool a genuine competitor.
//
// The agent has always recommended "hold", and it has always been right to: the 0.05% candidate
// pool (0x8523c3...) has zero liquidity and zero accumulated fees, so its cumulative fee-growth
// score is literally 0 against the current pool's ~5.68e35. No honest evaluator would ever move
// capital into it. BSC testnet has no organic traders to change that.
//
// So this creates real trading history in that pool: mint a real narrow position, then route real
// swaps through it. The fees are real fees paid by VEYRA's own wallet at the pool's real 0.05%
// rate, and feeGrowthGlobal rises because of them.
//
// One property makes this cheap: feeGrowthGlobal is fees PER UNIT OF LIQUIDITY (Q128). A pool with
// little liquidity accrues a large per-unit score from modest volume. That is not a trick -- it is
// exactly why a thin pool is a genuinely better place for a small LP, and precisely the signal the
// evaluator is designed to notice.
//
// This is test infrastructure, in the same spirit as seedAmbientLiquidity.ts, and the yield run
// archive says so explicitly.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData, formatUnits, formatEther } from "viem";
import { createSigner } from "@veyra/chain/txSigner";
import { ERC20_ABI, WBNB_ABI, NFPM_ABI, POOL_ABI, SWAP_ROUTER_ABI } from "@veyra/chain/abis";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const POOL_A = "0x61c17A2C050facFdf8651b576Bc898596f5223b9"; // current, 0.25%
const POOL_B = "0x8523c332b034b6D7586116b7739D0048fF1B7888"; // candidate, 0.05%
const FEE_B = 500;
const KEYSTORE_DIR = resolve(REPO, "smoketest/.studio/wallets");
const ENV_LOCAL = resolve(REPO, "smoketest/.studio/.env.local");

/** Deliberately thin: a small position makes each swap's per-unit fee-growth contribution large. */
const SEED_VUSD = 200n * 10n ** 18n;
const WRAP_WBNB = 20_000_000_000_000_000n; // 0.02 tBNB -> WBNB
const SWAP_SIZE_VUSD = 40n * 10n ** 18n;
const SWAP_ROUNDS = 40;

function readWalletPassword() {
  for (const line of readFileSync(ENV_LOCAL, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

// POOL_ABI in the shared abis module covers slot0/liquidity/feeGrowth but not these three.
const POOL_META_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
];

const score = async (pool) => {
  const [a, b] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
  ]);
  return a + b;
};

const scoreA = await score(POOL_A);
let scoreB = await score(POOL_B);
console.log(`pool A (current, 0.25%) score: ${scoreA}`);
console.log(`pool B (candidate, 0.05%) score: ${scoreB}`);
console.log(`B must exceed A for the agent to recommend migrating.\n`);

const [token0, token1, slot0, tickSpacing] = await Promise.all([
  client.readContract({ address: POOL_B, abi: POOL_META_ABI, functionName: "token0" }),
  client.readContract({ address: POOL_B, abi: POOL_META_ABI, functionName: "token1" }),
  client.readContract({ address: POOL_B, abi: POOL_ABI, functionName: "slot0" }),
  client.readContract({ address: POOL_B, abi: POOL_META_ABI, functionName: "tickSpacing" }),
]);
const currentTick = Number(slot0[1]);
const spacing = Number(tickSpacing);
// A wide-ish range so the swaps below stay inside it and keep paying this position fees.
const lower = Math.floor((currentTick - spacing * 60) / spacing) * spacing;
const upper = Math.ceil((currentTick + spacing * 60) / spacing) * spacing;
console.log(`pool B tick ${currentTick}, spacing ${spacing}, minting range [${lower}, ${upper})`);

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const walletProvider = new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: KEYSTORE_DIR, persist: true });
const signer = createSigner(client, walletProvider, CHAIN_ID);

const bal = (t) => client.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] });

// --- 1. make sure we hold enough WBNB -------------------------------------------------------
const wbnbBefore = await bal(token1);
console.log(`\nWBNB held: ${formatEther(wbnbBefore)}`);
if (wbnbBefore < WRAP_WBNB) {
  console.log(`wrapping ${formatEther(WRAP_WBNB)} tBNB -> WBNB…`);
  await signer.sendAndWait("wrap-wbnb", token1, encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit", args: [] }), WRAP_WBNB);
  console.log(`WBNB now: ${formatEther(await bal(token1))}`);
}

// --- 2. approve and mint a real position in pool B --------------------------------------------
console.log("\napproving NFPM + router…");
for (const [label, token] of [["token0", token0], ["token1", token1]]) {
  const amount = await bal(token);
  await signer.sendAndWait(`approve-nfpm-${label}`, token, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PANCAKE_V3_TESTNET.nonfungiblePositionManager, amount] }));
  await signer.sendAndWait(`approve-router-${label}`, token, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PANCAKE_V3_TESTNET.swapRouter, amount] }));
}

// Only mint if the pool is still empty. Re-running this script should add trading volume, not
// stack another position on top of one that already exists.
const existingLiquidity = await client.readContract({ address: POOL_B, abi: POOL_ABI, functionName: "liquidity" });
if (existingLiquidity > 0n) {
  console.log(`\npool B already holds liquidity (${existingLiquidity}) -- skipping the mint, going straight to swaps.`);
} else {
const wbnbAvail = await bal(token1);
const seedWbnb = wbnbAvail / 2n; // keep half for swapping
console.log(`\nminting into pool B with up to ${formatUnits(SEED_VUSD, 18)} VUSD + ${formatEther(seedWbnb)} WBNB…`);
const mintTx = await signer.sendAndWait(
  "mint-pool-b",
  PANCAKE_V3_TESTNET.nonfungiblePositionManager,
  encodeFunctionData({
    abi: NFPM_ABI,
    functionName: "mint",
    args: [{
      token0, token1, fee: FEE_B,
      tickLower: lower, tickUpper: upper,
      amount0Desired: SEED_VUSD, amount1Desired: seedWbnb,
      amount0Min: 0n, amount1Min: 0n,
      recipient: VEYRA_WALLET,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
    }],
  }),
);
console.log(`  minted: ${mintTx.hash}`);
console.log(`  pool B liquidity now: ${await client.readContract({ address: POOL_B, abi: POOL_ABI, functionName: "liquidity" })}`);
}

// --- 3. route real swaps through pool B to accrue real fees ------------------------------------
console.log(`\nrouting ${SWAP_ROUNDS} swaps through pool B to accrue real fee growth…`);
let zeroForOne = true;
for (let i = 0; i < SWAP_ROUNDS; i++) {
  const tokenIn = zeroForOne ? token0 : token1;
  const tokenOut = zeroForOne ? token1 : token0;
  const held = await bal(tokenIn);
  // Sizing learned from the first attempt, which hit two failure modes with 300-VUSD trades:
  // SPL (a thin pool moves a long way on a large trade, pushing price past the position's range)
  // and STF (the router's allowance had been fully consumed). So: take a modest slice, never the
  // whole balance, and re-approve immediately before each swap.
  const amountIn = zeroForOne ? (SWAP_SIZE_VUSD < held ? SWAP_SIZE_VUSD : held / 3n) : held / 3n;
  if (amountIn === 0n) {
    console.log(`  round ${i + 1}: nothing to swap in that direction, skipping`);
    zeroForOne = !zeroForOne;
    continue;
  }
  try {
    await signer.sendAndWait(
      `approve-swap-${i + 1}`,
      tokenIn,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PANCAKE_V3_TESTNET.swapRouter, amountIn] }),
    );
    await signer.sendAndWait(
      `swap-${i + 1}`,
      PANCAKE_V3_TESTNET.swapRouter,
      encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{
          tokenIn, tokenOut, fee: FEE_B, recipient: VEYRA_WALLET,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
          amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
        }],
      }),
    );
    scoreB = await score(POOL_B);
    console.log(`  round ${i + 1}: swapped ${formatUnits(amountIn, 18)} -> pool B score now ${scoreB} (${scoreB > scoreA ? "AHEAD of A" : "still behind A"})`);
  } catch (e) {
    console.log(`  round ${i + 1} failed: ${(e.shortMessage ?? e.message).slice(0, 120)}`);
  }
  if (scoreB > scoreA) break;
  zeroForOne = !zeroForOne;
}

console.log(`\nfinal: pool A ${scoreA}`);
console.log(`       pool B ${scoreB}`);
console.log(scoreB > scoreA
  ? "\nPool B now genuinely outscores pool A. The agent can legitimately recommend migrating."
  : "\nPool B still does not outscore pool A -- the agent will (correctly) keep holding.");

// Repairs the yield candidate pool, then builds real fee growth in it -- carefully this time.
//
// What went wrong on the first attempt: pool B was seeded with 200 VUSD against only 0.011 WBNB,
// then swapped 300 VUSD at a time. Two such swaps consumed every WBNB in range and drove the
// price to MIN_TICK (-887272), leaving the minted position entirely on one side with zero active
// liquidity. pool.liquidity() then read 0 -- it reports ACTIVE liquidity at the current tick, not
// total -- which also defeated the "already seeded?" guard and made the script try to re-mint.
//
// Two corrections here:
//   1. Depth. Wrap materially more WBNB so a VUSD inflow cannot drain the token1 side.
//   2. Restraint. Swap a small fraction of in-range depth, alternate strictly, and abort the
//      moment the tick leaves the seeded range instead of pushing until something breaks.
//
// Recovery itself is cheap: there is no liquidity between MIN_TICK and the position's lower
// bound, so the first WBNB->VUSD swap walks the price back up to the position at almost no cost.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData, formatUnits, formatEther } from "viem";
import { createSigner } from "@veyra/chain/txSigner";
import { ERC20_ABI, WBNB_ABI, POOL_ABI, SWAP_ROUTER_ABI } from "@veyra/chain/abis";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const POOL_A = "0x61c17A2C050facFdf8651b576Bc898596f5223b9";
const POOL_B = "0x8523c332b034b6D7586116b7739D0048fF1B7888";
const FEE_B = 500;
const TOKEN0 = "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d"; // VUSD
const TOKEN1 = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"; // WBNB
const RANGE_LOWER = -58820;
const RANGE_UPPER = -57610;

const WRAP_AMOUNT = 150_000_000_000_000_000n; // 0.15 tBNB -> WBNB, leaving plenty for gas
const MAX_ROUNDS = 60;

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

const readTick = async () => Number((await client.readContract({ address: POOL_B, abi: POOL_ABI, functionName: "slot0" }))[1]);
const readLiq = () => client.readContract({ address: POOL_B, abi: POOL_ABI, functionName: "liquidity" });
const score = async (pool) => {
  const [a, b] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
  ]);
  return a + b;
};
const bal = (t) => client.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] });

function readWalletPassword() {
  for (const line of readFileSync(resolve(REPO, "smoketest/.studio/.env.local"), "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
  CHAIN_ID,
);

const scoreA = await score(POOL_A);
let scoreB = await score(POOL_B);
console.log(`pool A score: ${scoreA}`);
console.log(`pool B score: ${scoreB}  (${Number((scoreB * 100n) / scoreA)}% of A)`);
console.log(`pool B tick: ${await readTick()}, active liquidity: ${await readLiq()}`);

// --- 1. depth -----------------------------------------------------------------------------------
const wbnb = await bal(TOKEN1);
console.log(`\nWBNB held: ${formatEther(wbnb)}`);
if (wbnb < WRAP_AMOUNT) {
  console.log(`wrapping ${formatEther(WRAP_AMOUNT)} tBNB -> WBNB for depth…`);
  await signer.sendAndWait("wrap", TOKEN1, encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit", args: [] }), WRAP_AMOUNT);
  console.log(`WBNB now: ${formatEther(await bal(TOKEN1))}`);
}

async function swap(label, tokenIn, tokenOut, amountIn) {
  await signer.sendAndWait(
    `approve-${label}`,
    tokenIn,
    encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PANCAKE_V3_TESTNET.swapRouter, amountIn] }),
  );
  await signer.sendAndWait(
    label,
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
}

// --- 2. walk the price back into the seeded range -------------------------------------------------
let tick = await readTick();
if (tick < RANGE_LOWER) {
  console.log(`\nprice is below the seeded range (${tick} < ${RANGE_LOWER}); walking it back with WBNB->VUSD…`);
  for (let i = 0; i < 8 && tick < RANGE_LOWER; i++) {
    const amount = (await bal(TOKEN1)) / 20n;
    if (amount === 0n) break;
    try {
      await swap(`repair-${i + 1}`, TOKEN1, TOKEN0, amount);
      tick = await readTick();
      console.log(`  repair ${i + 1}: swapped ${formatEther(amount)} WBNB -> tick now ${tick}, active liquidity ${await readLiq()}`);
    } catch (e) {
      console.log(`  repair ${i + 1} failed: ${(e.shortMessage ?? e.message).slice(0, 90)}`);
      break;
    }
  }
}

if ((await readLiq()) === 0n) {
  console.log("\nPool B still has no active liquidity at the current price. Stopping -- swapping into a pool with no depth would only push the price further, not build fee growth.");
  process.exit(1);
}

// --- 3. build fee growth with small, alternating trades -------------------------------------------
console.log(`\nbuilding fee growth with small alternating swaps (abort if tick leaves [${RANGE_LOWER}, ${RANGE_UPPER}))…`);
let zeroForOne = true;
let done = 0;
for (let i = 0; i < MAX_ROUNDS && scoreB <= scoreA; i++) {
  tick = await readTick();
  if (tick <= RANGE_LOWER + 20 || tick >= RANGE_UPPER - 20) {
    // Reverse rather than push further: this is exactly what broke the pool last time.
    zeroForOne = tick <= RANGE_LOWER + 20 ? false : true;
  }
  const tokenIn = zeroForOne ? TOKEN0 : TOKEN1;
  const tokenOut = zeroForOne ? TOKEN1 : TOKEN0;
  const held = await bal(tokenIn);
  const amountIn = held / 40n; // a small slice, so no single trade can drain a side
  if (amountIn === 0n) { zeroForOne = !zeroForOne; continue; }

  try {
    await swap(`swap-${i + 1}`, tokenIn, tokenOut, amountIn);
    done++;
    scoreB = await score(POOL_B);
    tick = await readTick();
    console.log(`  ${i + 1}: ${zeroForOne ? "VUSD->WBNB" : "WBNB->VUSD"} ${formatUnits(amountIn, 18)} | tick ${tick} | B is ${Number((scoreB * 100n) / scoreA)}% of A`);
  } catch (e) {
    console.log(`  ${i + 1}: failed (${(e.shortMessage ?? e.message).slice(0, 70)})`);
  }
  zeroForOne = !zeroForOne;
}

console.log(`\ncompleted ${done} swaps.`);
console.log(`pool A: ${scoreA}`);
console.log(`pool B: ${scoreB}`);
console.log(scoreB > scoreA
  ? "\nPool B now genuinely outscores pool A -- the agent can legitimately recommend migrating."
  : `\nPool B is at ${Number((scoreB * 100n) / scoreA)}% of pool A. Not there yet.`);

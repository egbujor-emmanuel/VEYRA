// Moves the pool price far enough to make a grid slot need repositioning, so the FIXED grid
// execution path can be exercised on-chain rather than only reasoned about.
//
// Why this is legitimate and what it is not:
//
// The grid daemon was disabled on 2026-09-04 after its first scheduled pass unwound slot 0 and
// then failed at the ratio-fixing swap, leaving the position decreased and unminted. The cause was
// targets that straddled the current tick, forcing a two-token mint and therefore a swap; slots
// are now placed strictly to one side, so a reposition needs no swap at all. That reasoning is
// covered by unit tests -- but the path has not RUN since the fix, because this pool sees no
// organic flow and the tick has sat at -58216 throughout. Every daemon pass since has said "hold".
// A claim of "fixed" resting on an execution path that never executed is not worth much.
//
// So this induces the market CONDITION (a real price move) in order to test the path. It does not
// fabricate an OBSERVATION. That distinction is the line this project holds: the archive records
// the condition as operator-induced, exactly as the yield run records its advantage as seeded
// rather than observed.
//
// One important side effect, stated so nobody later mistakes it for organic data: a swap writes an
// oracle observation. This will begin filling the buffer that readRealizedVolatility reads. Any
// volatility measurable afterward is a consequence of this script, NOT of market activity, and
// must not be presented as organic.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { createSigner } from "@veyra/chain/txSigner";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.VEYRA_RPC ?? "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const POOL = "0x61c17A2C050facFdf8651b576Bc898596f5223b9";
const VUSD = "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d"; // token0
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"; // token1
const FEE = 2500;
const SWAP_ROUTER = PANCAKE_V3_TESTNET.swapRouter;

/** Ticks to move. Slot 0 needs repositioning at roughly +200; +210 clears it without overshooting. */
const TARGET_TICK_DELTA = 210;
/** Hard ceiling, independent of the computed amount. A miscalculation must not drain the wallet. */
const MAX_SPEND_WEI = 70_000_000_000_000_000n; // 0.07 WBNB

const client = createPublicClient({
  chain: {
    id: CHAIN_ID,
    name: "bsc-testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

function readWalletPassword() {
  for (const line of readFileSync(resolve(REPO, "smoketest/.studio/.env.local"), "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

const SLOT0_ABI = [
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint32" },
      { name: "unlocked", type: "bool" },
    ],
  },
];
const LIQ_ABI = [{ type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] }];
const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const ROUTER_ABI = [
  {
    type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
        { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

const [slot0, liquidity, heldWbnb] = await Promise.all([
  client.readContract({ address: POOL, abi: SLOT0_ABI, functionName: "slot0" }),
  client.readContract({ address: POOL, abi: LIQ_ABI, functionName: "liquidity" }),
  client.readContract({ address: WBNB, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA] }),
]);
const tickBefore = slot0[1];
const target = tickBefore + TARGET_TICK_DELTA;
console.log(`pool ${POOL}`);
console.log(`  tick before : ${tickBefore}  (target ${target})`);
console.log(`  liquidity   : ${liquidity}`);
console.log(`  WBNB held   : ${heldWbnb} (${(Number(heldWbnb) / 1e18).toFixed(5)})`);

// Buying token0 with token1 pushes the price of token0 up, which raises the tick.
const sq = (t) => Math.pow(1.0001, t / 2);
let amountIn = BigInt(Math.ceil(Number(liquidity) * (sq(target) - sq(tickBefore))));
if (amountIn > MAX_SPEND_WEI) {
  console.log(`  computed ${amountIn} exceeds the ${MAX_SPEND_WEI} ceiling -- capping.`);
  amountIn = MAX_SPEND_WEI;
}
if (amountIn >= heldWbnb) throw new Error(`need ${amountIn} WBNB, hold ${heldWbnb}`);
console.log(`  swapping    : ${amountIn} wei WBNB -> VUSD (${(Number(amountIn) / 1e18).toFixed(5)} WBNB)`);

if (process.argv.includes("--dry-run")) {
  console.log("\n--dry-run: nothing signed, nothing sent.");
  process.exit(0);
}

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({
    password: readWalletPassword(), address: VEYRA,
    walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true,
  }),
  CHAIN_ID,
);

const approve = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER, amountIn] });
console.log(`  approve tx  : ${(await signer.sendAndWait("approve-swaprouter-wbnb", WBNB, approve)).hash}`);

const swap = encodeFunctionData({
  abi: ROUTER_ABI, functionName: "exactInputSingle",
  args: [{
    tokenIn: WBNB, tokenOut: VUSD, fee: FEE, recipient: VEYRA,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  }],
});
console.log(`  swap tx     : ${(await signer.sendAndWait("induce-price-move", SWAP_ROUTER, swap)).hash}`);

const after = await client.readContract({ address: POOL, abi: SLOT0_ABI, functionName: "slot0" });
console.log(`  tick after  : ${after[1]}  (moved ${after[1] - tickBefore} ticks)`);
console.log(`  cardinality : ${after[3]} (was ${slot0[3]}) -- this swap writes an oracle observation`);

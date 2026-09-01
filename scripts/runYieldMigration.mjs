// Yield Optimisation, executing for real on BSC testnet.
//
// This category has always returned "hold", and correctly: the candidate 0.05% pool had zero
// liquidity and zero accumulated fees, so its cumulative fee-growth score was literally 0 against
// the current pool's ~5.68e35. No honest evaluator moves capital into that.
//
// scripts/repairAndSeedPoolB.mjs changed the facts, not the rules: it minted real liquidity in the
// candidate pool and routed 25 real swaps through it, paying real 0.05% fees, until its fee-growth
// score genuinely exceeded the current pool's. The evaluator is untouched.
//
// What this script does:
//   1. Mint a DEDICATED position in the current pool as the capital to be managed. VEYRA's other
//      positions belong to the Rebalancing (#37079) and Grid (#37091/#37093) demonstrations and
//      are deliberately left alone.
//   2. Let the unmodified strategy observe both pools and decide.
//   3. If it says migrate: withdraw everything from the current pool and redeploy it into the
//      recommended one -- decrease, collect, mint.
//   4. Verify against chain, then archive.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, formatUnits, formatEther } from "viem";
import { yieldOptimiserStrategy } from "@veyra/core";
import { createSigner } from "@veyra/chain/txSigner";
import { ERC20_ABI, NFPM_ABI, POOL_ABI } from "@veyra/chain/abis";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const NFPM = PANCAKE_V3_TESTNET.nonfungiblePositionManager;
const ARCHIVE_DIR = resolve(REPO, "docs/yield-runs");

const POOLS = {
  "0x61c17A2C050facFdf8651b576Bc898596f5223b9": { label: "VUSD/WBNB 0.25%", fee: 2500, spacing: 50 },
  "0x8523c332b034b6D7586116b7739D0048fF1B7888": { label: "VUSD/WBNB 0.05%", fee: 500, spacing: 10 },
};
const CURRENT_POOL = "0x61c17A2C050facFdf8651b576Bc898596f5223b9";
const TOKEN0 = "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d";
const TOKEN1 = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const MAX_UINT128 = (1n << 128n) - 1n;

/** Small on purpose: this is a demonstration of the mechanism, not a capital allocation. */
const STAKE_VUSD = 120n * 10n ** 18n;
const STAKE_WBNB = 6_000_000_000_000_000n; // 0.006 WBNB

// The shared POOL_ABI covers liquidity and feeGrowth but not slot0, so the tick is read here.
const POOL_META_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bool" }] },
];

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

const bal = (t) => client.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] });
const tickOf = async (pool) => Number((await client.readContract({ address: pool, abi: POOL_META_ABI, functionName: "slot0" }))[1]);

async function readPool(address) {
  const meta = POOLS[address];
  const [liquidity, fg0, fg1] = await Promise.all([
    client.readContract({ address, abi: POOL_ABI, functionName: "liquidity" }),
    client.readContract({ address, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
    client.readContract({ address, abi: POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
  ]);
  return { poolAddress: address, label: meta.label, fee: meta.fee, currentLiquidity: liquidity, feeGrowthGlobal0X128: fg0, feeGrowthGlobal1X128: fg1 };
}

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
  CHAIN_ID,
);
const allTxs = [];

// --- 1. deploy the capital this agent will manage -------------------------------------------------
console.log("=== 1. mint a dedicated yield position in the current pool ===");
const curTick = await tickOf(CURRENT_POOL);
const curSpacing = POOLS[CURRENT_POOL].spacing;
const lowerA = Math.floor((curTick - curSpacing * 20) / curSpacing) * curSpacing;
const upperA = Math.ceil((curTick + curSpacing * 20) / curSpacing) * curSpacing;
console.log(`  pool tick ${curTick}, minting range [${lowerA}, ${upperA})`);

for (const [label, token, amount] of [["vusd", TOKEN0, STAKE_VUSD], ["wbnb", TOKEN1, STAKE_WBNB]]) {
  await signer.sendAndWait(`approve-nfpm-${label}`, token, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM, amount * 2n] }));
}

const mintATx = await signer.sendAndWait(
  "mint-yield-position",
  NFPM,
  encodeFunctionData({
    abi: NFPM_ABI, functionName: "mint",
    args: [{
      token0: TOKEN0, token1: TOKEN1, fee: POOLS[CURRENT_POOL].fee,
      tickLower: lowerA, tickUpper: upperA,
      amount0Desired: STAKE_VUSD, amount1Desired: STAKE_WBNB,
      amount0Min: 0n, amount1Min: 0n, recipient: VEYRA_WALLET,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
    }],
  }),
);
allTxs.push(mintATx);

const mintReceipt = await client.getTransactionReceipt({ hash: mintATx.hash });
let sourceTokenId;
for (const log of mintReceipt.logs) {
  if (log.address.toLowerCase() !== NFPM.toLowerCase()) continue;
  try {
    const d = decodeEventLog({ abi: NFPM_ABI, eventName: "IncreaseLiquidity", data: log.data, topics: log.topics });
    if (d.args?.tokenId !== undefined) { sourceTokenId = d.args.tokenId; break; }
  } catch { /* not it */ }
}
if (sourceTokenId === undefined) throw new Error("Could not resolve the minted position's tokenId from the receipt.");
const posAfterMint = await client.readContract({ address: NFPM, abi: NFPM_ABI, functionName: "positions", args: [sourceTokenId] });
console.log(`  minted position #${sourceTokenId}, liquidity ${posAfterMint[7]}`);

// --- 2. let the unmodified strategy decide --------------------------------------------------------
console.log("\n=== 2. let the UNMODIFIED strategy decide ===");
const snapshot = {
  currentPoolAddress: CURRENT_POOL,
  pools: await Promise.all(Object.keys(POOLS).map(readPool)),
};
for (const p of snapshot.pools) {
  console.log(`  ${p.label.padEnd(18)} score ${p.feeGrowthGlobal0X128 + p.feeGrowthGlobal1X128}`);
}
const job = {
  jobId: `yield-exec-${Date.now()}`,
  createdAt: new Date().toISOString(),
  ownerWallet: VEYRA_WALLET,
  category: "yield-optimisation",
  target: { protocol: "pancakeswap-v3", network: "bsc-testnet", candidatePools: Object.entries(POOLS).map(([poolAddress, m]) => ({ poolAddress, label: m.label })) },
};
const proposal = await yieldOptimiserStrategy(job, snapshot);
console.log(`  decision : ${proposal.proposedAction.kind}`);
console.log(`  rationale: ${proposal.rationale}`);

if (proposal.proposedAction.kind !== "recommend-migrate") {
  console.log("\nThe strategy did not call for a migration. Stopping rather than forcing an action it did not choose.");
  process.exit(1);
}
const targetPool = proposal.proposedAction.toPool;
console.log(`  target pool: ${targetPool}`);

// --- 3. execute the migration ---------------------------------------------------------------------
console.log("\n=== 3. EXECUTE: withdraw from the current pool ===");
const liquidityToPull = posAfterMint[7];
allTxs.push(await signer.sendAndWait(
  "decrease-liquidity",
  NFPM,
  encodeFunctionData({
    abi: NFPM_ABI, functionName: "decreaseLiquidity",
    args: [{ tokenId: sourceTokenId, liquidity: liquidityToPull, amount0Min: 0n, amount1Min: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 1200) }],
  }),
));

const before0 = await bal(TOKEN0);
const before1 = await bal(TOKEN1);
allTxs.push(await signer.sendAndWait(
  "collect",
  NFPM,
  encodeFunctionData({
    abi: NFPM_ABI, functionName: "collect",
    args: [{ tokenId: sourceTokenId, recipient: VEYRA_WALLET, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
  }),
));
const after0 = await bal(TOKEN0);
const after1 = await bal(TOKEN1);
// Delta-based, never absolute: this is what actually came back out of the position.
const recovered0 = after0 - before0;
const recovered1 = after1 - before1;
console.log(`  recovered ${formatUnits(recovered0, 18)} VUSD + ${formatEther(recovered1)} WBNB`);

const sourceAfter = await client.readContract({ address: NFPM, abi: NFPM_ABI, functionName: "positions", args: [sourceTokenId] });
if (sourceAfter[7] !== 0n) throw new Error(`Source position #${sourceTokenId} still holds liquidity ${sourceAfter[7]} -- migration incomplete.`);
console.log(`  source position #${sourceTokenId} drained to zero liquidity`);

console.log("\n=== 4. EXECUTE: redeploy into the recommended pool ===");
const tgtTick = await tickOf(targetPool);
const tgtSpacing = POOLS[targetPool].spacing;
const lowerB = Math.floor((tgtTick - tgtSpacing * 40) / tgtSpacing) * tgtSpacing;
const upperB = Math.ceil((tgtTick + tgtSpacing * 40) / tgtSpacing) * tgtSpacing;
console.log(`  target tick ${tgtTick}, minting range [${lowerB}, ${upperB})`);

for (const [label, token, amount] of [["vusd", TOKEN0, recovered0], ["wbnb", TOKEN1, recovered1]]) {
  if (amount > 0n) {
    await signer.sendAndWait(`approve-target-${label}`, token, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM, amount] }));
  }
}

const mintBTx = await signer.sendAndWait(
  "mint-in-target-pool",
  NFPM,
  encodeFunctionData({
    abi: NFPM_ABI, functionName: "mint",
    args: [{
      token0: TOKEN0, token1: TOKEN1, fee: POOLS[targetPool].fee,
      tickLower: lowerB, tickUpper: upperB,
      amount0Desired: recovered0, amount1Desired: recovered1,
      amount0Min: 0n, amount1Min: 0n, recipient: VEYRA_WALLET,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
    }],
  }),
);
allTxs.push(mintBTx);

const mintBReceipt = await client.getTransactionReceipt({ hash: mintBTx.hash });
let targetTokenId;
for (const log of mintBReceipt.logs) {
  if (log.address.toLowerCase() !== NFPM.toLowerCase()) continue;
  try {
    const d = decodeEventLog({ abi: NFPM_ABI, eventName: "IncreaseLiquidity", data: log.data, topics: log.topics });
    if (d.args?.tokenId !== undefined) { targetTokenId = d.args.tokenId; break; }
  } catch { /* not it */ }
}
if (targetTokenId === undefined) throw new Error("Migration mint succeeded but no tokenId could be resolved.");
const targetPos = await client.readContract({ address: NFPM, abi: NFPM_ABI, functionName: "positions", args: [targetTokenId] });
console.log(`  minted position #${targetTokenId} in ${POOLS[targetPool].label}, liquidity ${targetPos[7]}`);
if (targetPos[7] === 0n) throw new Error("Target position has zero liquidity -- refusing to report this as a migration.");

// --- 5. archive -----------------------------------------------------------------------------------
mkdirSync(ARCHIVE_DIR, { recursive: true });
const runId = (existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR).filter((f) => f.startsWith("run-")).length : 0) + 1;
const path = resolve(ARCHIVE_DIR, `run-${String(runId).padStart(4, "0")}.json`);
const j = (v) => (typeof v === "bigint" ? v.toString() : v);

writeFileSync(path, JSON.stringify({
  runId,
  kind: "YIELD_OPTIMISATION_EXECUTED",
  status: "EXECUTED",
  veyraAgentId: 1890,
  ownerWallet: VEYRA_WALLET,
  network: "bsc-testnet",
  opportunityConditionNote:
    "The candidate pool's advantage was created deliberately, not observed organically. BSC testnet " +
    "has no trading volume, so the 0.05% pool held zero liquidity and zero fees and could never win. " +
    "scripts/repairAndSeedPoolB.mjs minted real liquidity there and routed 25 real swaps through it, " +
    "paying real fees at the pool's real rate, until its cumulative fee-growth score genuinely " +
    "exceeded the current pool's. The evaluator and its scoring were NOT modified, and the decision " +
    "below is its own.",
  knownLimitation:
    "The evaluator scores pools on cumulative fee growth alone and does not consider liquidity depth. " +
    "The candidate pool is thin: during seeding, single large swaps repeatedly drove its price to " +
    "MIN_TICK. A depth or price-stability term is a real gap this run exposed.",
  pools: snapshot.pools.map((p) => ({ poolAddress: p.poolAddress, label: p.label, fee: p.fee, score: j(p.feeGrowthGlobal0X128 + p.feeGrowthGlobal1X128) })),
  decision: { kind: proposal.proposedAction.kind, targetPool, rationale: proposal.rationale },
  execution: {
    sourceTokenId: j(sourceTokenId), sourcePool: CURRENT_POOL, sourceLiquidityPulled: j(liquidityToPull),
    recoveredToken0: j(recovered0), recoveredToken1: j(recovered1),
    targetTokenId: j(targetTokenId), targetPool, targetLiquidity: j(targetPos[7]),
  },
  transactions: allTxs.map((t) => ({ ...t, gasUsed: j(t.gasUsed), gasPriceWei: j(t.gasPriceWei) })),
  generatedAt: new Date().toISOString(),
}, null, 2));

console.log(`\narchived: ${path}`);
console.log("\nYIELD OPTIMISATION EXECUTED FOR REAL.");
for (const t of allTxs) console.log(`  ${t.step.padEnd(24)} https://testnet.bscscan.com/tx/${t.hash}`);

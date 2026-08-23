// TEST INFRASTRUCTURE / AMBIENT LIQUIDITY -- NOT part of VEYRA's identity, track record, or
// execution history. This mints a SEPARATE PancakeSwap V3 position, owned by a freshly
// generated, dedicated wallet (not the VEYRA/RangeKeeper wallet), covering the CURRENT tick, so
// the isolated demo pool has real depth for a corrective swap to trade against. It is never
// farmed, never touched by the arena/evaluator/execution pipeline, and never counted toward
// VEYRA Agent #1890's performance in any way.
//
// Why this exists: Test B's controlled market transition (docs/test-b/test-b-0001.json) pushed
// price into a region where the ONLY existing liquidity (Position #37059, owned by VEYRA) no
// longer covers the current tick -- so the pool has zero active liquidity there, and the
// ratio-fixing swap this same session built (packages/veyra-core/src/rebalanceSwap.ts) has
// nothing to trade against (confirmed live: the QuoterV2 call reverted, see
// docs/agent-arena-runs-v2/run-0002.json). This script fixes that by giving the pool ambient
// depth at the current price -- and ONLY that, nothing about VEYRA's own decision-making.
//
// Sequence: fund a new wallet (native tBNB + token0, both transferred from the VEYRA wallet,
// visibly and on-chain) -> wrap some of that tBNB into WBNB (token1) in the NEW wallet -> mint a
// position centered on the current tick from the NEW wallet -> verify the pool now has real
// active liquidity AND that a standalone QuoterV2 quote for the actual corrective swap succeeds
// -- only then is it safe to run the real VEYRA execution.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createPublicClient, http, encodeFunctionData, type Address } from "viem";
import { roundToTickSpacing, getLiquidityForAmounts, getAmountsForLiquidity } from "@veyra/core";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation } from "../src/positionReader.js";
import { getLiveSwapQuote } from "../src/rebalanceQuote.js";
import { createSigner } from "../src/txSigner.js";
import { NFPM_ABI, ERC20_ABI, WBNB_ABI, POOL_ABI } from "../src/abis.js";
import { PANCAKE_V3_TESTNET, WBNB_TESTNET } from "../src/testnetAddresses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const SMOKETEST_ROOT = resolve(REPO_ROOT, "smoketest");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const DOCS_DIR = resolve(REPO_ROOT, "docs");
const TEST_INFRA_DIR = resolve(DOCS_DIR, "test-infrastructure");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const AMBIENT_WALLET = "0x62472499C7390ee1dbfb45E782847b35c754C5f0" as const;
const VEYRA_POSITION_TOKEN_ID = 37059n;
const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;

const NATIVE_TO_AMBIENT_WEI = 30_000_000_000_000_000n; // 0.03 tBNB
const NATIVE_TO_WRAP_WEI = 25_000_000_000_000_000n; // 0.025 of that -> WBNB, leaving ~0.005 for gas
const TOKEN0_TO_AMBIENT = 500_000_000_000_000_000_000n; // 500 token0
const AMBIENT_HALF_WIDTH_TICKS = 1000; // matches RangeKeeper's own base half-width style -- not a special number

function readEnvVar(name: string): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  throw new Error(`${name} not found in ${ENV_LOCAL_PATH}`);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
  }
  return value;
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: 97, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  const { EVMWalletProvider } = await import("@bnbagent/sdk");
  const veyraWallet = new EVMWalletProvider({ password: readEnvVar("WALLET_PASSWORD"), address: VEYRA_WALLET, walletsDir: KEYSTORE_DIR, persist: true });
  const ambientWallet = new EVMWalletProvider({ password: readEnvVar("AMBIENT_WALLET_PASSWORD"), address: AMBIENT_WALLET, walletsDir: KEYSTORE_DIR, persist: true });

  const veyraSigner = createSigner(client, veyraWallet, 97);
  const ambientSigner = createSigner(client, ambientWallet, 97);

  section("Position #37059 -- unaffected reference point (OBSERVED)");
  const positionObservation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  console.log(`current tick: ${positionObservation.currentTick}, Position #37059 range (untouched): [${positionObservation.tickLower}, ${positionObservation.tickUpper})`);
  const token0 = positionObservation.token0;
  const token1 = positionObservation.token1;
  const fee = positionObservation.fee;
  const poolAddress = positionObservation.poolAddress;

  const [existingToken0, existingToken1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "balanceOf", args: [AMBIENT_WALLET] }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "balanceOf", args: [AMBIENT_WALLET] }),
  ]);
  const alreadyFunded = existingToken0 >= TOKEN0_TO_AMBIENT && existingToken1 >= NATIVE_TO_WRAP_WEI;
  let nativeTransferHash = "SKIPPED_ALREADY_FUNDED";
  let token0TransferTxHash = "SKIPPED_ALREADY_FUNDED";
  let wrapHash = "SKIPPED_ALREADY_FUNDED";

  if (alreadyFunded) {
    section("STEP 1+2: SKIPPED -- ambient wallet is already funded from a prior run of this script");
    console.log(`existing balances: token0=${existingToken0}, token1=${existingToken1}`);
  } else {
    section("STEP 1: Fund the ambient wallet from the VEYRA wallet (visible, on-chain, clearly labeled)");
    // Native transfer -- txSigner.ts's sendAndWait hardcodes value:0n (it's built for contract
    // calls), so this one plain value-transfer is built directly against the wallet's own
    // signTransaction(), the same primitive sendAndWait itself uses underneath.
    const nonce = await client.getTransactionCount({ address: VEYRA_WALLET, blockTag: "pending" });
    const gasPriceWei = await client.getGasPrice();
    const signedNative = await veyraWallet.signTransaction({ to: AMBIENT_WALLET, data: "0x", value: NATIVE_TO_AMBIENT_WEI, gas: 21_000n, gasPrice: gasPriceWei, nonce, chainId: 97 });
    nativeTransferHash = await client.sendRawTransaction({ serializedTransaction: signedNative.rawTransaction });
    await client.waitForTransactionReceipt({ hash: nativeTransferHash as `0x${string}`, timeout: 120_000 });
    console.log(`native transfer (0.03 tBNB, VEYRA -> ambient): ${nativeTransferHash}`);

    const transferToken0Data = encodeFunctionData({
      abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "transfer",
      args: [AMBIENT_WALLET, TOKEN0_TO_AMBIENT],
    });
    const token0TransferTx = await veyraSigner.sendAndWait("transfer-token0-to-ambient", token0, transferToken0Data);
    token0TransferTxHash = token0TransferTx.hash;
    console.log(`token0 transfer (500, VEYRA -> ambient): ${token0TransferTxHash}`);

    section("STEP 2: Wrap tBNB -> WBNB in the ambient wallet (its own token1)");
    const wrapData = encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit", args: [] });
    const nonce2 = await client.getTransactionCount({ address: AMBIENT_WALLET, blockTag: "pending" });
    const gasPriceWei2 = await client.getGasPrice();
    const gasEstimateWrap = await client.estimateGas({ account: AMBIENT_WALLET, to: WBNB_TESTNET as Address, data: wrapData, value: NATIVE_TO_WRAP_WEI });
    const signedWrap = await ambientWallet.signTransaction({ to: WBNB_TESTNET as Address, data: wrapData, value: NATIVE_TO_WRAP_WEI, gas: (gasEstimateWrap * 120n) / 100n, gasPrice: gasPriceWei2, nonce: nonce2, chainId: 97 });
    wrapHash = await client.sendRawTransaction({ serializedTransaction: signedWrap.rawTransaction });
    await client.waitForTransactionReceipt({ hash: wrapHash as `0x${string}`, timeout: 120_000 });
    console.log(`wrap (0.025 tBNB -> WBNB, in ambient wallet): ${wrapHash}`);
  }

  section("STEP 3: Mint the ambient position, centered on the CURRENT tick");
  const freshSlot0Before = await client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "slot0" });
  const currentTick = freshSlot0Before[1];
  const ambientTickLower = roundToTickSpacing(currentTick - AMBIENT_HALF_WIDTH_TICKS, 50);
  const ambientTickUpper = roundToTickSpacing(currentTick + AMBIENT_HALF_WIDTH_TICKS, 50);
  console.log(`fresh current tick: ${currentTick} -> ambient range [${ambientTickLower}, ${ambientTickUpper})`);

  const [token0Balance, token1Balance] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "balanceOf", args: [AMBIENT_WALLET] }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "balanceOf", args: [AMBIENT_WALLET] }),
  ]);
  console.log(`ambient wallet balances before mint: token0=${token0Balance}, token1=${token1Balance}`);

  const approve0Data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, token0Balance] });
  await ambientSigner.sendAndWait("ambient-approve-token0", token0, approve0Data);
  const approve1Data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, token1Balance] });
  await ambientSigner.sendAndWait("ambient-approve-token1", token1, approve1Data);

  // token0Balance/token1Balance are wildly mismatched relative to what this range needs at the
  // current price (500 token0 vs. 0.025 WBNB) -- mint() will bottleneck on WBNB and refund most
  // of the token0, exactly like every other mint in this codebase. The floor must be set against
  // what will ACTUALLY be consumed, not a flat percentage of what was merely offered.
  const achievableLiquidity = getLiquidityForAmounts(freshSlot0Before[0], ambientTickLower, ambientTickUpper, token0Balance, token1Balance);
  const consumed = getAmountsForLiquidity(freshSlot0Before[0], ambientTickLower, ambientTickUpper, achievableLiquidity);
  console.log(`achievable liquidity ${achievableLiquidity} will actually consume: amount0=${consumed.amount0}, amount1=${consumed.amount1} (rest refunded)`);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const mintArgs = {
    token0,
    token1,
    fee,
    tickLower: ambientTickLower,
    tickUpper: ambientTickUpper,
    amount0Desired: token0Balance,
    amount1Desired: token1Balance,
    amount0Min: (consumed.amount0 * 90n) / 100n, // 10% floor against what will ACTUALLY be consumed -- a one-time infra step, not part of VEYRA's execution safety guarantees, but still never zero
    amount1Min: (consumed.amount1 * 90n) / 100n,
    recipient: AMBIENT_WALLET,
    deadline,
  };
  const mintData = encodeFunctionData({ abi: NFPM_ABI, functionName: "mint", args: [mintArgs] });
  const mintTx = await ambientSigner.sendAndWait("ambient-mint", NFPM_ADDRESS, mintData);
  console.log(`ambient position minted: ${mintTx.hash}`);

  section("STEP 4: Verify the pool now has REAL active liquidity at the current price");
  const [freshSlot0After, poolLiquidityAfter] = await Promise.all([
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "liquidity" }),
  ]);
  const tickNow = freshSlot0After[1];
  const liquidityActive = poolLiquidityAfter > 0n;
  const tickInsideAmbientRange = tickNow >= ambientTickLower && tickNow < ambientTickUpper;
  console.log(`pool liquidity now: ${poolLiquidityAfter} (active: ${liquidityActive})`);
  console.log(`current tick ${tickNow} inside ambient range [${ambientTickLower}, ${ambientTickUpper}): ${tickInsideAmbientRange}`);

  section("STEP 5: Standalone QuoterV2 pre-flight -- confirms the pool can now trade at all");
  // A reasonably-sized sanity quote (magnitude comparable to what the real corrective swap will
  // need, per this session's earlier read of Position #37059's real decrease-implied amounts --
  // not required to be the exact future target range, which depends on RangeKeeper's live
  // proposal at actual execution time; that real, authoritative check happens when the real
  // orchestrator runs next, computing everything fresh).
  const PREFLIGHT_TEST_AMOUNT_IN = 1_000_000_000_000_000_000n; // 1 token0 -- comfortably inside the ambient position's own depth
  let quoteSucceeded = false;
  let quoteDetail: Record<string, unknown> = {};
  try {
    const quote = await getLiveSwapQuote({ client, tokenIn: token0, tokenOut: token1, fee, amountIn: PREFLIGHT_TEST_AMOUNT_IN });
    quoteSucceeded = true;
    quoteDetail = { amountIn: PREFLIGHT_TEST_AMOUNT_IN.toString(), amountOut: quote.amountOut.toString(), sqrtPriceX96After: quote.sqrtPriceX96After.toString(), gasEstimate: quote.gasEstimate.toString() };
    console.log(`QuoterV2 pre-flight SUCCEEDED: 1 token0 -> ${quote.amountOut} token1`);
  } catch (err) {
    quoteDetail = { error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    console.log(`QuoterV2 pre-flight FAILED: ${quoteDetail.error}`);
  }

  const record = {
    label: "TEST_INFRASTRUCTURE_AMBIENT_LIQUIDITY",
    note: "This position is NOT owned by VEYRA, is NOT part of VEYRA Agent #1890's identity/track record/execution history, and is never farmed or otherwise interacted with beyond this one mint. Its sole purpose is giving the isolated demo pool real depth at the current price so a corrective swap has something to trade against.",
    ambientWallet: AMBIENT_WALLET,
    veyraWallet: VEYRA_WALLET,
    unaffectedReferencePosition: {
      tokenId: VEYRA_POSITION_TOKEN_ID.toString(),
      note: "Position #37059 itself was NOT read-modified by this script beyond the one slot0/positions read used to size the pre-flight quote check -- no transaction in this script touches it.",
      observedTick: positionObservation.currentTick,
      observedRange: { tickLower: positionObservation.tickLower, tickUpper: positionObservation.tickUpper },
    },
    funding: {
      nativeTransferTxHash: nativeTransferHash,
      nativeTransferAmountWei: NATIVE_TO_AMBIENT_WEI.toString(),
      token0TransferTxHash,
      token0TransferAmount: TOKEN0_TO_AMBIENT.toString(),
      wrapTxHash: wrapHash,
      wrapAmountWei: NATIVE_TO_WRAP_WEI.toString(),
    },
    ambientPosition: {
      mintTxHash: mintTx.hash,
      tickLower: ambientTickLower,
      tickUpper: ambientTickUpper,
      amount0Desired: token0Balance.toString(),
      amount1Desired: token1Balance.toString(),
    },
    verification: {
      poolAddress,
      currentTick: tickNow,
      poolLiquidity: poolLiquidityAfter.toString(),
      liquidityActive,
      tickInsideAmbientRange,
      quoterPreflightSucceeded: quoteSucceeded,
      quoterPreflightDetail: quoteDetail,
      safeToAuthorizeRealExecution: liquidityActive && tickInsideAmbientRange && quoteSucceeded,
    },
    generatedAt: new Date().toISOString(),
  };
  const artifactHash = sha256(JSON.stringify(record));
  mkdirSync(TEST_INFRA_DIR, { recursive: true });
  const outPath = resolve(TEST_INFRA_DIR, "ambient-liquidity-0001.json");
  writeFileSync(outPath, JSON.stringify({ ...record, artifactHash }, null, 2));

  section("RESULT");
  console.log(`safeToAuthorizeRealExecution: ${record.verification.safeToAuthorizeRealExecution}`);
  console.log(`Archived: docs/test-infrastructure/ambient-liquidity-0001.json`);
}

main().catch((err) => {
  console.error("Ambient liquidity seeding failed:", err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

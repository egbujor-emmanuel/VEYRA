// Follow-up to seedAmbientLiquidity.ts: the first ambient position (tokenId #37062, ~9.4e18
// liquidity) made the QuoterV2 quote succeed, but the corrective swap (~6.1e18 token0) is such
// a large fraction of that depth that REAL price impact stranded ~3.7% of capital -- above the
// 1% ratio-mismatch threshold (docs/agent-arena-runs-v2 read-only check, this session). Per
// instruction, the threshold itself is never touched; this adds MORE real ambient depth instead,
// using every remaining accessible fund (VEYRA's leftover WBNB dust + wrapping the rest of both
// wallets' native tBNB) via NFPM.increaseLiquidity on the SAME ambient position -- still not
// owned by VEYRA, still never part of its track record.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createPublicClient, http, encodeFunctionData, type Address } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
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

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const AMBIENT_WALLET = "0x62472499C7390ee1dbfb45E782847b35c754C5f0" as const;
const AMBIENT_POSITION_TOKEN_ID = 37062n;
const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;

const token0Addr = "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d" as Address;
const token1Addr = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address;
const poolFee = 2500;

const TRANSFER_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

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
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
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

  const poolAddress = (await client.readContract({ address: PANCAKE_V3_TESTNET.factory as Address, abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "fee", type: "uint24" }], outputs: [{ type: "address" }] }] as const, functionName: "getPool", args: [token0Addr, token1Addr, poolFee] })) as Address;

  section("STEP 1: move all remaining accessible funds toward the ambient wallet");
  // VEYRA's leftover WBNB dust (from Test B's own swap output) -- not needed for VEYRA's
  // upcoming operation, which sources its mint amounts from decreasing Position #37059 itself.
  const veyraToken1 = await client.readContract({ address: token1Addr, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] });
  if (veyraToken1 > 0n) {
    const transferData = encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [AMBIENT_WALLET, veyraToken1] });
    const tx = await veyraSigner.sendAndWait("transfer-remaining-wbnb-to-ambient", token1Addr, transferData);
    console.log(`transferred ${veyraToken1} WBNB dust from VEYRA -> ambient: ${tx.hash}`);
  }
  // Wrap VEYRA's remaining native tBNB (minus a safety reserve for its own upcoming ~7 txs,
  // which cost ~0.00002 tBNB each per this session's own observed history -- 0.01 is generous).
  const veyraNative = await client.getBalance({ address: VEYRA_WALLET });
  const veyraReserve = 10_000_000_000_000_000n; // 0.01 tBNB kept for VEYRA's own real execution
  const veyraToWrap = veyraNative > veyraReserve ? veyraNative - veyraReserve : 0n;
  if (veyraToWrap > 0n) {
    const wrapData = encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit", args: [] });
    const nonce = await client.getTransactionCount({ address: VEYRA_WALLET, blockTag: "pending" });
    const gasPriceWei = await client.getGasPrice();
    const gasEst = await client.estimateGas({ account: VEYRA_WALLET, to: WBNB_TESTNET as Address, data: wrapData, value: veyraToWrap });
    const signed = await veyraWallet.signTransaction({ to: WBNB_TESTNET as Address, data: wrapData, value: veyraToWrap, gas: (gasEst * 120n) / 100n, gasPrice: gasPriceWei, nonce, chainId: 97 });
    const hash = await client.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
    await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log(`VEYRA wrapped ${veyraToWrap} tBNB -> WBNB: ${hash}`);
    const postWrapBalance = await client.readContract({ address: token1Addr, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] });
    const transferData = encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [AMBIENT_WALLET, postWrapBalance] });
    const tx = await veyraSigner.sendAndWait("transfer-newly-wrapped-wbnb-to-ambient", token1Addr, transferData);
    console.log(`transferred ${postWrapBalance} newly-wrapped WBNB from VEYRA -> ambient: ${tx.hash}`);
  }

  // Wrap ambient's own remaining native tBNB too (minus a small gas reserve).
  const ambientNative = await client.getBalance({ address: AMBIENT_WALLET });
  const ambientReserve = 2_000_000_000_000_000n; // 0.002 tBNB kept for this script's own remaining txs
  const ambientToWrap = ambientNative > ambientReserve ? ambientNative - ambientReserve : 0n;
  if (ambientToWrap > 0n) {
    const wrapData = encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit", args: [] });
    const nonce = await client.getTransactionCount({ address: AMBIENT_WALLET, blockTag: "pending" });
    const gasPriceWei = await client.getGasPrice();
    const gasEst = await client.estimateGas({ account: AMBIENT_WALLET, to: WBNB_TESTNET as Address, data: wrapData, value: ambientToWrap });
    const signed = await ambientWallet.signTransaction({ to: WBNB_TESTNET as Address, data: wrapData, value: ambientToWrap, gas: (gasEst * 120n) / 100n, gasPrice: gasPriceWei, nonce, chainId: 97 });
    const hash = await client.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
    await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log(`ambient wrapped its own ${ambientToWrap} tBNB -> WBNB: ${hash}`);
  }

  section("STEP 2: increaseLiquidity on the SAME ambient position (#37062) with everything now available");
  const [ambientToken0, ambientToken1] = await Promise.all([
    client.readContract({ address: token0Addr, abi: ERC20_ABI, functionName: "balanceOf", args: [AMBIENT_WALLET] }),
    client.readContract({ address: token1Addr, abi: ERC20_ABI, functionName: "balanceOf", args: [AMBIENT_WALLET] }),
  ]);
  console.log(`ambient wallet balances before increaseLiquidity: token0=${ambientToken0}, token1=${ambientToken1}`);

  const { getLiquidityForAmounts, getAmountsForLiquidity } = await import("@veyra/core");
  const slot0Before = await client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "slot0" });
  const ambientPosition = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "positions", args: [AMBIENT_POSITION_TOKEN_ID] });
  const [, , , , , ambTickLower, ambTickUpper] = ambientPosition;
  const achievableLiquidity = getLiquidityForAmounts(slot0Before[0], ambTickLower, ambTickUpper, ambientToken0, ambientToken1);
  const consumed = getAmountsForLiquidity(slot0Before[0], ambTickLower, ambTickUpper, achievableLiquidity);
  console.log(`will actually consume: amount0=${consumed.amount0}, amount1=${consumed.amount1}`);

  const approve0 = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, ambientToken0] });
  await ambientSigner.sendAndWait("ambient-approve-token0-more", token0Addr, approve0);
  const approve1 = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, ambientToken1] });
  await ambientSigner.sendAndWait("ambient-approve-token1-more", token1Addr, approve1);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const increaseData = encodeFunctionData({
    abi: NFPM_ABI,
    functionName: "increaseLiquidity",
    args: [{ tokenId: AMBIENT_POSITION_TOKEN_ID, amount0Desired: ambientToken0, amount1Desired: ambientToken1, amount0Min: (consumed.amount0 * 90n) / 100n, amount1Min: (consumed.amount1 * 90n) / 100n, deadline }],
  });
  const increaseTx = await ambientSigner.sendAndWait("ambient-increaseLiquidity", NFPM_ADDRESS, increaseData);
  console.log(`increaseLiquidity: ${increaseTx.hash}`);

  section("STEP 3: verify the pool's new depth and re-run the QuoterV2 pre-flight");
  const [slot0After, poolLiquidityAfter] = await Promise.all([
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "liquidity" }),
  ]);
  console.log(`pool liquidity now: ${poolLiquidityAfter}`);

  const quote = await getLiveSwapQuote({ client, tokenIn: token0Addr, tokenOut: token1Addr, fee: poolFee, amountIn: 1_000_000_000_000_000_000n });
  console.log(`QuoterV2 pre-flight: 1 token0 -> ${quote.amountOut} token1`);

  const record = {
    label: "TEST_INFRASTRUCTURE_AMBIENT_LIQUIDITY_DEEPENING",
    note: "Follow-up to ambient-liquidity-0001.json -- adds more real depth to the SAME ambient position (#37062) because the first amount, while enough to make QuoterV2 succeed, was still a large enough fraction of the swap size to cause real price impact exceeding the ratio-mismatch threshold. Still not VEYRA's position, still not part of its track record.",
    ambientPositionTokenId: AMBIENT_POSITION_TOKEN_ID.toString(),
    increaseLiquidityTxHash: increaseTx.hash,
    poolLiquidityAfter: poolLiquidityAfter.toString(),
    currentTick: slot0After[1],
    quoterPreflight: { amountIn: "1000000000000000000", amountOut: quote.amountOut.toString() },
    generatedAt: new Date().toISOString(),
  };
  const artifactHash = sha256(JSON.stringify(record));
  writeFileSync(resolve(DOCS_DIR, "test-infrastructure", "ambient-liquidity-0002-deepening.json"), JSON.stringify({ ...record, artifactHash }, null, 2));
  console.log(`\nArchived: docs/test-infrastructure/ambient-liquidity-0002-deepening.json`);
}

main().catch((err) => {
  console.error("Deepening failed:", err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

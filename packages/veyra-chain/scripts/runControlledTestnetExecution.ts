// Controlled Testnet Execution (Slice 3) -- NOT "autonomous execution". A human (you) invoked
// this script explicitly, after reviewing the exact safety gates below. It proves
// execute -> verify on top of the observe -> evaluate -> plan -> simulate chain Slices 0-2
// already proved.
//
// This does NOT run through the arena's evaluator against baselines -- the real arena
// (runLiveArenaEvaluation.ts) has been producing "Baseline Hold" every round because the
// isolated testnet pool VEYRA minted has had no real trading activity, so RangeKeeper's
// tighter range never scores better than "do nothing." Per explicit instruction: do not
// manipulate the market or scoring to manufacture a rebalance winner, and do not let this
// script touch docs/arena-rounds/ or the real arena's winner history. Instead, this is a
// separately labeled validation: it calls the REAL rangeKeeperStrategy() function (unmodified,
// same code the arena uses) directly against a fresh live snapshot, then plans/simulates/
// executes THAT real proposal on its own, explicitly out-of-band track.
//
// Safety gates, enforced in code, not just in this comment:
//   1. sim.executable must be true (this ANDs the pure structural/ratio checks from
//      simulatePlan() with the LIVE decreaseLiquidity/collect eth_estimateGas checks from
//      simulateLive() -- strictly more complete than checking pureExecutable alone).
//   2. If the proposal is "hold" (targetRange === null), ABORT. Nothing to execute.
//   3. Before EVERY transaction: gas is re-estimated fresh (not reused from the plan).
//   4. After EVERY transaction: receipt.status must be "success" (viem's literal value for
//      what the user's spec calls SUCCESS) or the whole run aborts immediately and archives
//      exactly what happened, with no attempt to "push through."
//   5. Chain state is re-read between steps (post-decrease position state, post-collect real
//      token balances) -- mint uses the REAL observed post-collect balances, never the
//      pre-execution plan's estimates.
//   6. No MasterChef/farming, no leverage, no swap of any kind, no zero slippage floors.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, type Address, type Hex } from "viem";
import {
  planExecution,
  rangeKeeperStrategy,
  VEYRA_AGENT_ID_ON_CHAIN,
  type JobSpec,
  type CurrentPositionState,
} from "@veyra/core";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation, toMarketSnapshot } from "../src/positionReader.js";
import { simulateLive } from "../src/simulate.js";
import { NFPM_ABI, ERC20_ABI } from "../src/abis.js";
import { PANCAKE_V3_TESTNET } from "../src/testnetAddresses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname at runtime is dist/scripts/ -- 4 levels up reaches the repo root.
const REPO_ROOT = resolve(__dirname, "../../../../");
const SMOKETEST_ROOT = resolve(REPO_ROOT, "smoketest");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const EXECUTIONS_DIR = resolve(REPO_ROOT, "docs/executions");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const VEYRA_POSITION_TOKEN_ID = 37058n;
const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;
const CHAIN_ID = 97;
const GAS_BUFFER_NUMERATOR = 120n; // +20%, matching the SDK's own documented gas-estimation convention
const GAS_BUFFER_DENOMINATOR = 100n;

function readWalletPassword(): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WALLET_PASSWORD=")) return trimmed.slice("WALLET_PASSWORD=".length);
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}

function nextExecutionId(): number {
  mkdirSync(EXECUTIONS_DIR, { recursive: true });
  const existing = readdirSync(EXECUTIONS_DIR)
    .map((f) => /^execution-(\d+)\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
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

interface TxRecord {
  step: string;
  hash: Hex;
  gasUsed: string;
  gasPriceWei: string;
  status: "success" | "reverted";
  blockNumber: string;
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: {
      id: CHAIN_ID,
      name: "bsc-testnet",
      nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl),
  });

  const { EVMWalletProvider } = await import("@bnbagent/sdk");
  const walletProvider = new EVMWalletProvider({
    password: readWalletPassword(),
    address: VEYRA_WALLET,
    walletsDir: KEYSTORE_DIR,
    persist: true,
  });

  /** Build, sign (via the wallet's own encapsulated key -- never extracted into this script), broadcast, and wait. Throws on revert. */
  async function sendAndWait(step: string, to: Address, data: Hex): Promise<TxRecord> {
    const [nonce, gasPriceWei, gasEstimate] = await Promise.all([
      client.getTransactionCount({ address: VEYRA_WALLET, blockTag: "pending" }),
      client.getGasPrice(),
      client.estimateGas({ account: VEYRA_WALLET, to, data, value: 0n }),
    ]);
    const gas = (gasEstimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;

    const signed = await walletProvider.signTransaction({ to, data, value: 0n, gas, gasPrice: gasPriceWei, nonce, chainId: CHAIN_ID });
    console.log(`  [${step}] signed, broadcasting... (nonce ${nonce}, gas ${gas}, gasPrice ${gasPriceWei})`);
    const hash = await client.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
    console.log(`  [${step}] tx hash: ${hash} -- waiting for receipt...`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log(`  [${step}] receipt: status=${receipt.status}, block=${receipt.blockNumber}, gasUsed=${receipt.gasUsed}`);

    if (receipt.status !== "success") {
      throw new Error(`[${step}] transaction REVERTED (hash ${hash}) -- aborting the remaining sequence, nothing further will be sent`);
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

  section("Step 0 -- fresh live observation of Position #37058 (not read from any saved file)");
  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });
  console.log(`current tick: ${observation.currentTick}, position range: [${observation.tickLower}, ${observation.tickUpper}), liquidity: ${observation.positionLiquidity}`);

  // Baseline balances BEFORE any transaction. Lesson learned the hard way in execution-0001:
  // the wallet can hold pre-existing token balances unrelated to this position (e.g. VEYRA's
  // own demo token, minted in bulk when the pool was first created). Using the wallet's
  // absolute post-collect balance as "what this operation yielded" swept up that unrelated
  // balance and fed mint() a wildly wrong ratio, reverting with "Price slippage check". The
  // fix: always use the DELTA (after collect minus this baseline), never the absolute balance.
  const [baselineBalance0, baselineBalance1] = await Promise.all([
    client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
    client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
  ]);
  console.log(`baseline balance0 (before any tx this run): ${baselineBalance0}`);
  console.log(`baseline balance1 (before any tx this run): ${baselineBalance1}`);

  const job: JobSpec = {
    jobId: `controlled-execution-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ownerWallet: VEYRA_WALLET,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(VEYRA_POSITION_TOKEN_ID) },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "awarded",
    erc8183JobId: null,
  };

  section("Step 1 -- generate the REAL rangeKeeperStrategy() proposal (unmodified, same code the arena uses)");
  const proposal = await rangeKeeperStrategy(job, snapshot);
  console.log(`proposal: ${JSON.stringify(proposal.proposedAction)}`);
  console.log(`rationale: ${proposal.rationale}`);

  if (proposal.proposedAction.kind === "hold") {
    console.log("\nABORT: RangeKeeper proposed hold. This validation only proceeds for a genuine rebalance proposal -- nothing executed.");
    return;
  }

  const currentPosition: CurrentPositionState = {
    tokenId: Number(observation.positionTokenId),
    token0: observation.token0,
    token1: observation.token1,
    fee: observation.fee,
    tickLower: observation.tickLower,
    tickUpper: observation.tickUpper,
    liquidity: observation.positionLiquidity,
    sqrtPriceX96: observation.sqrtPriceX96,
  };

  section("Step 2 -- plan");
  const plan = planExecution({ job, proposal, currentPosition, recipient: VEYRA_WALLET });
  console.log(`targetRange: [${plan.targetRange!.tickLower}, ${plan.targetRange!.tickUpper})`);
  console.log(`plan.feasible: ${plan.feasible}`);

  section("Step 3 -- simulate (pure + live)");
  const sim = await simulateLive({ client, plan, currentSqrtPriceX96: observation.sqrtPriceX96, tickSpacing: snapshot.tickSpacing, account: VEYRA_WALLET });
  console.log(`targetRangeValidity: ${sim.targetRangeValidity.status}`);
  console.log(`mintStructuralValidity: ${sim.mintStructuralValidity.status}`);
  console.log(`slippageProtection: ${sim.slippageProtection.status}`);
  console.log(`ratioAdjustment: ${sim.ratioAdjustment.status} (fixRequired=${sim.ratioAdjustment.ratioFixRequired}) -- ${sim.ratioAdjustment.detail}`);
  console.log(`decreaseLiquidity (LIVE): ${sim.decreaseLiquidityLive.status}`);
  console.log(`collect (LIVE): ${sim.collectLive.status}`);
  console.log(`SAFETY GATE -- sim.executable: ${sim.executable}`);

  if (!sim.executable) {
    console.log(`\nABORT: simulation.executable is false (${sim.executableReasons.join("; ")}). Nothing executed.`);
    return;
  }

  section("Step 4 -- APPROVE EXECUTION (safety gate passed; proceeding to real, signed transactions on BSC testnet)");
  const txRecords: TxRecord[] = [];
  const partial: Record<string, unknown> = {};

  function archive(status: "EXECUTED" | "ABORTED", extra: Record<string, unknown>) {
    const executionId = nextExecutionId();
    const contentRecord = {
      kind: "CONTROLLED_TESTNET_EXECUTION",
      label: "Controlled Testnet Execution -- NOT autonomous. Human-invoked, safety-gated, single run.",
      generatedAt: new Date().toISOString(),
      network: "bsc-testnet",
      veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
      ownerWallet: VEYRA_WALLET,
      winningProposal: proposal,
      plan: bigintsToStrings(plan),
      simulation: bigintsToStrings(sim),
      oldPosition: { tokenId: VEYRA_POSITION_TOKEN_ID.toString(), ...(bigintsToStrings(observation) as Record<string, unknown>) },
      transactions: txRecords,
      status,
      ...extra,
    };
    const artifactHash = sha256(JSON.stringify(contentRecord));
    const fullRecord = { executionId, artifactHash, ...contentRecord };
    const outPath = resolve(EXECUTIONS_DIR, `execution-${String(executionId).padStart(4, "0")}.json`);
    writeFileSync(outPath, JSON.stringify(fullRecord, null, 2));
    console.log(`\n${status === "EXECUTED" ? "Execution" : "Aborted execution"} #${executionId} archived: docs/executions/execution-${String(executionId).padStart(4, "0")}.json`);
    console.log(`artifact hash: ${artifactHash}`);
  }

  try {
    await runExecutionSequence();
  } catch (err) {
    console.error(`\nABORTING mid-sequence: ${err instanceof Error ? err.message : err}`);
    console.error(`Transactions completed before the abort (${txRecords.length}): ${txRecords.map((t) => `${t.step}:${t.hash}`).join(", ") || "none"}`);
    archive("ABORTED", { ...partial, abortReason: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  async function runExecutionSequence() {
  // --- 1. decreaseLiquidity: remove the position's full current liquidity ---
  section("Step 5 -- decreaseLiquidity");
  const decreaseStep = plan.steps.find((s) => s.kind === "decreaseLiquidity")!;
  const decreaseData = encodeFunctionData({
    abi: NFPM_ABI,
    functionName: "decreaseLiquidity",
    args: [{ tokenId: BigInt(decreaseStep.tokenId), liquidity: decreaseStep.liquidity, amount0Min: decreaseStep.amount0Min, amount1Min: decreaseStep.amount1Min, deadline: BigInt(decreaseStep.deadline) }],
  });
  txRecords.push(await sendAndWait("decreaseLiquidity", NFPM_ADDRESS, decreaseData));

  section("Step 6 -- VERIFY CHAIN: re-read Position #37058 after decreaseLiquidity");
  const postDecrease = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "positions", args: [VEYRA_POSITION_TOKEN_ID] });
  const [, , , , , , , postDecreaseLiquidity, , , tokensOwed0, tokensOwed1] = postDecrease;
  console.log(`post-decrease liquidity: ${postDecreaseLiquidity} (expected 0)`);
  console.log(`tokensOwed0: ${tokensOwed0}, tokensOwed1: ${tokensOwed1}`);
  partial.postDecreaseLiquidity = postDecreaseLiquidity.toString();
  partial.tokensOwed0 = tokensOwed0.toString();
  partial.tokensOwed1 = tokensOwed1.toString();
  if (postDecreaseLiquidity !== 0n) {
    throw new Error(`post-decrease liquidity is ${postDecreaseLiquidity}, expected 0 -- aborting before collect`);
  }

  // --- 2. collect: withdraw everything owed (principal + fees) to the wallet ---
  section("Step 7 -- collect");
  const collectStep = plan.steps.find((s) => s.kind === "collect")!;
  const collectData = encodeFunctionData({
    abi: NFPM_ABI,
    functionName: "collect",
    args: [{ tokenId: BigInt(collectStep.tokenId), recipient: collectStep.recipient as Address, amount0Max: collectStep.amount0Max, amount1Max: collectStep.amount1Max }],
  });
  txRecords.push(await sendAndWait("collect", NFPM_ADDRESS, collectData));

  section("Step 8 -- VERIFY CHAIN: re-read wallet balances and compute the DELTA this operation actually yielded");
  const [postCollectBalance0, postCollectBalance1] = await Promise.all([
    client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
    client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
  ]);
  // DELTA, not absolute balance -- see this file's Step 0 comment on why. A pre-existing
  // balance would otherwise be silently swept into "what to mint," distorting the ratio.
  const collectedAmount0 = postCollectBalance0 - baselineBalance0;
  const collectedAmount1 = postCollectBalance1 - baselineBalance1;
  console.log(`post-collect balance0: ${postCollectBalance0} (baseline was ${baselineBalance0}) -> collected delta: ${collectedAmount0}`);
  console.log(`post-collect balance1: ${postCollectBalance1} (baseline was ${baselineBalance1}) -> collected delta: ${collectedAmount1}`);
  partial.collectedAmount0 = collectedAmount0.toString();
  partial.collectedAmount1 = collectedAmount1.toString();
  if (collectedAmount0 < 0n || collectedAmount1 < 0n) {
    throw new Error(`a collected delta went negative (amount0=${collectedAmount0}, amount1=${collectedAmount1}) -- wallet balance dropped unexpectedly, aborting`);
  }
  if (collectedAmount0 === 0n && collectedAmount1 === 0n) {
    throw new Error("collected deltas are both zero -- nothing to mint, aborting before approve/mint");
  }

  // --- approve: standard ERC20 permission grant, scoped EXACTLY to the collected delta
  // (never unbounded, never the wallet's total balance) -- not a swap, not a fund movement,
  // just a permission the mint call needs. ---
  section("Step 9 -- approve NFPM to spend exactly the collected delta (scoped exactly, not unbounded)");
  if (collectedAmount0 > 0n) {
    const approve0Data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, collectedAmount0] });
    txRecords.push(await sendAndWait("approve-token0", observation.token0, approve0Data));
  }
  if (collectedAmount1 > 0n) {
    const approve1Data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, collectedAmount1] });
    txRecords.push(await sendAndWait("approve-token1", observation.token1, approve1Data));
  }

  // --- 3. mint: uses the collected DELTA, never the plan's pre-execution estimate, never the
  // wallet's total balance ---
  section("Step 10 -- mint (amounts are the collected delta, slippage floor recomputed against it)");
  const maxSlippageBps = job.constraints.maxSlippageBps;
  const amount0Min = (collectedAmount0 * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const amount1Min = (collectedAmount1 * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const deadline = Math.floor(Date.now() / 1000) + job.constraints.deadlineSeconds;
  const mintArgs = {
    token0: observation.token0,
    token1: observation.token1,
    fee: observation.fee,
    tickLower: plan.targetRange!.tickLower,
    tickUpper: plan.targetRange!.tickUpper,
    amount0Desired: collectedAmount0,
    amount1Desired: collectedAmount1,
    amount0Min,
    amount1Min,
    recipient: VEYRA_WALLET,
    deadline: BigInt(deadline),
  };
  console.log(`mint args: ${JSON.stringify(bigintsToStrings(mintArgs))}`);
  const mintData = encodeFunctionData({ abi: NFPM_ABI, functionName: "mint", args: [mintArgs] });
  const mintTxRecord = await sendAndWait("mint", NFPM_ADDRESS, mintData);
  txRecords.push(mintTxRecord);

  section("Step 11 -- VERIFY NEW POSITION: decode the IncreaseLiquidity event to find the new tokenId");
  const mintReceipt = await client.getTransactionReceipt({ hash: mintTxRecord.hash });
  let newTokenId: bigint | null = null;
  for (const log of mintReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: NFPM_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "IncreaseLiquidity" && log.address.toLowerCase() === NFPM_ADDRESS.toLowerCase()) {
        newTokenId = (decoded.args as { tokenId: bigint }).tokenId;
        break;
      }
    } catch {
      // not every log in this receipt decodes against NFPM_ABI (e.g. ERC20 Transfer logs) -- skip
    }
  }
  if (newTokenId === null) {
    throw new Error("mint succeeded but no IncreaseLiquidity event was found in its receipt -- cannot identify the new position");
  }
  console.log(`new tokenId: ${newTokenId}`);

  section("Step 12 -- independently re-read the new position from chain");
  const newPositionObservation = await readPositionObservation(client, newTokenId);
  const newOwner = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "ownerOf", args: [newTokenId] });
  console.log(`ownerOf(${newTokenId}): ${newOwner}`);
  console.log(`token0/token1: ${newPositionObservation.token0} / ${newPositionObservation.token1}`);
  console.log(`fee: ${newPositionObservation.fee}`);
  console.log(`range: [${newPositionObservation.tickLower}, ${newPositionObservation.tickUpper})`);
  console.log(`liquidity: ${newPositionObservation.positionLiquidity}`);
  console.log(`pool: ${newPositionObservation.poolAddress}`);
  console.log(`currentTick: ${newPositionObservation.currentTick}`);

  const verified =
    newOwner.toLowerCase() === VEYRA_WALLET.toLowerCase() &&
    newPositionObservation.tickLower === plan.targetRange!.tickLower &&
    newPositionObservation.tickUpper === plan.targetRange!.tickUpper &&
    newPositionObservation.fee === observation.fee &&
    newPositionObservation.token0.toLowerCase() === observation.token0.toLowerCase() &&
    newPositionObservation.token1.toLowerCase() === observation.token1.toLowerCase() &&
    newPositionObservation.positionLiquidity > 0n;

  console.log(`\nVERIFIED: VEYRA wallet owns the resulting position and its parameters match the execution plan: ${verified}`);
  if (!verified) {
    throw new Error("post-mint verification FAILED -- the new position's on-chain parameters do not match the execution plan (see log above for specifics)");
  }

  archive("EXECUTED", {
    newPosition: { tokenId: newTokenId.toString(), ...(bigintsToStrings(newPositionObservation) as Record<string, unknown>) },
    postExecutionObservation: {
      postDecreaseLiquidity: postDecreaseLiquidity.toString(),
      tokensOwed0: tokensOwed0.toString(),
      tokensOwed1: tokensOwed1.toString(),
      baselineBalance0: baselineBalance0.toString(),
      baselineBalance1: baselineBalance1.toString(),
      collectedAmount0: collectedAmount0.toString(),
      collectedAmount1: collectedAmount1.toString(),
    },
    verified,
  });
  }
}

main().catch((err) => {
  console.error("\nControlled Testnet Execution aborted:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

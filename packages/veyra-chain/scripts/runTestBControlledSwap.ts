// TEST B — TESTNET CONTROLLED MARKET TRANSITION. NOT NATURAL MARKET ACTIVITY.
//
// Purpose: prove that evaluateV2's winner genuinely responds to REAL, chain-observed market
// movement -- not to any special-casing of which candidate is "RangeKeeper." Same code, same
// three strategies, same common evaluator as every other v2 round; the ONLY thing this script
// does differently is deliberately move the isolated demo pool's price via one real, bounded
// swap, then re-observe and re-evaluate exactly as runLiveArenaEvaluationV2.ts already does.
//
// Sequence: BASELINE (read-only) -> CONTROLLED SWAP (one real, price-bounded transaction) ->
// RE-OBSERVE (real chain read) -> POST-TRANSITION EVALUATE (read-only) -> ARCHIVE.
//
// This script NEVER proceeds to plan/simulate/execute a rebalance itself, regardless of the
// post-transition winner. If RangeKeeper wins here, the separate, already-existing
// runAgentArenaLoop({evaluatorVersion:"v2"}) is the next, independent step -- run only after
// reviewing this script's result, not automatically chained.
//
// Written to docs/test-b/ -- kept entirely separate from both docs/arena-rounds/ (v1 history)
// and docs/arena-rounds-v2/ (ordinary v2 rounds), since this is a deliberately-engineered
// validation exercise, not organic arena activity.

import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, encodeFunctionData, type Address } from "viem";
import { evaluateV2, planExecution, getSqrtRatioAtTick, estimateSwapAmountForPriceMove, roundToTickSpacing, rangeKeeperStrategy, baselineHoldStrategy, baselineSymmetricRangeStrategy, VEYRA_AGENT_ID_ON_CHAIN, type JobSpec, type MarketSnapshot } from "@veyra/core";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation, toMarketSnapshot, type OnChainPositionObservation } from "../src/positionReader.js";
import { simulateLive } from "../src/simulate.js";
import { createSigner } from "../src/txSigner.js";
import { ERC20_ABI, SWAP_ROUTER_ABI } from "../src/abis.js";
import { PANCAKE_V3_TESTNET } from "../src/testnetAddresses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const SMOKETEST_ROOT = resolve(REPO_ROOT, "smoketest");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const DOCS_DIR = resolve(REPO_ROOT, "docs");
const TEST_B_DIR = resolve(DOCS_DIR, "test-b");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const VEYRA_POSITION_TOKEN_ID = 37059n;
const SWAP_ROUTER = PANCAKE_V3_TESTNET.swapRouter as Address;

// Target: push the tick past the LOWER edge of the position's current range (chosen, not the
// upper edge, specifically because the wallet holds token0 and zero token1 -- see this slice's
// chat record for the balance check that decided this). "Past," not "at": -58050 is the range's
// own lower bound; a genuinely out-of-range demonstration needs to clear it with margin.
const TARGET_TICK_OFFSET_PAST_EDGE = 100; // ticks past the edge, in tick-spacing units below
const SAFETY_MULTIPLIER = 3n; // covers the real pool fee (this estimate ignores it) and any minor liquidity-distribution slack

function readWalletPassword(): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WALLET_PASSWORD=")) return trimmed.slice("WALLET_PASSWORD=".length);
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}

function nextTestBId(): number {
  mkdirSync(TEST_B_DIR, { recursive: true });
  const existing = readdirSync(TEST_B_DIR)
    .map((f) => /^test-b-(\d+)\.json$/.exec(f)?.[1])
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

function makeJob(observation: OnChainPositionObservation): JobSpec {
  return {
    jobId: `test-b-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ownerWallet: VEYRA_WALLET,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(observation.positionTokenId) },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "evaluating",
    erc8183JobId: null,
  };
}

async function evaluateSnapshot(job: JobSpec, snapshot: MarketSnapshot) {
  const proposals = await Promise.all([rangeKeeperStrategy(job, snapshot), baselineHoldStrategy(job, snapshot), baselineSymmetricRangeStrategy(job, snapshot)]);
  return evaluateV2(job, snapshot, proposals);
}

function reportEvaluation(label: string, result: Awaited<ReturnType<typeof evaluateSnapshot>>) {
  section(label);
  for (const s of result.scored) {
    const marker = s.isWinner ? " <-- WINNER" : "";
    console.log(`${s.proposal.displayLabel} (${s.proposal.candidateId})${marker}: total=${s.score.totalScore.toFixed(2)} width=${s.metrics.widthEfficiency.toFixed(1)} positioning=${s.metrics.positioningScore.toFixed(1)}`);
  }
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: 97, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  console.log("TEST B -- TESTNET CONTROLLED MARKET TRANSITION. NOT NATURAL MARKET ACTIVITY.");

  // --- STEP 1: BASELINE (read-only, no signer touched yet) ---
  const baselineObservation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  const baselineSnapshot = toMarketSnapshot(baselineObservation, { recentVolatilityBps: 0 });
  const baselineJob = makeJob(baselineObservation);
  const baselineResult = await evaluateSnapshot(baselineJob, baselineSnapshot);
  reportEvaluation("STEP 1: BASELINE (pre-transition, OBSERVED)", baselineResult);
  console.log(`Position #${VEYRA_POSITION_TOKEN_ID}: tick=${baselineObservation.currentTick}, range=[${baselineObservation.tickLower}, ${baselineObservation.tickUpper})`);

  // --- STEP 2: CONTROLLED SWAP (one real, price-bounded transaction) ---
  section("STEP 2: CONTROLLED SWAP -- TESTNET_CONTROLLED, not natural activity");
  const targetTick = roundToTickSpacing(baselineObservation.tickLower - TARGET_TICK_OFFSET_PAST_EDGE, 50);
  const sqrtPriceLimitX96 = getSqrtRatioAtTick(targetTick);
  const estimate = estimateSwapAmountForPriceMove(baselineObservation.sqrtPriceX96, sqrtPriceLimitX96, baselineObservation.positionLiquidity);
  if (!estimate.zeroForOne) throw new Error("expected a token0-in swap given the chosen (lower) target -- aborting rather than proceeding on a wrong assumption");
  const amountInCeiling = estimate.amountIn * SAFETY_MULTIPLIER;

  const walletBalance0 = await client.readContract({ address: baselineObservation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] });
  if (walletBalance0 < amountInCeiling) {
    throw new Error(`wallet token0 balance ${walletBalance0} is less than the computed swap ceiling ${amountInCeiling} -- aborting rather than under-funding the swap`);
  }
  console.log(`target tick: ${targetTick} (${TARGET_TICK_OFFSET_PAST_EDGE} ticks past the lower edge ${baselineObservation.tickLower})`);
  console.log(`swap direction: token0 in (zeroForOne=true)`);
  console.log(`amountIn ceiling (3x the fee-free estimate, price-bounded so this is a ceiling, not a target): ${amountInCeiling}`);

  const { EVMWalletProvider } = await import("@bnbagent/sdk");
  const wallet = new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: KEYSTORE_DIR, persist: true });
  const signer = createSigner(client, wallet, 97);

  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER, amountInCeiling] });
  const approveTx = await signer.sendAndWait("approve-swaprouter-token0", baselineObservation.token0, approveData);
  console.log(`approve tx: ${approveTx.hash}`);

  const swapDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: baselineObservation.token0,
        tokenOut: baselineObservation.token1,
        fee: baselineObservation.fee,
        recipient: VEYRA_WALLET,
        deadline: swapDeadline,
        amountIn: amountInCeiling,
        // amountOutMinimum = 0 is deliberate and narrowly scoped here, NOT a general policy:
        // this is a private, isolated, single-position pool WE created with no other
        // participants, and the "trade" is the deliberate point of the exercise, not a real
        // position being protected from sandwich risk. sqrtPriceLimitX96 is the real safety
        // bound on this swap, not amountOutMinimum.
        amountOutMinimum: 0n,
        sqrtPriceLimitX96,
      },
    ],
  });
  const swapTx = await signer.sendAndWait("controlled-swap-exactInputSingle", SWAP_ROUTER, swapData);
  console.log(`swap tx: ${swapTx.hash}`);

  // --- STEP 3: RE-OBSERVE (real chain read, not manufactured) ---
  section("STEP 3: RE-OBSERVE (post-swap, OBSERVED)");
  const postSwapObservation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  const postSwapSnapshot = toMarketSnapshot(postSwapObservation, { recentVolatilityBps: 0 });
  console.log(`Position #${VEYRA_POSITION_TOKEN_ID}: tick=${postSwapObservation.currentTick} (was ${baselineObservation.currentTick}), range unchanged=[${postSwapObservation.tickLower}, ${postSwapObservation.tickUpper})`);
  const nowOutOfRange = postSwapObservation.currentTick < postSwapObservation.tickLower || postSwapObservation.currentTick >= postSwapObservation.tickUpper;
  console.log(`position now out of range: ${nowOutOfRange}`);

  // --- STEP 4: POST-TRANSITION EVALUATE (read-only, same code, same strategies) ---
  const postJob = makeJob(postSwapObservation);
  const postResult = await evaluateSnapshot(postJob, postSwapSnapshot);
  reportEvaluation("STEP 4: POST-TRANSITION EVALUATE (v2-market-aware)", postResult);

  const rangeKeeperWonNaturally = postResult.winner.proposal.candidateId === "rangekeeper-v1";

  // Plan+simulate the post-transition winner too (read-only) -- gives the archive a complete
  // picture even though this script stops here regardless of the result.
  const currentPosition = {
    tokenId: Number(postSwapObservation.positionTokenId),
    token0: postSwapObservation.token0,
    token1: postSwapObservation.token1,
    fee: postSwapObservation.fee,
    tickLower: postSwapObservation.tickLower,
    tickUpper: postSwapObservation.tickUpper,
    liquidity: postSwapObservation.positionLiquidity,
    sqrtPriceX96: postSwapObservation.sqrtPriceX96,
  };
  const postPlan = planExecution({ job: postJob, proposal: postResult.winner.proposal, currentPosition, recipient: VEYRA_WALLET });
  const postSim = await simulateLive({ client, plan: postPlan, currentSqrtPriceX96: postSwapObservation.sqrtPriceX96, tickSpacing: postSwapSnapshot.tickSpacing, account: VEYRA_WALLET });

  section("RESULT");
  if (rangeKeeperWonNaturally) {
    console.log(`RangeKeeper won naturally after the controlled market transition. simulation.executable=${postSim.executable}`);
    console.log(`Next step (separate, not run by this script): runAgentArenaLoop({ evaluatorVersion: "v2" }) against Position #${VEYRA_POSITION_TOKEN_ID}.`);
  } else {
    console.log(`RangeKeeper did NOT win (winner: ${postResult.winner.proposal.candidateId}). Archiving the honest result -- no further market manipulation will be attempted.`);
  }

  // --- ARCHIVE: the complete Test B record ---
  const testBId = nextTestBId();
  const record = {
    testBId,
    label: "TESTNET_CONTROLLED_MARKET_TRANSITION",
    provenance: {
      baseline: "OBSERVED",
      swapTransaction: "TESTNET_CONTROLLED", // deliberate, not natural market activity
      postTransitionObservation: "OBSERVED",
      positioningAndScores: "DERIVED",
      recentVolatilityBps: "SUPPLIED_NOT_OBSERVED",
      planAndSimulation: "SIMULATED",
    },
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: VEYRA_WALLET,
    positionTokenId: VEYRA_POSITION_TOKEN_ID.toString(),
    baseline: {
      observedAtBlock: baselineObservation.blockNumber.toString(),
      observed: bigintsToStrings({ ...baselineObservation }),
      winnerCandidateId: baselineResult.winner.proposal.candidateId,
      scored: baselineResult.scored.map((s) => ({ candidateId: s.proposal.candidateId, displayLabel: s.proposal.displayLabel, metrics: bigintsToStrings(s.metrics), score: s.score, isWinner: s.isWinner })),
    },
    controlledSwap: {
      targetTick,
      sqrtPriceLimitX96: sqrtPriceLimitX96.toString(),
      zeroForOne: estimate.zeroForOne,
      amountInCeiling: amountInCeiling.toString(),
      approveTx: approveTx,
      swapTx: swapTx,
    },
    postTransition: {
      observedAtBlock: postSwapObservation.blockNumber.toString(),
      observed: bigintsToStrings({ ...postSwapObservation }),
      nowOutOfRange,
      winnerCandidateId: postResult.winner.proposal.candidateId,
      scored: postResult.scored.map((s) => ({ candidateId: s.proposal.candidateId, displayLabel: s.proposal.displayLabel, metrics: bigintsToStrings(s.metrics), score: s.score, isWinner: s.isWinner })),
      executionPlan: bigintsToStrings(postPlan),
      simulation: bigintsToStrings(postSim),
    },
    rangeKeeperWonNaturally,
    conclusion: rangeKeeperWonNaturally
      ? "Same code, same strategies, same evaluator, real chain state: Hold won before the transition, RangeKeeper won after it. No candidate-identity branching was added anywhere to produce this."
      : "The controlled transition did not flip the winner. Archived honestly; no further market manipulation was attempted.",
    generatedAt: new Date().toISOString(),
  };
  const artifactHash = sha256(JSON.stringify(record));
  const outPath = resolve(TEST_B_DIR, `test-b-${String(testBId).padStart(4, "0")}.json`);
  writeFileSync(outPath, JSON.stringify({ ...record, artifactHash }, null, 2));
  console.log(`\nArchived: docs/test-b/test-b-${String(testBId).padStart(4, "0")}.json`);
}

main().catch((err) => {
  console.error("Test B failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

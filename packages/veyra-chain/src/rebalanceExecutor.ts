// The real decrease -> collect -> (swap if needed) -> mint -> verify sequence, extracted
// verbatim from orchestrator.ts's runAgentArenaLoop (four-category expansion, Day 3) so a grid
// slot's rebalance reuses the EXACT SAME proven, historically-real execution logic instead of a
// second, independently-reviewed copy of money-moving code. This is a pure extraction: every
// safety property, comment, and the exact sequence of operations is unchanged from the
// single-position path -- verified byte-identical behavior via the existing chain test suite
// before this was relied on for anything new.

import { encodeFunctionData, decodeEventLog, type PublicClient, type Address } from "viem";
import {
  computeCollectedAmounts,
  transition,
  computeRebalanceSwapRequirement,
  getLiquidityForAmounts,
  getAmountsForLiquidity,
  RATIO_MISMATCH_THRESHOLD,
  type JobSpec,
  type ExecutionPlan,
  type RunRecord,
  type RunState,
} from "@veyra/core";
import { readPositionObservation, type OnChainPositionObservation } from "./positionReader.js";
import { getLiveSwapQuote } from "./rebalanceQuote.js";
import type { Signer, TxRecord } from "./txSigner.js";
import { NFPM_ABI, ERC20_ABI, POOL_ABI, SWAP_ROUTER_ABI } from "./abis.js";
import { PANCAKE_V3_TESTNET } from "./testnetAddresses.js";

const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;
const SWAP_ROUTER = PANCAKE_V3_TESTNET.swapRouter as Address;

function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
  }
  return value;
}

export interface ExecuteRebalanceOpts {
  client: PublicClient;
  signer: Signer;
  job: JobSpec; // only .constraints (maxSlippageBps, deadlineSeconds) is read
  plan: ExecutionPlan; // must have targetRange !== null -- a real rebalance plan, never a hold
  positionTokenId: bigint;
  observation: OnChainPositionObservation;
  ownerWallet: Address;
  /** Current state machine record -- expected to already be past PLAN/SIMULATE. Transitioned internally through DECREASE_PENDING -> ... -> EXECUTED, or to the matching *_FAILED state on error. */
  run: RunRecord;
}

export interface ExecuteRebalanceResult {
  run: RunRecord; // final state: EXECUTED, or one of the *_FAILED states
  txRecords: TxRecord[];
  newPositionTokenId: bigint | null;
  detail: Record<string, unknown>; // swap/newPosition/collectedAmount/verified detail
}

export async function executeRebalanceForPosition(opts: ExecuteRebalanceOpts): Promise<ExecuteRebalanceResult> {
  const { client, signer, job, plan, positionTokenId, observation, ownerWallet } = opts;
  let run = opts.run;
  const txRecords: TxRecord[] = [];
  let newPositionTokenId: bigint | null = null;
  let detail: Record<string, unknown> = {};

  if (plan.targetRange === null) {
    throw new Error("executeRebalanceForPosition requires a real rebalance plan (targetRange !== null), not a hold");
  }
  const targetRange = plan.targetRange;

  const [baselineBalance0, baselineBalance1] = await Promise.all([
    client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerWallet] }),
    client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerWallet] }),
  ]);

  run = transition(run, "DECREASE_PENDING");
  try {
    const decreaseStep = plan.steps.find((s) => s.kind === "decreaseLiquidity")!;
    const data = encodeFunctionData({
      abi: NFPM_ABI,
      functionName: "decreaseLiquidity",
      args: [{ tokenId: BigInt(decreaseStep.tokenId), liquidity: decreaseStep.liquidity, amount0Min: decreaseStep.amount0Min, amount1Min: decreaseStep.amount1Min, deadline: BigInt(decreaseStep.deadline) }],
    });
    txRecords.push(await signer.sendAndWait("decreaseLiquidity", NFPM_ADDRESS, data));

    const postDecrease = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "positions", args: [positionTokenId] });
    if (postDecrease[7] !== 0n) throw new Error(`post-decrease liquidity is ${postDecrease[7]}, expected 0`);

    run = transition(run, "COLLECT_PENDING");
    const collectStep = plan.steps.find((s) => s.kind === "collect")!;
    const collectData = encodeFunctionData({
      abi: NFPM_ABI,
      functionName: "collect",
      args: [{ tokenId: BigInt(collectStep.tokenId), recipient: collectStep.recipient as Address, amount0Max: collectStep.amount0Max, amount1Max: collectStep.amount1Max }],
    });
    txRecords.push(await signer.sendAndWait("collect", NFPM_ADDRESS, collectData));

    const [postCollectBalance0, postCollectBalance1] = await Promise.all([
      client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerWallet] }),
      client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerWallet] }),
    ]);
    const { collectedAmount0, collectedAmount1 } = computeCollectedAmounts({ baselineBalance0, baselineBalance1, postCollectBalance0, postCollectBalance1 });

    const freshSlot0 = await client.readContract({ address: observation.poolAddress, abi: POOL_ABI, functionName: "slot0" });
    const swapRequirement = computeRebalanceSwapRequirement(collectedAmount0, collectedAmount1, targetRange.tickLower, targetRange.tickUpper, freshSlot0[0]);

    let mintAmount0 = collectedAmount0;
    let mintAmount1 = collectedAmount1;
    let swapDetail: Record<string, unknown> = { swapRequirement: bigintsToStrings(swapRequirement) };

    if (swapRequirement.direction !== "NO_SWAP_REQUIRED") {
      run = transition(run, "SWAP_PENDING");
      const [tokenIn, tokenOut] = swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1" ? [observation.token0, observation.token1] : [observation.token1, observation.token0];

      const freshQuote = await getLiveSwapQuote({ client, tokenIn, tokenOut, fee: observation.fee, amountIn: swapRequirement.amountIn });
      const maxSlippageBps = job.constraints.maxSlippageBps;
      const amountOutMinimum = (freshQuote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;

      const approveSwapData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER, swapRequirement.amountIn] });
      txRecords.push(await signer.sendAndWait(`approve-swaprouter-${swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1" ? "token0" : "token1"}`, tokenIn, approveSwapData));

      const swapDeadline = BigInt(Math.floor(Date.now() / 1000) + job.constraints.deadlineSeconds);
      const swapData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{ tokenIn, tokenOut, fee: observation.fee, recipient: ownerWallet, deadline: swapDeadline, amountIn: swapRequirement.amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
      });
      txRecords.push(await signer.sendAndWait("ratio-fix-swap", SWAP_ROUTER, swapData));

      const [postSwapBalance0, postSwapBalance1] = await Promise.all([
        client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerWallet] }),
        client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerWallet] }),
      ]);
      mintAmount0 = postSwapBalance0 - baselineBalance0;
      mintAmount1 = postSwapBalance1 - baselineBalance1;

      // Re-read slot0 AFTER the swap's receipt is confirmed -- a swap moves the pool's price, so
      // the post-swap ratio re-check and the mint amountMin floor must use the price mint() will
      // actually execute against, not the pre-swap price (the real bug found live in this
      // project's own history).
      const postSwapSlot0 = await client.readContract({ address: observation.poolAddress, abi: POOL_ABI, functionName: "slot0" });

      const achievableLiquidity = getLiquidityForAmounts(postSwapSlot0[0], targetRange.tickLower, targetRange.tickUpper, mintAmount0, mintAmount1);
      const consumed = getAmountsForLiquidity(postSwapSlot0[0], targetRange.tickLower, targetRange.tickUpper, achievableLiquidity);
      const strandedFraction0 = mintAmount0 === 0n ? 0 : Number(mintAmount0 - consumed.amount0) / Number(mintAmount0);
      const strandedFraction1 = mintAmount1 === 0n ? 0 : Number(mintAmount1 - consumed.amount1) / Number(mintAmount1);
      if (strandedFraction0 > RATIO_MISMATCH_THRESHOLD || strandedFraction1 > RATIO_MISMATCH_THRESHOLD) {
        throw new Error(
          `post-swap ratio still outside tolerance: stranded fractions ${strandedFraction0.toFixed(4)}/${strandedFraction1.toFixed(4)} exceed ${RATIO_MISMATCH_THRESHOLD} -- refusing to mint`,
        );
      }

      swapDetail = {
        swapRequirement: bigintsToStrings(swapRequirement),
        freshQuote: bigintsToStrings(freshQuote),
        amountOutMinimum: amountOutMinimum.toString(),
        mintAmount0: mintAmount0.toString(),
        mintAmount1: mintAmount1.toString(),
        postSwapStrandedFraction0: strandedFraction0,
        postSwapStrandedFraction1: strandedFraction1,
      };
    }
    detail = { swap: swapDetail };

    if (mintAmount0 > 0n) {
      const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, mintAmount0] });
      txRecords.push(await signer.sendAndWait("approve-token0", observation.token0, approveData));
    }
    if (mintAmount1 > 0n) {
      const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, mintAmount1] });
      txRecords.push(await signer.sendAndWait("approve-token1", observation.token1, approveData));
    }

    run = transition(run, "MINT_PENDING");
    const maxSlippageBps = job.constraints.maxSlippageBps;
    const amount0Min = (mintAmount0 * BigInt(10_000 - maxSlippageBps)) / 10_000n;
    const amount1Min = (mintAmount1 * BigInt(10_000 - maxSlippageBps)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + job.constraints.deadlineSeconds;
    const mintArgs = {
      token0: observation.token0,
      token1: observation.token1,
      fee: observation.fee,
      tickLower: targetRange.tickLower,
      tickUpper: targetRange.tickUpper,
      amount0Desired: mintAmount0,
      amount1Desired: mintAmount1,
      amount0Min,
      amount1Min,
      recipient: ownerWallet,
      deadline: BigInt(deadline),
    };
    const mintData = encodeFunctionData({ abi: NFPM_ABI, functionName: "mint", args: [mintArgs] });
    const mintTxRecord = await signer.sendAndWait("mint", NFPM_ADDRESS, mintData);
    txRecords.push(mintTxRecord);

    run = transition(run, "VERIFYING");
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
        // non-NFPM logs don't decode against NFPM_ABI -- expected, skip
      }
    }
    if (newTokenId === null) throw new Error("mint succeeded but no IncreaseLiquidity event was found");

    const newPositionObservation = await readPositionObservation(client, newTokenId);
    const newOwner = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "ownerOf", args: [newTokenId] });
    const verified =
      newOwner.toLowerCase() === ownerWallet.toLowerCase() &&
      newPositionObservation.tickLower === targetRange.tickLower &&
      newPositionObservation.tickUpper === targetRange.tickUpper &&
      newPositionObservation.fee === observation.fee &&
      newPositionObservation.token0.toLowerCase() === observation.token0.toLowerCase() &&
      newPositionObservation.token1.toLowerCase() === observation.token1.toLowerCase() &&
      newPositionObservation.positionLiquidity > 0n;

    newPositionTokenId = newTokenId;
    detail = {
      ...detail,
      newPosition: { tokenId: newTokenId.toString(), ...(bigintsToStrings(newPositionObservation) as Record<string, unknown>) },
      collectedAmount0: collectedAmount0.toString(),
      collectedAmount1: collectedAmount1.toString(),
      verified,
    };

    if (!verified) throw new Error("post-mint verification FAILED -- new position parameters do not match the plan");
    run = transition(run, "EXECUTED");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failureFor: Record<string, RunState> = {
      DECREASE_PENDING: "DECREASE_FAILED",
      COLLECT_PENDING: "COLLECT_FAILED",
      SWAP_PENDING: "SWAP_FAILED",
      MINT_PENDING: "MINT_FAILED",
      VERIFYING: "VERIFICATION_FAILED",
    };
    const failState = failureFor[run.currentState] ?? "MINT_FAILED";
    run = transition(run, failState, reason);
  }

  return { run, txRecords, newPositionTokenId, detail };
}

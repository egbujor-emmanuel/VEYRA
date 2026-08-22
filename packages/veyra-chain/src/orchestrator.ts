// The Agent Arena Loop (Slice 4): connects the REAL arena winner to REAL execution, driven by
// the formal run state machine (@veyra/core's runStateMachine.ts). This is the "big one" --
// previously, Slice 3's controlled execution called rangeKeeperStrategy() directly, out of
// band from the arena, specifically because the real arena was picking Baseline Hold. This
// module removes that gap: it runs the SAME observe -> evaluate sequence the arena uses,
// takes WHICHEVER proposal the common evaluator actually picks (never assumes it's
// RangeKeeper), and only proceeds into execution if that real winner is a feasible rebalance.
//
// If the real winner is hold, this naturally ends in the HOLD state and archives a run record
// with no transactions sent -- exactly the same honest behavior the arena has shown so far,
// now formalized instead of asserted.

import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { encodeFunctionData, decodeEventLog, type PublicClient, type Address } from "viem";
import {
  evaluate,
  planExecution,
  computeCollectedAmounts,
  createRun,
  transition,
  isFailure,
  authorizeExecution,
  DEFAULT_EXECUTION_POLICY,
  rangeKeeperStrategy,
  baselineHoldStrategy,
  baselineSymmetricRangeStrategy,
  VEYRA_AGENT_ID_ON_CHAIN,
  type JobSpec,
  type CurrentPositionState,
  type RunRecord,
  type RunState,
  type ExecutionPolicy,
} from "@veyra/core";
import { readPositionObservation, toMarketSnapshot } from "./positionReader.js";
import { simulateLive } from "./simulate.js";
import { createSigner, type SigningWallet, type TxRecord } from "./txSigner.js";
import { NFPM_ABI, ERC20_ABI } from "./abis.js";
import { PANCAKE_V3_TESTNET } from "./testnetAddresses.js";

const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;

function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
  }
  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Same numbering scheme runLiveArenaEvaluation.ts uses -- both draw from the same archive directory. */
function nextRoundId(arenaRoundsDir: string): number {
  mkdirSync(arenaRoundsDir, { recursive: true });
  const existing = readdirSync(arenaRoundsDir)
    .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

function nextRunArchiveId(runsDir: string): number {
  mkdirSync(runsDir, { recursive: true });
  const existing = readdirSync(runsDir)
    .map((f) => /^run-(\d+)\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

export interface RunAgentArenaLoopOpts {
  client: PublicClient;
  wallet: SigningWallet;
  positionTokenId: bigint;
  ownerWallet: Address;
  docsDir: string; // absolute path to the repo's docs/ directory
  chainId?: number; // default 97
  policy?: ExecutionPolicy; // default DEFAULT_EXECUTION_POLICY
}

export interface AgentArenaLoopResult {
  run: RunRecord;
  roundId: number;
  runArchiveId: number;
  winnerCandidateId: string;
  newPositionTokenId: string | null;
  outPath: string;
}

interface BlockTrace {
  observationBlock: string;
  planningBlock: string;
  simulationBlock: string;
  executionStartBlock: string | null; // null when execution was never authorized
}

export async function runAgentArenaLoop(opts: RunAgentArenaLoopOpts): Promise<AgentArenaLoopResult> {
  const chainId = opts.chainId ?? 97;
  const arenaRoundsDir = resolve(opts.docsDir, "arena-rounds");
  const runsDir = resolve(opts.docsDir, "agent-arena-runs");
  const runId = randomUUID();
  let run = createRun(runId);
  const txRecords: TxRecord[] = [];
  let newPositionTokenId: string | null = null;
  let verificationDetail: Record<string, unknown> = {};

  // --- OBSERVE ---
  const observation = await readPositionObservation(opts.client, opts.positionTokenId);
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });
  run = transition(run, "EVALUATE");

  const job: JobSpec = {
    jobId: `agent-arena-loop-${runId}`,
    createdAt: new Date().toISOString(),
    ownerWallet: opts.ownerWallet,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(opts.positionTokenId) },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "evaluating",
    erc8183JobId: null,
  };

  // --- EVALUATE: the exact same 3 strategies + common evaluator the real arena uses. The
  // winner is whichever proposal ACTUALLY scores best -- never assumed to be RangeKeeper. ---
  const proposals = await Promise.all([rangeKeeperStrategy(job, snapshot), baselineHoldStrategy(job, snapshot), baselineSymmetricRangeStrategy(job, snapshot)]);
  const evaluationResult = evaluate(job, snapshot, proposals);
  const winner = evaluationResult.winner;

  const roundId = nextRoundId(arenaRoundsDir);

  // --- PLAN ---
  run = transition(run, "PLAN");
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
  const plan = planExecution({ job, proposal: winner.proposal, currentPosition, recipient: opts.ownerWallet });
  const planningBlock = await opts.client.getBlockNumber();

  // --- SIMULATE ---
  run = transition(run, "SIMULATE");
  const sim = await simulateLive({ client: opts.client, plan, currentSqrtPriceX96: observation.sqrtPriceX96, tickSpacing: snapshot.tickSpacing, account: opts.ownerWallet });
  const simulationBlock = await opts.client.getBlockNumber();

  // Write the arena round record now that plan+simulation exist -- kept schema-compatible with
  // runLiveArenaEvaluation.ts's output (same executionPlan/simulation fields) so
  // renderArenaPage.ts works against a round produced by EITHER path.
  const roundRecordContent = {
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: opts.ownerWallet,
    positionTokenId: opts.positionTokenId.toString(),
    observedAtBlock: observation.blockNumber.toString(),
    observed: bigintsToStrings({ ...observation }),
    marketSnapshot: { ...(bigintsToStrings(snapshot) as Record<string, unknown>), recentVolatilityBpsProvenance: "SUPPLIED_NOT_OBSERVED" },
    job: bigintsToStrings(job),
    proposals: evaluationResult.scored.map((s) => ({ ...(bigintsToStrings(s.proposal) as Record<string, unknown>), metrics: bigintsToStrings(s.metrics), score: s.score, isWinner: s.isWinner })),
    winnerCandidateId: winner.proposal.candidateId,
    executionPlan: bigintsToStrings(plan),
    simulation: bigintsToStrings(sim),
    generatedAt: new Date().toISOString(),
  };
  const roundArtifactHash = sha256(JSON.stringify(roundRecordContent));
  const fullRoundRecord = { roundId, artifactHash: roundArtifactHash, ...roundRecordContent };
  writeFileSync(resolve(arenaRoundsDir, `round-${String(roundId).padStart(4, "0")}.json`), JSON.stringify(fullRoundRecord, null, 2));
  writeFileSync(resolve(opts.docsDir, "veyra-live-evaluation.json"), JSON.stringify(fullRoundRecord, null, 2));

  const policy = opts.policy ?? DEFAULT_EXECUTION_POLICY;
  let executionStartBlock: bigint | null = null;
  let authorization: ReturnType<typeof authorizeExecution> | null = null;

  if (plan.targetRange === null) {
    // The real arena's winner was hold. Not a failure -- the honest, expected outcome when
    // nothing scores better than doing nothing. No policy check applies -- authorizeExecution
    // itself always refuses a hold action trivially, so there is nothing to gate here.
    run = transition(run, "HOLD");
  } else {
    // The ONLY things this authorization check may ever look at: the winner's ACTION
    // ("rebalance"), the simulation's verdict, verified on-chain ownership, gas-vs-cap, and
    // observation freshness. It never sees which candidate proposed it -- see
    // executionPolicy.ts's own structural test for why that's guaranteed, not just asserted.
    const [ownerOfPosition, freshBlock] = await Promise.all([
      opts.client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "ownerOf", args: [opts.positionTokenId] }),
      opts.client.getBlockNumber(),
    ]);
    executionStartBlock = freshBlock;
    const ownershipVerified = ownerOfPosition.toLowerCase() === opts.ownerWallet.toLowerCase();

    authorization = authorizeExecution({
      policy,
      winnerAction: "rebalance",
      simulationExecutable: sim.executable,
      ownershipVerified,
      observationBlock: observation.blockNumber,
      currentBlock: freshBlock,
      estimatedGasWei: plan.estimatedGasWei,
    });
    const blockTrace: BlockTrace = {
      observationBlock: observation.blockNumber.toString(),
      planningBlock: planningBlock.toString(),
      simulationBlock: simulationBlock.toString(),
      executionStartBlock: executionStartBlock.toString(),
    };
    verificationDetail = { authorization, blockTrace };

    if (!authorization.authorized) {
      run = transition(run, "EXECUTION_BLOCKED", authorization.reasons.join("; "));
      return archiveAndReturn();
    }

    // --- Real execution path: DECREASE -> VERIFY -> COLLECT -> VERIFY -> MINT -> VERIFY ---
    const signer = createSigner(opts.client, opts.wallet, chainId);
    const [baselineBalance0, baselineBalance1] = await Promise.all([
      opts.client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [opts.ownerWallet] }),
      opts.client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [opts.ownerWallet] }),
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

      const postDecrease = await opts.client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "positions", args: [opts.positionTokenId] });
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
        opts.client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [opts.ownerWallet] }),
        opts.client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [opts.ownerWallet] }),
      ]);
      // The hard invariant from Slice 3's incident: DELTA against a baseline, never an
      // absolute balance. See accounting.ts.
      const { collectedAmount0, collectedAmount1 } = computeCollectedAmounts({ baselineBalance0, baselineBalance1, postCollectBalance0, postCollectBalance1 });

      if (collectedAmount0 > 0n) {
        const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, collectedAmount0] });
        txRecords.push(await signer.sendAndWait("approve-token0", observation.token0, approveData));
      }
      if (collectedAmount1 > 0n) {
        const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, collectedAmount1] });
        txRecords.push(await signer.sendAndWait("approve-token1", observation.token1, approveData));
      }

      run = transition(run, "MINT_PENDING");
      const maxSlippageBps = job.constraints.maxSlippageBps;
      const amount0Min = (collectedAmount0 * BigInt(10_000 - maxSlippageBps)) / 10_000n;
      const amount1Min = (collectedAmount1 * BigInt(10_000 - maxSlippageBps)) / 10_000n;
      const deadline = Math.floor(Date.now() / 1000) + job.constraints.deadlineSeconds;
      const mintArgs = {
        token0: observation.token0,
        token1: observation.token1,
        fee: observation.fee,
        tickLower: plan.targetRange.tickLower,
        tickUpper: plan.targetRange.tickUpper,
        amount0Desired: collectedAmount0,
        amount1Desired: collectedAmount1,
        amount0Min,
        amount1Min,
        recipient: opts.ownerWallet,
        deadline: BigInt(deadline),
      };
      const mintData = encodeFunctionData({ abi: NFPM_ABI, functionName: "mint", args: [mintArgs] });
      const mintTxRecord = await signer.sendAndWait("mint", NFPM_ADDRESS, mintData);
      txRecords.push(mintTxRecord);

      run = transition(run, "VERIFYING");
      const mintReceipt = await opts.client.getTransactionReceipt({ hash: mintTxRecord.hash });
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

      const newPositionObservation = await readPositionObservation(opts.client, newTokenId);
      const newOwner = await opts.client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "ownerOf", args: [newTokenId] });
      const verified =
        newOwner.toLowerCase() === opts.ownerWallet.toLowerCase() &&
        newPositionObservation.tickLower === plan.targetRange.tickLower &&
        newPositionObservation.tickUpper === plan.targetRange.tickUpper &&
        newPositionObservation.fee === observation.fee &&
        newPositionObservation.token0.toLowerCase() === observation.token0.toLowerCase() &&
        newPositionObservation.token1.toLowerCase() === observation.token1.toLowerCase() &&
        newPositionObservation.positionLiquidity > 0n;

      newPositionTokenId = newTokenId.toString();
      verificationDetail = {
        ...verificationDetail,
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
        MINT_PENDING: "MINT_FAILED",
        VERIFYING: "VERIFICATION_FAILED",
      };
      const failState = failureFor[run.currentState] ?? "MINT_FAILED";
      run = transition(run, failState, reason);
    }
  }

  // --- ARCHIVE: always, regardless of outcome ---
  return archiveAndReturn();

  function archiveAndReturn(): AgentArenaLoopResult {
    const finalState = run.currentState; // the meaningful outcome (HOLD / EXECUTED / *_FAILED / EXECUTION_BLOCKED), captured BEFORE the bookkeeping ARCHIVED transition below
    const runArchiveId = nextRunArchiveId(runsDir);
    const contentRecord = {
      runArchiveId,
      runId,
      roundId,
      veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
      ownerWallet: opts.ownerWallet,
      winnerCandidateId: winner.proposal.candidateId,
      winningProposal: winner.proposal,
      plan: bigintsToStrings(plan),
      simulation: bigintsToStrings(sim),
      policy: bigintsToStrings(policy),
      finalState,
      isFailure: isFailure(finalState),
      transactions: txRecords,
      ...verificationDetail,
      generatedAt: new Date().toISOString(),
    };
    run = transition(run, "ARCHIVED");
    const record = { ...contentRecord, transitions: run.transitions };
    const artifactHash = sha256(JSON.stringify(record));
    const outPath = resolve(runsDir, `run-${String(runArchiveId).padStart(4, "0")}.json`);
    writeFileSync(outPath, JSON.stringify({ ...record, artifactHash }, null, 2));

    return { run, roundId, runArchiveId, winnerCandidateId: winner.proposal.candidateId, newPositionTokenId, outPath };
  }
}

// Grid Trading's real agent loop (four-category expansion). Mirrors orchestrator.ts's shape
// (OBSERVE -> EVALUATE -> PLAN -> SIMULATE -> authorize -> execute -> archive) but reads N
// positions instead of one, and executes each adjusted slot via executeRebalanceForPosition --
// the SAME proven decrease/collect/swap/mint/verify sequence orchestrator.ts uses, run once per
// slot. A deliberate near-duplicate of orchestrator.ts's overall structure, not a shared generic
// shell -- see this project's own plan notes on why (evaluatorV2.ts is a direct precedent for
// this exact tradeoff).

import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PublicClient, Address } from "viem";
import {
  evaluateGrid,
  gridKeeperStrategy,
  baselineHoldGridStrategy,
  planGridExecution,
  createRun,
  transition,
  isFailure,
  authorizeExecution,
  DEFAULT_EXECUTION_POLICY,
  VEYRA_AGENT_ID_ON_CHAIN,
  type GridTradingJobSpec,
  type ExecutionPolicy,
  type SlotOnChainState,
} from "@veyra/core";
import { readGridObservation, toGridMarketSnapshot } from "./gridPositionReader.js";
import { simulateGridPlanLive } from "./simulateGrid.js";
import { executeRebalanceForPosition } from "./rebalanceExecutor.js";
import { createSigner, type SigningWallet, type TxRecord } from "./txSigner.js";
import { NFPM_ABI } from "./abis.js";
import { PANCAKE_V3_TESTNET } from "./testnetAddresses.js";
import { bigintsToStrings, sha256, nextArchiveId } from "./archiveUtils.js";

const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;

export interface RunGridOrchestratorLoopOpts {
  client: PublicClient;
  wallet: SigningWallet;
  gridPositionTokenIds: bigint[];
  ownerWallet: Address;
  docsDir: string;
  chainId?: number;
  policy?: ExecutionPolicy;
}

export interface GridSlotOutcome {
  slotIndex: number;
  positionTokenId: number;
  finalState: string;
  newPositionTokenId: string | null;
  transactions: TxRecord[];
}

export interface GridOrchestratorLoopResult {
  runId: string;
  roundId: number;
  runArchiveId: number;
  winnerCandidateId: string;
  slotOutcomes: GridSlotOutcome[];
  outPath: string;
}

export async function runGridOrchestratorLoop(opts: RunGridOrchestratorLoopOpts): Promise<GridOrchestratorLoopResult> {
  const chainId = opts.chainId ?? 97;
  const gridRoundsDir = resolve(opts.docsDir, "grid-rounds");
  const gridRunsDir = resolve(opts.docsDir, "grid-runs");
  const runId = randomUUID();

  // --- OBSERVE ---
  const slotObservations = await readGridObservation(opts.client, opts.gridPositionTokenIds);
  const gridSnapshot = toGridMarketSnapshot(slotObservations, { recentVolatilityBps: 0 });
  const poolSqrtPriceX96 = slotObservations[0]!.observation.sqrtPriceX96; // one pool -- every slot shares this price
  const tickSpacing = gridSnapshot.slots[0]!.tickSpacing;

  const job: GridTradingJobSpec = {
    jobId: `grid-loop-${runId}`,
    createdAt: new Date().toISOString(),
    ownerWallet: opts.ownerWallet,
    category: "grid-trading",
    target: {
      protocol: "pancakeswap-v3",
      network: "bsc-testnet",
      poolAddress: gridSnapshot.poolAddress,
      gridPositionTokenIds: opts.gridPositionTokenIds.map(Number),
    },
    constraints: {
      maxSpendWei: 10_000_000_000_000_000n * BigInt(opts.gridPositionTokenIds.length),
      maxSlippageBps: 100,
      riskTolerance: "medium",
      deadlineSeconds: 600,
    },
    budget: { currency: "U", amountWei: 0n },
    status: "evaluating",
    erc8183JobId: null,
  };

  // --- EVALUATE ---
  const proposals = await Promise.all([gridKeeperStrategy(job, gridSnapshot), baselineHoldGridStrategy(job, gridSnapshot)]);
  const evaluationResult = evaluateGrid(job, gridSnapshot, proposals);
  const winner = evaluationResult.winner;

  const roundId = nextArchiveId(gridRoundsDir, "round");

  // --- PLAN ---
  const slotStates = new Map<number, SlotOnChainState>();
  if (winner.proposal.proposedAction.kind === "grid-rebalance") {
    for (const adjustment of winner.proposal.proposedAction.slotAdjustments) {
      const slotObs = slotObservations.find((s) => s.slotIndex === adjustment.slotIndex)!.observation;
      slotStates.set(adjustment.slotIndex, {
        currentPosition: {
          tokenId: Number(slotObs.positionTokenId),
          token0: slotObs.token0,
          token1: slotObs.token1,
          fee: slotObs.fee,
          tickLower: slotObs.tickLower,
          tickUpper: slotObs.tickUpper,
          liquidity: slotObs.positionLiquidity,
          sqrtPriceX96: slotObs.sqrtPriceX96,
        },
        recipient: opts.ownerWallet,
      });
    }
  }
  const gridPlan = planGridExecution({
    jobId: job.jobId,
    candidateId: winner.proposal.candidateId,
    proposal: winner.proposal,
    slotStates,
    maxSlippageBps: job.constraints.maxSlippageBps,
    deadlineSeconds: job.constraints.deadlineSeconds,
  });

  // --- SIMULATE ---
  // LIVE, not pure-only: a real QuoterV2 quote is what actually clears a ratio-fixing-swap
  // requirement (see simulateGrid.ts's header comment for why the pure-only layer alone would
  // permanently block any slot that needs one).
  const gridSim = await simulateGridPlanLive({ client: opts.client, plan: gridPlan, currentSqrtPriceX96: poolSqrtPriceX96, tickSpacing, account: opts.ownerWallet });

  const roundRecordContent = {
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: opts.ownerWallet,
    gridPositionTokenIds: opts.gridPositionTokenIds.map(String),
    observed: bigintsToStrings(slotObservations),
    gridSnapshot: bigintsToStrings(gridSnapshot),
    job: bigintsToStrings(job),
    proposals: evaluationResult.scored.map((s) => ({ ...(bigintsToStrings(s.proposal) as Record<string, unknown>), metrics: bigintsToStrings(s.metrics), score: s.score, isWinner: s.isWinner })),
    winnerCandidateId: winner.proposal.candidateId,
    executionPlan: bigintsToStrings(gridPlan),
    simulation: bigintsToStrings(gridSim),
    generatedAt: new Date().toISOString(),
  };
  const roundArtifactHash = sha256(JSON.stringify(roundRecordContent));
  mkdirSync(gridRoundsDir, { recursive: true });
  writeFileSync(resolve(gridRoundsDir, `round-${String(roundId).padStart(4, "0")}.json`), JSON.stringify({ roundId, artifactHash: roundArtifactHash, ...roundRecordContent }, null, 2));

  const policy = opts.policy ?? DEFAULT_EXECUTION_POLICY;
  const slotOutcomes: GridSlotOutcome[] = [];
  let authorization: ReturnType<typeof authorizeExecution> | null = null;

  if (winner.proposal.proposedAction.kind !== "grid-rebalance" || gridPlan.slotPlans.length === 0) {
    // Hold -- the honest, expected outcome when no slot has drifted enough to fix. Same as
    // orchestrator.ts: authorizeExecution always refuses a hold trivially, nothing to gate.
  } else {
    const [ownerships, freshBlock] = await Promise.all([
      Promise.all(
        gridPlan.slotPlans.map((sp) => opts.client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "ownerOf", args: [BigInt(sp.positionTokenId)] })),
      ),
      opts.client.getBlockNumber(),
    ]);
    const ownershipVerified = ownerships.every((o) => o.toLowerCase() === opts.ownerWallet.toLowerCase());
    const oldestObservationBlock = slotObservations.reduce((min, s) => (s.observation.blockNumber < min ? s.observation.blockNumber : min), slotObservations[0]!.observation.blockNumber);

    authorization = authorizeExecution({
      policy,
      winnerAction: "grid-rebalance",
      simulationExecutable: gridSim.executable,
      ownershipVerified,
      observationBlock: oldestObservationBlock,
      currentBlock: freshBlock,
      estimatedGasWei: gridPlan.estimatedGasWei,
    });

    if (authorization.authorized) {
      const signer = createSigner(opts.client, opts.wallet, chainId);
      // Executed sequentially, not in parallel -- each slot's execution shares the same signer
      // (and thus the same nonce sequence); running them concurrently would race.
      for (const slotPlan of gridPlan.slotPlans) {
        // Stop at SIMULATE -- executeRebalanceForPosition performs the DECREASE_PENDING
        // transition itself as its own first step (it did the same thing inline inside
        // orchestrator.ts before extraction). Transitioning here too double-transitions into the
        // same state, which the state machine correctly rejects.
        let run = createRun(`${runId}-slot-${slotPlan.slotIndex}`);
        run = transition(run, "EVALUATE");
        run = transition(run, "PLAN");
        run = transition(run, "SIMULATE");

        const slotObs = slotObservations.find((s) => s.slotIndex === slotPlan.slotIndex)!.observation;
        const execResult = await executeRebalanceForPosition({
          client: opts.client,
          signer,
          job,
          plan: slotPlan.plan,
          positionTokenId: BigInt(slotPlan.positionTokenId),
          observation: slotObs,
          ownerWallet: opts.ownerWallet,
          run,
        });

        slotOutcomes.push({
          slotIndex: slotPlan.slotIndex,
          positionTokenId: slotPlan.positionTokenId,
          finalState: execResult.run.currentState,
          newPositionTokenId: execResult.newPositionTokenId?.toString() ?? null,
          transactions: execResult.txRecords,
        });
      }
    }
  }

  const runArchiveId = nextArchiveId(gridRunsDir, "run");
  const anyFailure = slotOutcomes.some((o) => isFailure(o.finalState as Parameters<typeof isFailure>[0]));
  const contentRecord = {
    runArchiveId,
    runId,
    roundId,
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: opts.ownerWallet,
    winnerCandidateId: winner.proposal.candidateId,
    winningProposal: winner.proposal,
    plan: bigintsToStrings(gridPlan),
    simulation: bigintsToStrings(gridSim),
    policy: bigintsToStrings(policy),
    authorization: authorization ? bigintsToStrings(authorization) : null,
    slotOutcomes,
    isFailure: anyFailure,
    generatedAt: new Date().toISOString(),
  };
  const artifactHash = sha256(JSON.stringify(contentRecord));
  const outPath = resolve(gridRunsDir, `run-${String(runArchiveId).padStart(4, "0")}.json`);
  mkdirSync(gridRunsDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...contentRecord, artifactHash }, null, 2));

  return { runId, roundId, runArchiveId, winnerCandidateId: winner.proposal.candidateId, slotOutcomes, outPath };
}

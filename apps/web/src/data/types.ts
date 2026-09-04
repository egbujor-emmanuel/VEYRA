// Types for the ARCHIVED JSON records under docs/arena-rounds-v2/ and docs/agent-arena-runs-v2/.
// Deliberately NOT reusing @veyra/core's bigint-typed domain types here: JSON.parse gives
// strings for every bigint field (see e.g. round-0007.json's "positionLiquidity": "..."), so
// typing these as `string` is what the data actually is after parsing, not an approximation.
// Verified directly against real files (docs/arena-rounds-v2/round-0007.json,
// docs/agent-arena-runs-v2/run-0004.json, run-0004-resumed-mint.json) before writing this file.

export type CandidateLabel = "Our Agent" | "Baseline Strategy" | "Reference Strategy";

export interface ProposedAction {
  kind: "rebalance" | "hold";
  newRange?: { tickLower: number; tickUpper: number };
}

export interface ArchivedProposal {
  candidateId: string;
  displayLabel: CandidateLabel;
  agentIdOnChain: number | null;
  proposedAction: ProposedAction;
  rationale: string;
  metrics?: {
    estimatedGasWei: string;
    estimatedFeeEfficiency: number;
    estimatedSlippageBps: number;
    riskScore: number;
    executionFeasible: boolean;
    widthEfficiency?: number;
    positioningScore?: number;
  };
  score?: {
    weights: { feeEfficiency: number; risk: number; gas: number; feasibility: number };
    normalized: { feeEfficiency: number; risk: number; gas: number; feasibility: number };
    totalScore: number;
  };
  isWinner: boolean;
}

export interface ArchivedObserved {
  positionTokenId: string;
  blockNumber: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  positionLiquidity: string;
  token0Decimals: number;
  token1Decimals: number;
  poolAddress: string;
  sqrtPriceX96: string;
  currentTick: number;
  poolLiquidity: string;
}

export interface ArchivedMarketSnapshot {
  currentTick: number;
  currentRange: { tickLower: number; tickUpper: number };
  currentLiquidity: string;
  tickSpacing: number;
  recentVolatilityBps: number;
  recentVolatilityBpsProvenance: "SUPPLIED_NOT_OBSERVED";
}

export interface ArchivedStepCheck {
  status: string;
  detail: string;
}

export interface ArchivedRatioAdjustment extends ArchivedStepCheck {
  strandedAmount0: string;
  strandedAmount1: string;
  strandedFraction0: number;
  strandedFraction1: number;
  ratioFixRequired: boolean;
}

export interface ArchivedSimulation {
  action: "HOLD" | "REBALANCE";
  oldRange: { tickLower: number; tickUpper: number } | null;
  targetRange: { tickLower: number; tickUpper: number } | null;
  targetRangeValidity: ArchivedStepCheck;
  mintStructuralValidity: ArchivedStepCheck;
  ratioAdjustment: ArchivedRatioAdjustment;
  slippageProtection: ArchivedStepCheck;
  pureExecutable: boolean;
  pureExecutableReasons: string[];
  decreaseLiquidityLive?: ArchivedStepCheck & { gasEstimateWei?: string };
  collectLive?: ArchivedStepCheck & { gasEstimateWei?: string };
  ratioFixLive?: ArchivedStepCheck & { realQuoteAmountOut?: string; realQuoteGasEstimateWei?: string };
  mintLive?: ArchivedStepCheck;
  liveGasEstimateWei?: string | null;
  executable: boolean;
  executableReasons: string[];
}

export interface ArchivedExecutionPlan {
  targetRange: { tickLower: number; tickUpper: number } | null;
  liquidityToMigrate: string;
  expectedAmounts: { amount0: string; amount1: string };
  steps: Array<{ kind: string; description: string; [k: string]: unknown }>;
  estimatedGasWei: string;
  feasible: boolean;
  feasibilityReasons: string[];
  status: "EXECUTION_NOT_SENT";
}

/** docs/arena-rounds-v2/round-NNNN.json */
export interface ArenaRound {
  roundId: number;
  artifactHash: string;
  evaluatorPolicy: "v1" | "v2-market-aware";
  veyraAgentId: number;
  ownerWallet: string;
  positionTokenId: string;
  observedAtBlock: string;
  observed: ArchivedObserved;
  marketSnapshot: ArchivedMarketSnapshot;
  proposals: ArchivedProposal[];
  winnerCandidateId: string;
  executionPlan: ArchivedExecutionPlan;
  simulation: ArchivedSimulation;
  generatedAt: string;
}

export interface TxRecord {
  step: string;
  hash: string;
  gasUsed: string;
  gasPriceWei: string;
  status: "success" | "reverted";
  blockNumber: string;
}

export interface RunTransition {
  from: string;
  to: string;
  timestamp: string;
  reason?: string;
}

/** docs/agent-arena-runs-v2/run-NNNN.json (the "primary" record shape) */
export interface AgentArenaRun {
  runArchiveId: number;
  runId: string;
  roundId: number;
  veyraAgentId: number;
  ownerWallet: string;
  winnerCandidateId: string;
  winningProposal: ArchivedProposal;
  plan: ArchivedExecutionPlan;
  simulation: ArchivedSimulation;
  policy: Record<string, unknown>;
  finalState: string; // "HOLD" | "EXECUTED" | "EXECUTION_BLOCKED" | "*_FAILED" | ...
  isFailure: boolean;
  transactions: TxRecord[];
  authorization?: { authorized: boolean; reasons: string[]; observationAgeBlocks: string | null };
  blockTrace?: Record<string, string>;
  generatedAt: string;
  transitions: RunTransition[];
  artifactHash: string;
}

/** docs/agent-arena-runs-v2/run-NNNN-resumed-mint.json (a DIFFERENT shape — an amendment record) */
export interface ResumedMintAmendment {
  artifactHash: string;
  kind: "AGENT_ARENA_LOOP_RESUMED_MINT";
  label: string;
  generatedAt: string;
  predecessorRunArchiveId: number;
  predecessorArtifactHash: string;
  rootCause: string;
  veyraAgentId: number;
  ownerWallet: string;
  winningProposal: ArchivedProposal;
  correctiveSwaps: Array<{
    attempt: number;
    swapRequirement: Record<string, unknown>;
    quote: Record<string, unknown>;
    amountOutMinimum: string;
    approveTx: TxRecord;
    swapTx: TxRecord;
    postSwapMintAmount0: string;
    postSwapMintAmount1: string;
    postSwapStrandedFraction0: number;
    postSwapStrandedFraction1: number;
  }>;
  finalStrandedFractionBeforeMint: { token0: number; token1: number };
  mintArgs: Record<string, unknown>;
  reusedFromPredecessor: Record<string, TxRecord>;
  mintTx: TxRecord;
  oldPosition: { tokenId: string };
  newPosition: {
    tokenId: string;
    positionTokenId: string;
    blockNumber: string;
    token0: string;
    token1: string;
    fee: number;
    tickLower: number;
    tickUpper: number;
    positionLiquidity: string;
    token0Decimals: number;
    token1Decimals: number;
    poolAddress: string;
    sqrtPriceX96: string;
    currentTick: number;
    poolLiquidity: string;
  };
  verified: boolean;
  status: "EXECUTED";
}

/** One row of the build-time-generated track-record manifest (see scripts/generateArchiveManifest.ts). */
export interface ManifestEntry {
  runArchiveId: number;
  roundId: number;
  sourceFile: string;
  winnerCandidateId: string;
  agentIdOnChain: number | null;
  /** The run's own finalState, UNCHANGED even when an amendment exists (the failure is preserved, not erased). */
  finalState: string;
  isFailure: boolean;
  /** finalState, unless an amendment record supersedes it (see effectiveExecuted below) -- this is what "executed" is actually counted from. */
  effectiveOutcome: string;
  effectiveExecuted: boolean;
  amendment: { sourceFile: string; newPositionTokenId: string } | null;
  /** Transactions the run broadcast, counting an amendment's. Zero for a blocked run -- that is the point. */
  transactionCount: number;
  /** Total gas used across those transactions, as a decimal string. */
  gasUsed: string;
  generatedAt: string | null;
}

/** Per-round outcome, so Arena History can show what happened without opening each round. */
export interface ArenaRoundSummary {
  roundId: number;
  winnerCandidateId: string | null;
  winnerAction: string | null;
  winnerScore: number | null;
  wonByOurAgent: boolean;
  candidateCount: number;
  /** The best-scoring candidate that did not win, so the margin is visible on the row. */
  runnerUpCandidateId: string | null;
  runnerUpScore: number | null;
  /** True when the winner tied the runner-up on BOTH score and gas -- list order decided it, not merit. */
  decidedByOrdering: boolean;
  /** The block whose state every candidate was handed -- distinct per round, and checkable. */
  observedAtBlock: string | null;
  generatedAt: string | null;
}

export interface ArchiveManifest {
  generatedAt: string;
  totalRuns: number;
  executedJobs: number;
  executionBlockedJobs: number;
  otherOutcomeJobs: number;
  wonByOurAgent: number;
  entries: ManifestEntry[];
  latestRoundId: number;
  arenaRoundIds: number[];
  arenaRounds: ArenaRoundSummary[];
  categories: CategorySummary[];
}

/** Per-category totals, computed from that category's own archives (see generateArchiveManifest.ts). */
export interface CategorySummary {
  category: string;
  roundCount: number;
  runCount: number;
  executedRunCount: number;
  recommendMigrateOrRepayCount: number;
  holdCount: number;
  transactionCount: number;
  totalGasUsed: string;
  lastActionAt: string | null;
  /** Runs whose failure is preserved in the record rather than deleted. */
  preservedFailureCount: number;
}

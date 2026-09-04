// Domain types for the VEYRA Core loop: Job -> Strategies -> Evaluation -> (Execution -> Track Record).
// Mirrors docs/AGENT_ARENA_ARCHITECTURE.md sections 1-4. Keep this file in sync with that document;
// it is the source of truth for *why* each field/rule exists.

export type RiskTolerance = "low" | "medium" | "high";

export type JobStatus =
  | "open"
  | "evaluating"
  | "awarded"
  | "executing"
  | "completed"
  | "failed"
  | "expired";

// Fields common to every category -- the only fields the shared kernel (evaluatorKernel.ts,
// executionPolicy.ts) is allowed to touch, so adding a category can never require changing them.
interface JobSpecBase {
  jobId: string;
  createdAt: string; // ISO timestamp
  ownerWallet: string;
  constraints: {
    maxSpendWei: bigint;
    maxSlippageBps: number;
    riskTolerance: RiskTolerance;
    deadlineSeconds: number;
  };
  budget: {
    currency: "U";
    amountWei: bigint;
  };
  status: JobStatus;
  erc8183JobId: string | null; // always null in MVP; reserved for the deferred on-chain-escrow path
}

export interface RebalanceJobSpec extends JobSpecBase {
  category: "rebalance";
  target: {
    protocol: "pancakeswap-v3";
    network: "bsc-testnet";
    positionTokenId: number;
  };
}

export interface GridTradingJobSpec extends JobSpecBase {
  category: "grid-trading";
  target: {
    protocol: "pancakeswap-v3";
    network: "bsc-testnet";
    poolAddress: `0x${string}`;
    gridPositionTokenIds: number[];
  };
}

export interface YieldOptimisationJobSpec extends JobSpecBase {
  category: "yield-optimisation";
  target: {
    protocol: "pancakeswap-v3";
    network: "bsc-testnet";
    candidatePools: { poolAddress: `0x${string}`; label: string }[];
  };
}

export interface HealthFactorJobSpec extends JobSpecBase {
  category: "health-factor-monitoring";
  target: {
    protocol: "venus";
    network: "bsc-testnet";
    account: `0x${string}`;
  };
}

export type JobSpec = RebalanceJobSpec | GridTradingJobSpec | YieldOptimisationJobSpec | HealthFactorJobSpec;

// ---- Market snapshot: SOURCE reads + shared DERIVED data, computed ONCE per job and
// handed identically to every candidate. All candidates see exactly the same market. ----

export interface MarketSnapshot {
  // SOURCE -- read verbatim from chain, never computed
  currentTick: number;
  currentRange: { tickLower: number; tickUpper: number };
  currentLiquidity: bigint;
  tickSpacing: number;
  // DERIVED, but shared/uncontroversial -- a market observation, not specific to any one proposal
  recentVolatilityBps: number; // short polling-window observation; label in UI as "recent, not historical"
}

// ---- Candidate / Strategy interface (architecture doc section 2) ----

export type CandidateLabel = "Our Agent" | "Baseline Strategy" | "Reference Strategy";

export interface RebalanceAction {
  kind: "rebalance";
  newRange: { tickLower: number; tickUpper: number };
}

export interface HoldAction {
  kind: "hold";
}

// Grid Trading: adjust one or more grid slots (each slot is its own narrow-range V3 position).
export interface GridRebalanceAction {
  kind: "grid-rebalance";
  slotAdjustments: Array<{ slotIndex: number; newRange: { tickLower: number; tickUpper: number } }>;
}

// Yield Optimisation and Health Factor Monitoring terminate at a recommendation in this scope --
// see docs/AGENT_ARENA_ARCHITECTURE.md and the category orchestrators for why execution is
// deliberately out of scope, not an oversight.
export interface YieldRecommendMigrateAction {
  kind: "recommend-migrate";
  fromPool: `0x${string}`;
  toPool: `0x${string}`;
  /**
   * Percentage difference in cumulative (all-time) fee-growth-per-liquidity between the two
   * pools -- deliberately NOT an APR. An annualized rate needs a time-normalized delta (two
   * readings, a known elapsed period); this is a single-snapshot, cumulative-since-inception
   * comparison. See yieldSnapshot.ts's own doc comment for the full rationale.
   */
  cumulativeFeeGrowthDeltaBps: number;
}

export interface HealthFactorRecommendAction {
  kind: "recommend-repay" | "recommend-add-collateral";
  suggestedAmountWei: bigint;
}

export type ProposedAction =
  | RebalanceAction
  | HoldAction
  | GridRebalanceAction
  | YieldRecommendMigrateAction
  | HealthFactorRecommendAction;

export interface StrategyProposal {
  candidateId: string;
  displayLabel: CandidateLabel;
  agentIdOnChain: number | null; // populated only for "Our Agent"
  proposedAction: ProposedAction;
  rationale: string; // an LLM may write this sentence; it must never originate a number used in scoring
}

export type StrategyFn = (job: JobSpec, snapshot: MarketSnapshot) => Promise<StrategyProposal>;

// ---- Evaluation / scoring (architecture doc section 3) ----
// The evaluator, not the strategy, computes every metric below -- uniformly, from the same
// formulas, for every proposal. A strategy never grades its own action.

export interface ProposalMetrics {
  estimatedGasWei: bigint;
  estimatedFeeEfficiency: number; // 0-100, deterministic formula over the proposed range -- not a historical backtest
  estimatedSlippageBps: number;
  riskScore: number; // 0-100, higher = riskier (narrower range / larger IL exposure)
  executionFeasible: boolean; // false if the proposal violates job.constraints
}

export interface ScoreBreakdown {
  weights: { feeEfficiency: number; risk: number; gas: number; feasibility: number };
  normalized: { feeEfficiency: number; risk: number; gas: number; feasibility: number };
  totalScore: number;
}

export interface ScoredProposal {
  proposal: StrategyProposal;
  metrics: ProposalMetrics;
  score: ScoreBreakdown;
  isWinner: boolean;
  /**
   * Set only on the winner, and only when the win was a tie broken by list order: the candidates
   * listed here matched it on BOTH total score and gas. Present so a tied outcome is never
   * reported as if the winner had scored higher.
   */
  wonByTiebreak?: string[];
}

export interface EvaluationResult {
  jobId: string;
  snapshot: MarketSnapshot;
  scored: ScoredProposal[]; // same order as input proposals
  winner: ScoredProposal;
}

// ---- Track record (architecture doc section 4) ----
// Keyed to agentIdOnChain only -- baselines structurally cannot have a row here.
export interface TrackRecord {
  agentIdOnChain: number;
  jobsWon: number;
  jobsCompleted: number;
  jobsFailed: number;
  avgScoreWhenWon: number;
  totalCapitalManagedWei: bigint;
  lastUpdatedAt: string;
}

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

export interface JobSpec {
  jobId: string;
  createdAt: string; // ISO timestamp
  ownerWallet: string;
  category: "rebalance"; // only value in MVP; other categories slot in later without a schema change
  target: {
    protocol: "pancakeswap-v3";
    network: "bsc-testnet";
    positionTokenId: number;
  };
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

export type ProposedAction = RebalanceAction | HoldAction;

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

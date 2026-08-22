// Execution planner (architecture doc §6): converts an already-selected WINNING
// StrategyProposal into a concrete, ordered sequence of PancakeSwap V3 NonfungiblePositionManager
// operations. Pure function -- no signer, no RPC call, no transaction is ever sent from here.
// status is always the literal "EXECUTION_NOT_SENT"; nothing in this module can change that.
//
// Scope, stated once: MVP always fully exits the current position before re-minting (recon
// §8: PancakeSwap's own docs say rebalancing is NOT atomic -- decrease -> collect -> mint is a
// composed, multi-tx sequence, not one call). The amounts re-minted are exactly what decreasing
// the current position yields (computed via the real Uniswap V3 liquidity/amount formula in
// tickMath.ts) -- this deliberately does NOT include a ratio-fixing swap leg to match whatever
// the new range's price-implied ratio "should" be. That swap leg is the same gap the evaluator
// already flags (architecture doc §3's estimatedSlippageBps note) and remains deferred.

import { getAmountsForLiquidity } from "./tickMath.js";
import type { JobSpec, StrategyProposal } from "./types.js";
import { PLACEHOLDER_REBALANCE_GAS_WEI } from "./evaluator.js";

export type ExecutionStepKind = "decreaseLiquidity" | "collect" | "mint";

export interface DecreaseLiquidityStep {
  kind: "decreaseLiquidity";
  description: string;
  tokenId: number;
  liquidity: bigint; // MVP always removes the position's FULL current liquidity
  amount0Min: bigint; // slippage floor -- derived from job.constraints.maxSlippageBps, never 0 by default
  amount1Min: bigint;
  deadline: number; // unix seconds
  estimatedGasWei: bigint;
}

export interface CollectStep {
  kind: "collect";
  description: string;
  tokenId: number;
  recipient: string;
  amount0Max: bigint; // standard V3 "collect everything owed" sentinel: 2**128 - 1
  amount1Max: bigint;
  estimatedGasWei: bigint;
}

export interface MintStep {
  kind: "mint";
  description: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: string;
  deadline: number;
  estimatedGasWei: bigint;
}

export type ExecutionStep = DecreaseLiquidityStep | CollectStep | MintStep;

export interface ExecutionPlan {
  jobId: string;
  candidateId: string; // which winning proposal this plan implements
  positionTokenId: number;
  network: "bsc-testnet";
  currentRange: { tickLower: number; tickUpper: number };
  targetRange: { tickLower: number; tickUpper: number } | null; // null when the winner was "hold" -- nothing to do
  liquidityToMigrate: bigint; // 0n for a hold plan
  expectedAmounts: { amount0: bigint; amount1: bigint }; // DERIVED via the real V3 liquidity formula, from OBSERVED current state -- not a projection of future value
  steps: ExecutionStep[]; // empty for a hold plan
  estimatedGasWei: bigint; // sum of per-step placeholders -- see PLACEHOLDER_REBALANCE_GAS_WEI; not a live eth_estimateGas result yet
  feasible: boolean;
  feasibilityReasons: string[];
  status: "EXECUTION_NOT_SENT";
}

/** The current, chain-observed state of the position this plan operates on. */
export interface CurrentPositionState {
  tokenId: number;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  sqrtPriceX96: bigint; // current pool price -- needed to convert liquidity -> token amounts
}

export interface PlanExecutionOpts {
  job: JobSpec;
  proposal: StrategyProposal; // the WINNING proposal -- selecting the winner is the evaluator's job, not this function's
  currentPosition: CurrentPositionState;
  recipient: string; // wallet that will own the resulting position (and receives collected tokens)
}

const MAX_UINT128 = (1n << 128n) - 1n;

function applySlippageFloor(amount: bigint, maxSlippageBps: number): bigint {
  // floor = amount * (1 - slippageBps/10000). Deliberately never defaults to 0 -- recon §8
  // explicitly warns a zero minimum is an open invitation to sandwich bots.
  return (amount * BigInt(10_000 - maxSlippageBps)) / 10_000n;
}

export function planExecution(opts: PlanExecutionOpts): ExecutionPlan {
  const { job, proposal, currentPosition, recipient } = opts;
  const currentRange = { tickLower: currentPosition.tickLower, tickUpper: currentPosition.tickUpper };
  const deadline = Math.floor(Date.now() / 1000) + job.constraints.deadlineSeconds;

  if (proposal.proposedAction.kind === "hold") {
    return {
      jobId: job.jobId,
      candidateId: proposal.candidateId,
      positionTokenId: currentPosition.tokenId,
      network: "bsc-testnet",
      currentRange,
      targetRange: null,
      liquidityToMigrate: 0n,
      expectedAmounts: { amount0: 0n, amount1: 0n },
      steps: [],
      estimatedGasWei: 0n,
      feasible: true,
      feasibilityReasons: [],
      status: "EXECUTION_NOT_SENT",
    };
  }

  const targetRange = proposal.proposedAction.newRange;

  // DERIVED from OBSERVED state via the real V3 liquidity<->amount formula -- what fully
  // decreasing the CURRENT position actually yields. Not amount projected for the NEW range.
  const expectedAmounts = getAmountsForLiquidity(
    currentPosition.sqrtPriceX96,
    currentPosition.tickLower,
    currentPosition.tickUpper,
    currentPosition.liquidity,
  );

  const perStepGasWei = PLACEHOLDER_REBALANCE_GAS_WEI / 3n;

  const decreaseStep: DecreaseLiquidityStep = {
    kind: "decreaseLiquidity",
    description: `Remove all ${currentPosition.liquidity} liquidity from position #${currentPosition.tokenId} (range [${currentRange.tickLower}, ${currentRange.tickUpper}))`,
    tokenId: currentPosition.tokenId,
    liquidity: currentPosition.liquidity,
    amount0Min: applySlippageFloor(expectedAmounts.amount0, job.constraints.maxSlippageBps),
    amount1Min: applySlippageFloor(expectedAmounts.amount1, job.constraints.maxSlippageBps),
    deadline,
    estimatedGasWei: perStepGasWei,
  };

  const collectStep: CollectStep = {
    kind: "collect",
    description: `Collect all owed token0/token1 (principal + fees) from position #${currentPosition.tokenId} to ${recipient}`,
    tokenId: currentPosition.tokenId,
    recipient,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
    estimatedGasWei: perStepGasWei,
  };

  const mintStep: MintStep = {
    kind: "mint",
    description: `Mint a new position on [${targetRange.tickLower}, ${targetRange.tickUpper}) using the collected amounts`,
    token0: currentPosition.token0,
    token1: currentPosition.token1,
    fee: currentPosition.fee,
    tickLower: targetRange.tickLower,
    tickUpper: targetRange.tickUpper,
    // MVP simplification, stated once here: redeploys exactly what decreasing the OLD position
    // yields. No ratio-fixing swap leg -- the new range's price-implied ratio may differ from
    // what's held. See this file's module doc comment and architecture doc §3.
    amount0Desired: expectedAmounts.amount0,
    amount1Desired: expectedAmounts.amount1,
    amount0Min: applySlippageFloor(expectedAmounts.amount0, job.constraints.maxSlippageBps),
    amount1Min: applySlippageFloor(expectedAmounts.amount1, job.constraints.maxSlippageBps),
    recipient,
    deadline,
    estimatedGasWei: perStepGasWei,
  };

  const steps: ExecutionStep[] = [decreaseStep, collectStep, mintStep];
  const estimatedGasWei = steps.reduce((sum, s) => sum + s.estimatedGasWei, 0n);

  const feasibilityReasons: string[] = [];
  if (estimatedGasWei > job.constraints.maxSpendWei) {
    feasibilityReasons.push(
      `estimated gas ${estimatedGasWei} wei exceeds job.constraints.maxSpendWei ${job.constraints.maxSpendWei} wei`,
    );
  }
  if (targetRange.tickLower >= targetRange.tickUpper) {
    feasibilityReasons.push(`target range is invalid: tickLower ${targetRange.tickLower} >= tickUpper ${targetRange.tickUpper}`);
  }

  return {
    jobId: job.jobId,
    candidateId: proposal.candidateId,
    positionTokenId: currentPosition.tokenId,
    network: "bsc-testnet",
    currentRange,
    targetRange,
    liquidityToMigrate: currentPosition.liquidity,
    expectedAmounts,
    steps,
    estimatedGasWei,
    feasible: feasibilityReasons.length === 0,
    feasibilityReasons,
    status: "EXECUTION_NOT_SENT",
  };
}

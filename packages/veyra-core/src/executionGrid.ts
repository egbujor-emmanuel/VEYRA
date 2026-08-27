// Grid Trading execution planning. A grid slot rebalance IS a rebalance -- just against a
// different position than VEYRA's main one -- so this reuses execution.ts's `planExecution`
// unmodified, once per slot being adjusted, rather than reimplementing decrease/collect/mint
// planning a second time.

import { planExecution, type ExecutionPlan, type CurrentPositionState } from "./execution.js";
import type { RebalanceJobSpec, StrategyProposal } from "./types.js";

export interface GridSlotPlan {
  slotIndex: number;
  positionTokenId: number;
  plan: ExecutionPlan;
}

export interface GridExecutionPlan {
  jobId: string;
  candidateId: string;
  slotPlans: GridSlotPlan[]; // one entry per slot actually being adjusted -- empty for a hold winner
  estimatedGasWei: bigint;
  feasible: boolean;
  feasibilityReasons: string[];
}

export interface SlotOnChainState {
  currentPosition: CurrentPositionState;
  recipient: string;
}

export interface PlanGridExecutionOpts {
  jobId: string;
  candidateId: string;
  proposal: StrategyProposal; // the WINNING proposal -- "grid-rebalance" or "hold"
  /** Current on-chain state for every slot that IS being adjusted (keyed by slotIndex). */
  slotStates: Map<number, SlotOnChainState>;
  maxSlippageBps: number;
  deadlineSeconds: number;
}

export function planGridExecution(opts: PlanGridExecutionOpts): GridExecutionPlan {
  const { jobId, candidateId, proposal } = opts;

  if (proposal.proposedAction.kind !== "grid-rebalance") {
    return { jobId, candidateId, slotPlans: [], estimatedGasWei: 0n, feasible: true, feasibilityReasons: [] };
  }

  const slotPlans: GridSlotPlan[] = proposal.proposedAction.slotAdjustments.map(({ slotIndex, newRange }) => {
    const slotState = opts.slotStates.get(slotIndex);
    if (!slotState) {
      throw new Error(`planGridExecution: no on-chain position state supplied for grid slot ${slotIndex}`);
    }

    const subJob: RebalanceJobSpec = {
      jobId,
      createdAt: new Date().toISOString(),
      ownerWallet: slotState.recipient,
      category: "rebalance",
      target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: slotState.currentPosition.tokenId },
      constraints: {
        maxSpendWei: 10_000_000_000_000_000n,
        maxSlippageBps: opts.maxSlippageBps,
        riskTolerance: "medium",
        deadlineSeconds: opts.deadlineSeconds,
      },
      budget: { currency: "U", amountWei: 0n },
      status: "executing",
      erc8183JobId: null,
    };
    const subProposal: StrategyProposal = {
      candidateId,
      displayLabel: proposal.displayLabel,
      agentIdOnChain: proposal.agentIdOnChain,
      proposedAction: { kind: "rebalance", newRange },
      rationale: proposal.rationale,
    };

    const plan = planExecution({ job: subJob, proposal: subProposal, currentPosition: slotState.currentPosition, recipient: slotState.recipient });
    return { slotIndex, positionTokenId: slotState.currentPosition.tokenId, plan };
  });

  const estimatedGasWei = slotPlans.reduce((sum, sp) => sum + sp.plan.estimatedGasWei, 0n);
  const feasibilityReasons = slotPlans.flatMap((sp) => sp.plan.feasibilityReasons);

  return { jobId, candidateId, slotPlans, estimatedGasWei, feasible: feasibilityReasons.length === 0, feasibilityReasons };
}

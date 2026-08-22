import type { StrategyFn, StrategyProposal } from "../types.js";

// A legitimate, honest comparison point: always proposes doing nothing. Sometimes this SHOULD
// win -- that proves the evaluator isn't rigged in favor of "Our Agent".
export const baselineHoldStrategy: StrategyFn = async (): Promise<StrategyProposal> => {
  return {
    candidateId: "baseline-hold",
    displayLabel: "Baseline Strategy",
    agentIdOnChain: null,
    proposedAction: { kind: "hold" },
    rationale: "Keeps the current range unchanged; no rebalance proposed.",
  };
};

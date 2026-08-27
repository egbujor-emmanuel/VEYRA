import type { HealthFactorStrategyFn } from "../healthFactorSnapshot.js";
import { VEYRA_AGENT_ID_ON_CHAIN } from "./rangeKeeper.js";

// Deliberately simple, conservative threshold -- a policy choice, not a derived constant, same
// discipline as executionPolicy.ts's own gates. 60% borrow-to-capacity is well short of Venus's
// own shortfall point; the point is to recommend action with real margin left to act on it.
const WARNING_THRESHOLD_PCT = 60;

export const healthFactorMonitorStrategy: HealthFactorStrategyFn = async (_job, snapshot) => {
  const { observation, solvencyStatus, borrowToCapacityRatio } = snapshot;

  if (solvencyStatus === "NO_BORROW_POSITION") {
    return {
      candidateId: "health-factor-monitor-v1",
      displayLabel: "Our Agent",
      agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
      proposedAction: { kind: "hold" },
      rationale: "No outstanding borrow position on Venus -- nothing to monitor for liquidation risk.",
    };
  }

  if (solvencyStatus === "SHORTFALL" || borrowToCapacityRatio >= WARNING_THRESHOLD_PCT) {
    return {
      candidateId: "health-factor-monitor-v1",
      displayLabel: "Our Agent",
      agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
      proposedAction: { kind: "recommend-repay", suggestedAmountWei: observation.borrowedPrincipalUnderlyingUnits },
      rationale:
        solvencyStatus === "SHORTFALL"
          ? `Account is in real shortfall (Venus's own solvency check: ${observation.shortfallUsd1e18.toString()} USD-1e18 deficit) -- recommending an immediate repay. Not executed automatically.`
          : `Borrow-to-capacity ratio (${borrowToCapacityRatio.toFixed(1)}%) exceeds the ${WARNING_THRESHOLD_PCT}% warning threshold -- recommending a repay before real liquidation risk develops. Not executed automatically.`,
    };
  }

  return {
    candidateId: "health-factor-monitor-v1",
    displayLabel: "Our Agent",
    agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
    proposedAction: { kind: "hold" },
    rationale: `Borrow-to-capacity ratio (${borrowToCapacityRatio.toFixed(1)}%) is within the ${WARNING_THRESHOLD_PCT}% warning threshold -- position is healthy, no action recommended.`,
  };
};

/** Baseline candidate: never recommends action, regardless of solvency data. */
export const baselineHoldHealthFactorStrategy: HealthFactorStrategyFn = async () => ({
  candidateId: "baseline-hold-health-factor",
  displayLabel: "Baseline Strategy",
  agentIdOnChain: null,
  proposedAction: { kind: "hold" },
  rationale: "Baseline: never recommends action, regardless of solvency data.",
});

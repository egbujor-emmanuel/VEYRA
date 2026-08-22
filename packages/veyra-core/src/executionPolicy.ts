// Execution policy (Slice 5): the explicit boundary between "the agent recommends this" and
// "the system is authorized to execute this." The evaluator decides what looks best; this
// module decides, independently, whether acting on that recommendation is currently permitted.
// Nothing here inspects WHICH candidate won -- only whether its action is "rebalance", and
// whether that rebalance clears every configured gate. A candidate's identity/name never
// appears in this file's logic, by design (see the orchestrator's own comment on the same rule).

export interface ExecutionPolicy {
  enabled: boolean;
  maxSpendWei: bigint;
  maxSlippageBps: number;
  requireSimulationPass: boolean;
  requireVerifiedOwnership: boolean;
  requireFreshObservation: boolean;
  /** Only consulted when requireFreshObservation is true. A policy choice, not a derived constant. */
  maxObservationAgeBlocks: number;
  requirePostTxVerification: boolean;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  enabled: true,
  maxSpendWei: 10_000_000_000_000_000n,
  maxSlippageBps: 100,
  requireSimulationPass: true,
  requireVerifiedOwnership: true,
  requireFreshObservation: true,
  maxObservationAgeBlocks: 50, // ~a few minutes at BSC's ~3s block time -- conservative default, not derived from anything
  requirePostTxVerification: true,
};

export interface ExecutionAuthorizationInputs {
  policy: ExecutionPolicy;
  /** What the evaluator's winner actually proposes -- "hold" is never authorized, trivially. */
  winnerAction: "hold" | "rebalance";
  simulationExecutable: boolean;
  ownershipVerified: boolean;
  /** The block OBSERVE read state at. */
  observationBlock: bigint;
  /** The block read immediately before authorizing -- i.e. right at execution-start time. */
  currentBlock: bigint;
  /** The plan's own estimated cost, checked against policy.maxSpendWei independently of whatever the plan itself already decided. */
  estimatedGasWei: bigint;
}

export interface ExecutionAuthorizationResult {
  authorized: boolean;
  reasons: string[];
  observationAgeBlocks: bigint | null;
}

/**
 * Pure decision function: given everything already computed by OBSERVE/EVALUATE/PLAN/SIMULATE,
 * says whether execution is authorized right now. Collects EVERY failing reason, not just the
 * first, so a rejected run's archive record explains itself completely.
 */
export function authorizeExecution(inputs: ExecutionAuthorizationInputs): ExecutionAuthorizationResult {
  const reasons: string[] = [];

  if (inputs.winnerAction === "hold") {
    return { authorized: false, reasons: ["winner action is hold -- nothing to authorize"], observationAgeBlocks: null };
  }

  if (!inputs.policy.enabled) {
    reasons.push("execution policy is disabled");
  }
  if (inputs.policy.requireSimulationPass && !inputs.simulationExecutable) {
    reasons.push("simulation.executable is false");
  }
  if (inputs.policy.requireVerifiedOwnership && !inputs.ownershipVerified) {
    reasons.push("wallet ownership of the position could not be verified");
  }
  if (inputs.estimatedGasWei > inputs.policy.maxSpendWei) {
    reasons.push(`estimated gas ${inputs.estimatedGasWei} wei exceeds policy.maxSpendWei ${inputs.policy.maxSpendWei} wei`);
  }

  let observationAgeBlocks: bigint | null = null;
  if (inputs.policy.requireFreshObservation) {
    const age = inputs.currentBlock - inputs.observationBlock;
    observationAgeBlocks = age;
    if (age < 0n) {
      reasons.push(`observation block ${inputs.observationBlock} is AHEAD of current block ${inputs.currentBlock} -- refusing`);
    } else if (age > BigInt(inputs.policy.maxObservationAgeBlocks)) {
      reasons.push(`observation is stale: ${age} block(s) old, exceeds policy.maxObservationAgeBlocks (${inputs.policy.maxObservationAgeBlocks})`);
    }
  }

  return { authorized: reasons.length === 0, reasons, observationAgeBlocks };
}

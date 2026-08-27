import { cumulativeFeeGrowthScore, type YieldStrategyFn } from "../yieldSnapshot.js";
import { VEYRA_AGENT_ID_ON_CHAIN } from "./rangeKeeper.js";

export const yieldOptimiserStrategy: YieldStrategyFn = async (_job, snapshot) => {
  const current = snapshot.pools.find((p) => p.poolAddress.toLowerCase() === snapshot.currentPoolAddress.toLowerCase());
  if (!current) throw new Error("yieldOptimiserStrategy: current pool not found in snapshot.pools");

  const currentScore = cumulativeFeeGrowthScore(current);
  const alternatives = snapshot.pools.filter((p) => p.poolAddress.toLowerCase() !== snapshot.currentPoolAddress.toLowerCase());

  let best: typeof current | null = null;
  let bestScore = currentScore;
  for (const pool of alternatives) {
    const score = cumulativeFeeGrowthScore(pool);
    if (score > bestScore) {
      best = pool;
      bestScore = score;
    }
  }

  if (!best) {
    return {
      candidateId: "yield-optimiser-v1",
      displayLabel: "Our Agent",
      agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
      proposedAction: { kind: "hold" },
      rationale: `No candidate pool's cumulative fee-growth score exceeds the current pool (${current.label}, fee ${current.fee}); staying.`,
    };
  }

  // currentScore of 0 (a genuinely brand-new pool) can't express a percentage delta -- report 0
  // rather than a divide-by-zero or an invented number.
  const cumulativeFeeGrowthDeltaBps = currentScore === 0n ? 0 : Number(((bestScore - currentScore) * 10_000n) / currentScore);

  return {
    candidateId: "yield-optimiser-v1",
    displayLabel: "Our Agent",
    agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
    proposedAction: { kind: "recommend-migrate", fromPool: current.poolAddress, toPool: best.poolAddress, cumulativeFeeGrowthDeltaBps },
    rationale: `${best.label} (fee ${best.fee}) shows a higher cumulative fee-growth score than the current pool (${current.label}, fee ${current.fee}) -- recommending evaluation of a migration. Not executed automatically.`,
  };
};

/** Baseline candidate: never recommends migrating -- mirrors baselineHoldStrategy's role for rebalancing. */
export const baselineHoldYieldStrategy: YieldStrategyFn = async () => ({
  candidateId: "baseline-hold-yield",
  displayLabel: "Baseline Strategy",
  agentIdOnChain: null,
  proposedAction: { kind: "hold" },
  rationale: "Baseline: never recommends migrating, regardless of market conditions.",
});

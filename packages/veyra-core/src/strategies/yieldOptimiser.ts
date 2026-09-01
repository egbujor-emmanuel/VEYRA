import { cumulativeFeeGrowthScore, type YieldStrategyFn } from "../yieldSnapshot.js";
import { VEYRA_AGENT_ID_ON_CHAIN } from "./rangeKeeper.js";

/**
 * A candidate must hold at least this fraction of the current pool's liquidity, in basis points,
 * before its fee-growth score is allowed to win.
 *
 * Why this gate exists. feeGrowthGlobal is fees PER UNIT OF LIQUIDITY, so a nearly-empty pool
 * posts a spectacular score off trivial volume -- and is simultaneously the worst place to put
 * capital, because it cannot absorb a trade. This is not hypothetical: while seeding the testnet
 * candidate pool (docs/yield-runs/run-0001.json), single 300-VUSD swaps repeatedly drove its
 * price to MIN_TICK (-887272). Scoring on fee growth alone would happily recommend migrating into
 * exactly that. 25% is a policy choice, deliberately conservative, in the same spirit as the 60%
 * threshold in healthFactorMonitor.ts -- not a derived constant.
 */
const MIN_RELATIVE_LIQUIDITY_BPS = 2_500n;

export const yieldOptimiserStrategy: YieldStrategyFn = async (_job, snapshot) => {
  const current = snapshot.pools.find((p) => p.poolAddress.toLowerCase() === snapshot.currentPoolAddress.toLowerCase());
  if (!current) throw new Error("yieldOptimiserStrategy: current pool not found in snapshot.pools");

  const currentScore = cumulativeFeeGrowthScore(current);
  const alternatives = snapshot.pools.filter((p) => p.poolAddress.toLowerCase() !== snapshot.currentPoolAddress.toLowerCase());

  let best: typeof current | null = null;
  let bestScore = currentScore;
  const rejectedForDepth: string[] = [];
  for (const pool of alternatives) {
    const score = cumulativeFeeGrowthScore(pool);
    if (score <= bestScore) continue;

    // Depth gate: a higher score earned on negligible liquidity is not an opportunity.
    const requiredLiquidity = (current.currentLiquidity * MIN_RELATIVE_LIQUIDITY_BPS) / 10_000n;
    if (pool.currentLiquidity < requiredLiquidity) {
      rejectedForDepth.push(
        `${pool.label} (liquidity ${pool.currentLiquidity} < ${requiredLiquidity} required)`,
      );
      continue;
    }

    best = pool;
    bestScore = score;
  }

  if (!best) {
    return {
      candidateId: "yield-optimiser-v1",
      displayLabel: "Our Agent",
      agentIdOnChain: VEYRA_AGENT_ID_ON_CHAIN,
      proposedAction: { kind: "hold" },
      rationale:
        rejectedForDepth.length > 0
          ? `A candidate out-scored the current pool (${current.label}, fee ${current.fee}) on cumulative fee growth, but was rejected for insufficient liquidity depth: ${rejectedForDepth.join("; ")}. Fee growth is measured per unit of liquidity, so a nearly-empty pool posts a high score while being unable to absorb a trade; staying.`
          : `No candidate pool's cumulative fee-growth score exceeds the current pool (${current.label}, fee ${current.fee}); staying.`,
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

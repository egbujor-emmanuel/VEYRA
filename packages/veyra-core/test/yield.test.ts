import { test } from "node:test";
import assert from "node:assert/strict";
import {
  yieldOptimiserStrategy,
  baselineHoldYieldStrategy,
  computeMetricsYield,
  evaluateYield,
  cumulativeFeeGrowthScore,
  type YieldMarketSnapshot,
  type YieldOptimisationJobSpec,
} from "../src/index.js";

const POOL_A = "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as const; // current pool (0.25%)
const POOL_B = "0x8523c332b034b6D7586116b7739D0048fF1B7888" as const; // candidate pool (0.05%)

function yieldJob(overrides: Partial<YieldOptimisationJobSpec> = {}): YieldOptimisationJobSpec {
  return {
    jobId: "yield-job-1",
    createdAt: new Date().toISOString(),
    ownerWallet: "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11",
    category: "yield-optimisation",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", candidatePools: [{ poolAddress: POOL_A, label: "0.25% pool" }, { poolAddress: POOL_B, label: "0.05% pool" }] },
    constraints: { maxSpendWei: 0n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 0n },
    status: "open",
    erc8183JobId: null,
    ...overrides,
  };
}

// ---------- cumulativeFeeGrowthScore ----------

test("cumulativeFeeGrowthScore sums both tokens' fee growth", () => {
  const score = cumulativeFeeGrowthScore({ poolAddress: POOL_A, label: "a", fee: 2500, currentLiquidity: 100n, feeGrowthGlobal0X128: 10n, feeGrowthGlobal1X128: 20n });
  assert.equal(score, 30n);
});

// ---------- yieldOptimiserStrategy ----------

test("yieldOptimiserStrategy: a fresh, zero-history candidate pool never beats a current pool with real accumulated fee growth -- holds", async () => {
  const snapshot: YieldMarketSnapshot = {
    currentPoolAddress: POOL_A,
    pools: [
      { poolAddress: POOL_A, label: "0.25% pool", fee: 2500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 500n, feeGrowthGlobal1X128: 500n },
      { poolAddress: POOL_B, label: "0.05% pool", fee: 500, currentLiquidity: 0n, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n },
    ],
  };
  const proposal = await yieldOptimiserStrategy(yieldJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

test("yieldOptimiserStrategy: a candidate pool with genuinely higher cumulative fee-growth triggers a recommend-migrate", async () => {
  const snapshot: YieldMarketSnapshot = {
    currentPoolAddress: POOL_A,
    pools: [
      { poolAddress: POOL_A, label: "0.25% pool", fee: 2500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 100n, feeGrowthGlobal1X128: 100n },
      { poolAddress: POOL_B, label: "0.05% pool", fee: 500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 1000n, feeGrowthGlobal1X128: 1000n },
    ],
  };
  const proposal = await yieldOptimiserStrategy(yieldJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "recommend-migrate");
  if (proposal.proposedAction.kind === "recommend-migrate") {
    assert.equal(proposal.proposedAction.toPool, POOL_B);
    assert.equal(proposal.proposedAction.fromPool, POOL_A);
    assert.ok(proposal.proposedAction.cumulativeFeeGrowthDeltaBps > 0);
  }
});

test("yieldOptimiserStrategy: never claims an APR -- the recommend-migrate rationale never uses the word 'APR'", async () => {
  const snapshot: YieldMarketSnapshot = {
    currentPoolAddress: POOL_A,
    pools: [
      { poolAddress: POOL_A, label: "0.25% pool", fee: 2500, currentLiquidity: 1n, feeGrowthGlobal0X128: 1n, feeGrowthGlobal1X128: 1n },
      { poolAddress: POOL_B, label: "0.05% pool", fee: 500, currentLiquidity: 1n, feeGrowthGlobal0X128: 100n, feeGrowthGlobal1X128: 100n },
    ],
  };
  const proposal = await yieldOptimiserStrategy(yieldJob(), snapshot);
  assert.ok(!proposal.rationale.toLowerCase().includes("apr"));
});

test("baselineHoldYieldStrategy: always holds regardless of input", async () => {
  const snapshot: YieldMarketSnapshot = { currentPoolAddress: POOL_A, pools: [{ poolAddress: POOL_A, label: "a", fee: 2500, currentLiquidity: 0n, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 999999n }] };
  const proposal = await baselineHoldYieldStrategy(yieldJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

// ---------- computeMetricsYield / evaluateYield ----------

test("computeMetricsYield: estimatedGasWei is always zero -- this category never executes", () => {
  const snapshot: YieldMarketSnapshot = { currentPoolAddress: POOL_A, pools: [{ poolAddress: POOL_A, label: "a", fee: 2500, currentLiquidity: 1n, feeGrowthGlobal0X128: 10n, feeGrowthGlobal1X128: 10n }] };
  const proposal = { candidateId: "x", displayLabel: "Our Agent" as const, agentIdOnChain: null, proposedAction: { kind: "hold" as const }, rationale: "" };
  const metrics = computeMetricsYield(yieldJob(), snapshot, proposal);
  assert.equal(metrics.estimatedGasWei, 0n);
  assert.equal(metrics.executionFeasible, true);
});

test("computeMetricsYield: throws with an explicit message if the recommended pool isn't in the snapshot", () => {
  const snapshot: YieldMarketSnapshot = { currentPoolAddress: POOL_A, pools: [{ poolAddress: POOL_A, label: "a", fee: 2500, currentLiquidity: 1n, feeGrowthGlobal0X128: 10n, feeGrowthGlobal1X128: 10n }] };
  const proposal = { candidateId: "x", displayLabel: "Our Agent" as const, agentIdOnChain: null, proposedAction: { kind: "recommend-migrate" as const, fromPool: POOL_A, toPool: "0x000000000000000000000000000000000000dEaD" as const, cumulativeFeeGrowthDeltaBps: 0 }, rationale: "" };
  assert.throws(() => computeMetricsYield(yieldJob(), snapshot, proposal), /not found in snapshot/);
});

test("evaluateYield: exactly one winner, real-data yieldOptimiser beats baseline hold when there's a genuinely better pool", async () => {
  const snapshot: YieldMarketSnapshot = {
    currentPoolAddress: POOL_A,
    pools: [
      { poolAddress: POOL_A, label: "0.25% pool", fee: 2500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 100n, feeGrowthGlobal1X128: 100n },
      { poolAddress: POOL_B, label: "0.05% pool", fee: 500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 5000n, feeGrowthGlobal1X128: 5000n },
    ],
  };
  const job = yieldJob();
  const [ours, baseline] = await Promise.all([yieldOptimiserStrategy(job, snapshot), baselineHoldYieldStrategy(job, snapshot)]);
  const result = evaluateYield(job, snapshot, [ours, baseline]);
  assert.equal(result.scored.filter((s) => s.isWinner).length, 1);
  assert.equal(result.winner.proposal.candidateId, "yield-optimiser-v1");
});

// ---------- liquidity-depth gate ----------
// Regression tests for a real defect found during the first live migration
// (docs/yield-runs/run-0001.json): feeGrowthGlobal is fees PER UNIT OF LIQUIDITY, so a nearly
// empty pool posts a spectacular score off trivial volume while being the worst possible place
// to put capital. On testnet, single 300-VUSD swaps drove exactly such a pool to MIN_TICK.

test("yieldOptimiserStrategy: a thin pool does NOT win on fee growth alone -- depth gate holds it back", async () => {
  const snapshot: YieldMarketSnapshot = {
    currentPoolAddress: POOL_A,
    pools: [
      { poolAddress: POOL_A, label: "0.25% pool", fee: 2500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 100n, feeGrowthGlobal1X128: 100n },
      // Score is 10x the current pool's, but it holds 1% of the liquidity -- under the 25% floor.
      { poolAddress: POOL_B, label: "0.05% pool", fee: 500, currentLiquidity: 10_000n, feeGrowthGlobal0X128: 1000n, feeGrowthGlobal1X128: 1000n },
    ],
  };
  const proposal = await yieldOptimiserStrategy(yieldJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
  assert.match(proposal.rationale, /liquidity depth/i);
});

test("yieldOptimiserStrategy: the depth gate explains itself rather than silently holding", async () => {
  const snapshot: YieldMarketSnapshot = {
    currentPoolAddress: POOL_A,
    pools: [
      { poolAddress: POOL_A, label: "0.25% pool", fee: 2500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 100n, feeGrowthGlobal1X128: 100n },
      { poolAddress: POOL_B, label: "thin pool", fee: 500, currentLiquidity: 1n, feeGrowthGlobal0X128: 9_000n, feeGrowthGlobal1X128: 9_000n },
    ],
  };
  const proposal = await yieldOptimiserStrategy(yieldJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
  // The operator must be able to tell "nothing better exists" apart from "something scored
  // better but was too thin to trust" -- these are very different situations.
  assert.match(proposal.rationale, /thin pool/);
});

test("yieldOptimiserStrategy: a deep candidate at exactly the 25% floor still wins", async () => {
  const snapshot: YieldMarketSnapshot = {
    currentPoolAddress: POOL_A,
    pools: [
      { poolAddress: POOL_A, label: "0.25% pool", fee: 2500, currentLiquidity: 1_000_000n, feeGrowthGlobal0X128: 100n, feeGrowthGlobal1X128: 100n },
      { poolAddress: POOL_B, label: "0.05% pool", fee: 500, currentLiquidity: 250_000n, feeGrowthGlobal0X128: 1000n, feeGrowthGlobal1X128: 1000n },
    ],
  };
  const proposal = await yieldOptimiserStrategy(yieldJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "recommend-migrate");
});

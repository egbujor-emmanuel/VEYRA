import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  rangeKeeperStrategy,
  baselineHoldStrategy,
  baselineSymmetricRangeStrategy,
  VEYRA_AGENT_ID_ON_CHAIN,
  type JobSpec,
  type RebalanceJobSpec,
  type MarketSnapshot,
} from "../src/index.js";

function mockJob(overrides: Partial<RebalanceJobSpec> = {}): JobSpec {
  return {
    jobId: "job-1",
    createdAt: new Date().toISOString(),
    ownerWallet: "0x0000000000000000000000000000000000dEaD",
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: 1 },
    constraints: {
      maxSpendWei: 10_000_000_000_000_000n, // 0.01 BNB-equivalent -- comfortably above the placeholder gas estimate
      maxSlippageBps: 100,
      riskTolerance: "medium",
      deadlineSeconds: 600,
    },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "open",
    erc8183JobId: null,
    ...overrides,
  };
}

function mockSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    currentTick: 1000,
    currentRange: { tickLower: 400, tickUpper: 1600 }, // width 1200 = 24 * tickSpacing(50) -- a wide, stale range
    currentLiquidity: 1_000_000_000n,
    tickSpacing: 50,
    recentVolatilityBps: 200,
    ...overrides,
  };
}

async function runAllStrategies(job: JobSpec, snapshot: MarketSnapshot) {
  return Promise.all([
    rangeKeeperStrategy(job, snapshot),
    baselineHoldStrategy(job, snapshot),
    baselineSymmetricRangeStrategy(job, snapshot),
  ]);
}

test("all three candidates produce proposals with correct labels", async () => {
  const job = mockJob();
  const snapshot = mockSnapshot();
  const proposals = await runAllStrategies(job, snapshot);

  assert.equal(proposals[0].displayLabel, "Our Agent");
  assert.equal(proposals[0].agentIdOnChain, VEYRA_AGENT_ID_ON_CHAIN); // registered on-chain -- see rangeKeeper.ts
  assert.equal(proposals[1].displayLabel, "Baseline Strategy");
  assert.equal(proposals[1].agentIdOnChain, null);
  assert.equal(proposals[2].displayLabel, "Baseline Strategy");
  assert.equal(proposals[2].agentIdOnChain, null);

  assert.equal(proposals[1].proposedAction.kind, "hold");
  assert.equal(proposals[0].proposedAction.kind, "rebalance");
  assert.equal(proposals[2].proposedAction.kind, "rebalance");
});

test("evaluator picks exactly one winner and every score is well-formed", async () => {
  const job = mockJob();
  const snapshot = mockSnapshot();
  const proposals = await runAllStrategies(job, snapshot);
  const result = evaluate(job, snapshot, proposals);

  const winners = result.scored.filter((s) => s.isWinner);
  assert.equal(winners.length, 1);
  assert.equal(result.winner.proposal.candidateId, winners[0]!.proposal.candidateId);

  for (const scored of result.scored) {
    const w = scored.score.weights;
    const weightSum = w.feeEfficiency + w.risk + w.gas + w.feasibility;
    assert.ok(Math.abs(weightSum - 1) < 1e-9, "weights must sum to 1");

    for (const v of Object.values(scored.score.normalized)) {
      assert.ok(v >= 0 && v <= 100, `normalized component out of [0,100]: ${v}`);
    }
    assert.ok(scored.score.totalScore >= 0 && scored.score.totalScore <= 100);
  }
});

test("a narrower proposed range scores higher on fee efficiency and lower on risk than a wider one", async () => {
  const job = mockJob();
  const snapshot = mockSnapshot();
  const proposals = await runAllStrategies(job, snapshot);
  const result = evaluate(job, snapshot, proposals);

  const rangeKeeper = result.scored.find((s) => s.proposal.candidateId === "rangekeeper-v1")!;
  const wideBaseline = result.scored.find((s) => s.proposal.candidateId === "baseline-symmetric-range")!;

  // rangeKeeper widens for volatility (200bps here), so its range should be wider than the
  // fixed-width baseline in this scenario -- meaning it scores WORSE on fee efficiency and
  // BETTER on the (inverted) risk axis. Assert the actual relationship, not a fixed winner.
  assert.ok(rangeKeeper.metrics.estimatedFeeEfficiency <= wideBaseline.metrics.estimatedFeeEfficiency);
  assert.ok(rangeKeeper.metrics.riskScore <= wideBaseline.metrics.riskScore);
});

test("low risk tolerance shifts weights toward risk avoidance, per the one documented rule", async () => {
  const snapshot = mockSnapshot();
  const mediumJob = mockJob({ constraints: { ...mockJob().constraints, riskTolerance: "medium" } });
  const lowRiskJob = mockJob({ constraints: { ...mockJob().constraints, riskTolerance: "low" } });

  const proposals = await runAllStrategies(mediumJob, snapshot);
  const mediumResult = evaluate(mediumJob, snapshot, proposals);
  const lowRiskResult = evaluate(lowRiskJob, snapshot, proposals);

  assert.deepEqual(mediumResult.scored[0]!.score.weights, {
    feeEfficiency: 0.25,
    risk: 0.25,
    gas: 0.25,
    feasibility: 0.25,
  });
  assert.deepEqual(lowRiskResult.scored[0]!.score.weights, {
    feeEfficiency: 0.1,
    risk: 0.4,
    gas: 0.25,
    feasibility: 0.25,
  });
});

test("a proposal whose gas exceeds maxSpendWei is marked infeasible and cannot win", async () => {
  const snapshot = mockSnapshot();
  const tinyBudgetJob = mockJob({
    constraints: { ...mockJob().constraints, maxSpendWei: 1n }, // smaller than the placeholder rebalance gas estimate
  });
  const proposals = await runAllStrategies(tinyBudgetJob, snapshot);
  const result = evaluate(tinyBudgetJob, snapshot, proposals);

  const rebalanceProposals = result.scored.filter((s) => s.proposal.proposedAction.kind === "rebalance");
  for (const s of rebalanceProposals) {
    assert.equal(s.metrics.executionFeasible, false);
    assert.equal(s.score.normalized.feasibility, 0);
  }
  // hold is always feasible (zero gas), so it must win when nothing else can execute
  assert.equal(result.winner.proposal.proposedAction.kind, "hold");
});

test("holding is scored against the current (unchanged) range, not penalized as a null action", async () => {
  const job = mockJob();
  const snapshot = mockSnapshot();
  const proposals = await runAllStrategies(job, snapshot);
  const result = evaluate(job, snapshot, proposals);

  const hold = result.scored.find((s) => s.proposal.candidateId === "baseline-hold")!;
  assert.equal(hold.metrics.estimatedGasWei, 0n);
  assert.equal(hold.metrics.executionFeasible, true);
  assert.ok(hold.metrics.estimatedFeeEfficiency > 0);
});

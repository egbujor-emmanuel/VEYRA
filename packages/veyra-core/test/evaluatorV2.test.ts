import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  evaluateV2,
  positioningScore,
  rangeKeeperStrategy,
  baselineHoldStrategy,
  baselineSymmetricRangeStrategy,
  type JobSpec,
  type MarketSnapshot,
  type StrategyProposal,
} from "../src/index.js";

function job(overrides: Partial<JobSpec["constraints"]> = {}): JobSpec {
  return {
    jobId: "job-v2-test",
    createdAt: new Date().toISOString(),
    ownerWallet: "0x0000000000000000000000000000000000dEaD",
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: 37059 },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600, ...overrides },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "evaluating",
    erc8183JobId: null,
  };
}

// Real position #37059's range (docs/agent-arena-runs/*.json).
const CURRENT_RANGE = { tickLower: -58050, tickUpper: -56050 };

function snapshotAt(currentTick: number): MarketSnapshot {
  return { currentTick, currentRange: CURRENT_RANGE, currentLiquidity: 7_039_210_414_078_688_290n, tickSpacing: 50, recentVolatilityBps: 0 };
}

async function runAllStrategies(j: JobSpec, snapshot: MarketSnapshot) {
  return Promise.all([rangeKeeperStrategy(j, snapshot), baselineHoldStrategy(j, snapshot), baselineSymmetricRangeStrategy(j, snapshot)]);
}

// ---- positioningScore() pure unit tests ----

test("positioningScore: exact center of the range is 100", () => {
  assert.equal(positioningScore(-100, 100, 0), 100);
});

test("positioningScore: exactly at the lower edge is 0", () => {
  assert.equal(positioningScore(-100, 100, -100), 0);
});

test("positioningScore: at or past the upper edge is 0 (half-open range convention)", () => {
  assert.equal(positioningScore(-100, 100, 100), 0);
  assert.equal(positioningScore(-100, 100, 150), 0);
});

test("positioningScore: below the lower edge is 0", () => {
  assert.equal(positioningScore(-100, 100, -500), 0);
});

test("positioningScore: exactly halfway between center and edge is 50", () => {
  assert.equal(positioningScore(-100, 100, -50), 50); // halfway from center(0) to lower edge(-100)
  assert.equal(positioningScore(-100, 100, 50), 50); // halfway from center(0) to upper edge(100)
});

// ---- Full evaluateV2() scenarios, using the REAL Position #37059 fixture ----

test("v2: price unchanged (centered) -- Hold wins legitimately, same 100/75 split as v1 historically showed", async () => {
  const j = job();
  const snapshot = snapshotAt(-57050); // dead center of [-58050, -56050)
  const proposals = await runAllStrategies(j, snapshot);
  const result = evaluateV2(j, snapshot, proposals);

  assert.equal(result.evaluatorPolicy, "v2-market-aware");
  assert.equal(result.winner.proposal.candidateId, "baseline-hold");
  assert.equal(result.winner.score.totalScore, 100);
  const rangeKeeper = result.scored.find((s) => s.proposal.candidateId === "rangekeeper-v1")!;
  assert.equal(rangeKeeper.score.totalScore, 75);
  assert.equal(rangeKeeper.metrics.positioningScore, 100); // rangeKeeper always recenters -- perfectly positioned regardless
});

test("v2: price drifted near the range edge -- RangeKeeper wins NATURALLY, driven by real market movement, not a rebalance bonus", async () => {
  const j = job();
  const snapshot = snapshotAt(-56100); // near the upper edge of [-58050, -56050)
  const proposals = await runAllStrategies(j, snapshot);
  const result = evaluateV2(j, snapshot, proposals);

  assert.equal(result.winner.proposal.candidateId, "rangekeeper-v1");
  assert.equal(result.winner.proposal.proposedAction.kind, "rebalance");

  const hold = result.scored.find((s) => s.proposal.candidateId === "baseline-hold")!;
  const rangeKeeper = result.scored.find((s) => s.proposal.candidateId === "rangekeeper-v1")!;
  assert.ok(hold.metrics.positioningScore < 10, `hold's stale range should score very poorly on positioning near the edge, got ${hold.metrics.positioningScore}`);
  assert.equal(rangeKeeper.metrics.positioningScore, 100, "rangeKeeper always recenters on the current tick");
  assert.ok(rangeKeeper.score.totalScore > hold.score.totalScore, "the winner must actually outscore hold, not just be picked by a tie-break");
});

test("v2: price moved completely OUT of the current range -- RangeKeeper wins, hold's positioning is exactly 0 (earning zero real fees)", async () => {
  const j = job();
  const snapshot = snapshotAt(-50000); // far outside [-58050, -56050)
  const proposals = await runAllStrategies(j, snapshot);
  const result = evaluateV2(j, snapshot, proposals);

  const hold = result.scored.find((s) => s.proposal.candidateId === "baseline-hold")!;
  assert.equal(hold.metrics.positioningScore, 0);
  assert.equal(result.winner.proposal.candidateId, "rangekeeper-v1");
});

test("REGRESSION GUARD: v1's evaluate() is completely unchanged -- Hold still wins the SAME out-of-range scenario v2 just flipped", async () => {
  const j = job();
  const snapshot = snapshotAt(-50000); // identical inputs to the v2 test above
  const proposals = await runAllStrategies(j, snapshot);
  const v1Result = evaluate(j, snapshot, proposals);

  assert.equal(v1Result.winner.proposal.candidateId, "baseline-hold");
  assert.equal(v1Result.winner.score.totalScore, 100);
  // v1's ProposalMetrics has no positioningScore field at all -- structurally cannot have one.
  assert.ok(!("positioningScore" in v1Result.winner.metrics));
});

test("v2 never branches on candidate identity: two DIFFERENT candidateIds proposing the IDENTICAL action get IDENTICAL metrics", async () => {
  const j = job();
  const snapshot = snapshotAt(-56100);
  const proposalA: StrategyProposal = {
    candidateId: "impersonator-a",
    displayLabel: "Baseline Strategy",
    agentIdOnChain: null,
    proposedAction: { kind: "rebalance", newRange: { tickLower: -57050, tickUpper: -55050 } },
    rationale: "test",
  };
  const proposalB: StrategyProposal = { ...proposalA, candidateId: "impersonator-b", agentIdOnChain: 9999 };

  const result = evaluateV2(j, snapshot, [proposalA, proposalB]);
  const a = result.scored.find((s) => s.proposal.candidateId === "impersonator-a")!;
  const b = result.scored.find((s) => s.proposal.candidateId === "impersonator-b")!;
  assert.deepEqual(a.metrics, b.metrics, "identical actions must score identically regardless of candidateId/agentIdOnChain");
});

test("v2 preserves the one documented weight rule: low risk tolerance still shifts weights toward risk avoidance", async () => {
  const snapshot = snapshotAt(-56100);
  const mediumJob = job({ riskTolerance: "medium" });
  const lowRiskJob = job({ riskTolerance: "low" });
  const proposals = await runAllStrategies(mediumJob, snapshot);

  const mediumResult = evaluateV2(mediumJob, snapshot, proposals);
  const lowRiskResult = evaluateV2(lowRiskJob, snapshot, proposals);

  assert.deepEqual(mediumResult.scored[0]!.score.weights, { feeEfficiency: 0.25, risk: 0.25, gas: 0.25, feasibility: 0.25 });
  assert.deepEqual(lowRiskResult.scored[0]!.score.weights, { feeEfficiency: 0.1, risk: 0.4, gas: 0.25, feasibility: 0.25 });
});

test("v2 still exactly one winner, and every normalized component stays within [0,100]", async () => {
  const j = job();
  const snapshot = snapshotAt(-56100);
  const proposals = await runAllStrategies(j, snapshot);
  const result = evaluateV2(j, snapshot, proposals);

  assert.equal(result.scored.filter((s) => s.isWinner).length, 1);
  for (const s of result.scored) {
    for (const v of Object.values(s.score.normalized)) {
      assert.ok(v >= 0 && v <= 100, `normalized component out of [0,100]: ${v}`);
    }
    assert.ok(s.score.totalScore >= 0 && s.score.totalScore <= 100);
  }
});

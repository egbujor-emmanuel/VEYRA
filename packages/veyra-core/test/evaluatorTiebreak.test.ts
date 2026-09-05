import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateV2,
  rangeKeeperStrategy,
  baselineHoldStrategy,
  baselineSymmetricRangeStrategy,
  type JobSpec,
  type MarketSnapshot,
} from "../src/index.js";

// Rounds 2-7 of the real archive all came out 75-75 between rangekeeper-v1 and
// baseline-symmetric-range on identical gas, so the winner was decided by list order alone.
// These tests exist so that fact stays visible: if the tie marker is ever dropped, the arena
// pages would silently go back to presenting six ties as six wins.

function job(): JobSpec {
  return {
    jobId: "job-tiebreak-test",
    createdAt: new Date().toISOString(),
    ownerWallet: "0x0000000000000000000000000000000000dEaD",
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: 37059 },
    constraints: {
      maxSpendWei: 10_000_000_000_000_000n,
      maxSlippageBps: 100,
      riskTolerance: "medium",
      deadlineSeconds: 600,
    },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "evaluating",
    erc8183JobId: null,
  };
}

/** Tick -58150 is round 7's actual observed tick, below position #37059's range. */
function snapshotAt(currentTick: number): MarketSnapshot {
  return {
    currentTick,
    currentRange: { tickLower: -58050, tickUpper: -56050 },
    currentLiquidity: 7_039_210_414_078_688_290n,
    tickSpacing: 50,
    recentVolatilityBps: 0,
  };
}

test("a win that is really a tie is recorded as one", async () => {
  const j = job();
  // Dead center of the range: rangeKeeper declines to reposition a healthy position, and so does
  // baseline-hold. Two candidates proposing the identical correct action must register as a tie.
  const snapshot = snapshotAt(-57050);
  const proposals = await Promise.all([
    rangeKeeperStrategy(j, snapshot),
    baselineHoldStrategy(j, snapshot),
    baselineSymmetricRangeStrategy(j, snapshot),
  ]);
  const result = evaluateV2(j, snapshot, proposals);

  assert.equal(result.winner.proposal.candidateId, "rangekeeper-v1");
  assert.ok(
    result.winner.wonByTiebreak?.includes("baseline-hold"),
    "rangekeeper only edged the hold baseline on list order -- that must be recorded",
  );

  // And the tie is genuine on both axes, not just score.
  const tied = result.scored.find((s) => s.proposal.candidateId === "baseline-hold")!;
  assert.equal(tied.score.totalScore, result.winner.score.totalScore);
  assert.equal(tied.metrics.estimatedGasWei, result.winner.metrics.estimatedGasWei);
});

test("a genuine win carries no tie marker", async () => {
  const j = job();
  // Far out of range: every candidate proposes something different, so nothing ties.
  const snapshot = snapshotAt(-50000);
  const proposals = await Promise.all([
    rangeKeeperStrategy(j, snapshot),
    baselineHoldStrategy(j, snapshot),
    baselineSymmetricRangeStrategy(j, snapshot),
  ]);
  const result = evaluateV2(j, snapshot, proposals);

  const runnerUpScores = result.scored
    .filter((s) => s !== result.winner)
    .map((s) => s.score.totalScore);
  if (!runnerUpScores.includes(result.winner.score.totalScore)) {
    assert.equal(result.winner.wonByTiebreak, undefined);
  }
});

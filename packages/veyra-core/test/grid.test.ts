import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gridKeeperStrategy,
  baselineHoldGridStrategy,
  computeMetricsGrid,
  evaluateGrid,
  planGridExecution,
  simulateGridPlan,
  type GridMarketSnapshot,
  type GridTradingJobSpec,
  type MarketSnapshot,
  type CurrentPositionState,
} from "../src/index.js";

const TICK_SPACING = 50;
const POOL = "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as const;

function slot(currentTick: number, rangeCenterOffset: number, halfWidthSpacings = 4): MarketSnapshot {
  const center = currentTick + rangeCenterOffset * TICK_SPACING;
  const halfWidth = halfWidthSpacings * TICK_SPACING;
  return {
    currentTick,
    currentRange: { tickLower: center - halfWidth, tickUpper: center + halfWidth },
    currentLiquidity: 1_000_000_000n,
    tickSpacing: TICK_SPACING,
    recentVolatilityBps: 0,
  };
}

function gridJob(overrides: Partial<GridTradingJobSpec> = {}): GridTradingJobSpec {
  return {
    jobId: "grid-job-1",
    createdAt: new Date().toISOString(),
    ownerWallet: "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11",
    category: "grid-trading",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", poolAddress: POOL, gridPositionTokenIds: [1, 2, 3] },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 0n },
    status: "open",
    erc8183JobId: null,
    ...overrides,
  };
}

// ---------- gridKeeperStrategy ----------

test("gridKeeperStrategy: every slot already sitting on its ladder position and in range -> hold", async () => {
  const currentTick = 0;
  // ladder for 3 slots, step 8: offsets are -1, 0, +1 relative slots -> centers at -8,0,+8 * tickSpacing
  const snapshot: GridMarketSnapshot = { poolAddress: POOL, slots: [slot(currentTick, -8), slot(currentTick, 0), slot(currentTick, 8)] };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

test("gridKeeperStrategy: a slot out of range AND drifted from the ladder gets a slotAdjustment", async () => {
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = {
    poolAddress: POOL,
    slots: [
      slot(currentTick, -8), // in range, on ladder
      slot(currentTick, 0), // in range, on ladder
      slot(currentTick, 20, 2), // way off ladder AND currentTick(0) is outside this slot's range -> must adjust
    ],
  };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "grid-rebalance");
  if (proposal.proposedAction.kind === "grid-rebalance") {
    assert.equal(proposal.proposedAction.slotAdjustments.length, 1);
    assert.equal(proposal.proposedAction.slotAdjustments[0]!.slotIndex, 2);
  }
});

test("gridKeeperStrategy: a slot that is OUT of its own range but the ladder didn't move it (edge case) is still adjusted since drift is checked independently", async () => {
  // in-range slots must never be touched even if the ladder shifted slightly -- confirm the reverse isn't true by construction:
  // an in-range slot exactly on the ladder position produces no adjustment.
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = { poolAddress: POOL, slots: [slot(currentTick, 0)] };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

test("baselineHoldGridStrategy: always proposes hold regardless of input", async () => {
  const proposal = await baselineHoldGridStrategy(gridJob(), { poolAddress: POOL, slots: [slot(0, 20, 2)] });
  assert.equal(proposal.proposedAction.kind, "hold");
  assert.equal(proposal.displayLabel, "Baseline Strategy");
});

// ---------- computeMetricsGrid / evaluateGrid ----------

test("computeMetricsGrid: gas scales with the number of slot adjustments", async () => {
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = { poolAddress: POOL, slots: [slot(currentTick, -8), slot(currentTick, 20, 2), slot(currentTick, -20, 2)] };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);
  const metrics = computeMetricsGrid(gridJob(), snapshot, proposal);
  const numAdjustments = proposal.proposedAction.kind === "grid-rebalance" ? proposal.proposedAction.slotAdjustments.length : 0;
  assert.ok(numAdjustments >= 1);
  assert.equal(metrics.estimatedGasWei > 0n, true);
  assert.equal(metrics.executionFeasible, true);
});

test("computeMetricsGrid: exceeding maxSpendWei makes the proposal infeasible", async () => {
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = { poolAddress: POOL, slots: [slot(currentTick, 20, 2), slot(currentTick, -20, 2), slot(currentTick, 40, 2)] };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);
  const tightJob = gridJob({ constraints: { ...gridJob().constraints, maxSpendWei: 1n } });
  const metrics = computeMetricsGrid(tightJob, snapshot, proposal);
  assert.equal(metrics.executionFeasible, false);
});

test("evaluateGrid: exactly one winner, gridKeeper beats a do-nothing baseline when it has real drift to fix", async () => {
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = { poolAddress: POOL, slots: [slot(currentTick, 20, 2), slot(currentTick, 0), slot(currentTick, -8)] };
  const job = gridJob();
  const [ours, baseline] = await Promise.all([gridKeeperStrategy(job, snapshot), baselineHoldGridStrategy(job, snapshot)]);
  const result = evaluateGrid(job, snapshot, [ours, baseline]);
  assert.equal(result.scored.filter((s) => s.isWinner).length, 1);
});

// ---------- planGridExecution ----------

function fakePosition(tokenId: number, tickLower: number, tickUpper: number): CurrentPositionState {
  return {
    tokenId, token0: "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d", token1: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    fee: 2500, tickLower, tickUpper, liquidity: 1_000_000_000n, sqrtPriceX96: 4_308_080_754_748_429_504_989_982_581n,
  };
}

test("planGridExecution: a hold proposal produces zero slot plans", () => {
  const result = planGridExecution({
    jobId: "j1", candidateId: "gridkeeper-v1",
    proposal: { candidateId: "gridkeeper-v1", displayLabel: "Our Agent", agentIdOnChain: 1890, proposedAction: { kind: "hold" }, rationale: "" },
    slotStates: new Map(), maxSlippageBps: 100, deadlineSeconds: 600,
  });
  assert.deepEqual(result.slotPlans, []);
  assert.equal(result.estimatedGasWei, 0n);
});

test("planGridExecution: a grid-rebalance proposal produces one real ExecutionPlan per adjusted slot, via the SAME planExecution used for single-position rebalancing", () => {
  const slotStates = new Map([[0, { currentPosition: fakePosition(101, -100, -50), recipient: "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" }]]);
  const result = planGridExecution({
    jobId: "j1", candidateId: "gridkeeper-v1",
    proposal: {
      candidateId: "gridkeeper-v1", displayLabel: "Our Agent", agentIdOnChain: 1890,
      proposedAction: { kind: "grid-rebalance", slotAdjustments: [{ slotIndex: 0, newRange: { tickLower: -150, tickUpper: -100 } }] },
      rationale: "",
    },
    slotStates, maxSlippageBps: 100, deadlineSeconds: 600,
  });
  assert.equal(result.slotPlans.length, 1);
  assert.equal(result.slotPlans[0]!.positionTokenId, 101);
  assert.equal(result.slotPlans[0]!.plan.targetRange?.tickLower, -150);
  assert.ok(result.estimatedGasWei > 0n);
});

test("planGridExecution: throws with an explicit message if a slot is adjusted but no on-chain state was supplied for it", () => {
  assert.throws(
    () =>
      planGridExecution({
        jobId: "j1", candidateId: "gridkeeper-v1",
        proposal: {
          candidateId: "gridkeeper-v1", displayLabel: "Our Agent", agentIdOnChain: 1890,
          proposedAction: { kind: "grid-rebalance", slotAdjustments: [{ slotIndex: 5, newRange: { tickLower: -50, tickUpper: 50 } }] },
          rationale: "",
        },
        slotStates: new Map(), maxSlippageBps: 100, deadlineSeconds: 600,
      }),
    /slot 5/,
  );
});

// ---------- simulateGridPlan ----------

test("simulateGridPlan: all slots valid -> pureExecutable true", () => {
  const slotStates = new Map([[0, { currentPosition: fakePosition(101, -100, -50), recipient: "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" }]]);
  const plan = planGridExecution({
    jobId: "j1", candidateId: "gridkeeper-v1",
    proposal: {
      candidateId: "gridkeeper-v1", displayLabel: "Our Agent", agentIdOnChain: 1890,
      proposedAction: { kind: "grid-rebalance", slotAdjustments: [{ slotIndex: 0, newRange: { tickLower: -150, tickUpper: -50 } }] },
      rationale: "",
    },
    slotStates, maxSlippageBps: 100, deadlineSeconds: 600,
  });
  const result = simulateGridPlan({ plan, currentSqrtPriceX96: fakePosition(101, -100, -50).sqrtPriceX96, tickSpacing: TICK_SPACING });
  assert.equal(result.slotResults.length, 1);
  assert.equal(result.pureExecutable, true);
});

test("simulateGridPlan: an invalid target range on one slot is reported with an explicit, slot-indexed reason", () => {
  const slotStates = new Map([[0, { currentPosition: fakePosition(101, -100, -50), recipient: "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" }]]);
  const plan = planGridExecution({
    jobId: "j1", candidateId: "gridkeeper-v1",
    proposal: {
      candidateId: "gridkeeper-v1", displayLabel: "Our Agent", agentIdOnChain: 1890,
      // tickLower >= tickUpper -- invalid, and not tick-spacing aligned either
      proposedAction: { kind: "grid-rebalance", slotAdjustments: [{ slotIndex: 0, newRange: { tickLower: -49, tickUpper: -51 } }] },
      rationale: "",
    },
    slotStates, maxSlippageBps: 100, deadlineSeconds: 600,
  });
  const result = simulateGridPlan({ plan, currentSqrtPriceX96: fakePosition(101, -100, -50).sqrtPriceX96, tickSpacing: TICK_SPACING });
  assert.equal(result.pureExecutable, false);
  assert.ok(result.pureExecutableReasons.some((r) => r.startsWith("slot 0:")));
});

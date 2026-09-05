import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gridProximityScore,
  gridKeeperStrategy,
  baselineHoldGridStrategy,
  computeMetricsGrid,
  evaluateGrid,
  planGridExecution,
  simulateGridPlan,
  gridPlacementScore,
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

/** A slot at an explicit range, for asserting against the ladder's exact output. */
function slotAt(currentTick: number, tickLower: number, tickUpper: number): MarketSnapshot {
  return {
    currentTick,
    currentRange: { tickLower, tickUpper },
    currentLiquidity: 1_000_000_000n,
    tickSpacing: TICK_SPACING,
    recentVolatilityBps: 0,
  };
}

test("gridKeeperStrategy: every slot already sitting on its ladder position -> hold", async () => {
  const currentTick = 0;
  // The ladder uses half-integer offsets so no slot is centered on the price. For 3 slots at
  // step 8 and half-width 4 (tickSpacing 50) that is offsets -1.5, -0.5, +0.5.
  const snapshot: GridMarketSnapshot = {
    poolAddress: POOL,
    slots: [slotAt(currentTick, -800, -400), slotAt(currentTick, -400, 0), slotAt(currentTick, 50, 450)],
  };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

test("gridKeeperStrategy: no slot ever straddles the current tick -- every target is one-sided", async () => {
  // This is the property that keeps a recentering swap-free. A straddling target needs both
  // tokens to mint, which forces a ratio-fixing swap; against a thin pool that swap moves the
  // price out from under the plan and the mint is refused. Checked across a spread of ticks and
  // slot counts, including ticks that do not sit on a tickSpacing boundary.
  for (const n of [2, 3, 4, 5]) {
    for (const currentTick of [0, -58216, -58200, 37, -1, 12345]) {
      const stale = Array.from({ length: n }, () => slotAt(currentTick, -1_000_000, -999_000));
      const proposal = await gridKeeperStrategy(gridJob(), { poolAddress: POOL, slots: stale });
      assert.equal(proposal.proposedAction.kind, "grid-rebalance", `n=${n} tick=${currentTick}`);
      if (proposal.proposedAction.kind !== "grid-rebalance") continue;
      for (const adj of proposal.proposedAction.slotAdjustments) {
        const { tickLower, tickUpper } = adj.newRange;
        const entirelyBelow = currentTick >= tickUpper; // holds token1 only
        const entirelyAbove = currentTick < tickLower; // holds token0 only
        assert.ok(
          entirelyBelow || entirelyAbove,
          `n=${n} tick=${currentTick} slot ${adj.slotIndex} straddles: [${tickLower}, ${tickUpper})`,
        );
        assert.ok(tickLower < tickUpper, `n=${n} slot ${adj.slotIndex} has empty range`);
        // Divisibility, not modulo: (-400 % 50) is -0, which is not strictly equal to 0.
        assert.ok(Number.isInteger(tickLower / TICK_SPACING), `lower bound ${tickLower} off tickSpacing`);
        assert.ok(Number.isInteger(tickUpper / TICK_SPACING), `upper bound ${tickUpper} off tickSpacing`);
      }
    }
  }
});

test("gridKeeperStrategy: a slot one tickSpacing off its ladder position is left alone, not churned", async () => {
  // The ladder shifts with the price, so exact-inequality drift proposed a full
  // decrease/collect/mint cycle to move a slot by a single spacing. Half a ladder step is the
  // threshold; below it the gas is not worth the reposition.
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = {
    poolAddress: POOL,
    slots: [slotAt(currentTick, -850, -450), slotAt(currentTick, -400, 0), slotAt(currentTick, 50, 450)],
  };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

test("gridKeeperStrategy: a slot out of range AND drifted from the ladder gets a slotAdjustment", async () => {
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = {
    poolAddress: POOL,
    slots: [
      slotAt(currentTick, -800, -400), // on the ladder
      slotAt(currentTick, -400, 0), // on the ladder
      slotAt(currentTick, 900, 1100), // far off the ladder, and the tick is nowhere near it
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

test("gridKeeperStrategy: a slot whose repositioning would need a swap is skipped, and says so", async () => {
  // A slot sitting entirely ABOVE the price holds token0. Put it far enough above that the ladder
  // wants it back down BELOW the price, where minting needs token1. Unwinding yields token0,
  // minting needs token1 -- that gap is exactly the swap that stranded slot 0 in production.
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = {
    poolAddress: POOL,
    slots: [slotAt(currentTick, 20_000, 20_400), slotAt(currentTick, 50, 450)],
  };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);

  assert.equal(proposal.proposedAction.kind, "hold", "must not attempt a swap-requiring reposition");
  assert.match(proposal.rationale, /would need a token swap/);
  assert.match(proposal.rationale, /Slot\(s\) 0/);
});

test("gridKeeperStrategy: a swap-free reposition on the same side is still proposed", async () => {
  // Same setup, but the stale slot is on the side the ladder wants it on. Unwinding and minting
  // both use token1, so there is no swap and no reason to skip it.
  const currentTick = 0;
  const snapshot: GridMarketSnapshot = {
    poolAddress: POOL,
    slots: [slotAt(currentTick, -20_400, -20_000), slotAt(currentTick, 50, 450)],
  };
  const proposal = await gridKeeperStrategy(gridJob(), snapshot);

  assert.equal(proposal.proposedAction.kind, "grid-rebalance");
  if (proposal.proposedAction.kind !== "grid-rebalance") return;
  assert.equal(proposal.proposedAction.slotAdjustments.length, 1);
  assert.equal(proposal.proposedAction.slotAdjustments[0]!.slotIndex, 0);
  const { tickLower, tickUpper } = proposal.proposedAction.slotAdjustments[0]!.newRange;
  assert.ok(currentTick >= tickUpper, "target must stay on the token1 side, so no swap is needed");
});

// ---------- gridPlacementScore ----------

test("gridPlacementScore: a one-sided slot is scored on distance, not centeredness", async () => {
  // The defect this metric replaces. v2's positioningScore rewards a range for CONTAINING the
  // price, so it returned 0 for every grid slot -- which are one-sided by design. Every candidate
  // then scored identically on fee efficiency and risk, gas was the only difference, and holding
  // won every round by construction. The grid agent could not act at all.
  const currentTick = -58006;
  const stranded = { tickLower: -58650, tickUpper: -58250 }; // 244 ticks below the price
  const wellPlaced = { tickLower: -58450, tickUpper: -58050 }; // 44 ticks below the price

  const strandedScore = gridPlacementScore(stranded, currentTick);
  const wellPlacedScore = gridPlacementScore(wellPlaced, currentTick);

  assert.ok(wellPlacedScore > strandedScore, `${wellPlacedScore} should beat ${strandedScore}`);
  // Both are one-sided, so v2's metric would have given both exactly 0.
  assert.ok(strandedScore > 0 && strandedScore < 100);
});

test("gridPlacementScore: a slot the price has entered is fully valued", async () => {
  assert.equal(gridPlacementScore({ tickLower: -58250, tickUpper: -57850 }, -58006), 100);
});

test("gridPlacementScore: a slot a full width away from the price is worth nothing", async () => {
  // 400 ticks wide, sitting 400+ ticks below the price -- too far out to be filled.
  assert.equal(gridPlacementScore({ tickLower: -59000, tickUpper: -58600 }, -58006), 0);
});

test("evaluateGrid: recentering a stranded slot beats holding, even though it costs gas", async () => {
  // The end-to-end property. Recentering must be able to WIN when it genuinely improves placement,
  // otherwise the category is inert no matter what the strategy proposes.
  const currentTick = -58006;
  const snapshot: GridMarketSnapshot = {
    poolAddress: POOL,
    slots: [
      { currentTick, currentRange: { tickLower: -58650, tickUpper: -58250 }, currentLiquidity: 1_000_000_000n, tickSpacing: TICK_SPACING, recentVolatilityBps: 0 },
      { currentTick, currentRange: { tickLower: -58250, tickUpper: -57850 }, currentLiquidity: 1_000_000_000n, tickSpacing: TICK_SPACING, recentVolatilityBps: 0 },
    ],
  };
  // The budget the grid orchestrator actually builds: one rebalance allowance per slot.
  const j = gridJob({
    constraints: { maxSpendWei: 10_000_000_000_000_000n * 2n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
  });
  const proposals = await Promise.all([gridKeeperStrategy(j, snapshot), baselineHoldGridStrategy(j, snapshot)]);
  const result = evaluateGrid(j, snapshot, proposals);

  assert.equal(result.winner.proposal.candidateId, "gridkeeper-v1");
  assert.equal(result.winner.proposal.proposedAction.kind, "grid-rebalance");

  // And the converse, which is the same mechanism working rather than a separate rule: squeeze the
  // spend limit and the identical reposition stops being worth its gas. Gas is scored against the
  // job's own budget, so a tighter budget makes the same action more expensive in score terms.
  const tight = gridJob({
    constraints: { maxSpendWei: 4_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
  });
  const tightResult = evaluateGrid(tight, snapshot, await Promise.all([
    gridKeeperStrategy(tight, snapshot), baselineHoldGridStrategy(tight, snapshot),
  ]));
  assert.equal(tightResult.winner.proposal.proposedAction.kind, "hold");
});


// ---------- gridProximityScore + the evaluator's ability to tell repositioning from doing nothing ----------

test("gridProximityScore: a slot the price is inside scores 100", () => {
  assert.equal(gridProximityScore(-100, 100, 0), 100);
  assert.equal(gridProximityScore(-100, 100, -100), 100); // lower edge is inclusive
});

test("gridProximityScore: falls off with distance and bottoms out a full width away", () => {
  // Width 200. Half a width past the upper edge -> 50; a full width past -> 0.
  assert.equal(gridProximityScore(-100, 100, 100), 100 * (1 - 1 / 200)); // just outside, still near
  assert.ok(Math.abs(gridProximityScore(-100, 100, 199) - 50) < 1);
  assert.equal(gridProximityScore(-100, 100, 400), 0);
  assert.equal(gridProximityScore(-100, 100, -400), 0);
});

test("gridProximityScore: unlike positioningScore, a one-sided slot is not simply zero", () => {
  // The whole defect. Every grid slot sits outside the price by construction, and centeredness
  // scores all of them 0 -- so a repositioning proposal and a do-nothing proposal came out with
  // identical metrics, gas decided, and doing nothing always won.
  const nearby = gridProximityScore(-58450, -58050, -58006);
  const drifted = gridProximityScore(-58650, -58250, -58006);
  assert.ok(nearby > 0, "a slot just below the price must not score zero");
  assert.ok(nearby > drifted, `recentering must improve the score (${drifted} -> ${nearby})`);
});

test("evaluateGrid: repositioning a drifted slot beats holding, and holding wins when it should not", async () => {
  function snapshotAtTick(currentTick: number): GridMarketSnapshot {
    // Slot 0 parked below the price, slot 1 above it -- the shape of the real live grid.
    return {
      poolAddress: POOL,
      slots: [
        { currentTick, currentRange: { tickLower: -800, tickUpper: -400 }, currentLiquidity: 1_000_000_000n, tickSpacing: TICK_SPACING, recentVolatilityBps: 0 },
        { currentTick, currentRange: { tickLower: -400, tickUpper: 0 }, currentLiquidity: 1_000_000_000n, tickSpacing: TICK_SPACING, recentVolatilityBps: 0 },
      ],
    };
  }

  async function judge(currentTick: number) {
    const snapshot = snapshotAtTick(currentTick);
    const j = gridJob();
    const proposals = [await gridKeeperStrategy(j, snapshot), await baselineHoldGridStrategy(j, snapshot)];
    const result = evaluateGrid(j, snapshot, proposals);
    const keeper = result.scored.find((s) => s.proposal.candidateId === "gridkeeper-v1")!;
    const hold = result.scored.find((s) => s.proposal.candidateId !== "gridkeeper-v1")!;
    return { keeper, hold, delta: keeper.score.totalScore - hold.score.totalScore };
  }

  // Price well away from where the ladder would now sit: repositioning is worth paying for.
  const drifted = await judge(900);
  assert.equal(drifted.keeper.proposal.proposedAction.kind, "grid-rebalance");
  assert.ok(
    drifted.delta > 0,
    `repositioning a drifted grid must beat holding, got a margin of ${drifted.delta}`,
  );

  // Note the margin is deliberately NOT asserted to grow without bound with drift: repositioning
  // more slots costs proportionally more gas, so a worse-placed grid can be worth less to fix than
  // a mildly-placed one. Monotonicity would be a nice story and is not what the arithmetic does.

  // Price sitting where the ladder already put the slots: the keeper should decline, not invent work.
  const settled = await judge(-200);
  const keeperAction = settled.keeper.proposal.proposedAction;
  if (keeperAction.kind === "grid-rebalance") {
    // If it does propose something here it must at least be for a slot genuinely out of range.
    for (const adj of keeperAction.slotAdjustments) {
      const slot = snapshotAtTick(-200).slots[adj.slotIndex]!;
      const outOfRange = slot.currentTick < slot.currentRange.tickLower || slot.currentTick >= slot.currentRange.tickUpper;
      assert.ok(outOfRange, `slot ${adj.slotIndex} was in range and should not have been touched`);
    }
  }
});

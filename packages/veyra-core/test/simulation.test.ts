import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planExecution,
  simulatePlan,
  type JobSpec,
  type StrategyProposal,
  type CurrentPositionState,
} from "../src/index.js";

// Same real, chain-observed Position #37058 fixture used in execution.test.ts
// (docs/arena-rounds/round-0001.json) -- not a synthetic mock.
const POSITION_37058: CurrentPositionState = {
  tokenId: 37058,
  token0: "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d",
  token1: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
  fee: 2500,
  tickLower: -59050,
  tickUpper: -55050,
  liquidity: 3_624_304_981_691_222_991n,
  sqrtPriceX96: 4_574_240_095_500_993_253_416_187_062n,
};
const TICK_SPACING = 50; // fee 2500 -> spacing 50
const RECIPIENT = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";

function job37058(): JobSpec {
  return {
    jobId: "fb6f032e-bd9a-4e47-a62e-c01b1792b6cc",
    createdAt: "2026-08-22T13:04:15.948Z",
    ownerWallet: RECIPIENT,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: 37058 },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "awarded",
    erc8183JobId: null,
  };
}

const HOLD_PROPOSAL: StrategyProposal = {
  candidateId: "baseline-hold",
  displayLabel: "Baseline Strategy",
  agentIdOnChain: null,
  proposedAction: { kind: "hold" },
  rationale: "Keeps the current range unchanged; no rebalance proposed.",
};

test("simulating a HOLD winner is a genuine no-op: every check NOT_APPLICABLE, pureExecutable true", () => {
  const plan = planExecution({ job: job37058(), proposal: HOLD_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const sim = simulatePlan({ plan, currentSqrtPriceX96: POSITION_37058.sqrtPriceX96, tickSpacing: TICK_SPACING });

  assert.equal(sim.status, "SIMULATED");
  assert.equal(sim.action, "HOLD");
  assert.equal(sim.targetRangeValidity.status, "NOT_APPLICABLE");
  assert.equal(sim.mintStructuralValidity.status, "NOT_APPLICABLE");
  assert.equal(sim.slippageProtection.status, "NOT_APPLICABLE");
  assert.equal(sim.ratioAdjustment.status, "NOT_APPLICABLE");
  assert.equal(sim.ratioAdjustment.ratioFixRequired, false);
  assert.equal(sim.pureExecutable, true);
  assert.deepEqual(sim.pureExecutableReasons, []);
});

test("REAL SCENARIO -- rangeKeeper-v1's actual Round #1 proposal: range/mint/slippage all VALID, ratio gap is under threshold", () => {
  const rangeKeeperProposal: StrategyProposal = {
    candidateId: "rangekeeper-v1",
    displayLabel: "Our Agent",
    agentIdOnChain: 1890,
    proposedAction: { kind: "rebalance", newRange: { tickLower: -58050, tickUpper: -56050 } }, // the real proposal from round-0001.json
    rationale: "Centered a 2000-tick-wide range on the current tick, widened for recent volatility of 0 bps (risk tolerance: medium).",
  };
  const plan = planExecution({ job: job37058(), proposal: rangeKeeperProposal, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const sim = simulatePlan({ plan, currentSqrtPriceX96: POSITION_37058.sqrtPriceX96, tickSpacing: TICK_SPACING });

  assert.equal(sim.action, "REBALANCE");
  assert.equal(sim.targetRangeValidity.status, "VALID");
  assert.equal(sim.mintStructuralValidity.status, "VALID");
  assert.equal(sim.slippageProtection.status, "VALID");
  // Computed directly from the real position/target: ~0.90% of token0 stranded, ~0% of token1 --
  // just under the 1% policy threshold. Not asserting an exact float (integer-math rounding is
  // legitimately sensitive) -- asserting the bounded range this real scenario actually produces.
  assert.equal(sim.ratioAdjustment.status, "NOT_IMPLEMENTED");
  assert.ok(sim.ratioAdjustment.strandedFraction0 > 0.005 && sim.ratioAdjustment.strandedFraction0 < 0.015);
  assert.ok(sim.ratioAdjustment.strandedFraction1 < 0.001);
  assert.equal(sim.ratioAdjustment.ratioFixRequired, false, "this real proposal's ratio gap is small enough not to require a fix under the documented threshold");
  assert.equal(sim.pureExecutable, true);
});

test("MATERIALLY MISMATCHED TARGET -- exposes the documented ratio-fixing-swap gap honestly: NOT_EXECUTABLE", () => {
  // Deliberately skewed: current tick (-57041) sits just inside the very bottom edge of this
  // target range, which then extends far upward. At the current price this range needs
  // overwhelmingly token1 -- but the held amounts (from the old, roughly-balanced wide range)
  // are mostly token0. This is exactly "remove -> collect -> mint without a swap is not
  // sufficient to recreate the desired position," made concrete.
  const skewedProposal: StrategyProposal = {
    candidateId: "adversarial-skewed-range",
    displayLabel: "Baseline Strategy",
    agentIdOnChain: null,
    proposedAction: { kind: "rebalance", newRange: { tickLower: -57050, tickUpper: -10050 } },
    rationale: "test fixture: deliberately mismatched ratio",
  };
  const plan = planExecution({ job: job37058(), proposal: skewedProposal, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const sim = simulatePlan({ plan, currentSqrtPriceX96: POSITION_37058.sqrtPriceX96, tickSpacing: TICK_SPACING });

  assert.equal(sim.targetRangeValidity.status, "VALID", "the range itself is a perfectly legal, tick-spacing-aligned range -- the problem is the ratio, not the range");
  assert.equal(sim.ratioAdjustment.status, "NOT_IMPLEMENTED");
  assert.ok(sim.ratioAdjustment.strandedFraction1 > 0.99, `expected near-total token1 stranding, got ${sim.ratioAdjustment.strandedFraction1}`);
  assert.equal(sim.ratioAdjustment.ratioFixRequired, true);
  assert.equal(sim.pureExecutable, false, "a real, quantified ratio mismatch this large must NOT be reported as executable");
  assert.ok(sim.pureExecutableReasons.some((r) => r.includes("ratio-fixing swap required")));
});

test("simulation never manufactures success: an already-infeasible plan (gas over budget) stays not-executable", () => {
  const tinyBudgetJob: JobSpec = {
    ...job37058(),
    constraints: { ...job37058().constraints, maxSpendWei: 1n },
  };
  const rangeKeeperProposal: StrategyProposal = {
    candidateId: "rangekeeper-v1",
    displayLabel: "Our Agent",
    agentIdOnChain: 1890,
    proposedAction: { kind: "rebalance", newRange: { tickLower: -58050, tickUpper: -56050 } },
    rationale: "test",
  };
  const plan = planExecution({ job: tinyBudgetJob, proposal: rangeKeeperProposal, currentPosition: POSITION_37058, recipient: RECIPIENT });
  assert.equal(plan.feasible, false); // sanity: the planner itself already flagged this

  const sim = simulatePlan({ plan, currentSqrtPriceX96: POSITION_37058.sqrtPriceX96, tickSpacing: TICK_SPACING });
  assert.equal(sim.pureExecutable, false);
  assert.ok(sim.pureExecutableReasons.some((r) => r.includes("maxSpendWei")));
});

test("an invalid (non-tick-spacing-aligned) target range is caught by targetRangeValidity, independent of the ratio check", () => {
  const misalignedProposal: StrategyProposal = {
    candidateId: "misaligned",
    displayLabel: "Baseline Strategy",
    agentIdOnChain: null,
    proposedAction: { kind: "rebalance", newRange: { tickLower: -58051, tickUpper: -56050 } }, // -58051 is not a multiple of 50
    rationale: "test fixture",
  };
  const plan = planExecution({ job: job37058(), proposal: misalignedProposal, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const sim = simulatePlan({ plan, currentSqrtPriceX96: POSITION_37058.sqrtPriceX96, tickSpacing: TICK_SPACING });

  assert.equal(sim.targetRangeValidity.status, "INVALID");
  assert.ok(sim.targetRangeValidity.detail.includes("tickSpacing"));
  assert.equal(sim.pureExecutable, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { planExecution, getAmountsForLiquidity, type JobSpec, type StrategyProposal, type CurrentPositionState } from "../src/index.js";

// Real, chain-observed fixture: BSC testnet Position #37058, owned by VEYRA Agent #1890, as
// read at block 126572064 (docs/arena-rounds/round-0001.json). Not a synthetic mock -- this is
// the actual position the arena evaluated in Round #1.
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

const RECIPIENT = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";

function job37058(overrides: Partial<JobSpec["constraints"]> = {}): JobSpec {
  return {
    jobId: "fb6f032e-bd9a-4e47-a62e-c01b1792b6cc", // the real Round #1 jobId
    createdAt: "2026-08-22T13:04:15.948Z",
    ownerWallet: RECIPIENT,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: 37058 },
    constraints: {
      maxSpendWei: 10_000_000_000_000_000n,
      maxSlippageBps: 100,
      riskTolerance: "medium",
      deadlineSeconds: 600,
      ...overrides,
    },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "awarded",
    erc8183JobId: null,
  };
}

// The real rangekeeper-v1 proposal from Round #1 (it did not win that round -- baseline-hold
// did -- but the planner's job is to turn WHICHEVER proposal is handed to it into a plan; it
// does not re-decide the winner).
const RANGEKEEPER_PROPOSAL: StrategyProposal = {
  candidateId: "rangekeeper-v1",
  displayLabel: "Our Agent",
  agentIdOnChain: 1890,
  proposedAction: { kind: "rebalance", newRange: { tickLower: -58050, tickUpper: -56050 } },
  rationale: "Centered a 2000-tick-wide range on the current tick, widened for recent volatility of 0 bps (risk tolerance: medium).",
};

const HOLD_PROPOSAL: StrategyProposal = {
  candidateId: "baseline-hold",
  displayLabel: "Baseline Strategy",
  agentIdOnChain: null,
  proposedAction: { kind: "hold" },
  rationale: "Keeps the current range unchanged; no rebalance proposed.",
};

test("a hold-winner plan has no steps, no liquidity to migrate, and is trivially feasible", () => {
  const plan = planExecution({ job: job37058(), proposal: HOLD_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });

  assert.equal(plan.status, "EXECUTION_NOT_SENT");
  assert.equal(plan.targetRange, null);
  assert.equal(plan.liquidityToMigrate, 0n);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.estimatedGasWei, 0n);
  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.feasibilityReasons, []);
  assert.deepEqual(plan.currentRange, { tickLower: -59050, tickUpper: -55050 });
});

test("a rebalance-winner plan produces the exact decrease -> collect -> mint sequence", () => {
  const plan = planExecution({ job: job37058(), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });

  assert.equal(plan.status, "EXECUTION_NOT_SENT");
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["decreaseLiquidity", "collect", "mint"]);
  assert.deepEqual(plan.targetRange, { tickLower: -58050, tickUpper: -56050 });
  assert.equal(plan.liquidityToMigrate, POSITION_37058.liquidity);
});

test("liquidityToMigrate is the position's FULL current liquidity -- MVP never partially exits", () => {
  const plan = planExecution({ job: job37058(), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const decrease = plan.steps.find((s) => s.kind === "decreaseLiquidity")!;
  assert.equal((decrease as any).liquidity, POSITION_37058.liquidity);
});

test("expectedAmounts matches the real Uniswap V3 liquidity/amount formula for the current position, exactly", () => {
  const plan = planExecution({ job: job37058(), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const expected = getAmountsForLiquidity(POSITION_37058.sqrtPriceX96, POSITION_37058.tickLower, POSITION_37058.tickUpper, POSITION_37058.liquidity);

  assert.equal(plan.expectedAmounts.amount0, expected.amount0);
  assert.equal(plan.expectedAmounts.amount1, expected.amount1);
  // Position #37058 is in-range (current tick -57041 is inside [-59050, -55050)), so both
  // amounts must be nonzero -- a real, two-sided position, not a degenerate single-token one.
  assert.ok(plan.expectedAmounts.amount0 > 0n);
  assert.ok(plan.expectedAmounts.amount1 > 0n);
});

test("mint step redeploys the decreased position's exact expected amounts (documented MVP simplification -- no ratio-fixing swap leg)", () => {
  const plan = planExecution({ job: job37058(), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const mint = plan.steps.find((s) => s.kind === "mint")! as Extract<(typeof plan.steps)[number], { kind: "mint" }>;

  assert.equal(mint.amount0Desired, plan.expectedAmounts.amount0);
  assert.equal(mint.amount1Desired, plan.expectedAmounts.amount1);
  assert.equal(mint.tickLower, -58050);
  assert.equal(mint.tickUpper, -56050);
  assert.equal(mint.token0, POSITION_37058.token0);
  assert.equal(mint.token1, POSITION_37058.token1);
  assert.equal(mint.fee, POSITION_37058.fee);
  assert.equal(mint.recipient, RECIPIENT);
});

test("amount0Min/amount1Min are a real slippage floor derived from job.constraints.maxSlippageBps -- never zero by default", () => {
  const plan = planExecution({ job: job37058({ maxSlippageBps: 100 }), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const decrease = plan.steps.find((s) => s.kind === "decreaseLiquidity")! as Extract<(typeof plan.steps)[number], { kind: "decreaseLiquidity" }>;

  // 100 bps = 1% floor below the expected amount.
  const expectedFloor0 = (plan.expectedAmounts.amount0 * 9_900n) / 10_000n;
  const expectedFloor1 = (plan.expectedAmounts.amount1 * 9_900n) / 10_000n;
  assert.equal(decrease.amount0Min, expectedFloor0);
  assert.equal(decrease.amount1Min, expectedFloor1);
  assert.ok(decrease.amount0Min > 0n, "slippage floor must not silently collapse to zero (recon §8's sandwich-bot warning)");
});

test("collect step uses the standard max-uint128 'collect everything owed' sentinel, not a computed amount", () => {
  const plan = planExecution({ job: job37058(), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const collect = plan.steps.find((s) => s.kind === "collect")! as Extract<(typeof plan.steps)[number], { kind: "collect" }>;
  const MAX_UINT128 = (1n << 128n) - 1n;
  assert.equal(collect.amount0Max, MAX_UINT128);
  assert.equal(collect.amount1Max, MAX_UINT128);
  assert.equal(collect.recipient, RECIPIENT);
});

test("estimatedGasWei sums the three per-step placeholders to the same total the evaluator already uses for a rebalance", () => {
  const plan = planExecution({ job: job37058(), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  assert.equal(plan.estimatedGasWei, 3_000_000_000_000_000n); // == evaluator's PLACEHOLDER_REBALANCE_GAS_WEI
});

test("a plan whose gas exceeds maxSpendWei is marked infeasible with an explicit reason", () => {
  const plan = planExecution({ job: job37058({ maxSpendWei: 1n }), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  assert.equal(plan.feasible, false);
  assert.ok(plan.feasibilityReasons.some((r) => r.includes("maxSpendWei")));
});

test("a plan with an invalid target range (tickLower >= tickUpper) is marked infeasible with an explicit reason", () => {
  const invalidProposal: StrategyProposal = {
    ...RANGEKEEPER_PROPOSAL,
    proposedAction: { kind: "rebalance", newRange: { tickLower: -56050, tickUpper: -58050 } },
  };
  const plan = planExecution({ job: job37058(), proposal: invalidProposal, currentPosition: POSITION_37058, recipient: RECIPIENT });
  assert.equal(plan.feasible, false);
  assert.ok(plan.feasibilityReasons.some((r) => r.includes("invalid")));
});

test("status is always the literal EXECUTION_NOT_SENT -- this module never transitions it", () => {
  const holdPlan = planExecution({ job: job37058(), proposal: HOLD_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  const rebalancePlan = planExecution({ job: job37058(), proposal: RANGEKEEPER_PROPOSAL, currentPosition: POSITION_37058, recipient: RECIPIENT });
  assert.equal(holdPlan.status, "EXECUTION_NOT_SENT");
  assert.equal(rebalancePlan.status, "EXECUTION_NOT_SENT");
});

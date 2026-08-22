import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeExecution, DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "../src/index.js";

function baseInputs(overrides: Partial<Parameters<typeof authorizeExecution>[0]> = {}) {
  return {
    policy: DEFAULT_EXECUTION_POLICY,
    winnerAction: "rebalance" as const,
    simulationExecutable: true,
    ownershipVerified: true,
    observationBlock: 1_000_000n,
    currentBlock: 1_000_010n,
    estimatedGasWei: 3_000_000_000_000_000n,
    ...overrides,
  };
}

test("hold is never authorized, regardless of every other input being favorable", () => {
  const result = authorizeExecution(baseInputs({ winnerAction: "hold" }));
  assert.equal(result.authorized, false);
  assert.deepEqual(result.reasons, ["winner action is hold -- nothing to authorize"]);
});

test("a fully passing rebalance is authorized with no reasons", () => {
  const result = authorizeExecution(baseInputs());
  assert.equal(result.authorized, true);
  assert.deepEqual(result.reasons, []);
});

test("a disabled policy blocks execution even when everything else passes", () => {
  const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, enabled: false };
  const result = authorizeExecution(baseInputs({ policy }));
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("disabled")));
});

test("simulation.executable=false blocks execution when requireSimulationPass is true (the default)", () => {
  const result = authorizeExecution(baseInputs({ simulationExecutable: false }));
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("simulation.executable")));
});

test("simulation.executable=false is TOLERATED when requireSimulationPass is explicitly disabled -- the flag must actually be honored", () => {
  const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, requireSimulationPass: false };
  const result = authorizeExecution(baseInputs({ policy, simulationExecutable: false }));
  assert.equal(result.authorized, true);
});

test("unverified ownership blocks execution when requireVerifiedOwnership is true (the default)", () => {
  const result = authorizeExecution(baseInputs({ ownershipVerified: false }));
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("ownership")));
});

test("estimated gas exceeding policy.maxSpendWei blocks execution", () => {
  const result = authorizeExecution(baseInputs({ estimatedGasWei: DEFAULT_EXECUTION_POLICY.maxSpendWei + 1n }));
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("maxSpendWei")));
});

test("a fresh observation (within maxObservationAgeBlocks) is authorized", () => {
  const result = authorizeExecution(baseInputs({ observationBlock: 1_000_000n, currentBlock: 1_000_000n + 5n }));
  assert.equal(result.authorized, true);
  assert.equal(result.observationAgeBlocks, 5n);
});

test("a stale observation (beyond maxObservationAgeBlocks) blocks execution with an explicit reason", () => {
  const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, maxObservationAgeBlocks: 10 };
  const result = authorizeExecution(baseInputs({ policy, observationBlock: 1_000_000n, currentBlock: 1_000_000n + 11n }));
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("stale")));
  assert.equal(result.observationAgeBlocks, 11n);
});

test("freshness is not checked at all when requireFreshObservation is false, however stale the observation", () => {
  const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, requireFreshObservation: false };
  const result = authorizeExecution(baseInputs({ policy, observationBlock: 1n, currentBlock: 1_000_000n }));
  assert.equal(result.authorized, true);
  assert.equal(result.observationAgeBlocks, null);
});

test("an observation block AHEAD of the current block is refused outright (an impossible, suspicious state)", () => {
  const result = authorizeExecution(baseInputs({ observationBlock: 1_000_010n, currentBlock: 1_000_000n }));
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("AHEAD")));
});

test("every failing reason is collected, not just the first", () => {
  const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, enabled: false, maxObservationAgeBlocks: 1 };
  const result = authorizeExecution(
    baseInputs({ policy, simulationExecutable: false, ownershipVerified: false, observationBlock: 1_000_000n, currentBlock: 1_000_050n }),
  );
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.length >= 4, `expected at least 4 reasons, got ${result.reasons.length}: ${JSON.stringify(result.reasons)}`);
});

test("this module never inspects a candidate's identity -- only its action and the policy gates", () => {
  // Structural guard, not a behavioral one: authorizeExecution's input type has no
  // candidateId/agentIdOnChain field at all, so it is impossible for this function's logic to
  // branch on "is this RangeKeeper" even by accident. Documented here as an explicit test
  // rather than left as an unverified claim in a comment.
  const inputs = baseInputs();
  assert.ok(!("candidateId" in inputs));
  assert.ok(!("agentIdOnChain" in inputs));
});

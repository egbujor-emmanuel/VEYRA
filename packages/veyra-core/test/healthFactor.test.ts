import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeHealthFactorSnapshot,
  healthFactorMonitorStrategy,
  baselineHoldHealthFactorStrategy,
  computeMetricsHealthFactor,
  evaluateHealthFactor,
  type VenusAccountObservation,
  type HealthFactorJobSpec,
} from "../src/index.js";

const ACCOUNT = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;

function obs(overrides: Partial<VenusAccountObservation> = {}): VenusAccountObservation {
  return {
    account: ACCOUNT,
    comptrollerError: 0n,
    liquidityUsd1e18: 8_849_997_761_687_166_348n, // real number from this session's live bootstrap
    shortfallUsd1e18: 0n,
    borrowedPrincipalUnderlyingUnits: 1_500_000n, // 1.5 USDT, 6 decimals
    borrowedTokenSymbol: "USDT",
    borrowedTokenDecimals: 6,
    ...overrides,
  };
}

function healthFactorJob(overrides: Partial<HealthFactorJobSpec> = {}): HealthFactorJobSpec {
  return {
    jobId: "hf-job-1",
    createdAt: new Date().toISOString(),
    ownerWallet: ACCOUNT,
    category: "health-factor-monitoring",
    target: { protocol: "venus", network: "bsc-testnet", account: ACCOUNT },
    constraints: { maxSpendWei: 0n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 0n },
    status: "open",
    erc8183JobId: null,
    ...overrides,
  };
}

// ---------- computeHealthFactorSnapshot ----------

test("computeHealthFactorSnapshot: a real shortfall is reported as SHORTFALL with borrowToCapacityRatio clamped to 100", () => {
  const snapshot = computeHealthFactorSnapshot(obs({ shortfallUsd1e18: 5_000_000_000_000_000_000n, liquidityUsd1e18: 0n }));
  assert.equal(snapshot.solvencyStatus, "SHORTFALL");
  assert.equal(snapshot.borrowToCapacityRatio, 100);
});

test("computeHealthFactorSnapshot: no borrow principal at all is NO_BORROW_POSITION with ratio 0", () => {
  const snapshot = computeHealthFactorSnapshot(obs({ borrowedPrincipalUnderlyingUnits: 0n }));
  assert.equal(snapshot.solvencyStatus, "NO_BORROW_POSITION");
  assert.equal(snapshot.borrowToCapacityRatio, 0);
});

test("computeHealthFactorSnapshot: the real bootstrapped position (1.5 USDT borrowed, ~$8.85 headroom) computes a healthy, real ratio around 14-15%", () => {
  const snapshot = computeHealthFactorSnapshot(obs());
  assert.equal(snapshot.solvencyStatus, "HEALTHY");
  assert.ok(snapshot.borrowToCapacityRatio > 13 && snapshot.borrowToCapacityRatio < 16, `expected ~14.5%, got ${snapshot.borrowToCapacityRatio}`);
});

test("computeHealthFactorSnapshot: correctly scales a non-18-decimal token (USDT, 6 decimals) against the 1e18-scaled liquidity figure", () => {
  // 1 USDT borrowed, 0 headroom remaining -> ratio should be exactly 100% (fully consumed capacity, not a shortfall).
  const snapshot = computeHealthFactorSnapshot(obs({ borrowedPrincipalUnderlyingUnits: 1_000_000n, liquidityUsd1e18: 0n }));
  assert.equal(snapshot.borrowToCapacityRatio, 100);
});

// ---------- healthFactorMonitorStrategy ----------

test("healthFactorMonitorStrategy: a healthy real position (well under the warning threshold) holds", async () => {
  const snapshot = computeHealthFactorSnapshot(obs());
  const proposal = await healthFactorMonitorStrategy(healthFactorJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

test("healthFactorMonitorStrategy: no borrow position at all holds, with an explicit 'nothing to monitor' rationale", async () => {
  const snapshot = computeHealthFactorSnapshot(obs({ borrowedPrincipalUnderlyingUnits: 0n }));
  const proposal = await healthFactorMonitorStrategy(healthFactorJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
  assert.ok(proposal.rationale.includes("nothing to monitor"));
});

test("healthFactorMonitorStrategy: crossing the warning threshold recommends a repay, not auto-executed", async () => {
  // Borrow high enough relative to remaining liquidity to exceed the 60% threshold.
  const snapshot = computeHealthFactorSnapshot(obs({ borrowedPrincipalUnderlyingUnits: 10_000_000n, liquidityUsd1e18: 2_000_000_000_000_000_000n }));
  const proposal = await healthFactorMonitorStrategy(healthFactorJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "recommend-repay");
  if (proposal.proposedAction.kind === "recommend-repay") {
    assert.equal(proposal.proposedAction.suggestedAmountWei, 10_000_000n);
  }
  assert.ok(proposal.rationale.includes("Not executed automatically"));
});

test("healthFactorMonitorStrategy: a real shortfall recommends an immediate repay, citing the real shortfall figure", async () => {
  const snapshot = computeHealthFactorSnapshot(obs({ shortfallUsd1e18: 5_000_000_000_000_000_000n, liquidityUsd1e18: 0n }));
  const proposal = await healthFactorMonitorStrategy(healthFactorJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "recommend-repay");
  assert.ok(proposal.rationale.includes("shortfall"));
});

test("healthFactorMonitorStrategy: never uses the phrase 'health factor' -- Venus's own (liquidity, shortfall) semantics are the real signal, not a synthesized Aave-style number", async () => {
  const snapshot = computeHealthFactorSnapshot(obs());
  const proposal = await healthFactorMonitorStrategy(healthFactorJob(), snapshot);
  assert.ok(!proposal.rationale.toLowerCase().includes("health factor"));
});

test("baselineHoldHealthFactorStrategy: always holds regardless of solvency data", async () => {
  const snapshot = computeHealthFactorSnapshot(obs({ shortfallUsd1e18: 999_999_999_999_999_999_999n }));
  const proposal = await baselineHoldHealthFactorStrategy(healthFactorJob(), snapshot);
  assert.equal(proposal.proposedAction.kind, "hold");
});

// ---------- computeMetricsHealthFactor / evaluateHealthFactor ----------

test("computeMetricsHealthFactor: estimatedGasWei is always zero -- this category never executes", () => {
  const snapshot = computeHealthFactorSnapshot(obs());
  const proposal = { candidateId: "x", displayLabel: "Our Agent" as const, agentIdOnChain: null, proposedAction: { kind: "hold" as const }, rationale: "" };
  const metrics = computeMetricsHealthFactor(healthFactorJob(), snapshot, proposal);
  assert.equal(metrics.estimatedGasWei, 0n);
  assert.equal(metrics.executionFeasible, true);
});

test("evaluateHealthFactor: exactly one winner, and a repay recommendation outscores a hold-forever baseline when there's real elevated risk", async () => {
  const snapshot = computeHealthFactorSnapshot(obs({ borrowedPrincipalUnderlyingUnits: 10_000_000n, liquidityUsd1e18: 2_000_000_000_000_000_000n }));
  const job = healthFactorJob();
  const [ours, baseline] = await Promise.all([healthFactorMonitorStrategy(job, snapshot), baselineHoldHealthFactorStrategy(job, snapshot)]);
  const result = evaluateHealthFactor(job, snapshot, [ours, baseline]);
  assert.equal(result.scored.filter((s) => s.isWinner).length, 1);
  assert.equal(result.winner.proposal.candidateId, "health-factor-monitor-v1");
});

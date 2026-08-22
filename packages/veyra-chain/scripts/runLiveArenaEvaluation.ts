// Read -> propose -> evaluate -> rank, against LIVE BSC testnet state. No transactions of
// any kind happen in this script -- no wallet, no signer, no rebalancing/execution. That is
// the next slice, not this one.
//
// Ties together:
//   @veyra/chain  readPositionObservation() + toMarketSnapshot()   (this package)
//   @veyra/core   rangeKeeperStrategy / baselineHoldStrategy / baselineSymmetricRangeStrategy
//                 + evaluate()                                     (the common evaluator)
//
// All three strategies are called with the exact same MarketSnapshot object (built once,
// below) -- the evaluator then computes every candidate's metrics itself from that shared
// snapshot. No strategy self-reports a score; see docs/AGENT_ARENA_ARCHITECTURE.md §2/§3.

import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http } from "viem";
import {
  evaluate,
  planExecution,
  rangeKeeperStrategy,
  baselineHoldStrategy,
  baselineSymmetricRangeStrategy,
  VEYRA_AGENT_ID_ON_CHAIN,
  type JobSpec,
  type CurrentPositionState,
} from "@veyra/core";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation, toMarketSnapshot } from "../src/positionReader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname at runtime is dist/scripts/ -- 4 levels up reaches the repo root.
const DOCS_DIR = resolve(__dirname, "../../../../docs");
const RECORD_PATH = resolve(DOCS_DIR, "veyra-live-evaluation.json");
const ROUNDS_DIR = resolve(DOCS_DIR, "arena-rounds");

/** Round numbers are append-only: scan the archive, never reuse or overwrite a past round. */
function nextRoundId(): number {
  mkdirSync(ROUNDS_DIR, { recursive: true });
  const existing = readdirSync(ROUNDS_DIR)
    .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// The position minted in the previous slice (docs/VEYRA_POSITION_VERIFICATION.md). Once a
// real job-creation flow exists, this comes from the JobSpec's own target field instead of
// being a script-level constant.
const VEYRA_POSITION_TOKEN_ID = 37058n;
const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;

// ASSUMED, NOT OBSERVED. See positionReader.ts's AssumedMarketInputs doc comment: this pool
// was created minutes ago and has no real price history, so any number here is a supplied
// placeholder, never a chain reading. 0 is the explicit choice, not a default that crept in --
// it is printed and recorded as "SUPPLIED (not observed)" everywhere below, precisely so a
// dashboard built on this data can never present it as a fact about the chain.
const ASSUMED_RECENT_VOLATILITY_BPS = 0;

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: {
      id: 97,
      name: "bsc-testnet",
      nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl),
  });

  section(`VEYRA Agent #${VEYRA_AGENT_ID_ON_CHAIN}`);
  console.log(`Owner wallet: ${VEYRA_WALLET}`);
  console.log(`ERC-8004 identity registered on BSC testnet -- see docs/RECON_REPORT.md §22.`);

  section(`Position #${VEYRA_POSITION_TOKEN_ID} -- OBSERVED (read live from chain)`);
  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  console.log(`Read at block: ${observation.blockNumber}`);
  console.log(`Pool: ${observation.poolAddress}`);
  console.log(`token0: ${observation.token0} (decimals ${observation.token0Decimals})`);
  console.log(`token1: ${observation.token1} (decimals ${observation.token1Decimals})`);
  console.log(`fee tier: ${observation.fee}`);
  console.log(`Position range: [${observation.tickLower}, ${observation.tickUpper})`);
  console.log(`Position liquidity: ${observation.positionLiquidity}`);
  console.log(`Pool total active liquidity: ${observation.poolLiquidity}`);
  console.log(`Current tick: ${observation.currentTick}`);
  console.log(`Current sqrtPriceX96: ${observation.sqrtPriceX96}`);

  section("MarketSnapshot (OBSERVED + one ASSUMED field, explicitly labeled)");
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: ASSUMED_RECENT_VOLATILITY_BPS });
  console.log(`currentTick:      ${snapshot.currentTick}                (OBSERVED)`);
  console.log(`currentRange:     [${snapshot.currentRange.tickLower}, ${snapshot.currentRange.tickUpper})   (OBSERVED)`);
  console.log(`currentLiquidity: ${snapshot.currentLiquidity}          (OBSERVED -- position's own liquidity)`);
  console.log(`tickSpacing:      ${snapshot.tickSpacing}                       (DERIVED from fee tier)`);
  console.log(`recentVolatilityBps: ${snapshot.recentVolatilityBps}                    (SUPPLIED INPUT -- NOT OBSERVED; no real price history exists for this pool yet)`);

  const job: JobSpec = {
    jobId: randomUUID(),
    createdAt: new Date().toISOString(),
    ownerWallet: VEYRA_WALLET,
    category: "rebalance",
    target: {
      protocol: "pancakeswap-v3",
      network: "bsc-testnet",
      positionTokenId: Number(VEYRA_POSITION_TOKEN_ID),
    },
    constraints: {
      maxSpendWei: 10_000_000_000_000_000n, // 0.01 tBNB-equivalent -- comfortably above the evaluator's placeholder gas estimate
      maxSlippageBps: 100,
      riskTolerance: "medium", // neutral weights -- see evaluator.ts's one documented weight rule
      deadlineSeconds: 600,
    },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "evaluating",
    erc8183JobId: null,
  };

  section("Job");
  console.log(JSON.stringify({ ...job, constraints: { ...job.constraints, maxSpendWei: job.constraints.maxSpendWei.toString() }, budget: { ...job.budget, amountWei: job.budget.amountWei.toString() } }, null, 2));

  section("Strategy Proposals (same MarketSnapshot handed to all three)");
  const proposals = await Promise.all([
    rangeKeeperStrategy(job, snapshot),
    baselineHoldStrategy(job, snapshot),
    baselineSymmetricRangeStrategy(job, snapshot),
  ]);
  for (const p of proposals) {
    console.log(`\n[${p.displayLabel}] ${p.candidateId}${p.agentIdOnChain !== null ? ` (ERC-8004 agentId ${p.agentIdOnChain})` : ""}`);
    console.log(`  proposed action: ${JSON.stringify(p.proposedAction)}`);
    console.log(`  rationale: ${p.rationale}`);
  }

  section("Evaluation (the common evaluator computes every candidate's metrics itself)");
  const result = evaluate(job, snapshot, proposals);
  for (const scored of result.scored) {
    const label = scored.isWinner ? " <-- WINNER" : "";
    console.log(`\n${scored.proposal.displayLabel} (${scored.proposal.candidateId})${label}`);
    console.log(`  metrics (DERIVED, deterministic formulas -- not a historical backtest, see architecture doc §7):`);
    console.log(`    estimatedFeeEfficiency: ${scored.metrics.estimatedFeeEfficiency.toFixed(2)}  (tick-width heuristic only -- NOT amount-aware; MarketSnapshot carries no decimals/token-amount fields yet)`);
    console.log(`    riskScore:              ${scored.metrics.riskScore.toFixed(2)}`);
    console.log(`    estimatedGasWei:        ${scored.metrics.estimatedGasWei}  (placeholder pending live eth_estimateGas wiring)`);
    console.log(`    executionFeasible:      ${scored.metrics.executionFeasible}`);
    console.log(`  score breakdown (weights: ${JSON.stringify(scored.score.weights)}):`);
    console.log(`    normalized: ${JSON.stringify(scored.score.normalized, (_, v) => (typeof v === "number" ? Number(v.toFixed(2)) : v))}`);
    console.log(`    totalScore: ${scored.score.totalScore.toFixed(2)}`);
  }

  section("Winner");
  console.log(`${result.winner.proposal.displayLabel} (${result.winner.proposal.candidateId}), score ${result.winner.score.totalScore.toFixed(2)}`);
  console.log(`Action: ${JSON.stringify(result.winner.proposal.proposedAction)}`);

  section("Execution Plan (planned only -- status is always EXECUTION_NOT_SENT; no signer, no transaction)");
  const currentPosition: CurrentPositionState = {
    tokenId: Number(observation.positionTokenId),
    token0: observation.token0,
    token1: observation.token1,
    fee: observation.fee,
    tickLower: observation.tickLower,
    tickUpper: observation.tickUpper,
    liquidity: observation.positionLiquidity,
    sqrtPriceX96: observation.sqrtPriceX96,
  };
  const plan = planExecution({ job, proposal: result.winner.proposal, currentPosition, recipient: VEYRA_WALLET });
  console.log(`status: ${plan.status}`);
  console.log(`feasible: ${plan.feasible}${plan.feasibilityReasons.length ? ` (${plan.feasibilityReasons.join("; ")})` : ""}`);
  console.log(`steps: ${plan.steps.length === 0 ? "(none -- hold requires no on-chain action)" : plan.steps.map((s) => s.kind).join(" -> ")}`);
  if (plan.steps.length > 0) {
    for (const s of plan.steps) console.log(`  - ${s.description}`);
    console.log(`expectedAmounts (DERIVED via the real V3 liquidity formula, from OBSERVED current state): amount0=${plan.expectedAmounts.amount0}, amount1=${plan.expectedAmounts.amount1}`);
  }
  console.log(`estimatedGasWei: ${plan.estimatedGasWei} (placeholder -- see execution.ts)`);
  console.log(`\nNo execution performed -- this slice stops at read -> propose -> evaluate -> rank -> plan.`);

  const roundId = nextRoundId();
  const recordContent = {
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: VEYRA_WALLET,
    positionTokenId: VEYRA_POSITION_TOKEN_ID.toString(),
    observedAtBlock: observation.blockNumber.toString(),
    observed: {
      poolAddress: observation.poolAddress,
      token0: observation.token0,
      token1: observation.token1,
      token0Decimals: observation.token0Decimals,
      token1Decimals: observation.token1Decimals,
      fee: observation.fee,
      tickLower: observation.tickLower,
      tickUpper: observation.tickUpper,
      positionLiquidity: observation.positionLiquidity.toString(),
      poolLiquidity: observation.poolLiquidity.toString(),
      currentTick: observation.currentTick,
      sqrtPriceX96: observation.sqrtPriceX96.toString(),
    },
    marketSnapshot: {
      ...snapshot,
      currentLiquidity: snapshot.currentLiquidity.toString(),
      recentVolatilityBpsProvenance: "SUPPLIED_NOT_OBSERVED",
    },
    job: {
      ...job,
      constraints: { ...job.constraints, maxSpendWei: job.constraints.maxSpendWei.toString() },
      budget: { ...job.budget, amountWei: job.budget.amountWei.toString() },
    },
    proposals: result.scored.map((s) => ({
      candidateId: s.proposal.candidateId,
      displayLabel: s.proposal.displayLabel,
      agentIdOnChain: s.proposal.agentIdOnChain,
      proposedAction: s.proposal.proposedAction,
      rationale: s.proposal.rationale,
      metrics: {
        ...s.metrics,
        estimatedGasWei: s.metrics.estimatedGasWei.toString(),
        provenanceNote: "DERIVED from deterministic formulas over OBSERVED chain state -- not a historical backtest, not a live gas estimate yet",
      },
      score: s.score,
      isWinner: s.isWinner,
    })),
    winnerCandidateId: result.winner.proposal.candidateId,
    executionPlan: {
      ...plan,
      liquidityToMigrate: plan.liquidityToMigrate.toString(),
      expectedAmounts: { amount0: plan.expectedAmounts.amount0.toString(), amount1: plan.expectedAmounts.amount1.toString() },
      estimatedGasWei: plan.estimatedGasWei.toString(),
      steps: plan.steps.map((s) => {
        const step: Record<string, unknown> = { ...s };
        for (const [k, v] of Object.entries(step)) {
          if (typeof v === "bigint") step[k] = v.toString();
        }
        return step;
      }),
    },
    generatedAt: new Date().toISOString(),
  };

  // Hash the content BEFORE roundId/artifactHash are attached -- the hash identifies this
  // round's actual observe/propose/evaluate/rank content, not the archival metadata wrapping it.
  const artifactHash = sha256(JSON.stringify(recordContent));
  const record = { roundId, artifactHash, ...recordContent };

  const roundPath = resolve(ROUNDS_DIR, `round-${String(roundId).padStart(4, "0")}.json`);
  const body = JSON.stringify(record, null, 2);
  writeFileSync(roundPath, body); // permanent, append-only archive entry for this round
  writeFileSync(RECORD_PATH, body); // "latest round" pointer the arena UI reads

  section(`Round #${roundId}`);
  console.log(`Archived: docs/arena-rounds/round-${String(roundId).padStart(4, "0")}.json`);
  console.log(`Artifact hash (sha256 of round content): ${artifactHash}`);
  console.log(`Updated docs/veyra-live-evaluation.json (latest-round pointer)`);
}

main().catch((err) => {
  console.error("Live evaluation failed:", err);
  process.exitCode = 1;
});

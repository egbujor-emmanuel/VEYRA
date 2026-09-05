// READ-ONLY verification of evaluatorV2 against live BSC testnet state. No transactions, no
// signer -- this exists specifically to satisfy "run the arena in read-only mode first" before
// any execution is permitted against the new evaluator.
//
// Writes to docs/arena-rounds-v2/ (a SEPARATE directory from docs/arena-rounds/) so v1's
// Rounds #1-7 are never intermixed with v2 output, per explicit instruction: v1's historical
// rounds stay exactly as they are.

import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import {
  evaluateV2,
  planExecution,
  rangeKeeperStrategy,
  baselineHoldStrategy,
  baselineSymmetricRangeStrategy,
  VEYRA_AGENT_ID_ON_CHAIN,
  type JobSpec,
} from "@veyra/core";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readRealizedVolatility } from "../src/volatilityReader.js";
import { readPositionObservation, toMarketSnapshot } from "../src/positionReader.js";
import { simulateLive } from "../src/simulate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, "../../../../docs");
const V2_ROUNDS_DIR = resolve(DOCS_DIR, "arena-rounds-v2");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const VEYRA_POSITION_TOKEN_ID = 37059n; // the real, current live position (result of Slice 3's execution)

function nextV2RoundId(): number {
  mkdirSync(V2_ROUNDS_DIR, { recursive: true });
  const existing = readdirSync(V2_ROUNDS_DIR)
    .map((f) => /^round-(\d+)\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
  }
  return value;
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: 97, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  section("READ-ONLY v2 verification -- no signer, no transaction, ever, in this script");
  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  const volatility = await readRealizedVolatility(client, observation.poolAddress as Address);
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: volatility.volatilityBps ?? 0 });
  console.log(`Position #${VEYRA_POSITION_TOKEN_ID}: current tick ${observation.currentTick}, range [${observation.tickLower}, ${observation.tickUpper})`);
  console.log(`recentVolatilityBps: ${volatility.volatilityBps ?? "unmeasured"} [${volatility.provenance}] -- ${volatility.detail}`);

  const job: JobSpec = {
    jobId: `v2-readonly-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ownerWallet: VEYRA_WALLET,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(VEYRA_POSITION_TOKEN_ID) },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "evaluating",
    erc8183JobId: null,
  };

  section("EVALUATE (v2-market-aware)");
  const proposals = await Promise.all([rangeKeeperStrategy(job, snapshot), baselineHoldStrategy(job, snapshot), baselineSymmetricRangeStrategy(job, snapshot)]);
  const result = evaluateV2(job, snapshot, proposals);
  for (const s of result.scored) {
    const label = s.isWinner ? " <-- WINNER" : "";
    console.log(`${s.proposal.displayLabel} (${s.proposal.candidateId})${label}`);
    console.log(`  widthEfficiency=${s.metrics.widthEfficiency.toFixed(2)} positioningScore=${s.metrics.positioningScore.toFixed(2)}`);
    console.log(`  feeEfficiency=${s.metrics.estimatedFeeEfficiency.toFixed(2)} riskScore=${s.metrics.riskScore.toFixed(2)} gas=${s.metrics.estimatedGasWei}`);
    console.log(`  totalScore=${s.score.totalScore.toFixed(2)}`);
  }

  section("PLAN (read-only)");
  const currentPosition = {
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
  console.log(`winner action: ${result.winner.proposal.proposedAction.kind}`);
  if (plan.targetRange) console.log(`target range: [${plan.targetRange.tickLower}, ${plan.targetRange.tickUpper})`);

  section("SIMULATE (read-only, live eth_estimateGas checks only -- no signer)");
  const sim = await simulateLive({ client, plan, currentSqrtPriceX96: observation.sqrtPriceX96, tickSpacing: snapshot.tickSpacing, account: VEYRA_WALLET });
  console.log(`simulation.executable: ${sim.executable}`);
  if (!sim.executable) console.log(`reasons: ${sim.executableReasons.join("; ")}`);

  const roundId = nextV2RoundId();
  const record = {
    roundId,
    evaluatorPolicy: "v2-market-aware",
    veyraAgentId: VEYRA_AGENT_ID_ON_CHAIN,
    ownerWallet: VEYRA_WALLET,
    positionTokenId: VEYRA_POSITION_TOKEN_ID.toString(),
    observedAtBlock: observation.blockNumber.toString(),
    observed: bigintsToStrings({ ...observation }),
    marketSnapshot: {
      ...(bigintsToStrings(snapshot) as Record<string, unknown>),
      recentVolatilityBpsProvenance: volatility.provenance,
      recentVolatilityDetail: volatility.detail,
      observationCardinality: volatility.observationCardinality,
    },
    job: bigintsToStrings(job),
    proposals: result.scored.map((s) => ({ ...(bigintsToStrings(s.proposal) as Record<string, unknown>), metrics: bigintsToStrings(s.metrics), score: s.score, isWinner: s.isWinner })),
    winnerCandidateId: result.winner.proposal.candidateId,
    executionPlan: bigintsToStrings(plan),
    simulation: bigintsToStrings(sim),
    note: "READ-ONLY verification round -- no transaction was sent or even attempted by this script.",
    generatedAt: new Date().toISOString(),
  };
  const artifactHash = sha256(JSON.stringify(record));
  const outPath = resolve(V2_ROUNDS_DIR, `round-${String(roundId).padStart(4, "0")}.json`);
  writeFileSync(outPath, JSON.stringify({ ...record, artifactHash }, null, 2));

  section(`v2 Round #${roundId} archived (read-only)`);
  console.log(`docs/arena-rounds-v2/round-${String(roundId).padStart(4, "0")}.json`);
}

main().catch((err) => {
  console.error("v2 read-only evaluation failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

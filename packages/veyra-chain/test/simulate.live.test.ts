// LIVE integration smoke test -- actually calls BSC testnet RPC via estimateContractGas.
// Not run by `npm test` (see package.json's separate `test:live` script). No private key, no
// signer, no transaction is ever sent -- estimateContractGas simulates a call as if `account`
// made it, which is exactly what "zero transaction submission" requires.
//
// Acceptance test for this slice: against the REAL Position #37058 (owned by the REAL VEYRA
// wallet), a rebalance plan's decreaseLiquidity and collect steps must simulate as VALID --
// proving the plan is genuinely executable by this wallet right now, not just internally
// consistent on paper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { planExecution, type JobSpec, type StrategyProposal, type CurrentPositionState } from "@veyra/core";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation } from "../src/positionReader.js";
import { simulateLive } from "../src/simulate.js";

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

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const VEYRA_POSITION_TOKEN_ID = 37058n;

function job(): JobSpec {
  return {
    jobId: "live-simulate-test",
    createdAt: new Date().toISOString(),
    ownerWallet: VEYRA_WALLET,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(VEYRA_POSITION_TOKEN_ID) },
    constraints: { maxSpendWei: 10_000_000_000_000_000n, maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: 100_000_000_000_000_000n },
    status: "awarded",
    erc8183JobId: null,
  };
}

test("live: a real rebalance plan's decreaseLiquidity and collect simulate as VALID against the wallet's actual owned position", async () => {
  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
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

  // A modest, valid narrowing centered on the current tick -- tick-spacing-aligned by
  // construction (round to the nearest 50, this pool's spacing at fee 2500).
  const spacing = 50;
  const round = (t: number) => Math.round(t / spacing) * spacing;
  const half = 20 * spacing;
  const proposal: StrategyProposal = {
    candidateId: "live-test-rebalance",
    displayLabel: "Our Agent",
    agentIdOnChain: 1890,
    proposedAction: {
      kind: "rebalance",
      newRange: { tickLower: round(observation.currentTick - half), tickUpper: round(observation.currentTick + half) },
    },
    rationale: "live simulation smoke test",
  };

  const plan = planExecution({ job: job(), proposal, currentPosition, recipient: VEYRA_WALLET });
  const sim = await simulateLive({
    client,
    plan,
    currentSqrtPriceX96: observation.sqrtPriceX96,
    tickSpacing: spacing,
    account: VEYRA_WALLET,
  });

  assert.equal(sim.status, "SIMULATED");
  assert.equal(sim.decreaseLiquidityLive.status, "VALID", `expected a real, owned position to simulate decreaseLiquidity as VALID; got: ${sim.decreaseLiquidityLive.detail}`);
  assert.equal(sim.collectLive.status, "VALID", `expected collect to simulate as VALID; got: ${sim.collectLive.detail}`);
  assert.ok(sim.decreaseLiquidityLive.gasEstimateWei! > 0n);
  assert.ok(sim.collectLive.gasEstimateWei! > 0n);
  assert.equal(sim.mintLive.status, "NOT_ATTEMPTED", "mint must never be live-estimated this slice -- see simulate.ts's documented reason");
  assert.ok(sim.liveGasEstimateWei! > 0n);
});

test("live: a HOLD plan performs no live estimation at all -- NOT_ATTEMPTED across the board, trivially executable", async () => {
  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
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
  const holdProposal: StrategyProposal = {
    candidateId: "baseline-hold",
    displayLabel: "Baseline Strategy",
    agentIdOnChain: null,
    proposedAction: { kind: "hold" },
    rationale: "no rebalance",
  };
  const plan = planExecution({ job: job(), proposal: holdProposal, currentPosition, recipient: VEYRA_WALLET });
  const sim = await simulateLive({ client, plan, currentSqrtPriceX96: observation.sqrtPriceX96, tickSpacing: 50, account: VEYRA_WALLET });

  assert.equal(sim.decreaseLiquidityLive.status, "NOT_ATTEMPTED");
  assert.equal(sim.collectLive.status, "NOT_ATTEMPTED");
  assert.equal(sim.mintLive.status, "NOT_ATTEMPTED");
  assert.equal(sim.liveGasEstimateWei, null);
  assert.equal(sim.executable, true);
});

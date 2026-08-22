// LIVE integration smoke test -- actually calls BSC testnet RPC. Not run by `npm test`
// (see package.json's separate `test:live` script) since it is network-dependent and slower.
//
// Acceptance test for this slice: a fresh invocation, given only the NFPM address and the
// tokenId, discovers Position #37058 and produces a complete MarketSnapshot -- WITHOUT
// reading any position-specific value from docs/veyra-position-record.json. The expected
// values below are hand-transcribed from that document as independent test assertions (a
// normal testing practice); the reader code itself never opens that file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation, toMarketSnapshot, isTickInRange } from "../src/positionReader.js";

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

const VEYRA_POSITION_TOKEN_ID = 37058n;

test("live: discovers Position #37058 on BSC testnet and reads its real on-chain state", async () => {
  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);

  assert.equal(observation.positionTokenId, VEYRA_POSITION_TOKEN_ID);
  assert.equal(observation.fee, 2500);
  assert.equal(observation.tickLower, -59050);
  assert.equal(observation.tickUpper, -55050);
  assert.equal(observation.token0.toLowerCase(), "0x00efbcce2ff935332fc66851cfd34a000f6c7b8d");
  assert.equal(observation.token1.toLowerCase(), "0xae13d989dac2f0debff460ac112a837c89baa7cd");
  assert.equal(observation.poolAddress.toLowerCase(), "0x61c17a2c050facfdf8651b576bc898596f5223b9");
  assert.equal(observation.token0Decimals, 18);
  assert.equal(observation.token1Decimals, 18);
  assert.ok(observation.positionLiquidity > 0n, "position must have nonzero liquidity");
  assert.ok(observation.poolLiquidity > 0n, "pool must have nonzero active liquidity");
  assert.ok(observation.blockNumber > 0n);

  // The pool's current tick may drift slightly from the mint-time value if anyone has
  // traded against it since, so this asserts the structural invariant (still in range) --
  // not the exact tick value, which is not guaranteed to stay fixed.
  assert.ok(
    isTickInRange(observation.currentTick, observation.tickLower, observation.tickUpper),
    `expected currentTick ${observation.currentTick} to remain within [${observation.tickLower}, ${observation.tickUpper})`,
  );
});

test("live: produces a complete, well-formed MarketSnapshot from the live reads", async () => {
  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });

  assert.equal(snapshot.currentRange.tickLower, -59050);
  assert.equal(snapshot.currentRange.tickUpper, -55050);
  assert.equal(snapshot.tickSpacing, 50);
  assert.equal(snapshot.currentLiquidity, observation.positionLiquidity);
  assert.equal(typeof snapshot.currentTick, "number");
  assert.equal(snapshot.recentVolatilityBps, 0); // explicit placeholder -- see AssumedMarketInputs doc comment
});

// Pure unit tests -- no network access. Covers the OBSERVED -> DERIVED conversion logic in
// positionReader.ts. The live chain-reading half (readPositionObservation) is covered
// separately by positionReader.live.test.ts, which actually hits BSC testnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tickSpacingForFee,
  isTickInRange,
  toMarketSnapshot,
  type OnChainPositionObservation,
} from "../src/positionReader.js";

// Real values from the position minted in the previous slice (tokenId 37058) -- used here
// only as realistic fixture data, not read from any file at runtime.
function realObservation(overrides: Partial<OnChainPositionObservation> = {}): OnChainPositionObservation {
  return {
    positionTokenId: 37058n,
    blockNumber: 12345n,
    token0: "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d",
    token1: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    fee: 2500,
    tickLower: -59050,
    tickUpper: -55050,
    positionLiquidity: 3624304981691222991n,
    token0Decimals: 18,
    token1Decimals: 18,
    poolAddress: "0x61c17A2C050facFdf8651b576Bc898596f5223b9",
    sqrtPriceX96: 4574240095500993253416187062n,
    currentTick: -57041,
    poolLiquidity: 3624304981691222991n,
    ...overrides,
  };
}

test("tickSpacingForFee returns the correct spacing for every known PancakeSwap V3 fee tier", () => {
  assert.equal(tickSpacingForFee(100), 1);
  assert.equal(tickSpacingForFee(500), 10);
  assert.equal(tickSpacingForFee(2500), 50);
  assert.equal(tickSpacingForFee(10000), 200);
});

test("tickSpacingForFee throws on an unrecognized fee tier rather than returning undefined", () => {
  assert.throws(() => tickSpacingForFee(9999), /Unknown PancakeSwap V3 fee tier/);
});

test("isTickInRange: half-open [tickLower, tickUpper) convention", () => {
  assert.equal(isTickInRange(-57041, -59050, -55050), true); // our real minted position: in range
  assert.equal(isTickInRange(-59050, -59050, -55050), true); // at tickLower -- inclusive
  assert.equal(isTickInRange(-55050, -59050, -55050), false); // at tickUpper -- exclusive
  assert.equal(isTickInRange(-59051, -59050, -55050), false); // just below tickLower
  assert.equal(isTickInRange(-55049, -59050, -55050), false); // just at/above tickUpper
});

test("toMarketSnapshot maps OBSERVED fields to MarketSnapshot correctly, including negative ticks", () => {
  const observation = realObservation();
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });

  assert.equal(snapshot.currentTick, -57041);
  assert.deepEqual(snapshot.currentRange, { tickLower: -59050, tickUpper: -55050 });
  assert.equal(snapshot.tickSpacing, 50);
  assert.equal(snapshot.recentVolatilityBps, 0);
});

test("toMarketSnapshot.currentLiquidity is the POSITION's own liquidity, not the pool's total liquidity", () => {
  const observation = realObservation({
    positionLiquidity: 111n,
    poolLiquidity: 999_999_999n, // deliberately different from positionLiquidity
  });
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });

  assert.equal(snapshot.currentLiquidity, 111n);
});

test("toMarketSnapshot forwards the caller-supplied assumed volatility verbatim -- never invents one", () => {
  const observation = realObservation();
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 250 });
  assert.equal(snapshot.recentVolatilityBps, 250);
});

test("toMarketSnapshot propagates tickSpacingForFee's error for an observation with an unknown fee tier", () => {
  const observation = realObservation({ fee: 12345 });
  assert.throws(() => toMarketSnapshot(observation, { recentVolatilityBps: 0 }), /Unknown PancakeSwap V3 fee tier/);
});

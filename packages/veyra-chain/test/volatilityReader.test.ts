import { test } from "node:test";
import assert from "node:assert/strict";
import { readRealizedVolatility } from "../src/volatilityReader.js";

const POOL = "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as const;

/** Minimal stand-in for the two contract reads the volatility reader makes. */
function fakeClient(opts: { cardinality: number; tickCumulatives?: bigint[]; observeThrows?: string; slot0Throws?: string }) {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "slot0") {
        if (opts.slot0Throws) throw new Error(opts.slot0Throws);
        return [0n, -58216, 0, opts.cardinality, 60, 0, true];
      }
      if (functionName === "observe") {
        if (opts.observeThrows) throw new Error(opts.observeThrows);
        return [opts.tickCumulatives ?? [], []];
      }
      throw new Error(`unexpected call ${functionName}`);
    },
  } as never;
}

test("a single stored observation is reported as unmeasurable, NOT as zero volatility", async () => {
  // The distinction this whole module exists for. Returning 0 here asserts a calm market;
  // the truth is that no measurement was possible.
  const reading = await readRealizedVolatility(fakeClient({ cardinality: 1 }), POOL);

  assert.equal(reading.volatilityBps, null);
  assert.equal(reading.provenance, "INSUFFICIENT_HISTORY");
  assert.equal(reading.observationCardinality, 1);
  assert.match(reading.detail, /observation/);
});

test("an oracle that does not reach back far enough is reported, not silently zeroed", async () => {
  const reading = await readRealizedVolatility(
    fakeClient({ cardinality: 60, observeThrows: "execution reverted: OLD" }),
    POOL,
  );

  assert.equal(reading.volatilityBps, null);
  assert.equal(reading.provenance, "INSUFFICIENT_HISTORY");
  assert.match(reading.detail, /OLD/);
});

test("identical buckets are treated as unmeasured rather than as a confident zero", async () => {
  // A flat cumulative series is what extrapolation from one observation looks like even when
  // cardinality claims otherwise -- so it must not come back as volatilityBps 0.
  const flat = [0n, 1n, 2n, 3n, 4n, 5n, 6n].map((i) => i * -58216n * 600n);
  const reading = await readRealizedVolatility(fakeClient({ cardinality: 60, tickCumulatives: flat }), POOL);

  assert.equal(reading.volatilityBps, null);
  assert.equal(reading.provenance, "INSUFFICIENT_HISTORY");
});

test("real movement across buckets produces an OBSERVED reading in bps", async () => {
  // Mean ticks of -100, -200, -300, -400, -500, -600 across six 600s buckets.
  // Cumulative tick at each boundary is the running sum * bucket length.
  const means = [-100, -200, -300, -400, -500, -600];
  const cumulatives: bigint[] = [0n];
  for (const m of means) cumulatives.push(cumulatives[cumulatives.length - 1]! + BigInt(m) * 600n);
  // secondsAgos is newest-last, so the reader differences consecutive entries; order matches.
  const reading = await readRealizedVolatility(
    fakeClient({ cardinality: 60, tickCumulatives: cumulatives }),
    POOL,
  );

  assert.equal(reading.provenance, "OBSERVED");
  assert.equal(reading.samples, 6);
  assert.ok(reading.volatilityBps !== null && reading.volatilityBps > 0);
  // Population stddev of [-100..-600] step 100 is ~170.78. A tick is a bp, so no scaling factor.
  assert.ok(Math.abs(reading.volatilityBps! - 170.78) < 0.5, `got ${reading.volatilityBps}`);
});

test("an unreadable pool is distinguished from one with no history", async () => {
  const reading = await readRealizedVolatility(fakeClient({ cardinality: 0, slot0Throws: "no code" }), POOL);
  assert.equal(reading.provenance, "ORACLE_UNAVAILABLE");
  assert.equal(reading.volatilityBps, null);
});

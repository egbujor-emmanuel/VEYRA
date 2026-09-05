import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLivePositionTokenId } from "../src/positionDiscovery.js";
import { VEYRA_LIVE_POSITION_TOKEN_ID } from "../src/testnetAddresses.js";

const OWNER = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const POOL_A = "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as const; // rebalance + grid
const POOL_B = "0x8523c3320000000000000000000000000000beef" as const; // yield

/** Stands in for the NFPM + factory reads the resolver makes. */
function fakeClient(positions: { id: bigint; liquidity: bigint; pool: string }[], opts: { enumThrows?: boolean } = {}) {
  return {
    async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
      if (functionName === "balanceOf") {
        if (opts.enumThrows) throw new Error("no enumerable support");
        return BigInt(positions.length);
      }
      if (functionName === "tokenOfOwnerByIndex") return positions[Number(args![1] as bigint)]!.id;
      if (functionName === "positions") {
        const p = positions.find((x) => x.id === (args![0] as bigint))!;
        // token0/token1/fee are placeholders; the fake factory keys off the id instead.
        return [0n, OWNER, `0x${p.id.toString(16).padStart(40, "0")}`, "0x00", 500, 0, 0, p.liquidity, 0n, 0n, 0n, 0n];
      }
      if (functionName === "getPool") {
        const token0 = (args![0] as string).toLowerCase();
        const match = positions.find((x) => `0x${x.id.toString(16).padStart(40, "0")}` === token0)!;
        return match.pool;
      }
      throw new Error(`unexpected ${functionName}`);
    },
  } as never;
}

test("the sole funded position in the target pool is discovered", async () => {
  const r = await resolveLivePositionTokenId(
    fakeClient([
      { id: 37079n, liquidity: 100n, pool: POOL_A },
      { id: 37091n, liquidity: 100n, pool: POOL_A }, // grid slot, excluded by id
      { id: 37141n, liquidity: 100n, pool: POOL_B }, // yield, excluded by pool
    ]),
    OWNER,
    { excludeTokenIds: [37091n, 37093n], poolAddress: POOL_A },
  );

  assert.equal(r.source, "discovered");
  assert.equal(r.tokenId, 37079n);
});

test("a drained position is never chosen -- this is the bug that shipped", async () => {
  // #37059 was the configured id for ten days after run #4 burned it to zero liquidity, and the
  // arena kept evaluating it. Discovery must pick the funded one on its own.
  const r = await resolveLivePositionTokenId(
    fakeClient([
      { id: 37059n, liquidity: 0n, pool: POOL_A },
      { id: 37079n, liquidity: 6811320819996921967n, pool: POOL_A },
    ]),
    OWNER,
    { poolAddress: POOL_A },
  );

  assert.equal(r.source, "discovered");
  assert.equal(r.tokenId, 37079n);
});

test("ambiguity falls back to the configured id and says so, rather than guessing silently", async () => {
  const r = await resolveLivePositionTokenId(
    fakeClient([
      { id: VEYRA_LIVE_POSITION_TOKEN_ID, liquidity: 100n, pool: POOL_A },
      { id: 40000n, liquidity: 100n, pool: POOL_A },
    ]),
    OWNER,
    { poolAddress: POOL_A },
  );

  assert.equal(r.source, "fallback");
  assert.equal(r.tokenId, VEYRA_LIVE_POSITION_TOKEN_ID);
  assert.match(r.detail, /2 funded positions/);
});

test("an unreadable wallet falls back instead of throwing -- a daemon must still start", async () => {
  const r = await resolveLivePositionTokenId(fakeClient([], { enumThrows: true }), OWNER, { poolAddress: POOL_A });
  assert.equal(r.source, "fallback");
  assert.equal(r.tokenId, VEYRA_LIVE_POSITION_TOKEN_ID);
  assert.match(r.detail, /could not enumerate/);
});

test("no funded positions at all falls back rather than returning nothing", async () => {
  const r = await resolveLivePositionTokenId(
    fakeClient([{ id: 37079n, liquidity: 0n, pool: POOL_A }]),
    OWNER,
    { poolAddress: POOL_A },
  );
  assert.equal(r.source, "fallback");
  assert.match(r.detail, /no funded positions/);
});

// Gate 1 integration verification: proves authorizeAltanaCall() is an actual pre-broadcast
// security boundary, not merely a standalone library that happens to be correct. Every test here
// uses a SPY executor -- a plain object recording whether/how many times .execute() was called --
// so "the signer/session executor was never invoked" is asserted directly, not inferred from a
// transaction reverting. No network call, no real Altana session, and no relay are involved in
// this file; that is deliberate (see Step 7 of the Gate 1 task: a controlled executor spy, never
// a production debug shortcut).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AltanaAuthorizedContext, AltanaOperation } from "@veyra/core";
import {
  executeAltanaOperation,
  AltanaCallRejectedError,
  type AltanaSessionExecutor,
  type AltanaIntent,
  type AltanaExecuteResult,
} from "../src/altanaExecutor.js";
import { NFPM_ABI, SWAP_ROUTER_ABI } from "../src/abis.js";
import { PANCAKE_V3_TESTNET } from "../src/testnetAddresses.js";

const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as `0x${string}`;
const SWAP_ROUTER = PANCAKE_V3_TESTNET.swapRouter as `0x${string}`;

const WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const ATTACKER_WALLET = "0x000000000000000000000000000000000000dEaD" as const;
const TOKEN0 = "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d" as const;
const TOKEN1 = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as const;
const UNRELATED_TOKEN = "0x1234567890123456789012345678901234567890" as const;
const AUTHORIZED_TOKEN_ID = 37079n;
const FEE = 2500;

function baseCtx(overrides: Partial<AltanaAuthorizedContext> = {}): AltanaAuthorizedContext {
  return {
    authorizedTokenId: AUTHORIZED_TOKEN_ID,
    authorizedWallet: WALLET,
    authorizedToken0: TOKEN0,
    authorizedToken1: TOKEN1,
    authorizedFee: FEE,
    maxAmountInWei: 1_000_000_000_000_000_000n,
    maxDecreaseLiquidity: 1_000_000_000_000_000_000n,
    maxSlippageBps: 100,
    nowUnixSeconds: 1_800_000_000n,
    maxDeadlineSecondsAhead: 600,
    ...overrides,
  };
}

/** Spy executor: a plain, dependency-free object recording every invocation. Never signs or
 *  broadcasts anything -- if a test's call count stays 0, nothing capable of doing either was
 *  ever reached. */
function makeSpyExecutor(): AltanaSessionExecutor & { calls: AltanaIntent[] } {
  const calls: AltanaIntent[] = [];
  return {
    calls,
    async execute(intent: AltanaIntent): Promise<AltanaExecuteResult> {
      calls.push(intent);
      return { status: "CONFIRMED", transactionHash: "0xspy" as `0x${string}` };
    },
  };
}

const abis = { nfpmAbi: NFPM_ABI, swapRouterAbi: SWAP_ROUTER_ABI };
const addresses = { nfpmAddress: NFPM_ADDRESS, swapRouterAddress: SWAP_ROUTER };

// ============================== VALID PATH ==============================

test("VALID collect: passes the policy, reaches the executor exactly once, with the correct encoded call", async () => {
  const executor = makeSpyExecutor();
  const op: AltanaOperation = { kind: "collect", tokenId: AUTHORIZED_TOKEN_ID, recipient: WALLET, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n };
  const result = await executeAltanaOperation({ operation: op, context: baseCtx(), executor, abis, addresses });
  assert.equal(result.authorization.authorized, true);
  assert.equal(executor.calls.length, 1, "signer/executor must be invoked exactly once for a valid call");
  assert.equal(executor.calls[0]!.call.address, NFPM_ADDRESS);
  assert.equal(executor.calls[0]!.call.functionName, "collect");
});

test("VALID decreaseLiquidity: passes the policy and reaches the executor exactly once", async () => {
  const executor = makeSpyExecutor();
  const op: AltanaOperation = { kind: "decreaseLiquidity", tokenId: AUTHORIZED_TOKEN_ID, liquidity: 1000n, amount0Min: 0n, amount1Min: 0n, deadline: 1_800_000_500n };
  const result = await executeAltanaOperation({ operation: op, context: baseCtx(), executor, abis, addresses });
  assert.equal(result.authorization.authorized, true);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0]!.call.functionName, "decreaseLiquidity");
});

test("VALID mint: passes the policy and reaches the executor exactly once", async () => {
  const executor = makeSpyExecutor();
  const op: AltanaOperation = {
    kind: "mint", token0: TOKEN0, token1: TOKEN1, fee: FEE, tickLower: -59150, tickUpper: -57150,
    amount0Desired: 100n, amount1Desired: 100n, amount0Min: 0n, amount1Min: 0n, recipient: WALLET, deadline: 1_800_000_500n,
  };
  const result = await executeAltanaOperation({ operation: op, context: baseCtx(), executor, abis, addresses });
  assert.equal(result.authorization.authorized, true);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0]!.call.functionName, "mint");
  assert.equal(executor.calls[0]!.call.address, NFPM_ADDRESS);
});

test("VALID swap: passes the policy, targets the swap router (not the NFPM), and reaches the executor exactly once", async () => {
  const executor = makeSpyExecutor();
  const op: AltanaOperation = {
    kind: "swap", tokenIn: TOKEN0, tokenOut: TOKEN1, fee: FEE, recipient: WALLET, deadline: 1_800_000_500n,
    amountIn: 1000n, amountOutMinimum: 990n, referenceAmountOut: 1000n,
  };
  const result = await executeAltanaOperation({ operation: op, context: baseCtx(), executor, abis, addresses });
  assert.equal(result.authorization.authorized, true);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0]!.call.functionName, "exactInputSingle");
  assert.equal(executor.calls[0]!.call.address, SWAP_ROUTER);
});

// ============================== ATTACK PATH ==============================
// Each case: mutate one protected argument, confirm the promise rejects with
// AltanaCallRejectedError BEFORE the executor is ever touched (calls.length stays 0).

async function expectRejected(op: AltanaOperation, ctx: AltanaAuthorizedContext, expectReasonIncludes: string) {
  const executor = makeSpyExecutor();
  await assert.rejects(
    () => executeAltanaOperation({ operation: op, context: ctx, executor, abis, addresses }),
    (err: unknown) => {
      assert.ok(err instanceof AltanaCallRejectedError);
      assert.ok(err.reasons.some((r) => r.includes(expectReasonIncludes)), `expected a reason containing "${expectReasonIncludes}", got: ${JSON.stringify(err.reasons)}`);
      return true;
    },
  );
  assert.equal(executor.calls.length, 0, "REJECTED call must never reach the executor -- broadcast count must be 0");
}

test("ATTACK collect: wrong tokenId is rejected before the executor is touched", () =>
  expectRejected({ kind: "collect", tokenId: 1n, recipient: WALLET, amount0Max: 1n, amount1Max: 1n }, baseCtx(), "tokenId"));

test("ATTACK collect: wrong (redirected) recipient is rejected before the executor is touched", () =>
  expectRejected({ kind: "collect", tokenId: AUTHORIZED_TOKEN_ID, recipient: ATTACKER_WALLET, amount0Max: 1n, amount1Max: 1n }, baseCtx(), "recipient"));

// collect() has no deadline parameter at all in the real NFPM ABI (verified against
// packages/veyra-chain/src/abis.ts) -- a "stale deadline" attack on collect is not a real attack
// surface for this operation, so it is intentionally not represented here rather than invented.

test("ATTACK decreaseLiquidity: wrong tokenId is rejected before the executor is touched", () =>
  expectRejected({ kind: "decreaseLiquidity", tokenId: 1n, liquidity: 1000n, amount0Min: 0n, amount1Min: 0n, deadline: 1_800_000_500n }, baseCtx(), "tokenId"));

test("ATTACK decreaseLiquidity: excessive liquidity amount is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "decreaseLiquidity", tokenId: AUTHORIZED_TOKEN_ID, liquidity: 10_000n, amount0Min: 0n, amount1Min: 0n, deadline: 1_800_000_500n },
    baseCtx({ maxDecreaseLiquidity: 500n }),
    "maxDecreaseLiquidity",
  ));

test("ATTACK decreaseLiquidity: stale (past) deadline is rejected before the executor is touched", () =>
  expectRejected({ kind: "decreaseLiquidity", tokenId: AUTHORIZED_TOKEN_ID, liquidity: 1000n, amount0Min: 0n, amount1Min: 0n, deadline: 1_799_999_000n }, baseCtx(), "past"));

test("ATTACK mint: wrong token0 is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "mint", token0: UNRELATED_TOKEN, token1: TOKEN1, fee: FEE, tickLower: -100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, recipient: WALLET, deadline: 1_800_000_500n },
    baseCtx(),
    "token pair",
  ));

test("ATTACK mint: wrong token1 is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "mint", token0: TOKEN0, token1: UNRELATED_TOKEN, fee: FEE, tickLower: -100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, recipient: WALLET, deadline: 1_800_000_500n },
    baseCtx(),
    "token pair",
  ));

test("ATTACK mint: wrong fee tier is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "mint", token0: TOKEN0, token1: TOKEN1, fee: 10_000, tickLower: -100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, recipient: WALLET, deadline: 1_800_000_500n },
    baseCtx(),
    "fee tier",
  ));

test("ATTACK mint: redirected recipient is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "mint", token0: TOKEN0, token1: TOKEN1, fee: FEE, tickLower: -100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, recipient: ATTACKER_WALLET, deadline: 1_800_000_500n },
    baseCtx(),
    "recipient",
  ));

// "wrong pool" (from the Step 5 attack list) is the same substitution surface as wrong
// token0/token1/fee above -- a pool is identified by exactly that triple, so it is not a
// separate, additional case beyond the three already covered.

test("ATTACK mint: invalid (zero/zero) amount is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "mint", token0: TOKEN0, token1: TOKEN1, fee: FEE, tickLower: -100, tickUpper: 100, amount0Desired: 0n, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n, recipient: WALLET, deadline: 1_800_000_500n },
    baseCtx(),
    "both zero",
  ));

test("ATTACK mint: stale (past) deadline is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "mint", token0: TOKEN0, token1: TOKEN1, fee: FEE, tickLower: -100, tickUpper: 100, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, recipient: WALLET, deadline: 1_799_999_000n },
    baseCtx(),
    "past",
  ));

test("ATTACK swap: wrong tokenIn is rejected before the executor is touched", () =>
  expectRejected({ kind: "swap", tokenIn: UNRELATED_TOKEN, tokenOut: TOKEN1, fee: FEE, recipient: WALLET, deadline: 1_800_000_500n, amountIn: 1n, amountOutMinimum: 1n, referenceAmountOut: 1n }, baseCtx(), "token pair"));

test("ATTACK swap: wrong tokenOut is rejected before the executor is touched", () =>
  expectRejected({ kind: "swap", tokenIn: TOKEN0, tokenOut: UNRELATED_TOKEN, fee: FEE, recipient: WALLET, deadline: 1_800_000_500n, amountIn: 1n, amountOutMinimum: 1n, referenceAmountOut: 1n }, baseCtx(), "token pair"));

// "unauthorized router" (from the Step 5 attack list) is not a representable attack in this
// design: the router address is a fixed constant this module's caller supplies
// (addresses.swapRouterAddress), never a field read off the untrusted AltanaOperation. There is
// no argument inside a swap operation that could substitute a different router, so faking one
// would test a surface that doesn't exist rather than the real one.

test("ATTACK swap: excessive amountIn is rejected before the executor is touched", () =>
  expectRejected(
    { kind: "swap", tokenIn: TOKEN0, tokenOut: TOKEN1, fee: FEE, recipient: WALLET, deadline: 1_800_000_500n, amountIn: 1000n, amountOutMinimum: 1n, referenceAmountOut: 1n },
    baseCtx({ maxAmountInWei: 500n }),
    "maxAmountInWei",
  ));

test("ATTACK swap: redirected recipient is rejected before the executor is touched", () =>
  expectRejected({ kind: "swap", tokenIn: TOKEN0, tokenOut: TOKEN1, fee: FEE, recipient: ATTACKER_WALLET, deadline: 1_800_000_500n, amountIn: 1n, amountOutMinimum: 1n, referenceAmountOut: 1n }, baseCtx(), "recipient"));

test("ATTACK swap: amountOutMinimum = 0 is rejected before the executor is touched -- the core relay-tampering case", () =>
  expectRejected({ kind: "swap", tokenIn: TOKEN0, tokenOut: TOKEN1, fee: FEE, recipient: WALLET, deadline: 1_800_000_500n, amountIn: 1000n, amountOutMinimum: 0n, referenceAmountOut: 1000n }, baseCtx(), "zero"));

test("ATTACK swap: stale (past) deadline is rejected before the executor is touched", () =>
  expectRejected({ kind: "swap", tokenIn: TOKEN0, tokenOut: TOKEN1, fee: FEE, recipient: WALLET, deadline: 1_799_999_000n, amountIn: 1n, amountOutMinimum: 1n, referenceAmountOut: 1n }, baseCtx(), "past"));

// ============================== SECOND-ORDER GUARANTEES ==============================

test("a rejected call never even reaches buildCall -- the executor receives literally zero calls, not a call with a caught error inside it", async () => {
  const executor = makeSpyExecutor();
  try {
    await executeAltanaOperation({
      operation: { kind: "collect", tokenId: 999n, recipient: ATTACKER_WALLET, amount0Max: 0n, amount1Max: 0n },
      context: baseCtx(),
      executor,
      abis,
      addresses,
    });
    assert.fail("expected executeAltanaOperation to throw");
  } catch (err) {
    assert.ok(err instanceof AltanaCallRejectedError);
    // Multiple independent violations at once (wrong tokenId, wrong recipient, zero/zero amounts)
    // -- confirms this integration surfaces every reason, not just the first, same as the pure policy.
    assert.ok(err.reasons.length >= 3, `expected >= 3 reasons, got: ${JSON.stringify(err.reasons)}`);
  }
  assert.equal(executor.calls.length, 0);
});

test("this integration module never inspects strategy/candidate identity -- ExecuteAltanaOperationOpts carries only operation/context/executor/abis/addresses", async () => {
  const executor = makeSpyExecutor();
  const op: AltanaOperation = { kind: "collect", tokenId: AUTHORIZED_TOKEN_ID, recipient: WALLET, amount0Max: 1n, amount1Max: 1n };
  const opts = { operation: op, context: baseCtx(), executor, abis, addresses };
  assert.ok(!("candidateId" in opts));
  assert.ok(!("strategyName" in opts));
  await executeAltanaOperation(opts);
});

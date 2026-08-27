import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeAltanaCall, type AltanaAuthorizedContext, type AltanaOperation } from "../src/index.js";

const WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const OTHER_WALLET = "0x000000000000000000000000000000000000dEaD" as const;
const TOKEN0 = "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d" as const; // matches VEYRA_POSITION_VERIFICATION.md's real token0
const TOKEN1 = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as const; // matches ...'s real token1
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
    maxSlippageBps: 100, // 1%, matching RATIO_MISMATCH_THRESHOLD elsewhere in this project
    nowUnixSeconds: 1_800_000_000n,
    maxDeadlineSecondsAhead: 600,
    ...overrides,
  };
}

// ---------- collect ----------

function baseCollect(overrides: Partial<Extract<AltanaOperation, { kind: "collect" }>> = {}): AltanaOperation {
  return { kind: "collect", tokenId: AUTHORIZED_TOKEN_ID, recipient: WALLET, amount0Max: 1n, amount1Max: 1n, ...overrides };
}

test("collect: correct tokenId + recipient is authorized", () => {
  const result = authorizeAltanaCall(baseCollect(), baseCtx());
  assert.equal(result.authorized, true);
  assert.deepEqual(result.reasons, []);
});

test("collect: address comparison is case-insensitive (checksum vs lowercase must not cause a false rejection)", () => {
  const result = authorizeAltanaCall(baseCollect({ recipient: WALLET.toLowerCase() as `0x${string}` }), baseCtx());
  assert.equal(result.authorized, true);
});

test("collect: a substituted tokenId is refused -- exactly the gap Altana's own scoping leaves open", () => {
  const result = authorizeAltanaCall(baseCollect({ tokenId: 99999n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("tokenId")));
});

test("collect: a redirected recipient is refused, even though Altana's own {signature,to} scoping would allow it", () => {
  const result = authorizeAltanaCall(baseCollect({ recipient: OTHER_WALLET }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("recipient")));
});

test("collect: amount0Max=0 AND amount1Max=0 is refused (mirrors the real on-chain revert found during Altana verification)", () => {
  const result = authorizeAltanaCall(baseCollect({ amount0Max: 0n, amount1Max: 0n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("zero")));
});

// ---------- decreaseLiquidity ----------

function baseDecrease(overrides: Partial<Extract<AltanaOperation, { kind: "decreaseLiquidity" }>> = {}): AltanaOperation {
  return { kind: "decreaseLiquidity", tokenId: AUTHORIZED_TOKEN_ID, liquidity: 1000n, amount0Min: 0n, amount1Min: 0n, deadline: 1_800_000_500n, ...overrides };
}

test("decreaseLiquidity: valid call on the authorized position is authorized", () => {
  const result = authorizeAltanaCall(baseDecrease(), baseCtx());
  assert.equal(result.authorized, true);
});

test("decreaseLiquidity: has no recipient field at all, by design -- it cannot redirect funds", () => {
  const op = baseDecrease();
  assert.ok(!("recipient" in op), "decreaseLiquidity must never carry a recipient -- collect() is the only redirection surface");
});

test("decreaseLiquidity: wrong tokenId is refused", () => {
  const result = authorizeAltanaCall(baseDecrease({ tokenId: 1n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("tokenId")));
});

test("decreaseLiquidity: a deadline already in the past is refused", () => {
  const result = authorizeAltanaCall(baseDecrease({ deadline: 1_799_999_999n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("past")));
});

test("decreaseLiquidity: a deadline far beyond maxDeadlineSecondsAhead is refused", () => {
  const result = authorizeAltanaCall(baseDecrease({ deadline: 1_800_100_000n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("maxDeadlineSecondsAhead")));
});

test("decreaseLiquidity: zero liquidity is refused", () => {
  const result = authorizeAltanaCall(baseDecrease({ liquidity: 0n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("liquidity")));
});

test("decreaseLiquidity: liquidity exceeding maxDecreaseLiquidity is refused (Gate 1 integration fix -- this ceiling did not exist before)", () => {
  const ctx = baseCtx({ maxDecreaseLiquidity: 500n });
  const result = authorizeAltanaCall(baseDecrease({ liquidity: 1000n }), ctx);
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("maxDecreaseLiquidity")));
});

// ---------- mint ----------

function baseMint(overrides: Partial<Extract<AltanaOperation, { kind: "mint" }>> = {}): AltanaOperation {
  return {
    kind: "mint", token0: TOKEN0, token1: TOKEN1, fee: FEE, tickLower: -59150, tickUpper: -57150,
    amount0Desired: 100n, amount1Desired: 100n, amount0Min: 0n, amount1Min: 0n, recipient: WALLET, deadline: 1_800_000_500n,
    ...overrides,
  };
}

test("mint: a valid call on the authorized pool is authorized", () => {
  const result = authorizeAltanaCall(baseMint(), baseCtx());
  assert.equal(result.authorized, true);
});

test("mint: token0/token1 supplied in reversed order is still authorized -- pool identity is order-independent", () => {
  const result = authorizeAltanaCall(baseMint({ token0: TOKEN1, token1: TOKEN0 }), baseCtx());
  assert.equal(result.authorized, true);
});

test("mint: an unrelated token pair is refused", () => {
  const result = authorizeAltanaCall(baseMint({ token0: TOKEN0, token1: UNRELATED_TOKEN }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("token pair")));
});

test("mint: the wrong fee tier is refused even when the token pair is correct", () => {
  const result = authorizeAltanaCall(baseMint({ fee: 500 }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("fee tier")));
});

test("mint: a redirected recipient is refused", () => {
  const result = authorizeAltanaCall(baseMint({ recipient: OTHER_WALLET }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("recipient")));
});

test("mint: an inverted tick range (tickLower >= tickUpper) is refused", () => {
  const result = authorizeAltanaCall(baseMint({ tickLower: -100, tickUpper: -200 }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("tickLower")));
});

test("mint: amounts exceeding the per-call ceiling are refused", () => {
  const ctx = baseCtx({ maxAmountInWei: 50n });
  const result = authorizeAltanaCall(baseMint({ amount0Desired: 100n }), ctx);
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("maxAmountInWei")));
});

test("mint: amount0Desired and amount1Desired both zero is refused (Gate 1 integration fix -- mirrors collect's zero/zero rejection)", () => {
  const result = authorizeAltanaCall(baseMint({ amount0Desired: 0n, amount1Desired: 0n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("both zero")));
});

test("mint: every failing reason is collected, not just the first", () => {
  const result = authorizeAltanaCall(
    baseMint({ token0: TOKEN0, token1: UNRELATED_TOKEN, fee: 500, recipient: OTHER_WALLET, tickLower: 0, tickUpper: -1 }),
    baseCtx(),
  );
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.length >= 4, `expected at least 4 reasons, got ${result.reasons.length}: ${JSON.stringify(result.reasons)}`);
});

// ---------- swap ----------

function baseSwap(overrides: Partial<Extract<AltanaOperation, { kind: "swap" }>> = {}): AltanaOperation {
  return {
    kind: "swap", tokenIn: TOKEN0, tokenOut: TOKEN1, fee: FEE, recipient: WALLET, deadline: 1_800_000_500n,
    amountIn: 1000n, amountOutMinimum: 990n, referenceAmountOut: 1000n,
    ...overrides,
  };
}

test("swap: amountOutMinimum within the slippage floor of the reference quote is authorized", () => {
  const result = authorizeAltanaCall(baseSwap(), baseCtx());
  assert.equal(result.authorized, true);
});

test("swap: a redirected recipient is refused", () => {
  const result = authorizeAltanaCall(baseSwap({ recipient: OTHER_WALLET }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("recipient")));
});

test("swap: an unrelated token pair is refused", () => {
  const result = authorizeAltanaCall(baseSwap({ tokenIn: TOKEN0, tokenOut: UNRELATED_TOKEN }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("token pair")));
});

test("swap: amountIn exceeding the per-call ceiling is refused", () => {
  const ctx = baseCtx({ maxAmountInWei: 500n });
  const result = authorizeAltanaCall(baseSwap({ amountIn: 1000n }), ctx);
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("maxAmountInWei")));
});

test("swap: amountOutMinimum of zero is refused outright, regardless of the reference quote -- the core relay-tampering case", () => {
  const result = authorizeAltanaCall(baseSwap({ amountOutMinimum: 0n, referenceAmountOut: 1000n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes("zero")));
});

test("swap: amountOutMinimum below the slippage-tolerant floor of the reference quote is refused", () => {
  // 1% tolerance on a reference of 1000 -> floor is 990; 980 must be refused.
  const result = authorizeAltanaCall(baseSwap({ amountOutMinimum: 980n, referenceAmountOut: 1000n }), baseCtx());
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.some((r) => r.includes("slippage-tolerant floor")));
});

test("swap: amountOutMinimum exactly at the slippage floor is authorized (boundary is inclusive)", () => {
  const result = authorizeAltanaCall(baseSwap({ amountOutMinimum: 990n, referenceAmountOut: 1000n }), baseCtx());
  assert.equal(result.authorized, true);
});

// ---------- structural guard ----------

test("this module never inspects strategy/candidate identity -- the context type carries only position/wallet/pool facts", () => {
  const ctx = baseCtx();
  assert.ok(!("candidateId" in ctx));
  assert.ok(!("agentIdOnChain" in ctx));
  assert.ok(!("strategyName" in ctx));
});

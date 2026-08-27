// Argument-level call policy (custody architecture, phase 1): the boundary the custody decision
// requires on top of Altana session delegation. Altana's own on-chain permission model scopes a
// session to (target contract, function selector) only -- see the threat-model review -- with no
// constraint on the ABI-encoded arguments inside an allowed call. That means a session correctly
// scoped to "collect() on the NFPM" is, as far as Altana itself is concerned, equally happy to
// collect a DIFFERENT tokenId or pay out to a DIFFERENT recipient. This module is the independent
// check that closes that gap: given the exact decoded parameters of a call VEYRA is about to make
// through an Altana session, and the position/wallet that session is actually supposed to act for,
// it decides whether those parameters are the ones that were actually authorized. It never talks to
// Altana, never signs anything, and never inspects strategy/candidate identity -- same discipline as
// executionPolicy.ts, one layer lower: that module gates WHEN to execute; this one gates WHAT, exactly,
// is being sent.

export type AltanaOperation =
  | { kind: "collect"; tokenId: bigint; recipient: `0x${string}`; amount0Max: bigint; amount1Max: bigint }
  | { kind: "decreaseLiquidity"; tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }
  | {
      kind: "mint";
      token0: `0x${string}`;
      token1: `0x${string}`;
      fee: number;
      tickLower: number;
      tickUpper: number;
      amount0Desired: bigint;
      amount1Desired: bigint;
      amount0Min: bigint;
      amount1Min: bigint;
      recipient: `0x${string}`;
      deadline: bigint;
    }
  | {
      kind: "swap";
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      fee: number;
      recipient: `0x${string}`;
      deadline: bigint;
      amountIn: bigint;
      amountOutMinimum: bigint;
      /** VEYRA's own independently-computed expected output (e.g. from QuoterV2), never taken from the call itself. */
      referenceAmountOut: bigint;
    };

export interface AltanaAuthorizedContext {
  /** The one position this session may ever act on. Substituting a different tokenId is exactly the gap Altana's own selector-level scoping leaves open. */
  authorizedTokenId: bigint;
  /** Every recipient field, on every operation that has one, must resolve to this address -- never anything the relay or a call's own payload supplies. */
  authorizedWallet: `0x${string}`;
  /** The pool's two tokens, order-independent, and its fee tier -- what `mint`/`swap` are allowed to touch. */
  authorizedToken0: `0x${string}`;
  authorizedToken1: `0x${string}`;
  authorizedFee: number;
  /** Per-call ceiling. Altana's own spend permission is a rolling-window aggregate (see threat model §6); it cannot express a single-call bound, so that has to live here. */
  maxAmountInWei: bigint;
  /**
   * Per-call ceiling on decreaseLiquidity's `liquidity` argument, in the pool's own liquidity
   * units (not token wei -- a distinct unit system, so this is intentionally separate from
   * maxAmountInWei rather than overloading it). Added during Gate 1 integration: mint and swap
   * both had a per-call ceiling on their amount arguments already; decreaseLiquidity -- one of the
   * two operations (with collect) that can actually move value -- had none. Treated as the
   * correctness gap it is, not a new design decision.
   */
  maxDecreaseLiquidity: bigint;
  /** Tolerance applied to amount0Min/amount1Min/amountOutMinimum against the reference values supplied per-call. */
  maxSlippageBps: number;
  /** Supplied by the caller, never read internally -- keeps this function pure and testable without a clock. */
  nowUnixSeconds: bigint;
  /** How far into the future a deadline may be set. A deadline far beyond this is itself suspicious: it lets a stale call sit valid for longer than any legitimate VEYRA flow needs. */
  maxDeadlineSecondsAhead: number;
}

export interface AltanaCallAuthorizationResult {
  authorized: boolean;
  reasons: string[];
}

function isSameAddress(a: `0x${string}`, b: `0x${string}`): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function checkRecipient(reasons: string[], recipient: `0x${string}`, ctx: AltanaAuthorizedContext): void {
  if (!isSameAddress(recipient, ctx.authorizedWallet)) {
    reasons.push(`recipient ${recipient} does not match the authorized wallet ${ctx.authorizedWallet}`);
  }
}

function checkTokenId(reasons: string[], tokenId: bigint, ctx: AltanaAuthorizedContext): void {
  if (tokenId !== ctx.authorizedTokenId) {
    reasons.push(`tokenId ${tokenId} does not match the authorized position ${ctx.authorizedTokenId}`);
  }
}

function checkDeadline(reasons: string[], deadline: bigint, ctx: AltanaAuthorizedContext): void {
  if (deadline < ctx.nowUnixSeconds) {
    reasons.push(`deadline ${deadline} is already in the past (now ${ctx.nowUnixSeconds})`);
  } else if (deadline > ctx.nowUnixSeconds + BigInt(ctx.maxDeadlineSecondsAhead)) {
    reasons.push(
      `deadline ${deadline} is ${deadline - ctx.nowUnixSeconds}s ahead, exceeding maxDeadlineSecondsAhead (${ctx.maxDeadlineSecondsAhead}s)`,
    );
  }
}

/** min acceptable = reference * (10000 - maxSlippageBps) / 10000, rounded down. */
function minAcceptable(reference: bigint, maxSlippageBps: number): bigint {
  return (reference * BigInt(10_000 - maxSlippageBps)) / 10_000n;
}

function checkAgainstReference(reasons: string[], label: string, supplied: bigint, reference: bigint, ctx: AltanaAuthorizedContext): void {
  const floor = minAcceptable(reference, ctx.maxSlippageBps);
  if (supplied < floor) {
    reasons.push(`${label} ${supplied} is below the slippage-tolerant floor ${floor} (reference ${reference}, maxSlippageBps ${ctx.maxSlippageBps})`);
  }
}

function checkPoolTokens(reasons: string[], tokenA: `0x${string}`, tokenB: `0x${string}`, fee: number, ctx: AltanaAuthorizedContext): void {
  const authorizedPair =
    (isSameAddress(tokenA, ctx.authorizedToken0) && isSameAddress(tokenB, ctx.authorizedToken1)) ||
    (isSameAddress(tokenA, ctx.authorizedToken1) && isSameAddress(tokenB, ctx.authorizedToken0));
  if (!authorizedPair) {
    reasons.push(`token pair (${tokenA}, ${tokenB}) does not match the authorized pool (${ctx.authorizedToken0}, ${ctx.authorizedToken1})`);
  }
  if (fee !== ctx.authorizedFee) {
    reasons.push(`fee tier ${fee} does not match the authorized fee tier ${ctx.authorizedFee}`);
  }
}

/**
 * Pure decision function: given the exact decoded parameters of one Altana-session-authorized
 * call, and the position/wallet that session is supposed to be acting for, says whether those
 * specific parameters are authorized to proceed. This is deliberately independent of, and
 * downstream of, executionPolicy.ts / simulation.ts -- this module assumes the decision to act has
 * already cleared those gates, and checks only whether the call about to be sent is the one that
 * was actually meant.
 */
export function authorizeAltanaCall(op: AltanaOperation, ctx: AltanaAuthorizedContext): AltanaCallAuthorizationResult {
  const reasons: string[] = [];

  switch (op.kind) {
    case "collect": {
      checkTokenId(reasons, op.tokenId, ctx);
      checkRecipient(reasons, op.recipient, ctx);
      if (op.amount0Max <= 0n && op.amount1Max <= 0n) {
        reasons.push("amount0Max and amount1Max are both zero -- not a valid collect (and this exact combination reverts on-chain regardless)");
      }
      break;
    }
    case "decreaseLiquidity": {
      // No recipient field exists on decreaseLiquidity: it only converts liquidity into the
      // position's internal tokensOwed balance and never moves value out. collect() is the only
      // operation that can actually redirect funds, so recipient scoping doesn't apply here.
      checkTokenId(reasons, op.tokenId, ctx);
      checkDeadline(reasons, op.deadline, ctx);
      if (op.liquidity <= 0n) {
        reasons.push("liquidity must be > 0");
      }
      if (op.liquidity > ctx.maxDecreaseLiquidity) {
        reasons.push(`liquidity ${op.liquidity} exceeds the per-call ceiling maxDecreaseLiquidity (${ctx.maxDecreaseLiquidity})`);
      }
      break;
    }
    case "mint": {
      checkPoolTokens(reasons, op.token0, op.token1, op.fee, ctx);
      checkRecipient(reasons, op.recipient, ctx);
      checkDeadline(reasons, op.deadline, ctx);
      if (op.tickLower >= op.tickUpper) {
        reasons.push(`tickLower (${op.tickLower}) must be < tickUpper (${op.tickUpper})`);
      }
      if (op.amount0Desired > ctx.maxAmountInWei || op.amount1Desired > ctx.maxAmountInWei) {
        reasons.push(`amount0Desired/amount1Desired exceed the per-call ceiling maxAmountInWei (${ctx.maxAmountInWei})`);
      }
      if (op.amount0Desired <= 0n && op.amount1Desired <= 0n) {
        // Mirrors collect's zero/zero rejection: a mint depositing nothing on either side is not
        // a valid operation this policy should wave through, independent of whether the
        // underlying contract would also reject it.
        reasons.push("amount0Desired and amount1Desired are both zero -- not a valid mint");
      }
      break;
    }
    case "swap": {
      checkPoolTokens(reasons, op.tokenIn, op.tokenOut, op.fee, ctx);
      checkRecipient(reasons, op.recipient, ctx);
      checkDeadline(reasons, op.deadline, ctx);
      if (op.amountIn > ctx.maxAmountInWei) {
        reasons.push(`amountIn ${op.amountIn} exceeds the per-call ceiling maxAmountInWei (${ctx.maxAmountInWei})`);
      }
      if (op.amountOutMinimum <= 0n) {
        // The threat model's central relay-tampering finding: nothing stops a compromised relay
        // from presenting a call whose amountOutMinimum was weakened to 0 for signing. Refusing a
        // zero minimum outright, independent of the reference check below, closes that specific case
        // even if referenceAmountOut were itself wrong or missing.
        reasons.push("amountOutMinimum is zero -- refusing regardless of reference quote (this is the exact relay-tampering case the policy layer exists to catch)");
      }
      checkAgainstReference(reasons, "amountOutMinimum", op.amountOutMinimum, op.referenceAmountOut, ctx);
      break;
    }
  }

  return { authorized: reasons.length === 0, reasons };
}

// Gate 3: relay-centralization risk mitigation. Altana's relay is a single, centrally-operated
// endpoint per network (see the threat-model review), and it sits on the only path in and out of
// every session action -- including revocation. Nothing in this module fixes that; a single
// operator cannot be turned into a decentralized one by policy. What this module bounds is the
// EXPOSURE WINDOW: the shorter a session's maximum lifetime, the less time a malicious or
// unavailable relay has to matter before the session expires on its own, with or without a
// successful revoke. This is the one concrete, buildable mitigation available at VEYRA's own
// layer, and it is enforced BEFORE a grant request is ever made, the same way authorizeAltanaCall
// gates a call before it's ever built.

export interface SessionLifetimePolicy {
  /** The longest a session may live, regardless of what any individual grant request asks for. */
  maxSessionLifetimeSeconds: number;
}

/**
 * 10 minutes -- matches every session actually granted during this project's live Altana
 * verification work. Not derived from anything else; a policy choice, same as
 * executionPolicy.ts's maxObservationAgeBlocks.
 */
export const DEFAULT_SESSION_LIFETIME_POLICY: SessionLifetimePolicy = {
  maxSessionLifetimeSeconds: 600,
};

export interface ValidateSessionLifetimeInputs {
  policy: SessionLifetimePolicy;
  /** Unix seconds -- the expiry a grant request is about to ask Altana for. */
  requestedExpiry: number;
  /** Supplied by the caller, never read internally -- keeps this function pure and testable without a clock. */
  nowUnixSeconds: number;
}

export interface ValidateSessionLifetimeResult {
  authorized: boolean;
  reasons: string[];
  requestedLifetimeSeconds: number;
}

/**
 * Pure decision function: should VEYRA even ASK Altana to grant a session with this expiry? Runs
 * before any grantSession call is made, mirroring authorizeAltanaCall's own "reject before the SDK
 * is touched" discipline one level earlier in the lifecycle -- this gate is about whether to
 * create a session at all, not about what an already-granted session may do.
 */
export function validateSessionLifetime(inputs: ValidateSessionLifetimeInputs): ValidateSessionLifetimeResult {
  const reasons: string[] = [];
  const requestedLifetimeSeconds = inputs.requestedExpiry - inputs.nowUnixSeconds;

  if (requestedLifetimeSeconds <= 0) {
    reasons.push(`requested expiry ${inputs.requestedExpiry} is not in the future (now ${inputs.nowUnixSeconds})`);
  } else if (requestedLifetimeSeconds > inputs.policy.maxSessionLifetimeSeconds) {
    reasons.push(
      `requested session lifetime ${requestedLifetimeSeconds}s exceeds policy.maxSessionLifetimeSeconds (${inputs.policy.maxSessionLifetimeSeconds}s) -- ` +
        "a shorter-lived session bounds how long a malicious or unavailable relay can matter before the session expires on its own",
    );
  }

  return { authorized: reasons.length === 0, reasons, requestedLifetimeSeconds };
}

// Gate 4 (buildable slice): a multi-session emergency-pause primitive. Altana's own revocation is
// per-session -- there is no single circuit breaker across several concurrent sessions (see the
// threat-model review, "emergency pause: no primitive found"). This module is that primitive at
// the code level: given a list of sessions, revoke every one of them, independently, and report
// exactly what happened to each. It is NOT the user-facing authorization/revocation product
// (wallet-connect, per-user session storage, a UI) -- that requires real backend infrastructure
// this project doesn't have yet and is explicitly out of scope for this phase.

/** Minimal shape this module needs to revoke one session -- decoupled from the concrete Altana
 *  admin provider the same way txSigner.ts/altanaExecutor.ts decouple from their SDKs, so this is
 *  testable with a plain spy and no real session or network call. */
export interface SessionRevoker {
  revokeSession(session: unknown): Promise<{ status: string; transactionHash?: `0x${string}` }>;
}

export interface RevocableSession {
  /** Identifies this session in the report only -- never used for any authorization decision. */
  label: string;
  /** The concrete Altana session object, passed through verbatim to the revoker. */
  session: unknown;
}

export interface SessionRevocationOutcome {
  label: string;
  revoked: boolean;
  error: string | null;
  transactionHash: `0x${string}` | null;
}

export interface PauseAllSessionsResult {
  outcomes: SessionRevocationOutcome[];
  revokedCount: number;
  failedCount: number;
  allRevoked: boolean;
}

/**
 * Revoke every session in the list. A failure revoking one session must never stop the rest from
 * being attempted -- an incident response needs "revoke as many as possible, and tell me exactly
 * which ones didn't go through," not "abort at the first error." Every outcome is reported,
 * success or failure, in the same order the sessions were given.
 */
export async function pauseAllSessions(sessions: readonly RevocableSession[], revoker: SessionRevoker): Promise<PauseAllSessionsResult> {
  const outcomes: SessionRevocationOutcome[] = [];

  for (const entry of sessions) {
    try {
      const result = await revoker.revokeSession(entry.session);
      outcomes.push({ label: entry.label, revoked: true, error: null, transactionHash: result.transactionHash ?? null });
    } catch (err) {
      outcomes.push({ label: entry.label, revoked: false, error: err instanceof Error ? err.message : String(err), transactionHash: null });
    }
  }

  const revokedCount = outcomes.filter((o) => o.revoked).length;
  const failedCount = outcomes.length - revokedCount;
  return { outcomes, revokedCount, failedCount, allRevoked: failedCount === 0 };
}

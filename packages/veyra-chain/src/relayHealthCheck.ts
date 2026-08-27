// Gate 3: a lightweight reachability check for Altana's relay, meant to run before granting a new
// session. Granting trust in a relay that's already unreachable compounds the exact risk this
// gate exists to bound: the relay is also the only revocation path (see the threat-model and Gate
// 2 reviews), so a session granted against a relay that's already failing may not be revocable
// either. This does not and cannot fix relay centralization -- it only avoids making a bad
// situation worse by refusing new trust while the one path to withdraw it is already unhealthy.

export interface RelayHealthCheckResult {
  healthy: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface CheckRelayHealthOpts {
  relayUrl: string;
  timeoutMs?: number;
  /** Injectable for tests -- never defaults to a real network call in a unit test. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Sends a minimal, side-effect-free JSON-RPC request (web3_clientVersion -- no chain state, no
 * account data) and reports whether the relay answered within the timeout. A pure reachability
 * signal, not a correctness check of anything the relay does once reachable.
 */
export async function checkRelayHealth(opts: CheckRelayHealthOpts): Promise<RelayHealthCheckResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchFn(opts.relayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    return { healthy: response.ok, latencyMs, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (err) {
    return { healthy: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

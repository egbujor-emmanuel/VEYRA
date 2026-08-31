// The visitor-facing wallet + authorization panel. This is the piece that makes VEYRA a
// marketplace rather than a display case: a stranger creates their own real smart account here
// and grants VEYRA scoped authority over their own funds, with a biometric prompt.

import { useUserWallet } from "../hooks/useUserWallet";

const DEFAULT_SPEND_LIMIT_WEI = 50_000_000_000_000_000n; // 0.05 BNB/day ceiling
const DEFAULT_SESSION_SECONDS = 3600; // 1 hour -- deliberately short; re-grant is one prompt

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletPanel() {
  const { state, create, recover, grant, revoke } = useUserWallet();

  return (
    <div className="panel">
      <h2>Your wallet</h2>

      {state.status === "disconnected" && (
        <>
          <p className="rationale">
            Create a wallet secured by your device's biometrics — no extension, no seed phrase, nothing to write down.
            You keep custody; VEYRA only ever gets a scoped, expiring key you can revoke.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={create}>Create wallet</button>
            <button className="btn btn-secondary" onClick={recover}>I already have one</button>
          </div>
        </>
      )}

      {state.status === "working" && (
        <p className="rationale" style={{ margin: 0 }}>
          <span className="dot-neutral" />
          {state.note}
        </p>
      )}

      {state.status === "error" && (
        <>
          <div className="error-box" style={{ marginBottom: 16 }}>{state.message}</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-secondary" onClick={create}>Try creating again</button>
            <button className="btn btn-secondary" onClick={recover}>Try recovering</button>
          </div>
        </>
      )}

      {state.status === "ready" && (
        <>
          <div className="hero-grid" style={{ marginBottom: 20 }}>
            <div className="hero-stat">
              <span className="k">Your account</span>
              <span className="v">{short(state.wallet.address)}</span>
            </div>
            <div className="hero-stat">
              <span className="k">VEYRA authorization</span>
              <span className="v">
                {state.session ? (
                  <span className="status-pill status-good"><span className="dot-good" />Active</span>
                ) : (
                  <span className="status-pill status-muted">Not granted</span>
                )}
              </span>
            </div>
            {state.session && (
              <div className="hero-stat">
                <span className="k">Expires</span>
                <span className="v">{new Date(state.session.expiry * 1000).toLocaleTimeString()}</span>
              </div>
            )}
          </div>

          {!state.session ? (
            <>
              <p className="rationale">
                Grant VEYRA a session scoped to PancakeSwap V3 position management only, capped at 0.05 BNB/day,
                expiring in one hour. It cannot touch anything else, and you can revoke it at any time.
              </p>
              <button className="btn btn-accent" onClick={() => grant(DEFAULT_SPEND_LIMIT_WEI, DEFAULT_SESSION_SECONDS)}>
                Authorize VEYRA
              </button>
            </>
          ) : (
            <>
              <p className="rationale">
                VEYRA can now manage your positions within the granted scope. Revoking takes effect on-chain
                immediately — the next call it attempts fails at the validator.
              </p>
              <button className="btn btn-secondary" onClick={revoke}>Revoke authorization</button>
            </>
          )}
        </>
      )}
    </div>
  );
}

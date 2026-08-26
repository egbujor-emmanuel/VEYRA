import { useLivePosition } from "../hooks/useLivePosition";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { VEYRA_AGENT_ID, ERC8004_REGISTRY_ADDRESS, VEYRA_WALLET } from "../constants";

export function LiveHero() {
  const { query, refetch } = useLivePosition();

  return (
    <div className="panel">
      <h2>Live State <ProvenanceBadge tier="OBSERVED" /></h2>

      <div className="kv" style={{ marginBottom: 16 }}>
        <div>
          <span className="k">VEYRA Agent</span>
          <span className="v">#{VEYRA_AGENT_ID} (documented identity, ERC-8004 registry {ERC8004_REGISTRY_ADDRESS.slice(0, 10)}…)</span>
        </div>
        <div>
          <span className="k">Owner wallet</span>
          <span className="v">{VEYRA_WALLET}</span>
        </div>
      </div>

      {query.status === "loading" && (
        <p className="subtitle">Reading live position state from BSC testnet…</p>
      )}

      {query.status === "error" && (
        <div className="error-box">
          <strong>Live read failed:</strong> {query.message}
          <div style={{ marginTop: 10 }}>
            <button className="retry-btn" onClick={refetch}>Retry</button>
          </div>
        </div>
      )}

      {query.status === "ready" && (
        <>
          <div className="hero-grid">
            <div className="hero-stat">
              <div className="label">Position</div>
              <div className="value">#{query.data.observation.positionTokenId.toString()}</div>
            </div>
            <div className="hero-stat">
              <div className="label">Owner verified</div>
              <div className="value">
                <span className={`status-pill ${query.data.ownershipVerified ? "status-good" : "status-bad"}`}>
                  {query.data.ownershipVerified ? "VERIFIED" : "MISMATCH"}
                </span>
              </div>
            </div>
            <div className="hero-stat">
              <div className="label">Current tick</div>
              <div className="value">{query.data.observation.currentTick}</div>
            </div>
            <div className="hero-stat">
              <div className="label">Range</div>
              <div className="value">
                [{query.data.observation.tickLower}, {query.data.observation.tickUpper})
              </div>
            </div>
            <div className="hero-stat">
              <div className="label">In range</div>
              <div className="value">
                <span className={`status-pill ${query.data.inRange ? "status-good" : "status-bad"}`}>
                  {query.data.inRange ? "IN RANGE" : "OUT OF RANGE"}
                </span>
              </div>
            </div>
            <div className="hero-stat">
              <div className="label">Liquidity</div>
              <div className="value">{query.data.observation.positionLiquidity.toString()}</div>
            </div>
          </div>

          <div className="freshness">
            <span>Read at block <strong>{query.data.observation.blockNumber.toString()}</strong>, fetched {new Date(query.data.fetchedAt).toLocaleString()}</span>
            <button className="retry-btn" onClick={refetch}>Refresh</button>
          </div>
        </>
      )}
    </div>
  );
}

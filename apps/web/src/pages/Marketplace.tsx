import { Link } from "react-router-dom";
import { AGENT_CATALOG } from "../data/agentCatalog";
import { MaturityBadge } from "../components/MaturityBadge";
import { StatusTicker } from "../components/StatusTicker";
import { WalletPanel } from "../components/WalletPanel";

export function Marketplace() {
  return (
    <>
      <StatusTicker />
      <div className="wrap">
        <span className="eyebrow">Autonomous finance on BNB Chain</span>
        <h1>Hire an agent to run your position.</h1>
        <p className="subtitle">
          Four agents, each with a verifiable on-chain record. Create a wallet with your fingerprint,
          grant a scoped key that expires, and revoke it whenever you want. Your funds never leave your account.
        </p>

        <WalletPanel />

        <h2 style={{ marginTop: 48 }}>Available agents</h2>
        <div className="cards">
          {AGENT_CATALOG.map((agent) => (
            <Link key={agent.id} to={`/agents/${agent.id}`} className="card">
              <div className="candidate-name">{agent.displayName}</div>
              <p className="rationale">{agent.shortDescription}</p>
              <MaturityBadge maturity={agent.maturity} />
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}

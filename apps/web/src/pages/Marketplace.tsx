import { Link } from "react-router-dom";
import { AGENT_CATALOG } from "../data/agentCatalog";
import { MaturityBadge } from "../components/MaturityBadge";

export function Marketplace() {
  return (
    <div className="wrap">
      <h1>VEYRA Agent Marketplace</h1>
      <p className="subtitle">All four categories, surfaced with equal depth. Each card links to the category's real, current state -- never a mock-up.</p>
      <div className="cards">
        {AGENT_CATALOG.map((agent) => (
          <Link key={agent.id} to={`/agents/${agent.id}`} className="card" style={{ textDecoration: "none", color: "inherit" }}>
            <div className="candidate-name">{agent.displayName}</div>
            <p className="rationale">{agent.shortDescription}</p>
            <MaturityBadge maturity={agent.maturity} />
          </Link>
        ))}
      </div>
    </div>
  );
}

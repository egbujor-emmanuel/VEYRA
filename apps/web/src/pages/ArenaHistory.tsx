import { Link } from "react-router-dom";
import { archiveManifest } from "../data/loadArchive";

export function ArenaHistory() {
  const roundIds = [...archiveManifest.arenaRoundIds].sort((a, b) => b - a);
  return (
    <div className="wrap">
      <h1>Arena History</h1>
      <p className="subtitle">Every v2 (market-aware evaluator) arena round, in order. v1 rounds are preserved in the legacy demo page, not shown here.</p>
      <div className="panel" style={{ padding: 0 }}>
        {roundIds.map((id) => (
          <Link key={id} to={`/arena/${id}`} className="list-row">
            <span>Round #{id}</span>
            <span style={{ color: "var(--muted)", fontSize: "0.82rem" }}>view →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

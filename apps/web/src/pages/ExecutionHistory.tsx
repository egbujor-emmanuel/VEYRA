import { Link } from "react-router-dom";
import { archiveManifest } from "../data/loadArchive";

function outcomeColor(outcome: string) {
  if (outcome === "EXECUTED") return "status-good";
  if (outcome === "EXECUTION_BLOCKED") return "status-muted";
  if (outcome.endsWith("_FAILED")) return "status-bad";
  return "status-muted";
}

export function ExecutionHistory() {
  const entries = [...archiveManifest.entries].sort((a, b) => b.runArchiveId - a.runArchiveId);
  return (
    <div className="wrap">
      <h1>Execution History</h1>
      <p className="subtitle">Every agent-arena-loop run, including blocked and failed attempts — nothing hidden.</p>
      <div className="panel" style={{ padding: 0 }}>
        {entries.map((e) => (
          <Link key={e.runArchiveId} to={`/executions/${e.runArchiveId}`} className="list-row">
            <span>Run #{e.runArchiveId} — {e.winnerCandidateId}</span>
            <span>
              <span className={`status-pill ${outcomeColor(e.effectiveOutcome)}`}>{e.effectiveOutcome}</span>
              {e.amendment && <span style={{ marginLeft: 8, fontSize: "0.75rem", color: "var(--muted)" }}>(resumed & completed)</span>}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

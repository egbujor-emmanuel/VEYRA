import type { ArchivedSimulation } from "../data/types";
import { ProvenanceBadge } from "./ProvenanceBadge";

function statusPill(status: string) {
  const good = status === "VALID" || status === "true";
  const bad = status === "INVALID";
  const cls = good ? "status-good" : bad ? "status-bad" : "status-muted";
  return <span className={`status-pill ${cls}`}>{status}</span>;
}

export function SimulationPanel({ simulation }: { simulation: ArchivedSimulation }) {
  if (simulation.action === "HOLD") {
    return (
      <div className="panel">
        <h2>Safety Checks <ProvenanceBadge tier="SIMULATED" /></h2>
        <p className="subtitle">Hold requires no simulation — nothing to validate. Not a manufactured pass, simply nothing to check.</p>
      </div>
    );
  }

  const strandedPct = (simulation.ratioAdjustment.strandedFraction0 * 100).toFixed(3);
  const strandedPct1 = (simulation.ratioAdjustment.strandedFraction1 * 100).toFixed(3);

  return (
    <div className="panel">
      <h2>Safety Checks <ProvenanceBadge tier="SIMULATED" /></h2>
      <div className="kv" style={{ marginBottom: 14 }}>
        <div><span className="k">Target range validity</span><span className="v">{statusPill(simulation.targetRangeValidity.status)}</span></div>
        <div><span className="k">Mint structural validity</span><span className="v">{statusPill(simulation.mintStructuralValidity.status)}</span></div>
        <div><span className="k">Slippage protection</span><span className="v">{statusPill(simulation.slippageProtection.status)}</span></div>
        {simulation.ratioFixLive && <div><span className="k">Ratio-fixing swap (live quote)</span><span className="v">{statusPill(simulation.ratioFixLive.status)}</span></div>}
      </div>
      <div className="panel" style={{ background: "var(--panel-2)", margin: 0 }}>
        <div style={{ fontSize: "0.85rem", marginBottom: 8 }}>Stranded capital (without a fix): <strong>{strandedPct}%</strong> token0 / <strong>{strandedPct1}%</strong> token1</div>
        <div style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{simulation.ratioAdjustment.detail}</div>
      </div>
      <div style={{ marginTop: 14 }}>
        <span className={`status-pill ${simulation.executable ? "status-good" : "status-bad"}`}>
          {simulation.executable ? "EXECUTABLE" : "BLOCKED"}
        </span>
        {!simulation.executable && (
          <ul style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: 8 }}>
            {simulation.executableReasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

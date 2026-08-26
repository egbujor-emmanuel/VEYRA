import type { ArchiveManifest } from "../data/types";

// Every number here comes straight from the build-time-generated manifest (see
// scripts/generateArchiveManifest.ts) -- nothing in this component computes or invents a count.
export function TrackRecordStat({ manifest }: { manifest: ArchiveManifest }) {
  return (
    <div className="panel">
      <h2>Verified Track Record</h2>
      <p className="subtitle" style={{ marginBottom: 16 }}>
        Computed fresh from the actual archived run files on every build — never hand-typed. Ambient/test-infrastructure records are structurally excluded.
      </p>
      <div className="stat-grid">
        <div className="stat-box">
          <div className="num" style={{ color: "var(--good)" }}>{manifest.executedJobs}</div>
          <div className="lbl">Executed</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: "var(--warn)" }}>{manifest.executionBlockedJobs}</div>
          <div className="lbl">Blocked by Safety Gate</div>
        </div>
        <div className="stat-box">
          <div className="num">{manifest.totalRuns}</div>
          <div className="lbl">Total Runs</div>
        </div>
        <div className="stat-box">
          <div className="num" style={{ color: "var(--accent)" }}>{manifest.wonByOurAgent}</div>
          <div className="lbl">Won by RangeKeeper</div>
        </div>
      </div>
      <p style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 14 }}>
        {manifest.executionBlockedJobs} blocked run(s) mean the safety gate correctly refused to execute an unsafe rebalance — that's the architecture working as intended, not a shortfall.
      </p>
    </div>
  );
}

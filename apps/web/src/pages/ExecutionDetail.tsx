import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { RunNarrative } from "../components/RunNarrative";
import { archiveManifest, loadAgentArenaRun, loadResumedMintAmendment } from "../data/loadArchive";
import type { AgentArenaRun, ResumedMintAmendment } from "../data/types";

export function ExecutionDetail() {
  const { runArchiveId } = useParams();
  const [run, setRun] = useState<AgentArenaRun | null>(null);
  const [amendment, setAmendment] = useState<ResumedMintAmendment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runArchiveId) return;
    const entry = archiveManifest.entries.find((e) => e.runArchiveId === Number(runArchiveId));
    if (!entry) {
      setError(`No run #${runArchiveId} found in the archive manifest`);
      return;
    }
    loadAgentArenaRun(entry.sourceFile).then(setRun).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    if (entry.amendment) {
      loadResumedMintAmendment(entry.amendment.sourceFile).then(setAmendment).catch(() => {});
    }
  }, [runArchiveId]);

  if (error) return <div className="wrap"><div className="error-box">{error}</div></div>;
  if (!run) return <div className="wrap"><p className="subtitle">Loading…</p></div>;

  return (
    <div className="wrap">
      <p><Link to="/executions">← Execution History</Link></p>
      <h1>Run #{run.runArchiveId}</h1>
      <p className="subtitle">Round #{run.roundId} · Winner: {run.winnerCandidateId} · Final state: {run.finalState}</p>
      <RunNarrative run={run} amendment={amendment} />
    </div>
  );
}

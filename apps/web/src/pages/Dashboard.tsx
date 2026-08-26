import { useEffect, useState } from "react";
import { LiveHero } from "../components/LiveHero";
import { ArenaCandidateCard } from "../components/ArenaCandidateCard";
import { ExecutionPlanPanel } from "../components/ExecutionPlanPanel";
import { SimulationPanel } from "../components/SimulationPanel";
import { RunNarrative } from "../components/RunNarrative";
import { TrackRecordStat } from "../components/TrackRecordStat";
import { ProvenanceBadge } from "../components/ProvenanceBadge";
import { archiveManifest, loadArenaRound, loadAgentArenaRun, loadResumedMintAmendment } from "../data/loadArchive";
import type { ArenaRound, AgentArenaRun, ResumedMintAmendment } from "../data/types";

export function Dashboard() {
  const [round, setRound] = useState<ArenaRound | null>(null);
  const [flagshipRun, setFlagshipRun] = useState<AgentArenaRun | null>(null);
  const [flagshipAmendment, setFlagshipAmendment] = useState<ResumedMintAmendment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadArenaRound(archiveManifest.latestRoundId)
      .then(setRound)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    // The flagship narrative is whichever run has a real amendment (a real failure that was
    // fixed and completed) -- not a hardcoded run number, so this stays correct if it happens again.
    const flagshipEntry = archiveManifest.entries.find((e) => e.amendment !== null);
    if (flagshipEntry) {
      loadAgentArenaRun(flagshipEntry.sourceFile).then(setFlagshipRun).catch(() => {});
      loadResumedMintAmendment(flagshipEntry.amendment!.sourceFile).then(setFlagshipAmendment).catch(() => {});
    }
  }, []);

  return (
    <div className="wrap">
      <h1>VEYRA</h1>
      <p className="subtitle">The intelligence layer for autonomous finance — real identity, real market observation, real safety gates, real execution.</p>

      <LiveHero />

      {error && <div className="error-box">Failed to load archived arena data: {error}</div>}

      {round && (
        <>
          <div className="panel">
            <h2>Agent Arena — Round #{round.roundId} <ProvenanceBadge tier="DERIVED" /></h2>
            <p className="subtitle" style={{ marginBottom: 16 }}>
              Same live market state handed to all three candidates. The winner is whichever proposal actually scores best — never assumed.
            </p>
            <div className="cards">
              {round.proposals.map((p) => (
                <ArenaCandidateCard key={p.candidateId} proposal={p} />
              ))}
            </div>
          </div>

          <ExecutionPlanPanel plan={round.executionPlan} />
          <SimulationPanel simulation={round.simulation} />
        </>
      )}

      {flagshipRun && (
        <RunNarrative run={flagshipRun} amendment={flagshipAmendment} />
      )}

      <TrackRecordStat manifest={archiveManifest} />

      <footer className="app-footer">
        VEYRA — BSC Testnet. Full round/run history in <a href="#/arena">Arena</a> and <a href="#/executions">Executions</a>.
        {" · "}
        <a href={`${import.meta.env.BASE_URL}legacy/arena.html`} target="_blank" rel="noreferrer">legacy v1 demo page</a>
      </footer>
    </div>
  );
}

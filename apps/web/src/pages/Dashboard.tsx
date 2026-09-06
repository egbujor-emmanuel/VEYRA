import { useEffect, useState } from "react";
import { LiveHero } from "../components/LiveHero";
import { tiedWithWinner } from "../data/arenaTie";
import { ArenaCandidateCard } from "../components/ArenaCandidateCard";
import { ExecutionPlanPanel } from "../components/ExecutionPlanPanel";
import { SimulationPanel } from "../components/SimulationPanel";
import { RunNarrative } from "../components/RunNarrative";
import { TrackRecordStat } from "../components/TrackRecordStat";
import { ProvenanceBadge } from "../components/ProvenanceBadge";
import { archiveManifest, loadArenaRound, loadAgentArenaRun, loadResumedMintAmendment } from "../data/loadArchive";
import type { ArenaRound, AgentArenaRun, ResumedMintAmendment } from "../data/types";
import { PageHeader } from "../components/PageHeader";

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
      <PageHeader
        eyebrow="Live state"
        title="Rebalancing dashboard"
        lead="Position state read live from BSC testnet, the latest evaluation round in full, and the execution narrative of the run that put the current position on chain."
      />

      <LiveHero />

      {error && <div className="error-box">Failed to load archived arena data: {error}</div>}

      {round && (
        <>
          <div className="panel">
            <h2>Agent Arena — Round #{round.roundId} <ProvenanceBadge tier="DERIVED" /></h2>
            <p className="subtitle" style={{ marginBottom: 16 }}>
              Same live market state handed to all three candidates. The winner is whichever proposal actually scores best — never assumed. When two score identically on identical gas, the round is decided by evaluation order and is labelled as such.
            </p>
            <div className="cards">
              {round.proposals.map((p) => (
                <ArenaCandidateCard key={p.candidateId} proposal={p} tiedWith={tiedWithWinner(round.proposals)} />
              ))}
            </div>
          </div>

          {/* Plan and simulation each took a full-width panel to report that a hold needs neither.
              Paired so a round that did nothing occupies the space of a round that did nothing. */}
          <div className="grid gap-5 md:grid-cols-2">
            <ExecutionPlanPanel plan={round.executionPlan} />
            <SimulationPanel simulation={round.simulation} />
          </div>
        </>
      )}

      {/* The forensic record of one historical run: state transitions, every transaction, the
          root-cause write-up, the corrective swaps, the final mint. It is the strongest evidence
          on the site and it is also 2,000px of it, which pushed the live state and the track
          record apart until the page read as a wall. Collapsed, not cut -- the summary line says
          what it contains so nobody has to guess whether it is worth opening. */}
      {flagshipRun && (
        <details className="disclosure disclosure--panel">
          <summary>
            Execution narrative — run #{flagshipRun.runArchiveId}: every state transition, transaction
            hash and gas figure, including the failure and how it was corrected
          </summary>
          <RunNarrative run={flagshipRun} amendment={flagshipAmendment} />
        </details>
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

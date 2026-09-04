import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { tiedWithWinner } from "../data/arenaTie";
import { ArenaCandidateCard } from "../components/ArenaCandidateCard";
import { ExecutionPlanPanel } from "../components/ExecutionPlanPanel";
import { SimulationPanel } from "../components/SimulationPanel";
import { ProvenanceBadge } from "../components/ProvenanceBadge";
import { loadArenaRound } from "../data/loadArchive";
import type { ArenaRound } from "../data/types";

export function ArenaRoundDetail() {
  const { roundId } = useParams();
  const [round, setRound] = useState<ArenaRound | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roundId) return;
    loadArenaRound(Number(roundId)).then(setRound).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [roundId]);

  if (error) return <div className="wrap"><div className="error-box">{error}</div></div>;
  if (!round) return <div className="wrap"><p className="subtitle">Loading…</p></div>;

  return (
    <div className="wrap">
      <p><Link to="/arena">← Arena History</Link></p>
      <h1>Round #{round.roundId}</h1>
      <p className="subtitle">Evaluator: {round.evaluatorPolicy} · Generated {new Date(round.generatedAt).toLocaleString()}</p>

      <div className="panel">
        <h2>Market Snapshot <ProvenanceBadge tier="OBSERVED" /><ProvenanceBadge tier="SUPPLIED" /></h2>
        <div className="kv">
          <div><span className="k">Current tick</span><span className="v">{round.marketSnapshot.currentTick}</span></div>
          <div><span className="k">Current range</span><span className="v">[{round.marketSnapshot.currentRange.tickLower}, {round.marketSnapshot.currentRange.tickUpper})</span></div>
          <div><span className="k">Liquidity</span><span className="v">{round.marketSnapshot.currentLiquidity}</span></div>
          <div><span className="k">Recent volatility (bps)</span><span className="v">{round.marketSnapshot.recentVolatilityBps} — {round.marketSnapshot.recentVolatilityBpsProvenance}</span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Candidates</h2>
        <div className="cards">
          {round.proposals.map((p) => <ArenaCandidateCard key={p.candidateId} proposal={p} tiedWith={tiedWithWinner(round.proposals)} />)}
        </div>
      </div>

      <ExecutionPlanPanel plan={round.executionPlan} />
      <SimulationPanel simulation={round.simulation} />
    </div>
  );
}

import type { ArchivedProposal } from "../data/types";
import { ProvenanceBadge } from "./ProvenanceBadge";

// Winner styling comes ENTIRELY from proposal.isWinner (data-driven). No candidateId/
// displayLabel check anywhere in this file decides who "wins" -- that would violate the
// non-negotiable "never hardcode RangeKeeper as winner" rule.
export function ArenaCandidateCard({ proposal }: { proposal: ArchivedProposal }) {
  const labelClass = proposal.displayLabel === "Our Agent" ? "label-agent" : "label-baseline";
  const action =
    proposal.proposedAction.kind === "hold"
      ? "Hold — no rebalance"
      : `Rebalance to [${proposal.proposedAction.newRange?.tickLower}, ${proposal.proposedAction.newRange?.tickUpper})`;

  return (
    <article className={`card ${proposal.isWinner ? "card-winner" : ""}`}>
      {proposal.isWinner && <div className="winner-ribbon">WINNER</div>}
      <span className={`label-badge ${labelClass}`}>{proposal.displayLabel}</span>
      {proposal.agentIdOnChain !== null && (
        <span style={{ marginLeft: 8, fontSize: "0.7rem", color: "var(--muted)" }}>ERC-8004 #{proposal.agentIdOnChain}</span>
      )}
      <div className="candidate-name">{proposal.candidateId}</div>
      <p className="rationale" style={{ fontSize: "0.9rem", color: "var(--text)" }}>{action}</p>
      <p className="rationale">{proposal.rationale}</p>

      {proposal.score && (
        <div className="score-row">
          <div className="score-bar-track">
            <div className="score-bar-fill" style={{ width: `${Math.max(0, Math.min(100, proposal.score.totalScore))}%` }} />
          </div>
          <div className="score-value">{proposal.score.totalScore.toFixed(2)}</div>
        </div>
      )}

      {proposal.metrics && (
        <table className="metrics">
          <tbody>
            <tr><td>fee efficiency</td><td>{proposal.metrics.estimatedFeeEfficiency.toFixed(1)}</td><td><ProvenanceBadge tier="DERIVED" /></td></tr>
            <tr><td>risk score</td><td>{proposal.metrics.riskScore.toFixed(1)}</td><td><ProvenanceBadge tier="DERIVED" /></td></tr>
            <tr><td>gas (wei)</td><td>{proposal.metrics.estimatedGasWei}</td><td><ProvenanceBadge tier="DERIVED" /></td></tr>
            <tr><td>feasible</td><td>{proposal.metrics.executionFeasible ? "yes" : "no"}</td><td><ProvenanceBadge tier="DERIVED" /></td></tr>
          </tbody>
        </table>
      )}
    </article>
  );
}

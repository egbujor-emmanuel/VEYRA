// Shared scoring kernel (four-category expansion, Day 1). Extracted from evaluator.ts's and
// evaluatorV2.ts's previously-duplicated tails -- normalize each axis, weight, pick a winner
// (tie-broken by lowest gas). Every category's evaluator computes its OWN metrics
// (computeMetrics/computeMetricsV2/computeMetricsGrid/...), then hands them to this one,
// unmodified, scoring shell. This is a pure refactor: verified byte-identical against the
// existing evaluator.test.ts/evaluatorV2.test.ts suites before anything new was built on it.

import { normalize, weightsFor } from "./evaluator.js";
import type { JobSpec, ProposalMetrics, ScoreBreakdown, ScoredProposal, StrategyProposal } from "./types.js";

export function scoreProposals<M extends ProposalMetrics>(
  job: JobSpec,
  proposals: StrategyProposal[],
  metrics: M[],
): { scored: (ScoredProposal & { metrics: M })[]; winner: ScoredProposal & { metrics: M } } {
  const weights = weightsFor(job);

  const feeEffNorm = normalize(
    metrics.map((m) => m.estimatedFeeEfficiency),
    true,
  );
  const riskNorm = normalize(
    metrics.map((m) => m.riskScore),
    false, // lower risk is better
  );
  const gasNorm = normalize(
    metrics.map((m) => Number(m.estimatedGasWei)),
    false, // lower gas is better
  );
  const feasibilityNorm = metrics.map((m) => (m.executionFeasible ? 100 : 0));

  const scored = proposals.map((proposal, i) => {
    const normalized: ScoreBreakdown["normalized"] = {
      feeEfficiency: feeEffNorm[i]!,
      risk: riskNorm[i]!,
      gas: gasNorm[i]!,
      feasibility: feasibilityNorm[i]!,
    };
    const totalScore =
      weights.feeEfficiency * normalized.feeEfficiency +
      weights.risk * normalized.risk +
      weights.gas * normalized.gas +
      weights.feasibility * normalized.feasibility;

    return {
      proposal,
      metrics: metrics[i]!,
      score: { weights, normalized, totalScore },
      isWinner: false,
      wonByTiebreak: undefined as string[] | undefined,
    };
  });

  const winner = scored.reduce((best, current) => {
    if (current.score.totalScore > best.score.totalScore) return current;
    if (current.score.totalScore === best.score.totalScore) {
      return current.metrics.estimatedGasWei < best.metrics.estimatedGasWei ? current : best;
    }
    return best;
  });
  winner.isWinner = true;

  // Record when the "win" was not actually a win.
  //
  // Rounds 2-7 of the real archive all came out 75-75 between rangekeeper-v1 and
  // baseline-symmetric-range, with identical gas -- so the reduce above kept the first-listed
  // proposal, which happens to be ours. That is arbitrary, and reporting it as a win over a
  // baseline would overstate what the evaluator found. The selection rule is deliberately left
  // unchanged (it must stay deterministic, and rewriting it would not make the old rounds any
  // less tied); what changes is that a tie is now stated rather than hidden behind isWinner.
  const tiedWith = scored
    .filter(
      (s) =>
        s !== winner &&
        s.score.totalScore === winner.score.totalScore &&
        s.metrics.estimatedGasWei === winner.metrics.estimatedGasWei,
    )
    .map((s) => s.proposal.candidateId);
  if (tiedWith.length > 0) winner.wonByTiebreak = tiedWith;

  return { scored, winner };
}

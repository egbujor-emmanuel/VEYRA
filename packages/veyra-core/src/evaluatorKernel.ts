// Shared scoring kernel (four-category expansion, Day 1). Extracted from evaluator.ts's and
// evaluatorV2.ts's previously-duplicated tails -- normalize each axis, weight, pick a winner
// (tie-broken by lowest gas). Every category's evaluator computes its OWN metrics
// (computeMetrics/computeMetricsV2/computeMetricsGrid/...), then hands them to this one,
// unmodified, scoring shell. This is a pure refactor: verified byte-identical against the
// existing evaluator.test.ts/evaluatorV2.test.ts suites before anything new was built on it.

import { normalize, weightsFor } from "./evaluator.js";
import type { JobSpec, ProposalMetrics, ScoreBreakdown, ScoredProposal, StrategyProposal } from "./types.js";

/**
 * How raw metrics become 0-100 axis scores.
 *
 * "relative" is min-max across the candidate set: best becomes 100, worst becomes 0, and the
 * distance between them is divided out. That is the original behaviour, and it has a serious
 * consequence -- it cannot distinguish "meaningfully better" from "trivially better". Round 8 is
 * the clean example: recentering a position already 93.4% centered moved fee efficiency from
 * 96.699 to 99.2 and risk from 53.300 to 50.8, under three points on each, and those were scored
 * as the full 100-vs-0. Rebalancing therefore looked decisively correct for five points of
 * centeredness, and the evaluator was structurally biased toward always rebalancing.
 *
 * "absolute" keeps the magnitudes. feeEfficiency and riskScore are ALREADY 0-100 quantities in
 * every category's metrics, so re-normalizing them against each other only destroyed information;
 * they are now used as they stand. Gas is the one axis that genuinely needs mapping, and it gets a
 * real anchor rather than a rank: what fraction of the job's own spend limit it consumes.
 *
 * v1's evaluate() deliberately stays on "relative". It is a preserved historical policy with a
 * regression guard asserting it never changes, and rewriting its scoring would erase the record of
 * what the first evaluator actually did.
 */
export type NormalizationMode = "relative" | "absolute";

/** Gas as a share of the job's own budget: 0 wei scores 100, spending the whole limit scores 0. */
function gasScoreAbsolute(gasWei: bigint, maxSpendWei: bigint): number {
  if (gasWei <= 0n) return 100;
  if (maxSpendWei <= 0n) return 0;
  // Ratio in basis points, so the division stays in bigint before touching Number.
  const ratioBps = Number((gasWei * 10_000n) / maxSpendWei) / 10_000;
  return Math.max(0, Math.min(100, 100 * (1 - ratioBps)));
}

export function scoreProposals<M extends ProposalMetrics>(
  job: JobSpec,
  proposals: StrategyProposal[],
  metrics: M[],
  mode: NormalizationMode = "absolute",
): { scored: (ScoredProposal & { metrics: M })[]; winner: ScoredProposal & { metrics: M } } {
  const weights = weightsFor(job);

  const feeEffNorm =
    mode === "absolute"
      ? metrics.map((m) => Math.max(0, Math.min(100, m.estimatedFeeEfficiency)))
      : normalize(metrics.map((m) => m.estimatedFeeEfficiency), true);
  const riskNorm =
    mode === "absolute"
      ? metrics.map((m) => Math.max(0, Math.min(100, 100 - m.riskScore)))
      : normalize(metrics.map((m) => m.riskScore), false); // lower risk is better
  const gasNorm =
    mode === "absolute"
      ? metrics.map((m) => gasScoreAbsolute(m.estimatedGasWei, job.constraints.maxSpendWei))
      : normalize(metrics.map((m) => Number(m.estimatedGasWei)), false); // lower gas is better
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

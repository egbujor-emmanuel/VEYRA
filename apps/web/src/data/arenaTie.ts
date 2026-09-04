import type { ArchivedProposal } from "./types";

/**
 * Which candidates matched the winner on BOTH total score and gas.
 *
 * When that set is non-empty the winner was chosen by evaluation order, not by scoring higher --
 * see evaluatorKernel.ts's reduce, which keeps the first-listed candidate once score and gas are
 * level. Derived here rather than read from the archives because those files were written before
 * the evaluator recorded ties, and back-editing them would be rewriting the record.
 */
export function tiedWithWinner(proposals: ArchivedProposal[]): string[] {
  const winner = proposals.find((p) => p.isWinner);
  if (!winner?.score || !winner.metrics) return [];
  return proposals
    .filter(
      (p) =>
        p !== winner &&
        p.score?.totalScore === winner.score!.totalScore &&
        p.metrics?.estimatedGasWei === winner.metrics!.estimatedGasWei,
    )
    .map((p) => p.candidateId);
}

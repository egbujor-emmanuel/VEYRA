import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { archiveManifest } from "../data/loadArchive";
import { Badge } from "../components/ui/badge";
import type { ArenaRoundSummary } from "../data/types";

/**
 * Every evaluation round, with the outcome visible without opening it.
 *
 * Two wrong claims have stood on this page, and the second is worth recording because the fix went
 * deeper than the wording.
 *
 * First it said "our agent won 6 of 7" -- reading a tiebreak as a victory. Then it said the
 * scoring axes could not separate a tick-aware range from a naive symmetric one. That was a
 * misdiagnosis. The axes were fine; the two STRATEGIES were the same function. rangeKeeper and
 * baseline-symmetric-range both computed a half-width of `tickSpacing * 20` centered on the
 * current tick, and the single thing meant to distinguish them -- a volatility multiplier -- is
 * exactly 1 whenever volatility is unobserved. These pools carry observationCardinality 1, so it
 * is always unobserved. Identical inputs, identical formula, identical output, every round.
 *
 * That is fixed at the source (see rangeKeeper.ts), so rounds 1-7 and round 8 were produced by
 * genuinely different strategies. The rounds are kept exactly as they were recorded rather than
 * re-run, so this page has to say which era a round belongs to instead of pretending to one.
 */

const ROUNDS: ArenaRoundSummary[] = archiveManifest.arenaRounds ?? [];

/**
 * Match the winner's precision instead of guessing per row.
 *
 * The tied rounds used to render at 0 decimals because the early ties were whole numbers, which
 * made round 8 show a winner of 85.85 level with a runner-up of "86" -- two spellings of the same
 * number, on a row whose whole point is that they are equal.
 */
function formatScore(n: number) {
  return Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2);
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** What actually happened in the round, in the fewest honest words. */
function verdict(r: ArenaRoundSummary): { label: string; variant: "warn" | "accent" | "neutral" } {
  if (r.decidedByOrdering) return { label: "tied · order decided", variant: "warn" };
  if (r.wonByOurAgent) return { label: "our agent won", variant: "accent" };
  return { label: "baseline won", variant: "neutral" };
}

export function ArenaHistory() {
  // Fall back to bare ids if the manifest predates the summaries, rather than rendering nothing.
  const rounds: ArenaRoundSummary[] =
    ROUNDS.length > 0
      ? ROUNDS
      : [...archiveManifest.arenaRoundIds]
          .sort((a, b) => b - a)
          .map((roundId) => ({
            roundId,
            winnerCandidateId: null, winnerAction: null, winnerScore: null,
            wonByOurAgent: false, candidateCount: 0, runnerUpCandidateId: null,
            runnerUpScore: null, decidedByOrdering: false, observedAtBlock: null, generatedAt: null,
          }));

  const ties = rounds.filter((r) => r.decidedByOrdering).length;
  /** Rounds recorded before rangeKeeper stopped being a rename of the symmetric baseline. */
  const LAST_DEGENERATE_ROUND = 7;
  const recent = rounds.filter((r) => r.roundId > LAST_DEGENERATE_ROUND);
  /** Rounds arrive newest-first, so the earliest post-fix round is the last of them. */
  const firstHonestRound = recent.length > 0 ? recent[recent.length - 1]! : null;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 pb-28 pt-16">
      <h1 className="text-display text-[clamp(1.9rem,4vw,2.75rem)] text-foreground">Arena History</h1>
      <p className="mt-4 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        Every evaluation round under the market-aware evaluator. Each hands the same on-chain state, read
        at the block shown, to every candidate and scores them on identical axes.
      </p>
      <p className="mt-3 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        <span className="text-foreground">
          For the first {LAST_DEGENERATE_ROUND} rounds our strategy was not really a strategy
        </span>{" "}
        — it computed the identical range to the naive baseline, so {ties} rounds tied on every axis and
        were decided by evaluation order alone. Two separate bugs caused that, and both are fixed.
      </p>

      {/* The full account is worth keeping and not worth forcing on everyone. Five paragraphs of
          post-mortem above a seven-row table buried the table. */}
      <details className="disclosure mt-4 max-w-[70ch]">
        <summary>What was wrong, and what changed</summary>

        <p>
          <span className="text-foreground">The strategies were the same function.</span> rangeKeeper and{" "}
          <span className="font-mono text-[13.5px]">baseline-symmetric-range</span> both computed a
          half-width of <span className="font-mono text-[13.5px]">tickSpacing × 20</span> centred on the
          current tick. The one input meant to separate them — recent volatility — is multiplied in, and it
          is exactly 1 whenever volatility is unobserved. These pools carry a single oracle observation, so
          it is always unobserved. Identical inputs, identical formula, identical output, every round.
        </p>

        <p>
          <span className="text-foreground">The scoring punished restraint.</span> Scores were normalised
          across the three candidates, so the best value on an axis became 100 and the worst 0 no matter how
          small the gap. In round 8 recentring moved fee efficiency from 96.7 to 99.2 and risk from 53.3 to
          50.8 — under three points each — and that was scored as 100 against 0. Holding lost 50 to 75, and
          the evaluator was structurally biased toward always rebalancing.
        </p>

        <p>
          Both are fixed. rangeKeeper now declines to reposition a position still in the middle half of its
          range, and widens on overshoot it can actually measure. Fee efficiency and risk are already 0–100
          quantities, so they are used as they stand, and gas is measured against a real anchor — the share
          of the job's own spend limit it consumes. The same round now scores holding 85.85 against the
          marginal rebalance's 79.60.
        </p>

        <p>
          Rounds 1–{LAST_DEGENERATE_ROUND} are kept exactly as recorded rather than re-run, so the table
          below marks which era each belongs to. v1's evaluator is also left on the old scoring on purpose:
          it is a preserved historical policy, and rewriting it would erase the record of what the first
          evaluator did.
        </p>
      </details>

      <div className="mt-8 overflow-hidden rounded-[14px] border border-white/[0.08]">
        {rounds.map((r, i) => {
          const v = verdict(r);
          return (
            <Link
              key={r.roundId}
              to={`/arena/${r.roundId}`}
              className={`group flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 no-underline transition-colors hover:bg-white/[0.04] ${
                i > 0 ? "border-t border-white/[0.06]" : ""
              }`}
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-[13px] text-muted-foreground">
                Round #{r.roundId}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-foreground">
                  {r.winnerCandidateId ?? "—"}
                  {r.winnerAction && (
                    <span className="ml-2 font-normal text-muted-foreground">→ {r.winnerAction}</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                  {r.runnerUpCandidateId && r.runnerUpScore !== null
                    ? `${r.decidedByOrdering ? "level with" : "ahead of"} ${r.runnerUpCandidateId} (${formatScore(r.runnerUpScore)})`
                    : r.candidateCount > 0
                      ? `${r.candidateCount} candidates`
                      : ""}
                  {r.observedAtBlock ? ` · block ${r.observedAtBlock}` : ""}
                  {formatDate(r.generatedAt) ? ` · ${formatDate(r.generatedAt)}` : ""}
                </span>
              </span>

              {r.winnerScore !== null && (
                <span className="shrink-0 font-mono text-[13px] tabular text-foreground">
                  {formatScore(r.winnerScore)}
                  <span className="text-muted-foreground">/100</span>
                </span>
              )}

              <Badge variant={v.variant} className="shrink-0">
                {v.label}
              </Badge>

              <ArrowRight className="shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
            </Link>
          );
        })}
      </div>

      <p className="mt-4 text-[13px] text-muted-foreground">
        v1 rounds, from before the market-aware evaluator, are preserved in the legacy demo page rather than
        deleted — they are simply not listed here.
      </p>
    </div>
  );
}

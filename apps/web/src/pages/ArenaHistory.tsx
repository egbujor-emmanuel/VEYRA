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
    <div className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-12">
      <h1 className="text-display text-[clamp(1.9rem,4vw,2.75rem)] text-foreground">Arena History</h1>
      <p className="mt-4 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        Every evaluation round under the market-aware evaluator. Each hands the same on-chain state, read
        at the block shown, to every candidate and scores them on identical axes.
      </p>
      <p className="mt-3 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        <span className="text-foreground">
          For the first {LAST_DEGENERATE_ROUND} rounds our strategy was not really a strategy.
        </span>{" "}
        It computed the same range as{" "}
        <span className="font-mono text-[14px]">baseline-symmetric-range</span> — the same half-width, the
        same centering — and the one input meant to separate them, recent volatility, is never observable on
        a pool whose oracle holds a single observation. So {ties} of those rounds tied on every axis and on
        gas, and were decided by evaluation order alone.
      </p>
      <p className="mt-3 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        That is fixed now. rangeKeeper declines to reposition a position still sitting in the middle half of
        its range, and widens on the overshoot it can actually measure rather than on a volatility number
        nobody supplies.{" "}
        {firstHonestRound && (
          <span className="text-foreground">
            In round {firstHonestRound.roundId} it declined to reposition a position already 93.4% centered,
            and that decision won.
          </span>
        )}{" "}
        Which took fixing the scoring, not the strategy.
      </p>
      <p className="mt-3 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        The first time that round ran, holding lost 50 to 75. Recentering moved fee efficiency from 96.7 to
        99.2 and risk from 53.3 to 50.8 — under three points on each — but scores were normalised across the
        three candidates, so the best value on an axis became 100 and the worst 0 no matter how small the gap.{" "}
        <span className="text-foreground">A 2.5-point real difference was scored as a 100-point one</span>,
        and the evaluator was structurally biased toward always rebalancing.
      </p>
      <p className="mt-3 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        Fee efficiency and risk are already 0–100 quantities, so ranking them against each other only threw
        the magnitudes away. They are now used as they stand, and gas is measured against a real anchor —
        the share of the job's own spend limit it consumes — rather than against the other candidates. The
        same round now scores holding 85.85 against the marginal rebalance's 79.60. v1's evaluator is left on
        the old scoring deliberately: it is a preserved historical policy, and rewriting it would erase the
        record of what the first evaluator did.
      </p>

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
                    ? `${r.decidedByOrdering ? "level with" : "ahead of"} ${r.runnerUpCandidateId} (${r.runnerUpScore.toFixed(r.decidedByOrdering ? 0 : 2)})`
                    : r.candidateCount > 0
                      ? `${r.candidateCount} candidates`
                      : ""}
                  {r.observedAtBlock ? ` · block ${r.observedAtBlock}` : ""}
                  {formatDate(r.generatedAt) ? ` · ${formatDate(r.generatedAt)}` : ""}
                </span>
              </span>

              {r.winnerScore !== null && (
                <span className="shrink-0 font-mono text-[13px] tabular text-foreground">
                  {r.winnerScore.toFixed(Number.isInteger(r.winnerScore) ? 0 : 2)}
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

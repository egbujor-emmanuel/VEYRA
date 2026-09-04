import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { archiveManifest } from "../data/loadArchive";
import { Badge } from "../components/ui/badge";
import type { ArenaRoundSummary } from "../data/types";

/**
 * Every evaluation round, with the outcome visible without opening it.
 *
 * This page used to render seven identical "Round #N -- view" rows, then briefly claimed "our agent
 * won 6 of 7". Both were wrong in different ways. The round files show that in rounds 2-7 our
 * strategy tied baseline-symmetric-range on every scored axis AND on gas, so it won only by being
 * listed first -- and in round 1 a baseline beat it outright. Saying "won 6 of 7" would be reading
 * a tiebreak as a victory. The rows say which is which.
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
  const outrightWins = rounds.filter((r) => r.wonByOurAgent && !r.decidedByOrdering).length;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-12">
      <h1 className="text-display text-[clamp(1.9rem,4vw,2.75rem)] text-foreground">Arena History</h1>
      <p className="mt-4 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        Every evaluation round under the market-aware evaluator. Each hands the same on-chain state, read
        at the block shown, to every candidate and scores them on identical axes.
      </p>
      <p className="mt-3 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
        <span className="text-foreground">
          Our strategy has not yet outscored a baseline in {rounds.length} rounds.
        </span>{" "}
        {ties > 0 && (
          <>
            In {ties} of them it tied <span className="font-mono text-[14px]">baseline-symmetric-range</span> on
            every axis and on gas, so it won only by being evaluated first.{" "}
          </>
        )}
        {outrightWins === 0 && "In the remaining round a baseline scored higher and was selected instead. "}
        That is a finding about the scoring axes — they cannot currently separate a tick-aware range from a
        naive symmetric one — and it is left on the page rather than smoothed over.
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
                    ? `${r.decidedByOrdering ? "level with" : "ahead of"} ${r.runnerUpCandidateId} (${r.runnerUpScore})`
                    : r.candidateCount > 0
                      ? `${r.candidateCount} candidates`
                      : ""}
                  {r.observedAtBlock ? ` · block ${r.observedAtBlock}` : ""}
                  {formatDate(r.generatedAt) ? ` · ${formatDate(r.generatedAt)}` : ""}
                </span>
              </span>

              {r.winnerScore !== null && (
                <span className="shrink-0 font-mono text-[13px] tabular text-foreground">
                  {r.winnerScore.toFixed(0)}
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

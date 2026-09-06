import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { archiveManifest } from "../data/loadArchive";
import { Badge } from "../components/ui/badge";
import { AGENT_CATALOG } from "../data/agentCatalog";
import { PageHeader } from "../components/PageHeader";

/**
 * Every agent-arena-loop run, including the ones that were blocked or failed.
 *
 * The failures are listed with the same weight as the successes on purpose. A run record that only
 * shows what worked proves nothing -- the point of keeping run #1-3's EXECUTION_BLOCKED outcomes is
 * that they were real, and were not deleted once a later run succeeded.
 */

function outcomeVariant(outcome: string) {
  if (outcome === "EXECUTED") return "live" as const;
  if (outcome.endsWith("_FAILED") || outcome.endsWith("ABORTED")) return "danger" as const;
  return "warn" as const; // blocked -- a real, deliberate refusal to execute, not a success
}

function formatGas(gas: string) {
  const n = BigInt(gas || "0");
  if (n === 0n) return null;
  return n.toLocaleString();
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ExecutionHistory() {
  const entries = [...archiveManifest.entries].sort((a, b) => b.runArchiveId - a.runArchiveId);

  const executed = entries.filter((e) => e.effectiveExecuted).length;
  const totalTxs = entries.reduce((n, e) => n + (e.transactionCount ?? 0), 0);
  const totalGas = entries.reduce((n, e) => n + BigInt(e.gasUsed ?? "0"), 0n);

  // The run list below is rebalance-only -- that is the category whose per-run archives are wired
  // into the /executions/:id drill-down. The other three categories have real runs of their own,
  // so summarising them here keeps the page from reading as "these four runs are everything".
  const categories = archiveManifest.categories ?? [];
  const others = categories.filter((c) => c.category !== "rebalance");
  const allRuns = categories.reduce((n, c) => n + c.runCount, 0);
  const allExecuted = categories.reduce((n, c) => n + c.executedRunCount, 0);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 pb-28 pt-16">
      <PageHeader
        eyebrow="On-chain runs"
        title="Execution History"
        accent="oklch(0.72 0.17 305)"
        lead={<>
        Every <span className="text-foreground">rebalancing</span> run, including blocked and failed
        attempts — nothing hidden.{" "}
        <span className="text-foreground">
          {executed} of {entries.length} reached the chain
        </span>
        , across {totalTxs} transactions and {totalGas.toLocaleString()} gas. The runs that did not are
        listed here too, with the state they stopped in.
        {others.length > 0 && (
          <>
            {" "}The other three categories have their own runs, not listed here — {allExecuted} of{" "}
            {allRuns} runs across all four categories reached the chain. Their records live on each
            agent&apos;s page.
          </>
        )}
        </>}
      />

      <div className="mt-8 overflow-hidden rounded-[14px] border border-white/[0.08]">
        {entries.map((e, i) => {
          const gas = formatGas(e.gasUsed ?? "0");
          const date = formatDate(e.generatedAt);
          return (
            <Link
              key={e.runArchiveId}
              to={`/executions/${e.runArchiveId}`}
              className={`group flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 no-underline transition-colors hover:bg-white/[0.04] ${
                i > 0 ? "border-t border-white/[0.06]" : ""
              }`}
            >
              <span className="w-[4.5rem] shrink-0 font-mono text-[13px] text-muted-foreground">
                Run #{e.runArchiveId}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-foreground">
                  {e.winnerCandidateId}
                  {typeof e.roundId === "number" && (
                    <span className="ml-2 font-normal text-muted-foreground">from round #{e.roundId}</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                  {/* Cost is the honest measure of what a run did: a blocked run spent nothing. */}
                  {e.transactionCount ? `${e.transactionCount} txs` : "no transactions"}
                  {gas ? ` · ${gas} gas` : ""}
                  {date ? ` · ${date}` : ""}
                  {e.amendment ? " · resumed and completed in a follow-up run" : ""}
                </span>
              </span>

              <Badge variant={outcomeVariant(e.effectiveOutcome)} className="shrink-0">
                {e.effectiveOutcome.replace(/_/g, " ")}
              </Badge>

              <ArrowRight className="shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
            </Link>
          );
        })}
      </div>

      {others.length > 0 && (
        <div className="mt-8">
          <h2 className="text-[13px] font-medium uppercase tracking-wide text-muted-foreground">
            Other categories
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {others.map((c) => {
              const meta = AGENT_CATALOG.find((a) => a.id === c.category);
              return (
                <Link
                  key={c.category}
                  to={`/agents/${c.category}`}
                  className="rounded-[12px] border border-white/[0.08] px-4 py-3 no-underline transition-colors hover:bg-white/[0.04]"
                >
                  <span className="block text-[14px] font-medium text-foreground">
                    {meta?.displayName ?? c.category}
                  </span>
                  <span className="mt-1 block text-[12.5px] text-muted-foreground">
                    {c.executedRunCount} of {c.runCount} executed · {c.transactionCount} txs ·{" "}
                    {BigInt(c.totalGasUsed || "0").toLocaleString()} gas
                    {c.preservedFailureCount > 0
                      ? ` · ${c.preservedFailureCount} failure kept on record`
                      : ""}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-4 text-[13px] text-muted-foreground">
        A blocked run is a policy refusal, not a crash: the agent proposed something the execution policy
        would not authorize, and it stopped there. Those records are kept exactly as written.
      </p>
    </div>
  );
}

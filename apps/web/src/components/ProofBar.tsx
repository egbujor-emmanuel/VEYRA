// The first ten seconds.
//
// A visitor landing here sees a headline and three promises, and has no reason yet to believe any
// of them -- the evidence all lives a click away, on agent cards and the technical page. Most
// people will not click. This puts the aggregate, verifiable facts directly under the hero so the
// claim and its proof arrive together.
//
// Every figure is summed at build time from the same archives the per-agent cards use. Nothing
// here is a marketing number: if an agent had never executed, the count would drop.

import manifest from "../generated/archiveManifest.json";
import { AGENT_CATALOG } from "../data/agentCatalog";

interface CategoryStats {
  category: string;
  runCount: number;
  executedRunCount: number;
  transactionCount: number;
  totalGasUsed: string;
  preservedFailureCount: number;
}

const CATEGORIES = (manifest as { categories?: CategoryStats[] }).categories ?? [];

const totals = CATEGORIES.reduce(
  (acc, c) => ({
    txs: acc.txs + c.transactionCount,
    gas: acc.gas + BigInt(c.totalGasUsed || "0"),
    executing: acc.executing + (c.executedRunCount > 0 ? 1 : 0),
    failures: acc.failures + c.preservedFailureCount,
  }),
  { txs: 0, gas: 0n, executing: 0, failures: 0 },
);

function Figure({ value, label, tone }: { value: string; label: string; tone?: "warning" }) {
  return (
    <div className="px-5 py-4">
      <div className={`text-[22px] font-medium tracking-[-0.02em] tabular ${tone === "warning" ? "text-warning" : "text-foreground"}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{label}</div>
    </div>
  );
}

export function ProofBar() {
  const gasM = Number(totals.gas) / 1_000_000;

  return (
    <div className="mt-10 overflow-hidden rounded-[14px] border border-white/[0.08] bg-white/[0.03]">
      <div className="grid grid-cols-2 divide-x divide-white/[0.06] sm:grid-cols-4">
        <Figure value={String(totals.txs)} label="real on-chain transactions" />
        <Figure value={`${gasM.toFixed(2)}M`} label="gas actually spent" />
        <Figure value={`${totals.executing}/${AGENT_CATALOG.length}`} label="agents with executed history" />
        {/* Shown deliberately. A submission with no failures on record is a submission that
            deleted them, and that is the claim most worth doubting. */}
        <Figure value={String(totals.failures)} label="failed runs kept on record" tone="warning" />
      </div>
      <p className="border-t border-white/[0.06] px-5 py-3 text-[12.5px] text-muted-foreground">
        Summed from this project&apos;s own archived runs, not a marketing figure — every transaction is
        listed with its hash in{" "}
        <a href="https://github.com/egbujor-emmanuel/VEYRA/blob/main/docs/AGENT_ADVANTAGE_REPORT.md" target="_blank" rel="noreferrer">
          the Agent Advantage Report
        </a>
        , and the failures are still in Execution History.
      </p>
    </div>
  );
}

import { Link } from "react-router-dom";
import {
  ArrowRight, Fingerprint, ShieldCheck, Timer,
  Scale, Grid3x3, TrendingUp, HeartPulse, Clock, Hand,
} from "lucide-react";
import { AGENT_CATALOG } from "../data/agentCatalog";
import { MaturityBadge } from "../components/MaturityBadge";
import { AgentTrackRecord } from "../components/AgentTrackRecord";
import { ProofBar } from "../components/ProofBar";
import { StatusTicker } from "../components/StatusTicker";
import { WalletPanel } from "../components/WalletPanel";
import { DepositPanel } from "../components/DepositPanel";
import { useConnectedWallet } from "../hooks/walletContext";
import { useWalletFunding } from "../hooks/useNativeBalance";
import { Card } from "../components/ui/card";
import { Badge, Dot } from "../components/ui/badge";
import { Reveal } from "../components/Motion";
import type { JobCategory } from "../data/agentCatalog";

/** One icon per category, so four structurally identical cards are scannable at a glance. */
const CATEGORY_ICON: Record<JobCategory, typeof Scale> = {
  "rebalance": Scale,
  "grid-trading": Grid3x3,
  "yield-optimisation": TrendingUp,
  "health-factor-monitoring": HeartPulse,
};

/**
 * The three properties that make this a custody story rather than a "connect wallet" story.
 * Kept short and concrete -- each one is a claim the rest of the app has to actually honour.
 */
const GUARANTEES = [
  {
    icon: Fingerprint,
    title: "Your device is the key",
    body: "A passkey creates a real smart account in your browser. No extension, no seed phrase, nothing to write down.",
  },
  {
    icon: ShieldCheck,
    title: "Scoped, not blanket",
    body: "VEYRA gets a key limited to PancakeSwap V3 position calls and a daily spend ceiling. It cannot touch anything else.",
  },
  {
    icon: Timer,
    title: "Expires, and revocable",
    body: "Sessions run out on their own. Revoke sooner and the very next call VEYRA attempts fails at the on-chain validator.",
  },
];

export function Marketplace() {
  const wallet = useConnectedWallet();
  const funding = useWalletFunding(wallet?.address ?? null);

  return (
    <>
      <StatusTicker />

      <div className="mx-auto w-full max-w-[1180px] px-6">
        {/* ---- hero ---- */}
        <section className="pt-28 pb-16 sm:pt-36 sm:pb-20">
          <Badge variant="accent" className="mb-7">
            <Dot />
            Live on BNB Smart Chain Testnet
          </Badge>

          <h1 className="text-display max-w-[15ch] text-balance text-[clamp(2.6rem,7vw,4.75rem)] leading-[1.03] text-foreground">
            Hire an agent to run your <span className="accent-word">position</span>
          </h1>

          <p className="mt-7 max-w-[54ch] text-[18px] leading-[1.65] text-muted-foreground">
            Four autonomous agents, each with a verifiable on-chain record.{" "}
            <span className="text-foreground">Your funds never leave your own account.</span>
          </p>
        </section>

        {/* ---- the marketplace itself ----
            This is what a visitor came for, so it comes first. It used to sit below a wallet
            setup form and a Windows 10 warning box, which meant the product was the last thing
            on the page. */}
        <section className="pb-24">
          <div className="mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
            <h2 className="text-display text-[30px] text-foreground">Choose an agent</h2>
            <p className="max-w-[46ch] text-[14px] leading-relaxed text-muted-foreground">
              Every figure is computed from that agent&apos;s own archived runs — real transactions, real
              gas, real decisions. Including the ones that failed.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {AGENT_CATALOG.map((agent) => {
              const Icon = CATEGORY_ICON[agent.id];
              // Deliberately NOT wrapped in Reveal. The catalog is the thing a visitor came for;
              // anything that can leave it invisible -- a skipped intersection, a fast scroll, a
              // jump to an anchor -- costs more than the animation is worth.
              return (
                <div key={agent.id}>
                  <Link to={`/agents/${agent.id}`} className="group block h-full no-underline">
                    <article
                      className="agent-card h-full"
                      style={
                        {
                          "--card-accent": agent.accent.fg,
                          "--card-wash": agent.accent.wash,
                          "--card-edge": agent.accent.edge,
                        } as React.CSSProperties
                      }
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="agent-card__icon">
                            <Icon className="size-[19px]" strokeWidth={1.75} />
                          </span>
                          <h3 className="text-display text-[21px] text-foreground">{agent.displayName}</h3>
                        </div>
                        <ArrowRight className="mt-1.5 shrink-0 text-muted-foreground transition-all group-hover:translate-x-1 group-hover:text-[var(--card-accent)]" />
                      </div>

                      <p className="mt-4 text-[14.5px] leading-[1.6] text-muted-foreground">
                        {agent.shortDescription}
                      </p>

                      {/* Two different questions, both worth answering before a visitor clicks:
                          has it really executed on-chain, and does it act without being asked. */}
                      <div className="mt-6 flex flex-wrap items-center gap-2">
                        <MaturityBadge maturity={agent.maturity} emphasis="quiet" />
                        <span
                          className={`status-pill ${agent.scheduling === "scheduled" ? "status-good" : "status-muted"}`}
                          title={agent.schedulingNote}
                        >
                          {agent.scheduling === "scheduled" ? (
                            <><Clock className="mr-1 inline size-3" strokeWidth={2} />ON A SCHEDULE</>
                          ) : (
                            <><Hand className="mr-1 inline size-3" strokeWidth={2} />OPERATOR-INVOKED</>
                          )}
                        </span>
                      </div>

                      <AgentTrackRecord category={agent.id} />
                    </article>
                  </Link>
                </div>
              );
            })}
          </div>
        </section>

        {/* ---- the aggregate record, as a quiet band rather than a hero element ---- */}
        <section className="pb-24">
          <ProofBar />
        </section>

        {/* ---- how custody works ---- */}
        <section className="pb-24">
          <h2 className="text-display mb-10 text-[30px] text-foreground">What you are actually granting</h2>
          <div className="grid gap-px overflow-hidden rounded-[18px] border border-white/[0.08] bg-white/[0.06] sm:grid-cols-3">
            {GUARANTEES.map(({ icon: Icon, title, body }, i) => (
              <Reveal key={title} delay={i * 70} className="bg-background/60 p-9 backdrop-blur-sm">
                <Icon className="mb-4 text-accent" />
                <h3 className="text-[16px] font-medium tracking-[-0.01em] text-foreground">{title}</h3>
                <p className="mt-2.5 text-[14px] leading-[1.6] text-muted-foreground">{body}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ---- and only then, the wallet ----
            Setup belongs after the decision it supports, not in front of it. */}
        <section className="pb-16">
          <h2 className="text-display mb-10 text-[30px] text-foreground">When you are ready</h2>
          <WalletPanel />
          <DepositPanel wallet={wallet} nativeBalanceWei={funding?.balance.wei ?? null} />
        </section>
      </div>
    </>
  );
}

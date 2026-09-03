import { Link } from "react-router-dom";
import { ArrowRight, Fingerprint, ShieldCheck, Timer } from "lucide-react";
import { AGENT_CATALOG } from "../data/agentCatalog";
import { MaturityBadge } from "../components/MaturityBadge";
import { StatusTicker } from "../components/StatusTicker";
import { WalletPanel } from "../components/WalletPanel";
import { DepositPanel } from "../components/DepositPanel";
import { useConnectedWallet } from "../hooks/walletContext";
import { useWalletFunding } from "../hooks/useNativeBalance";
import { Card } from "../components/ui/card";
import { Badge, Dot } from "../components/ui/badge";

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
        <section className="pt-20 pb-16 sm:pt-28">
          <Badge variant="accent" className="mb-6">
            <Dot />
            Live on BNB Smart Chain Testnet
          </Badge>

          <h1 className="text-display max-w-[16ch] text-balance text-[clamp(2.4rem,6.5vw,4.25rem)] text-foreground">
            Hire an agent to run your <span className="accent-word">position</span>
          </h1>

          <p className="mt-6 max-w-[58ch] text-[17px] leading-relaxed text-muted-foreground">
            Four autonomous agents, each with a verifiable on-chain record. Create a wallet with your
            fingerprint, grant a key that is scoped and expiring, and revoke it whenever you want.{" "}
            <span className="text-foreground">Your funds never leave your own account.</span>
          </p>

          <div className="mt-12 grid gap-px overflow-hidden rounded-[14px] border border-white/[0.08] bg-white/[0.06] sm:grid-cols-3">
            {GUARANTEES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-background/60 p-6 backdrop-blur-sm">
                <Icon className="mb-3 text-accent" />
                <h3 className="text-[15px] font-medium tracking-[-0.01em] text-foreground">{title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- the actual, usable wallet flow ---- */}
        <WalletPanel />

        {/* Only meaningful once there is a wallet -- renders nothing otherwise. */}
        <DepositPanel wallet={wallet} nativeBalanceWei={funding?.balance.wei ?? null} />

        {/* ---- catalog ---- */}
        <section className="pt-10 pb-4">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-display text-[26px] text-foreground">Available agents</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Badges below state exactly what each agent has really done on-chain — not what it could do.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {AGENT_CATALOG.map((agent) => (
              <Link key={agent.id} to={`/agents/${agent.id}`} className="group no-underline">
                <Card className="h-full p-6 transition-all duration-200 group-hover:border-accent/40 group-hover:bg-white/[0.06]">
                  <div className="flex items-start justify-between gap-4">
                    <h3 className="text-display text-[19px] text-foreground">{agent.displayName}</h3>
                    <ArrowRight className="mt-1 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
                  </div>
                  <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
                    {agent.shortDescription}
                  </p>
                  <div className="mt-5">
                    <MaturityBadge maturity={agent.maturity} />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

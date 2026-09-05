// The technical depth page: custody, the settlement deadlock we hit in BNB's own contracts, and
// how anyone can verify a delivered job without trusting us.
//
// These three are the project's strongest claims and were previously buried in a README. Each is
// stated with the on-chain evidence that backs it, and each names what it does NOT prove.

import { ShieldCheck, KeyRound, FileCheck2, ExternalLink } from "lucide-react";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { VEYRA_SETTLEMENT_HOOK, ERC8183_TESTNET } from "../constants";

const SCOPE_PROOF = [
  "session key present on-chain after grant",
  "in-scope call succeeds — CONFIRMED, real tx",
  "out-of-scope call is refused",
  "revoke completes",
  "session key removed on-chain after revoke — 1 scoped key → 0",
  "revoked session is refused",
];

function Section({
  icon: Icon,
  eyebrow,
  title,
  children,
}: {
  icon: typeof ShieldCheck;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-14">
      <div className="mb-3 flex items-center gap-2.5">
        <Icon className="text-accent" />
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</span>
      </div>
      <h2 className="text-display text-[26px] text-foreground">{title}</h2>
      <div className="mt-4 max-w-[74ch] space-y-4 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

/**
 * The deadlock, drawn. Inline SVG rather than an image so it stays crisp, themes correctly, and
 * carries real text for screen readers.
 */
function DeadlockDiagram() {
  return (
    <svg viewBox="0 0 720 210" className="mt-6 w-full max-w-[720px]" role="img"
         aria-label="The Router hook refuses to fund a job it does not evaluate, and registerJob refuses to set a policy unless the Router is the evaluator — a cycle that forces every job through the Router.">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      <g className="text-danger" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="16" y="24" width="200" height="66" rx="10" opacity="0.5" />
        <rect x="264" y="24" width="200" height="66" rx="10" opacity="0.5" />
        <rect x="512" y="24" width="192" height="66" rx="10" opacity="0.5" />
        <path d="M 216 57 L 258 57" markerEnd="url(#arrow)" />
        <path d="M 464 57 L 506 57" markerEnd="url(#arrow)" />
        <path d="M 608 96 L 608 140 L 116 140 L 116 96" markerEnd="url(#arrow)" strokeDasharray="5 4" />
      </g>
      <g fill="currentColor" className="text-foreground" fontSize="12.5">
        <text x="34" y="50">fund() a job</text>
        <text x="282" y="50">Router hook checks</text>
        <text x="530" y="50">registerJob() sets</text>
      </g>
      <g fill="currentColor" className="text-muted-foreground" fontSize="11.5">
        <text x="34" y="70">with a client as evaluator</text>
        <text x="282" y="70">PolicyNotSet() → revert</text>
        <text x="530" y="70">the missing policy</text>
        <text x="196" y="160">RouterNotEvaluator() → revert, because the client is the evaluator</text>
      </g>
    </svg>
  );
}

export function HowItWorks() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 pb-28 pt-16">
      <Badge variant="accent" className="mb-5">Technical detail</Badge>
      <h1 className="text-display max-w-[20ch] text-balance text-[clamp(2rem,5vw,3.2rem)] text-foreground">
        What VEYRA can do with your money, and what stops it
      </h1>
      <p className="mt-5 max-w-[68ch] text-[17px] leading-relaxed text-muted-foreground">
        Three claims this project makes that are worth checking rather than believing. Each one below is
        backed by something on-chain, and each says what it does <em>not</em> prove.
      </p>

      <Section icon={ShieldCheck} eyebrow="Custody" title="A scoped key, enforced by the chain">
        <p>
          You create an Altana smart account with a passkey, then grant VEYRA a session key limited to
          PancakeSwap V3 position calls, capped at 0.05 BNB/day, expiring in an hour. The limits are enforced
          by the account contract — not by our code choosing to behave.
        </p>
        <p>
          <code className="text-foreground">scripts/proveSessionScope.mjs</code> runs six assertions against a
          real wallet on chain 97:
        </p>
        <ul className="ml-1 space-y-1.5">
          {SCOPE_PROOF.map((line) => (
            <li key={line} className="flex gap-2.5">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-success" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p>
          The one that matters is the third: a session granted over the position manager{" "}
          <strong className="text-foreground">could not touch WBNB</strong>. And after revocation, the call
          that had just succeeded stopped working.
        </p>
        <p className="text-[13.5px]">
          <strong className="text-foreground">What this does not prove:</strong> Altana&apos;s scoping stops at
          (contract, selector). It cannot constrain <em>which</em> position or <em>which</em> recipient — that
          gap is closed by VEYRA&apos;s own argument-level policy before anything is broadcast, which is our
          code and not the chain&apos;s.
        </p>
      </Section>

      <Section icon={KeyRound} eyebrow="Protocol contribution" title="A deadlock in the escrow, and the contract that fixes it">
        <p>
          ERC-8183 lets the client of a job be its own evaluator — the person who paid decides whether the work
          was acceptable. BNB&apos;s deployment blocks that, through two constraints that only bite together:
        </p>
        <DeadlockDiagram />
        <p>
          The Router&apos;s hook rejects <code className="text-foreground">fund()</code> with{" "}
          <code className="text-foreground">PolicyNotSet()</code> on any job it does not itself evaluate — and{" "}
          <code className="text-foreground">registerJob()</code>, which sets that policy, reverts{" "}
          <code className="text-foreground">RouterNotEvaluator()</code> unless the Router <em>is</em> the
          evaluator. A job with no hook at all is refused outright.
        </p>
        <p>
          So every dispute had to route through <code className="text-foreground">OptimisticPolicy.voteReject()</code>,
          restricted to operator-granted voters — 2 of them, administered by an address that is not ours, with
          <code className="text-foreground"> addVoter()</code> admin-only. A client could raise a dispute and
          never resolve one.
        </p>
        <p>
          We deployed a hook that imposes no policy:{" "}
          <a href={`https://testnet.bscscan.com/address/${VEYRA_SETTLEMENT_HOOK}`} target="_blank" rel="noreferrer">
            {VEYRA_SETTLEMENT_HOOK} <ExternalLink size={13} className="inline align-[-2px]" />
          </a>
          . It holds no funds, has no owner, no upgrade path and no privileged caller; both of its methods are
          empty. All escrow logic stays in{" "}
          <a href={`https://testnet.bscscan.com/address/${ERC8183_TESTNET.commerce}`} target="_blank" rel="noreferrer">
            AgenticCommerce <ExternalLink size={13} className="inline align-[-2px]" />
          </a>
          , unchanged and not ours.
        </p>
        <p>
          Proven end to end on job <strong className="text-foreground">#919</strong>: funded, VEYRA submitted,
          the client rejected it, and the client was refunded in full. No operator voter involved.
        </p>
        <p className="text-[13.5px]">
          <strong className="text-foreground">The trade-off, stated plainly:</strong> a client-evaluated job
          trusts the client. A dishonest one can reject good work and reclaim the budget. That is the mirror
          image of the Router flow, where the provider is protected but the client is powerless. Neither is
          universally right, so the hook is a choice offered — not a claim that BNB&apos;s design is wrong.
        </p>
      </Section>

      <Section icon={FileCheck2} eyebrow="Verifiability" title="Check the work without trusting us">
        <p>
          When VEYRA delivers a job it does not post a screenshot. It runs its real evaluator against live
          on-chain state, archives the result, and commits the <code className="text-foreground">keccak256</code>{" "}
          of that exact artifact to the escrow contract as the deliverable.
        </p>
        <p>Anyone can re-derive it — no keys, no access, just a public RPC:</p>
        <pre className="overflow-x-auto rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 font-mono text-[12.5px] text-foreground">
{`$ node scripts/verifyDelivery.mjs 877

deliverable on-chain : 0x68c74e5658b7c46064e1f2bdc98ce739d98af76d5f9b21d8eb6e1da1ccf2e1a2
recomputed from file : 0x68c74e5658b7c46064e1f2bdc98ce739d98af76d5f9b21d8eb6e1da1ccf2e1a2

artifact self-consistent : YES   matches the chain : YES   job completed : YES`}
        </pre>
        <p className="text-[13.5px]">
          <strong className="text-foreground">What this does not prove:</strong> that the analysis inside the
          artifact is <em>good</em> — only that the work shown is exactly the work that was committed, and that
          neither side can alter it afterwards.
        </p>
      </Section>

      <Card className="mt-14 p-6">
        <h3 className="text-display text-[17px] text-foreground">The failures are still here too</h3>
        <p className="mt-2 max-w-[70ch] text-[14.5px] leading-relaxed text-muted-foreground">
          A first rebalance attempt <code className="text-foreground">ABORTED</code> after collecting, because
          the held token ratio did not match the target range. A grid slot ended{" "}
          <code className="text-foreground">SWAP_FAILED</code> when a corrective swap left 2.35% of value
          stranded, over the 1% threshold — the agent refused to mint rather than proceed with a bad position.
          Both are archived and shown in Execution History rather than deleted. The guard that stopped that
          mint is the agent&apos;s; a passive holder has no equivalent.
        </p>
      </Card>
    </div>
  );
}

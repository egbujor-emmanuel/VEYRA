// The visitor-facing wallet + authorization panel. This is the piece that makes VEYRA a
// marketplace rather than a display case: a stranger creates their own real smart account here
// and grants VEYRA scoped authority over their own funds, with a biometric prompt.

import { useState } from "react";
import { formatEther } from "viem";
import { Copy, Check, ExternalLink, Loader2, RotateCw } from "lucide-react";
import { useWallet } from "../hooks/walletContext";
import { useWalletFunding } from "../hooks/useNativeBalance";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge, Dot } from "./ui/badge";

const DEFAULT_SPEND_LIMIT_WEI = 50_000_000_000_000_000n; // 0.05 BNB/day ceiling
const DEFAULT_SESSION_SECONDS = 3600; // 1 hour -- deliberately short; re-grant is one prompt

/** BNB Chain's own testnet faucet. A new wallet needs a little tBNB before it can do anything. */
const FAUCET_URL = "https://www.bnbchain.org/en/testnet-faucet";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-2 font-mono text-[15px] text-foreground transition-colors hover:text-accent"
      onClick={() => {
        navigator.clipboard?.writeText(address).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          // Clipboard access can be denied; the address is still visible, so fail quietly.
          () => undefined,
        );
      }}
      title={address}
    >
      {short(address)}
      {copied ? <Check className="text-success" /> : <Copy className="opacity-50" />}
    </button>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3.5">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.11em] text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-[17px] font-medium tracking-[-0.015em] tabular">{children}</div>
    </div>
  );
}

export function WalletPanel() {
  const { state, create, recover, grant, revoke } = useWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const funding = useWalletFunding(state.status === "ready" ? state.wallet.address : null, refreshKey);
  const balance = funding?.balance ?? null;
  const underfunded = funding !== null && !funding.sufficient;

  return (
    <Card className="p-7">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 className="text-display text-[20px] text-foreground">Your wallet</h2>
        {state.status === "ready" && (
          <Badge variant={state.session ? "live" : "neutral"}>
            {state.session && <Dot />}
            {state.session ? "Session active" : "No session"}
          </Badge>
        )}
      </div>

      {state.status === "disconnected" && (
        <>
          <p className="mb-6 max-w-[62ch] text-[14.5px] leading-relaxed text-muted-foreground">
            Create a wallet secured by your device's biometrics — no extension, no seed phrase, nothing to
            write down. You keep custody; VEYRA only ever gets a scoped, expiring key you can revoke.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={create}>Create wallet</Button>
            <Button variant="secondary" onClick={recover}>
              I already have one
            </Button>
          </div>
        </>
      )}

      {state.status === "working" && (
        <div className="flex items-center gap-3 py-2 text-[14.5px] text-muted-foreground">
          <Loader2 className="animate-spin text-accent" />
          {state.note}
        </div>
      )}

      {state.status === "error" && (
        <>
          <div className="error-box mb-5">{state.message}</div>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={create}>
              Try creating again
            </Button>
            <Button variant="secondary" onClick={recover}>
              Try recovering
            </Button>
          </div>
        </>
      )}

      {state.status === "ready" && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Stat label="Your account">
              <CopyAddress address={state.wallet.address} />
            </Stat>
            <Stat label="Balance">{balance ? `${balance.formatted} tBNB` : "…"}</Stat>
            <Stat label="Session expires">
              {state.session ? new Date(state.session.expiry * 1000).toLocaleTimeString() : "—"}
            </Stat>
          </div>

          {underfunded && (
            <div className="notice-box mb-5">
              <strong>
                This wallet needs about {funding!.requirement.requiredFormatted} tBNB before it can authorize
                anything.
              </strong>{" "}
              {funding!.requirement.needsRegistration ? (
                <>
                  Your first on-chain action also registers your account key in Altana&apos;s KeyStore, which
                  charges a live fee of{" "}
                  <span className="tabular">{formatEther(funding!.requirement.feeWei)}</span> BNB, plus gas.
                  That is why an empty wallet fails here.
                </>
              ) : (
                <>Your key is already registered; this is just gas for the transaction.</>
              )}{" "}
              Get free tBNB from the{" "}
              <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                BNB Chain faucet <ExternalLink className="inline size-3.5 align-[-2px]" />
              </a>{" "}
              using the address above, then{" "}
              <button className="link-btn" onClick={() => setRefreshKey((k) => k + 1)}>
                refresh
              </button>
              .
            </div>
          )}

          {!state.session ? (
            <>
              <p className="mb-5 max-w-[64ch] text-[14.5px] leading-relaxed text-muted-foreground">
                Grant VEYRA a session scoped to PancakeSwap V3 position management only, capped at{" "}
                <span className="text-foreground">0.05 BNB/day</span>, expiring in{" "}
                <span className="text-foreground">one hour</span>. It cannot touch anything else, and you can
                revoke it at any time.
              </p>
              <Button
                disabled={underfunded}
                onClick={() => grant(DEFAULT_SPEND_LIMIT_WEI, DEFAULT_SESSION_SECONDS)}
              >
                Authorize VEYRA
              </Button>
              {underfunded && (
                <p className="mt-3 text-[13px] text-muted-foreground">
                  Disabled until the wallet is funded — clicking it now would fail on-chain with an
                  unhelpful error.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="mb-5 max-w-[64ch] text-[14.5px] leading-relaxed text-muted-foreground">
                VEYRA can now manage your positions within the granted scope. Revoking takes effect on-chain
                immediately — the next call it attempts fails at the validator.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button variant="danger" onClick={revoke}>
                  Revoke authorization
                </Button>
                <Button variant="ghost" onClick={() => setRefreshKey((k) => k + 1)}>
                  <RotateCw /> Refresh balance
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

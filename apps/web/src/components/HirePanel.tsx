// The paid-hire flow, per agent. Creates a real ERC-8183 escrow job funded in $U, signed by the
// user's own passkey wallet. VEYRA is the provider; the Router is the evaluator and hook, and
// the Policy contract binds the dispute window -- the same v1 deployment pattern @bnbagent/sdk
// uses server-side.

import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { ExternalLink, RotateCw } from "lucide-react";
import { hireAndFund, readUBalance, claimTestU } from "../chain/hireAgent";
import { rememberJob } from "../chain/jobStore";
import { VEYRA_WALLET } from "../constants";
import type { UserWallet } from "../chain/passkeyWallet";

const PRESET_BUDGETS = [
  { label: "1 $U", wei: 1_000_000_000_000_000_000n },
  { label: "5 $U", wei: 5_000_000_000_000_000_000n },
  { label: "25 $U", wei: 25_000_000_000_000_000_000n },
];
const JOB_EXPIRY_SECONDS = 86_400; // 24h before the user can reclaim an undelivered job

type HireState =
  | { status: "idle" }
  | { status: "working"; note: string }
  | { status: "done"; jobId: bigint; txHash: string | undefined }
  | { status: "error"; message: string };

/**
 * Escrow is denominated in $U, not BNB. A wallet with no $U fails deep inside the sequence with a
 * bare "0x" revert -- after the user has already approved a device prompt -- so the balance is
 * shown up front, the button is gated on it, and the faucet is one click away.
 */
function describeHireError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (raw.startsWith("INSUFFICIENT_U:")) {
    const [, have, need] = raw.split(":");
    return (
      `This job needs ${formatUnits(BigInt(need), 18)} $U but your wallet holds ` +
      `${formatUnits(BigInt(have ?? "0"), 18)}. Claim free testnet $U below, then try again.`
    );
  }
  if (/reason: 0x|executing calls/i.test(raw)) {
    return (
      "The transaction was rejected on-chain without a reason. This usually means the wallet is " +
      "short of $U for the escrow, or of testnet BNB for gas."
    );
  }
  if (/InvalidNonce/i.test(raw)) {
    return "Altana's relay was still catching up from the previous transaction. Wait a few seconds and try again.";
  }
  return raw;
}

export function HirePanel({ wallet, agentName }: { wallet: UserWallet | null; agentName: string }) {
  const [budget, setBudget] = useState(PRESET_BUDGETS[0]!);
  const [state, setState] = useState<HireState>({ status: "idle" });
  const [uBalance, setUBalance] = useState<bigint | null>(null);
  const [claiming, setClaiming] = useState(false);

  const refreshBalance = useCallback(() => {
    if (!wallet) return;
    readUBalance(wallet.address).then(setUBalance, () => setUBalance(null));
  }, [wallet]);

  useEffect(refreshBalance, [refreshBalance]);

  const insufficient = uBalance !== null && uBalance < budget.wei;

  async function claim() {
    if (!wallet) return;
    setClaiming(true);
    try {
      await claimTestU(wallet);
      refreshBalance();
    } catch (err) {
      setState({ status: "error", message: describeHireError(err) });
    } finally {
      setClaiming(false);
    }
  }

  async function submit() {
    if (!wallet) return;
    setState({ status: "working", note: "Confirm on your device…" });
    try {
      const result = await hireAndFund(
        {
          wallet,
          providerAddress: VEYRA_WALLET,
          budgetWei: budget.wei,
          description: `VEYRA · ${agentName}`,
          expirySeconds: JOB_EXPIRY_SECONDS,
        },
        (note) => setState({ status: "working", note }),
      );
      // Record it locally so the visitor can find it again and reclaim it if VEYRA never
      // delivers -- historical eth_getLogs is not served by public BSC testnet RPCs.
      rememberJob({
        jobId: result.jobId.toString(),
        agentName,
        budgetWei: budget.wei.toString(),
        createdAt: Date.now(),
        ...(result.fundTxHash ? { fundTxHash: result.fundTxHash } : {}),
      });
      setState({ status: "done", jobId: result.jobId, txHash: result.fundTxHash });
      refreshBalance();
    } catch (err) {
      setState({ status: "error", message: describeHireError(err) });
    }
  }

  return (
    <div className="panel">
      <h2>Hire this agent</h2>

      {!wallet ? (
        <p className="rationale" style={{ margin: 0 }}>
          Create a wallet above first — the job is funded from your own account, so it has to be signed by you.
        </p>
      ) : (
        <>
          <p className="rationale">
            Funds an on-chain escrow job in <strong>$U</strong> against VEYRA's address. The agent only gets paid
            after delivering; if it never does, you reclaim the full amount after 24 hours.
          </p>

          <div className="hero-grid" style={{ marginBottom: 18 }}>
            <div className="hero-stat">
              <span className="k">Your $U balance</span>
              <span className="v">{uBalance === null ? "…" : formatUnits(uBalance, 18)}</span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            <button className="btn btn-secondary" disabled={claiming} onClick={claim}>
              {claiming ? "Claiming…" : "Get free testnet $U"}
            </button>
            <button className="btn btn-secondary" onClick={refreshBalance}>
              <RotateCw size={15} /> Refresh
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            {PRESET_BUDGETS.map((b) => (
              <button
                key={b.label}
                className={`btn ${budget.label === b.label ? "btn-accent" : "btn-secondary"}`}
                onClick={() => setBudget(b)}
              >
                {b.label}
              </button>
            ))}
          </div>

          {state.status === "error" && <div className="error-box" style={{ marginBottom: 16 }}>{state.message}</div>}

          {insufficient && state.status !== "error" && (
            <div className="notice-box" style={{ marginBottom: 16 }}>
              You hold {formatUnits(uBalance!, 18)} $U but this job needs {budget.label}. Claim free testnet $U
              above, or pick a smaller budget.
            </div>
          )}

          {state.status === "done" ? (
            <div className="hero-stat">
              <span className="k">Job #{state.jobId.toString()} funded</span>
              <span className="v">
                {state.txHash ? (
                  <a href={`https://testnet.bscscan.com/tx/${state.txHash}`} target="_blank" rel="noreferrer">
                    {state.txHash.slice(0, 18)}… <ExternalLink size={13} />
                  </a>
                ) : (
                  "submitted"
                )}
              </span>
            </div>
          ) : (
            <>
              <button
                className="btn btn-primary"
                disabled={state.status === "working" || insufficient}
                onClick={submit}
              >
                {state.status === "working" ? state.note : `Hire for ${budget.label}`}
              </button>
              {state.status === "working" && (
                <p className="rationale" style={{ marginTop: 12, marginBottom: 0 }}>
                  This takes two on-chain steps — creating the job, then moving the budget into escrow — so
                  expect two device prompts.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

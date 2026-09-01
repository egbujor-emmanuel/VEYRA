// The paid-hire flow, per agent. Creates a real ERC-8183 escrow job funded in $U, signed by the
// user's own passkey wallet. VEYRA is the provider; the Router is the evaluator and hook, and
// the Policy contract binds the dispute window -- the same v1 deployment pattern @bnbagent/sdk
// uses server-side.

import { useState } from "react";
import { hireAndFund } from "../chain/hireAgent";
import { VEYRA_WALLET, U_TOKEN_FAUCET_TESTNET } from "../constants";
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

export function HirePanel({ wallet, agentName }: { wallet: UserWallet | null; agentName: string }) {
  const [budget, setBudget] = useState(PRESET_BUDGETS[0]!);
  const [state, setState] = useState<HireState>({ status: "idle" });

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
      setState({ status: "done", jobId: result.jobId, txHash: result.fundTxHash });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
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
            after delivering; if it never does, you reclaim the full amount after 24 hours. Testnet $U is free from
            the <a href={`https://testnet.bscscan.com/address/${U_TOKEN_FAUCET_TESTNET}`} target="_blank" rel="noreferrer">faucet</a>.
          </p>

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

          {state.status === "done" ? (
            <div className="hero-stat">
              <span className="k">Job #{state.jobId.toString()} funded</span>
              <span className="v">
                {state.txHash ? (
                  <a href={`https://testnet.bscscan.com/tx/${state.txHash}`} target="_blank" rel="noreferrer">{state.txHash.slice(0, 18)}…</a>
                ) : (
                  "submitted"
                )}
              </span>
            </div>
          ) : (
            <>
              <button className="btn btn-primary" disabled={state.status === "working"} onClick={submit}>
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

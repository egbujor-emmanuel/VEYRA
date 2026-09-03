// Shows the visitor the jobs they have funded, and lets them reclaim an undelivered one.
//
// This closes a gap the app previously had: the hire panel promises "if it never delivers, you
// reclaim the full amount after 24 hours", and claimRefund existed in the chain layer, but there
// was no way for a user to actually invoke it. A promise of reclaim with no button is not a
// refund guarantee.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatUnits, keccak256, toHex } from "viem";
import { ExternalLink, RotateCw } from "lucide-react";
import { claimRefund, readJob, rejectDelivery, acceptDelivery, type JobState } from "../chain/hireAgent";
import { loadJobs } from "../chain/jobStore";
import type { UserWallet } from "../chain/passkeyWallet";

type Row = { stored: { jobId: string; agentName: string }; state: JobState | null; error?: string };

/** A settled job needs no action; an expired undelivered one is the whole point of this panel. */
function statusVariant(state: JobState | null): string {
  if (!state) return "status-muted";
  if (state.status === "Completed") return "status-good";
  if (state.refundable || state.status === "Expired" || state.status === "Rejected") return "status-bad";
  return "status-muted";
}

/**
 * `agentName` scopes the list to one agent's jobs.
 *
 * Without it this panel showed every job the browser had ever funded on every agent page -- a
 * Rebalancing job appeared under Grid Trading, Yield and Health Factor identically, which reads
 * as though the same job had been carried out by all four. The job data was always correct; the
 * panel simply had no notion of which agent it was rendering beside.
 */
export function JobsPanel({ wallet, agentName }: { wallet: UserWallet | null; agentName?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const all = loadJobs();
    const stored = agentName ? all.filter((j) => j.agentName === agentName) : all;
    if (stored.length === 0) {
      setRows([]);
      return;
    }
    const next = await Promise.all(
      stored.map(async (s) => {
        try {
          return { stored: s, state: await readJob(BigInt(s.jobId)) } as Row;
        } catch (err) {
          return { stored: s, state: null, error: err instanceof Error ? err.message : String(err) } as Row;
        }
      }),
    );
    setRows(next);
  }, [agentName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Accept or reject a submitted deliverable. Only the job's evaluator may do this, and for jobs
   * created by this app the evaluator IS the client -- so the person who paid decides, and a
   * rejection refunds them immediately rather than making them wait out the expiry.
   */
  async function decide(jobId: string, accept: boolean) {
    if (!wallet) return;
    setBusyJobId(jobId);
    setMessage(null);
    const reason = keccak256(toHex(accept ? "accepted-by-client" : "rejected-by-client"));
    try {
      if (accept) await acceptDelivery(wallet, BigInt(jobId), reason);
      else await rejectDelivery(wallet, BigInt(jobId), reason);
      setMessage(
        accept
          ? `Job #${jobId} accepted — the budget has been released to VEYRA.`
          : `Job #${jobId} rejected — your budget has been returned in full.`,
      );
      await refresh();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setMessage(
        /reason: 0x|executing calls/i.test(raw)
          ? `The contract refused that without a reason. Only the job's evaluator can decide, and only while it is Submitted.`
          : raw,
      );
    } finally {
      setBusyJobId(null);
    }
  }

  async function reclaim(jobId: string) {
    if (!wallet) return;
    setBusyJobId(jobId);
    setMessage(null);
    try {
      await claimRefund(wallet, BigInt(jobId));
      setMessage(`Job #${jobId} refunded — the budget is back in your wallet.`);
      await refresh();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setMessage(
        /reason: 0x|executing calls/i.test(raw)
          ? `Job #${jobId} could not be refunded. The contract refused it without a reason, which usually means it is not yet past its expiry, or it has already been delivered or refunded.`
          : raw,
      );
    } finally {
      setBusyJobId(null);
    }
  }

  if (rows === null) return null;
  if (rows.length === 0) return null;

  return (
    <div className="panel">
      <h2>{agentName ? `Your ${agentName} jobs` : "Your jobs"}</h2>
      <p className="rationale">
        {agentName ? `Jobs you have funded for ${agentName}.` : "Jobs you have funded from this browser."}{" "}
        <strong>You are the evaluator on every job you create here</strong> —
        when VEYRA submits its work you decide whether to accept it and release payment, or reject it and be
        refunded in full. A job that passes its expiry undelivered can be reclaimed outright.
      </p>

      {message && <div className="notice-box" style={{ marginBottom: 16 }}>{message}</div>}

      <ul className="tx-list">
        {rows.map(({ stored, state, error }) => (
          <li key={stored.jobId}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
              <div>
                <div className="candidate-name" style={{ fontSize: 15 }}>
                  Job #{stored.jobId}{agentName ? "" : ` — ${stored.agentName}`}
                </div>
                <div className="freshness" style={{ marginTop: 4 }}>
                  {error
                    ? "could not read this job on-chain"
                    : state
                      ? `${formatUnits(state.budgetWei, 18)} $U · expires ${new Date(Number(state.expiredAt) * 1000).toLocaleString()}`
                      : ""}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`status-pill ${statusVariant(state)}`}>{state?.status ?? "unknown"}</span>
                {state?.status === "Submitted" && (
                  <>
                    <button
                      className="btn btn-accent"
                      disabled={!wallet || busyJobId === stored.jobId}
                      onClick={() => decide(stored.jobId, true)}
                    >
                      {busyJobId === stored.jobId ? "Working…" : "Accept & pay"}
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={!wallet || busyJobId === stored.jobId}
                      onClick={() => decide(stored.jobId, false)}
                    >
                      Reject & refund
                    </button>
                  </>
                )}
                {state?.refundable && (
                  <button
                    className="btn btn-secondary"
                    disabled={!wallet || busyJobId === stored.jobId}
                    onClick={() => reclaim(stored.jobId)}
                  >
                    {busyJobId === stored.jobId ? "Reclaiming…" : "Claim refund"}
                  </button>
                )}
                {/* A delivered job carries a deliverable hash on-chain, and the artifact behind it is
                    archived. Point at how to check that rather than asking anyone to take it on trust. */}
                {state?.status === "Completed" && (
                  <Link to="/how-it-works" className="freshness" title="How to re-derive this job's deliverable hash yourself">
                    verify this work
                  </Link>
                )}
                <a
                  href={`https://testnet.bscscan.com/address/0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de`}
                  target="_blank"
                  rel="noreferrer"
                  className="freshness"
                >
                  escrow <ExternalLink size={12} />
                </a>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => void refresh()}>
        <RotateCw size={15} /> Refresh
      </button>
    </div>
  );
}

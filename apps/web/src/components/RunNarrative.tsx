import type { AgentArenaRun, ResumedMintAmendment } from "../data/types";
import { TxEvidenceList } from "./TxEvidenceList";
import { ProvenanceBadge } from "./ProvenanceBadge";

function dotClass(to: string) {
  if (to.endsWith("_FAILED") || to === "EXECUTION_BLOCKED") return "dot-bad";
  if (to === "EXECUTED" || to === "HOLD" || to === "ARCHIVED") return "dot-good";
  return "dot-neutral";
}

/** The flagship narrative: a REAL failure (run.transitions includes the actual MINT_FAILED
 * revert reason, verbatim), root-caused, and completed for real (amendment). Nothing here is
 * hidden or smoothed over -- the failure is shown as evidence the safety architecture works. */
export function RunNarrative({ run, amendment }: { run: AgentArenaRun; amendment: ResumedMintAmendment | null }) {
  return (
    <div className="panel">
      <h2>
        Execution Narrative — Run #{run.runArchiveId} <ProvenanceBadge tier="OBSERVED" />
      </h2>

      <div style={{ marginBottom: 18 }}>
        {run.transitions.map((t, i) => (
          <div className="narrative-step" key={i}>
            <span className={`dot ${dotClass(t.to)}`} />
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: "0.85rem" }}>
                {t.from} → <strong>{t.to}</strong>
              </div>
              {t.reason && (
                <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4, maxWidth: 640 }}>
                  {t.reason.split("\n")[0]}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: 24 }}>Transactions <ProvenanceBadge tier="OBSERVED" /></h2>
      <TxEvidenceList transactions={run.transactions} />

      {amendment && (
        <>
          <div className="panel" style={{ background: "var(--panel-2)", marginTop: 20, marginBottom: 0 }}>
            <h2 style={{ marginBottom: 8 }}>Root-Caused, Fixed, and Completed</h2>
            <p style={{ fontSize: "0.85rem", color: "var(--text)", lineHeight: 1.6 }}>{amendment.rootCause}</p>
          </div>

          <h2 style={{ marginTop: 20 }}>Corrective Swaps <ProvenanceBadge tier="OBSERVED" /></h2>
          {amendment.correctiveSwaps.map((swap) => (
            <div key={swap.attempt} className="panel" style={{ background: "var(--panel-2)" }}>
              <div style={{ fontSize: "0.85rem", marginBottom: 8 }}>
                Attempt {swap.attempt} — stranded fractions after: <strong>{(swap.postSwapStrandedFraction0 * 100).toFixed(3)}%</strong> / <strong>{(swap.postSwapStrandedFraction1 * 100).toFixed(3)}%</strong>
              </div>
              <TxEvidenceList transactions={[swap.approveTx, swap.swapTx]} />
            </div>
          ))}

          <h2 style={{ marginTop: 20 }}>Final Mint <ProvenanceBadge tier="OBSERVED" /></h2>
          <TxEvidenceList transactions={[amendment.mintTx]} />

          <div className="kv" style={{ marginTop: 16 }}>
            <div><span className="k">New position</span><span className="v">#{amendment.newPosition.tokenId}</span></div>
            <div><span className="k">Range</span><span className="v">[{amendment.newPosition.tickLower}, {amendment.newPosition.tickUpper})</span></div>
            <div><span className="k">Liquidity</span><span className="v">{amendment.newPosition.positionLiquidity}</span></div>
            <div><span className="k">Verified</span><span className="v">
              <span className={`status-pill ${amendment.verified ? "status-good" : "status-bad"}`}>{amendment.verified ? "VERIFIED" : "NOT VERIFIED"}</span>
            </span></div>
          </div>
        </>
      )}
    </div>
  );
}

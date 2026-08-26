import type { ArchivedExecutionPlan } from "../data/types";
import { ProvenanceBadge } from "./ProvenanceBadge";

export function ExecutionPlanPanel({ plan }: { plan: ArchivedExecutionPlan }) {
  return (
    <div className="panel">
      <h2>Execution Plan <ProvenanceBadge tier="SIMULATED" /></h2>
      {plan.steps.length === 0 ? (
        <p className="subtitle">Winner was hold — no on-chain action required. A valid, complete outcome.</p>
      ) : (
        <>
          <ol style={{ margin: "0 0 14px", paddingLeft: 20, fontSize: "0.88rem", lineHeight: 1.7 }}>
            {plan.steps.map((s, i) => (
              <li key={i}>
                <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontWeight: 700 }}>{s.kind}</span> — {s.description}
              </li>
            ))}
          </ol>
          <div className="kv">
            <div><span className="k">Target range</span><span className="v">{plan.targetRange ? `[${plan.targetRange.tickLower}, ${plan.targetRange.tickUpper})` : "n/a"}</span></div>
            <div><span className="k">Liquidity to migrate</span><span className="v">{plan.liquidityToMigrate}</span></div>
            <div><span className="k">Estimated gas</span><span className="v">{plan.estimatedGasWei} wei</span></div>
            <div><span className="k">Feasible</span><span className="v">{plan.feasible ? "yes" : `no — ${plan.feasibilityReasons.join("; ")}`}</span></div>
          </div>
        </>
      )}
      <p style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: 12 }}>
        status: <code>{plan.status}</code> — never anything else at this stage; nothing has been signed.
      </p>
    </div>
  );
}

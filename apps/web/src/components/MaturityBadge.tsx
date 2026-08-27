// Separate from ProvenanceBadge (which has a fixed, different meaning: OBSERVED/DERIVED/
// SUPPLIED/SIMULATED, applied to individual data fields). This badge is applied to a whole
// CATEGORY, distinguishing "has this ever really executed on-chain" from "recommendation only".
import type { CategoryMaturity } from "../data/agentCatalog";

export function MaturityBadge({ maturity }: { maturity: CategoryMaturity }) {
  const label = maturity === "live-executed" ? "LIVE — REAL EXECUTED HISTORY" : "RECOMMENDATION ONLY — NOT YET EXECUTED";
  const cls = maturity === "live-executed" ? "status-good" : "status-muted";
  return <span className={`status-pill ${cls}`}>{label}</span>;
}

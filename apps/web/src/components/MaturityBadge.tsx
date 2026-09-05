// Separate from ProvenanceBadge (which has a fixed, different meaning: OBSERVED/DERIVED/
// SUPPLIED/SIMULATED, applied to individual data fields). This badge is applied to a whole
// CATEGORY, distinguishing "has this ever really executed on-chain" from "recommendation only".
import type { CategoryMaturity } from "../data/agentCatalog";

/**
 * `quiet` drops the colour without dropping the claim.
 *
 * On the marketplace grid all four categories are live-executed, so a green badge on every card
 * distinguishes nothing while spending the strongest colour on the page -- and it sat next to the
 * scheduling badge, which does vary. Colour goes to the badge that carries information; this one
 * still says what it says, just without shouting it four times.
 */
export function MaturityBadge({
  maturity,
  emphasis = "loud",
}: {
  maturity: CategoryMaturity;
  emphasis?: "loud" | "quiet";
}) {
  const label = maturity === "live-executed" ? "LIVE — REAL EXECUTED HISTORY" : "RECOMMENDATION ONLY — NOT YET EXECUTED";
  const cls =
    emphasis === "quiet" ? "status-muted" : maturity === "live-executed" ? "status-good" : "status-muted";
  return <span className={`status-pill ${cls}`}>{label}</span>;
}

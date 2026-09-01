// The marketplace's category catalog -- a real config array, not a hardcoded single agent.
// `maturity` must never be set to "live-executed" for a category that hasn't actually produced
// a real, verified, on-chain executed outcome; see docs/VEYRA_CUSTODY_ARCHITECTURE.md-style
// discipline applied to the frontend layer.

export type JobCategory = "rebalance" | "grid-trading" | "yield-optimisation" | "health-factor-monitoring";
export type CategoryMaturity = "live-executed" | "recommendation-only";

export interface AgentCatalogEntry {
  id: JobCategory;
  displayName: string;
  shortDescription: string;
  longDescription: string;
  maturity: CategoryMaturity;
}

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: "rebalance",
    displayName: "Rebalancing",
    shortDescription: "Manages PancakeSwap V3 LP ranges, recentering the position as price drifts.",
    longDescription:
      "Compares real candidate ranges against a market-aware evaluator and, when a rebalance genuinely scores best, executes the real decrease -> collect -> swap -> mint sequence on-chain -- including a ratio-fixing swap when the held tokens don't match the new range.",
    maturity: "live-executed",
  },
  {
    id: "grid-trading",
    displayName: "Grid Trading",
    shortDescription: "Places and recenters a ladder of narrow-range positions around the current price.",
    longDescription:
      "Each grid slot is its own narrow PancakeSwap V3 position. The agent only recenters a slot that is both out of range and drifted from where the ladder would now place it -- reusing the exact same proven decrease/collect/swap/mint execution path as Rebalancing, once per slot.",
    maturity: "live-executed",
  },
  {
    id: "yield-optimisation",
    displayName: "Yield Optimisation",
    shortDescription: "Compares real, observed fee-growth across pools and recommends where capital should sit.",
    longDescription:
      "Reads cumulative (all-time) fee-growth-per-liquidity directly from each candidate pool -- a real, observed signal, deliberately not presented as an annualized APR, which this project has no honest way to compute from a single snapshot. When a candidate genuinely outscores the pool capital currently sits in, it executes the migration: withdraw, collect, and redeploy into the better pool. Note the scoring considers fee growth only, not liquidity depth -- a real limitation recorded in the run archive.",
    maturity: "live-executed",
  },
  {
    id: "health-factor-monitoring",
    displayName: "Health Factor Monitoring",
    shortDescription: "Watches a real Venus Protocol lending position and recommends repayment before risk builds.",
    longDescription:
      "Reads Venus's own on-chain solvency signal (liquidity/shortfall) for a real, currently-open borrow position, and derives a precisely-labeled borrow-to-capacity ratio -- never called a \"health factor\", since Venus (a Compound fork) doesn't expose Aave's single number. When the ratio crosses the 60% warning threshold it executes a real repayBorrow on Venus, verified by re-reading the debt rather than trusting the receipt (a Compound fork returns an error code instead of reverting, so a mined transaction can change nothing).",
    maturity: "live-executed",
  },
];

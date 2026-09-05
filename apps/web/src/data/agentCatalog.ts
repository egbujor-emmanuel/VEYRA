// The marketplace's category catalog -- a real config array, not a hardcoded single agent.
// `maturity` must never be set to "live-executed" for a category that hasn't actually produced
// a real, verified, on-chain executed outcome; see docs/VEYRA_CUSTODY_ARCHITECTURE.md-style
// discipline applied to the frontend layer.

export type JobCategory = "rebalance" | "grid-trading" | "yield-optimisation" | "health-factor-monitoring";
export type CategoryMaturity = "live-executed" | "recommendation-only";

/**
 * Whether the daemon runs this category on its own, or it waits for an operator.
 *
 * Kept here rather than on the detail page, because the marketplace needs it too. Four cards all
 * carrying the same green "LIVE" badge told a visitor that four agents were equally autonomous,
 * which two of them are not -- the distinction only appeared once you clicked through. Maturity
 * ("has this really executed on-chain") and scheduling ("does it act without being asked") are
 * different questions and both belong on the card.
 */
export type CategoryScheduling = "scheduled" | "on-demand";

export interface AgentCatalogEntry {
  id: JobCategory;
  displayName: string;
  shortDescription: string;
  longDescription: string;
  maturity: CategoryMaturity;
  scheduling: CategoryScheduling;
  /** Why it is scheduled or not -- shown in full on the detail page. */
  schedulingNote: string;
}

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: "rebalance",
    displayName: "Rebalancing",
    shortDescription: "Manages PancakeSwap V3 LP ranges, recentering the position as price drifts.",
    longDescription:
      "Compares real candidate ranges against a market-aware evaluator and, when a rebalance genuinely scores best, executes the real decrease -> collect -> swap -> mint sequence on-chain -- including a ratio-fixing swap when the held tokens don't match the new range.",
    maturity: "live-executed",
    scheduling: "scheduled",
    schedulingNote:
      "The daemon runs against every account that has granted VEYRA a live, scoped session, and does not need this tab open -- activating here only turns on live reads so you can watch the state it works from.",
  },
  {
    id: "grid-trading",
    displayName: "Grid Trading",
    shortDescription: "Places and recenters a ladder of narrow-range positions around the current price.",
    longDescription:
      "Each grid slot is its own narrow PancakeSwap V3 position. The agent only recenters a slot that is both out of range and drifted from where the ladder would now place it -- reusing the exact same proven decrease/collect/swap/mint execution path as Rebalancing, once per slot.",
    maturity: "live-executed",
    scheduling: "scheduled",
    schedulingNote:
      "Runs under the daemon. It was taken offline once: a scheduled pass unwound a slot and then failed at the ratio-fixing swap, leaving it decreased and unminted. The cause was targets that straddled the current price -- slots are now placed strictly to one side, which removes the swap from the path, and any reposition that would still need one is refused outright.",
  },
  {
    id: "yield-optimisation",
    displayName: "Yield Optimisation",
    shortDescription: "Compares fee-growth across real PancakeSwap pools and moves capital to the better one.",
    longDescription:
      "Reads cumulative (all-time) fee-growth-per-liquidity directly from each candidate pool -- a real, observed signal, deliberately not presented as an annualized APR, which this project has no honest way to compute from a single snapshot. When a candidate genuinely outscores the pool capital currently sits in, it executes the migration: withdraw, collect, and redeploy into the better pool. Fee growth is measured per unit of liquidity, so a nearly-empty pool can post a high score while being unable to absorb a trade; a depth gate rejects any candidate holding under 25% of the current pool's liquidity, and says so rather than holding silently.",
    maturity: "live-executed",
    scheduling: "on-demand",
    schedulingNote:
      "Deliberately not scheduled. A migration moves the whole position, and this run's own record states the advantage it responded to was seeded rather than observed -- BSC testnet has too little volume for a candidate to overtake organically. Automating a capital move on a signal the record itself calls unreliable would be the wrong thing to build.",
  },
  {
    id: "health-factor-monitoring",
    displayName: "Health Factor Monitoring",
    shortDescription: "Watches a real Venus lending position and repays it before liquidation risk develops.",
    longDescription:
      "Reads Venus's own on-chain solvency signal (liquidity/shortfall) for a real, currently-open borrow position, and derives a precisely-labeled borrow-to-capacity ratio -- never called a \"health factor\", since Venus (a Compound fork) doesn't expose Aave's single number. When the ratio crosses the 60% warning threshold it executes a real repayBorrow on Venus, verified by re-reading the debt rather than trusting the receipt (a Compound fork returns an error code instead of reverting, so a mined transaction can change nothing).",
    maturity: "live-executed",
    scheduling: "scheduled",
    schedulingNote:
      "The daemon reads this position and repays without being asked once the ratio crosses the threshold. It does not need this tab open.",
  },
];

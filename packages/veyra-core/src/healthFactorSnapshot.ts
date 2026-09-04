// Health Factor Monitoring's market snapshot. Venus (the Compound-fork lending protocol this
// targets) does not expose a single Aave-style "health factor < 1.0" number -- its Comptroller
// returns (error, liquidity, shortfall): `liquidity` is real USD-scaled headroom when healthy,
// `shortfall` is real USD-scaled deficit when genuinely underwater/liquidatable. This module
// keeps both real numbers, and separately derives a precisely-named `borrowToCapacityRatio` (NOT
// called a health factor) using the borrowed principal's face value as its USD estimate -- an
// honest simplification for a stablecoin (USDT), not an invented number, and labeled as exactly
// that rather than dressed up as a more authoritative-sounding metric.

export interface VenusAccountObservation {
  /**
   * Venus oracle price for the borrowed asset, as returned by getUnderlyingPrice: the USD price
   * scaled by 1e(36 - token decimals). Optional so an observation built without an oracle read
   * still type-checks; when absent the ratio falls back to face value.
   */
  borrowedTokenPriceMantissa?: bigint;
  account: `0x${string}`;
  comptrollerError: bigint; // 0 == success; any nonzero value means the read itself failed, not a solvency judgment
  liquidityUsd1e18: bigint; // USD-scaled (1e18) headroom, 0 if none
  shortfallUsd1e18: bigint; // USD-scaled (1e18) deficit, 0 if healthy
  borrowedPrincipalUnderlyingUnits: bigint; // real, currently-owed principal (+accrued interest) in the borrowed token's own decimals
  borrowedTokenSymbol: string;
  borrowedTokenDecimals: number;
}

export type HealthFactorSolvencyStatus = "HEALTHY" | "SHORTFALL" | "NO_BORROW_POSITION";

export interface HealthFactorMarketSnapshot {
  observation: VenusAccountObservation;
  solvencyStatus: HealthFactorSolvencyStatus;
  /**
   * 0-100: borrowed value (using the borrowed stablecoin's face value as its USD estimate) as a
   * fraction of (borrowed value + remaining headroom). 0 = no debt. 100 = at or past shortfall.
   * Deliberately NOT named "health factor" -- Venus's own (liquidity, shortfall) pair is the
   * authoritative solvency signal; this is a derived, precisely-scoped convenience metric for
   * this evaluator only.
   */
  borrowToCapacityRatio: number;
}

export function computeHealthFactorSnapshot(observation: VenusAccountObservation): HealthFactorMarketSnapshot {
  if (observation.shortfallUsd1e18 > 0n) {
    return { observation, solvencyStatus: "SHORTFALL", borrowToCapacityRatio: 100 };
  }
  if (observation.borrowedPrincipalUnderlyingUnits === 0n) {
    return { observation, solvencyStatus: "NO_BORROW_POSITION", borrowToCapacityRatio: 0 };
  }
  // Value the debt with Venus's own oracle rather than assuming 1 token = $1.
  //
  // This previously used face value, described as "an honest simplification for a stablecoin".
  // It was not even that: Venus's testnet oracle prices USDT at $0.50, so the ratio overstated
  // the debt by 2x on the exact asset the simplification was justified for. Any non-$1 asset
  // would have been wrong by its whole price.
  //
  // getUnderlyingPrice returns price scaled by 1e(36 - decimals), which makes the conversion
  // pleasantly simple: units * mantissa / 1e18 lands directly in the same 1e18 USD scale that
  // liquidityUsd1e18 already uses, with no per-decimal juggling.
  const decimalsScale = 10n ** BigInt(18 - observation.borrowedTokenDecimals);
  const borrowedUsd1e18 =
    observation.borrowedTokenPriceMantissa && observation.borrowedTokenPriceMantissa > 0n
      ? (observation.borrowedPrincipalUnderlyingUnits * observation.borrowedTokenPriceMantissa) / 10n ** 18n
      // No price available: fall back to face value rather than reporting a zero-value debt,
      // which would read as a safe position and is the more dangerous failure.
      : observation.borrowedPrincipalUnderlyingUnits * decimalsScale;
  const totalCapacityUsd1e18 = borrowedUsd1e18 + observation.liquidityUsd1e18;
  const borrowToCapacityRatio = totalCapacityUsd1e18 === 0n ? 0 : Number((borrowedUsd1e18 * 100n) / totalCapacityUsd1e18);
  return { observation, solvencyStatus: "HEALTHY", borrowToCapacityRatio };
}

export type HealthFactorStrategyFn = (
  job: import("./types.js").HealthFactorJobSpec,
  snapshot: HealthFactorMarketSnapshot,
) => Promise<import("./types.js").StrategyProposal>;

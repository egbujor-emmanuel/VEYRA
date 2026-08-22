// Minimal tick-spacing helpers for PancakeSwap V3 (fork of Uniswap V3 -- same fee-tier/tickSpacing
// mapping). This is standard, publicly documented protocol constants, not something derived or guessed.

export const TICK_SPACING_BY_FEE: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
};

export function roundToTickSpacing(tick: number, tickSpacing: number): number {
  return Math.round(tick / tickSpacing) * tickSpacing;
}

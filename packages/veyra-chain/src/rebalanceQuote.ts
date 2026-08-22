// Live counterpart to @veyra/core's computeRebalanceSwapRequirement (which only ever estimates
// a swap's output ignoring pool fee/price impact). This module gets the REAL expected output
// from PancakeSwap V3's QuoterV2 via a call-simulated eth_call -- no signer, no transaction --
// so the actual amountOutMinimum used on-chain is derived from a real quote, never a guess.

import type { PublicClient, Address } from "viem";
import { QUOTER_V2_ABI } from "./abis.js";
import { PANCAKE_V3_TESTNET } from "./testnetAddresses.js";

export interface LiveSwapQuote {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  gasEstimate: bigint;
}

export interface GetLiveSwapQuoteOpts {
  client: PublicClient;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  quoterAddress?: Address;
}

/** No price limit on the quote itself (0n) -- the REAL swap transaction is what applies a
 * price/slippage bound; this call only asks "what would I get right now." */
export async function getLiveSwapQuote(opts: GetLiveSwapQuoteOpts): Promise<LiveSwapQuote> {
  const quoter = opts.quoterAddress ?? (PANCAKE_V3_TESTNET.quoterV2 as Address);
  const { result } = await opts.client.simulateContract({
    address: quoter,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: opts.tokenIn, tokenOut: opts.tokenOut, amountIn: opts.amountIn, fee: opts.fee, sqrtPriceLimitX96: 0n }],
  });
  const [amountOut, sqrtPriceX96After, , gasEstimate] = result;
  return { amountOut, sqrtPriceX96After, gasEstimate };
}

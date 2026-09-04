// Live reader for Health Factor Monitoring: reads Venus Protocol's real Comptroller +
// borrow-market state for one account. No new math beyond what healthFactorSnapshot.ts already
// derives from the raw observation.

import type { PublicClient, Address } from "viem";
import { computeHealthFactorSnapshot, type HealthFactorMarketSnapshot, type VenusAccountObservation } from "@veyra/core";
import { VENUS_COMPTROLLER_ABI, VTOKEN_BORROW_BALANCE_ABI, VTOKEN_UNDERLYING_ABI, ERC20_META_ABI } from "./venusAbis.js";

/** Venus's Comptroller exposes its price oracle; the oracle prices a market's underlying. */
const COMPTROLLER_ORACLE_ABI = [
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const ORACLE_ABI = [
  { type: "function", name: "getUnderlyingPrice", stateMutability: "view", inputs: [{ name: "vToken", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface ReadVenusAccountOpts {
  client: PublicClient;
  comptrollerAddress: Address;
  /** The vToken market whose borrow balance is being monitored (e.g. vUSDT). */
  borrowedVTokenAddress: Address;
  account: Address;
}

export async function readVenusAccountObservation(opts: ReadVenusAccountOpts): Promise<HealthFactorMarketSnapshot> {
  const [comptrollerError, liquidityUsd1e18, shortfallUsd1e18] = await opts.client.readContract({
    address: opts.comptrollerAddress,
    abi: VENUS_COMPTROLLER_ABI,
    functionName: "getAccountLiquidity",
    args: [opts.account],
  });
  const borrowedPrincipalUnderlyingUnits = await opts.client.readContract({
    address: opts.borrowedVTokenAddress,
    abi: VTOKEN_BORROW_BALANCE_ABI,
    functionName: "borrowBalanceCurrent",
    args: [opts.account],
  });
  // Price the debt properly. Failing softly here is deliberate: a missing oracle should degrade
  // to the face-value estimate, not abort monitoring a position that may be at risk.
  let borrowedTokenPriceMantissa: bigint | undefined;
  try {
    const oracle = (await opts.client.readContract({
      address: opts.comptrollerAddress,
      abi: COMPTROLLER_ORACLE_ABI,
      functionName: "oracle",
    })) as Address;
    borrowedTokenPriceMantissa = (await opts.client.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: "getUnderlyingPrice",
      args: [opts.borrowedVTokenAddress],
    })) as bigint;
  } catch {
    borrowedTokenPriceMantissa = undefined;
  }

  const underlyingAddress = await opts.client.readContract({
    address: opts.borrowedVTokenAddress,
    abi: VTOKEN_UNDERLYING_ABI,
    functionName: "underlying",
  });

  const borrowedTokenDecimals = await opts.client.readContract({ address: underlyingAddress, abi: ERC20_META_ABI, functionName: "decimals" });
  const borrowedTokenSymbol = await opts.client.readContract({ address: underlyingAddress, abi: ERC20_META_ABI, functionName: "symbol" });

  const observation: VenusAccountObservation = {
    account: opts.account,
    comptrollerError,
    liquidityUsd1e18,
    shortfallUsd1e18,
    borrowedPrincipalUnderlyingUnits,
    ...(borrowedTokenPriceMantissa !== undefined ? { borrowedTokenPriceMantissa } : {}),
    borrowedTokenSymbol,
    borrowedTokenDecimals,
  };

  return computeHealthFactorSnapshot(observation);
}

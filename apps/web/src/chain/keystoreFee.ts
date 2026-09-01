// Why this file exists.
//
// A brand-new smart account cannot perform ANY admin action until its admin key is registered in
// Altana's KeyStore, and that registration carries a real native-BNB fee. The SDK does this
// silently: buildFirstActionPrepend() reads the wallet's KeyStore keys and, when there are none,
// prepends initialRegisterKey(admin) with `value: fee` to whatever the user was actually trying
// to do. So a visitor's very first action -- authorizing VEYRA -- carries a hidden funding
// requirement, and with an empty wallet it reverts with a bare `0x` and no usable explanation.
//
// The ADMIN key's registration is mandatory and unconditional. On top of that, VEYRA registers
// the SESSION key too (grantSession register:true), because Altana's bounty requires sessions to
// be "registered in Keystore, so integration is read onchain" -- an unregistered session exists
// only inside the account contract and shows up nowhere publicly.
//
// So a first grant on a brand-new wallet pays TWO fees: one for the admin key, one for the
// session key. Later grants pay one. Getting this wrong under-funds the user and reproduces
// exactly the bare `0x` revert this module exists to prevent.
//
// The fee is not a constant. Two reads minutes apart on BSC testnet returned
// 0.000723947696053108 and 0.000720092991117518 BNB, so it is clearly pegged to a moving price
// and MUST be read live. Hardcoding it would drift and silently under-fund users.

import { formatEther } from "viem";
import { publicClient } from "./client";

/** Altana's KeyStore + controller on BSC testnet, from the SDK's own network config. */
const KEYSTORE = "0x6b8361C29d05D498b1a12B54A37310f94171E94A" as const;
const KEYSTORE_CONTROLLER = "0xb530D1971f5453F3359518343F05D0AedFfF7e12" as const;

/**
 * Headroom on top of the registration fee to cover gas for the batched calls. The relay fronts
 * gas and recovers it from the account, so the account needs more than the fee alone.
 */
const GAS_HEADROOM_WEI = 500_000_000_000_000n; // 0.0005 BNB

const CONTROLLER_ABI = [
  {
    name: "getRegistrationFeeInWei",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const KEYSTORE_ABI = [
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
] as const;

export interface FundingRequirement {
  /** True when the wallet has never registered an admin key, so the fee-bearing prepend applies. */
  needsRegistration: boolean;
  /** Live per-key registration fee, in wei. */
  feeWei: bigint;
  /** How many registrations this grant will pay for: 2 on a first grant, 1 afterwards. */
  registrationCount: number;
  /** Fee plus gas headroom -- what the wallet must actually hold. */
  requiredWei: bigint;
  /** Human-readable required amount, e.g. "0.0012". */
  requiredFormatted: string;
}

/**
 * Works out what this specific wallet must hold before its first admin action can succeed.
 * A wallet that has already registered needs only ordinary gas, not the fee.
 */
export async function fetchFundingRequirement(address: `0x${string}`): Promise<FundingRequirement> {
  const keys = (await publicClient.readContract({
    address: KEYSTORE,
    abi: KEYSTORE_ABI,
    functionName: "getKeys",
    args: [address],
  })) as readonly `0x${string}`[];

  const needsRegistration = keys.length === 0;

  // Always read the fee: the session key is registered on every grant, not just the first.
  const feeWei = (await publicClient.readContract({
    address: KEYSTORE_CONTROLLER,
    abi: CONTROLLER_ABI,
    functionName: "getRegistrationFeeInWei",
  })) as bigint;

  // Admin registration (first grant only) + session registration (every grant).
  const registrationCount = needsRegistration ? 2 : 1;
  const requiredWei = feeWei * BigInt(registrationCount) + GAS_HEADROOM_WEI;

  return {
    needsRegistration,
    feeWei,
    registrationCount,
    requiredWei,
    requiredFormatted: Number(formatEther(requiredWei)).toFixed(4),
  };
}

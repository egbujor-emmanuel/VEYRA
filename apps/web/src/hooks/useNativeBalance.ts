// Reads the visitor's own tBNB balance. This exists because of a concrete failure a real user hit:
// a freshly created passkey wallet holds zero BNB, and Altana's KeyStore registration charges a
// real fee (0.000723947696053108 BNB on BSC testnet, read live from getRegistrationFeeInWei), so
// the very first thing a new user tried -- authorizing VEYRA -- failed with a raw relay error and
// no hint about why. Showing the balance, and the faucet when it's empty, is the fix for that.

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { publicClient } from "../chain/client";
import { fetchFundingRequirement, type FundingRequirement } from "../chain/keystoreFee";

export interface NativeBalance {
  wei: bigint;
  formatted: string;
  isEmpty: boolean;
}

/** Balance paired with what this wallet actually needs before its first admin action. */
export interface WalletFunding {
  balance: NativeBalance;
  requirement: FundingRequirement;
  /** False when the next admin action would revert for lack of funds. */
  sufficient: boolean;
}

export function useWalletFunding(address: string | null, refreshKey = 0): WalletFunding | null {
  const [funding, setFunding] = useState<WalletFunding | null>(null);

  useEffect(() => {
    if (!address) {
      setFunding(null);
      return;
    }
    let cancelled = false;
    const addr = address as `0x${string}`;
    Promise.all([publicClient.getBalance({ address: addr }), fetchFundingRequirement(addr)])
      .then(([wei, requirement]) => {
        if (cancelled) return;
        setFunding({
          balance: { wei, formatted: Number(formatEther(wei)).toFixed(4), isEmpty: wei === 0n },
          requirement,
          sufficient: wei >= requirement.requiredWei,
        });
      })
      // Never block the UI on this read: if it fails we simply do not gate the button, and the
      // user gets the (now translated) on-chain error instead of a wrong "you are short" claim.
      .catch(() => !cancelled && setFunding(null));
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  return funding;
}

export function useNativeBalance(address: string | null, refreshKey = 0): NativeBalance | null {
  const [balance, setBalance] = useState<NativeBalance | null>(null);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    publicClient
      .getBalance({ address: address as `0x${string}` })
      .then((wei) => {
        if (cancelled) return;
        setBalance({ wei, formatted: Number(formatEther(wei)).toFixed(4), isEmpty: wei === 0n });
      })
      // A failed balance read must not block the wallet UI -- it is an affordance, not a gate.
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  return balance;
}

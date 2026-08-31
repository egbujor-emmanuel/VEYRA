// Reads the visitor's own tBNB balance. This exists because of a concrete failure a real user hit:
// a freshly created passkey wallet holds zero BNB, and Altana's KeyStore registration charges a
// real fee (0.000723947696053108 BNB on BSC testnet, read live from getRegistrationFeeInWei), so
// the very first thing a new user tried -- authorizing VEYRA -- failed with a raw relay error and
// no hint about why. Showing the balance, and the faucet when it's empty, is the fix for that.

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { publicClient } from "../chain/client";

export interface NativeBalance {
  wei: bigint;
  formatted: string;
  isEmpty: boolean;
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

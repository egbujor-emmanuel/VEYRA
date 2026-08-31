// useUserWallet holds its state in useState, so mounting it in two places would produce two
// independent wallets -- a visitor who created one on the marketplace would find the hire panel
// on an agent page still saying "create a wallet first". The wallet is genuinely app-wide state,
// so it lives in one provider at the root and every surface reads the same instance.

import { createContext, useContext, type ReactNode } from "react";
import { useUserWallet } from "./useUserWallet";

type WalletContextValue = ReturnType<typeof useUserWallet>;

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  return <WalletContext.Provider value={useUserWallet()}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>.");
  return ctx;
}

/** The connected wallet, or null when none has been created/recovered yet. */
export function useConnectedWallet() {
  const { state } = useWallet();
  return state.status === "ready" ? state.wallet : null;
}

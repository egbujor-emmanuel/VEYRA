// Holds the visitor's own wallet + any session they've granted VEYRA, for this browser session.
// Deliberately NOT persisted to localStorage: the wallet is recoverable from on-chain state via
// a biometric prompt (recoverFromPasskey), so there is no reason to keep anything client-side
// that could go stale or leak.

import { useCallback, useState } from "react";
import {
  createUserWallet,
  recoverUserWallet,
  grantVeyraSession,
  revokeVeyraSession,
  type UserWallet,
  type UserSession,
} from "../chain/passkeyWallet";

export type WalletState =
  | { status: "disconnected" }
  | { status: "working"; note: string }
  | { status: "ready"; wallet: UserWallet; session: UserSession | null }
  | { status: "error"; message: string; previous: UserWallet | null };

export function useUserWallet() {
  const [state, setState] = useState<WalletState>({ status: "disconnected" });

  const run = useCallback(async (note: string, fn: () => Promise<WalletState>) => {
    setState((prev) => {
      const carried = prev.status === "ready" ? prev.wallet : prev.status === "error" ? prev.previous : null;
      void carried;
      return { status: "working", note };
    });
    try {
      setState(await fn());
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : String(err), previous: null });
    }
  }, []);

  const create = useCallback(
    () => run("Waiting for your biometric prompt…", async () => ({ status: "ready", wallet: await createUserWallet(), session: null })),
    [run],
  );

  const recover = useCallback(
    () => run("Recovering your wallet…", async () => ({ status: "ready", wallet: await recoverUserWallet(), session: null })),
    [run],
  );

  const grant = useCallback(
    (spendLimitWei: bigint, lifetimeSeconds: number) =>
      run("Authorizing VEYRA…", async () => {
        if (state.status !== "ready") throw new Error("Create or recover a wallet first.");
        const session = await grantVeyraSession({ wallet: state.wallet, spendLimitWei, lifetimeSeconds });
        return { status: "ready", wallet: state.wallet, session };
      }),
    [run, state],
  );

  const revoke = useCallback(
    () =>
      run("Revoking…", async () => {
        if (state.status !== "ready" || !state.session) throw new Error("No active session to revoke.");
        await revokeVeyraSession(state.wallet, state.session);
        return { status: "ready", wallet: state.wallet, session: null };
      }),
    [run, state],
  );

  return { state, create, recover, grant, revoke };
}

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

/**
 * Two things learned from a real device that a virtual authenticator hid:
 *
 * 1. This is SLOW -- the biometric prompt is instant, but what follows is an on-chain EIP-7702
 *    account upgrade through Altana's relay, which took ~6s headless and noticeably longer on
 *    real hardware. A single frozen label for that whole window reads as "broken", so the notes
 *    below advance on a timer to show it is still working and what it is actually doing.
 * 2. It must never hang forever. If the relay stalls, say so with the stage it died at.
 */
/** Wallet creation: biometric prompt, then an EIP-7702 account upgrade through Altana's relay. */
const CREATE_NOTES = [
  { after: 0, note: "Waiting for your device…" },
  { after: 3_000, note: "Passkey accepted. Creating your account on-chain…" },
  { after: 12_000, note: "Still working — the on-chain upgrade can take a while. Don't close this tab." },
  { after: 30_000, note: "Taking longer than usual. Still waiting on Altana's relay…" },
];

/**
 * Granting is legitimately slower than creating, and for a reason worth stating rather than
 * papering over: after the relay reports CONFIRMED, the SDK deliberately polls getKeys() for up
 * to 30s and then sleeps a further 12s, because load-balanced BSC public RPCs serve stale reads
 * from independent connection pools -- skip that wait and the very next execute() fails with an
 * unknown key hash. So ~45s of the wait is by design, not a stall, and the copy should say so.
 */
const GRANT_NOTES = [
  { after: 0, note: "Waiting for your device…" },
  { after: 3_000, note: "Approved. Registering the session key on your account…" },
  { after: 15_000, note: "Session authorized on-chain. Waiting for BSC nodes to agree it exists…" },
  { after: 45_000, note: "Still syncing. This last step is a deliberate safety wait — nearly there." },
];

const CREATE_TIMEOUT_MS = 90_000;
/** Confirmation + up to 30s key-visibility polling + a 12s relay catch-up buffer, plus headroom. */
const GRANT_TIMEOUT_MS = 150_000;

export function useUserWallet() {
  const [state, setState] = useState<WalletState>({ status: "disconnected" });

  const run = useCallback(
    async (fn: () => Promise<WalletState>, stages: typeof CREATE_NOTES, timeoutMs: number) => {
      setState({ status: "working", note: stages[0]!.note });
      const timers = stages
        .slice(1)
        .map((s) =>
          setTimeout(
            () => setState((prev) => (prev.status === "working" ? { status: "working", note: s.note } : prev)),
            s.after,
          ),
        );
      const bail = setTimeout(
        () =>
          setState((prev) =>
            prev.status === "working"
              ? {
                  status: "error",
                  previous: null,
                  message:
                    `This didn't complete within ${Math.round(timeoutMs / 1000)}s. Your approval itself almost ` +
                    `certainly succeeded — what stalls after it is Altana's relay or a slow BSC node. Retrying usually works.`,
                }
              : prev,
          ),
        timeoutMs,
      );

      try {
        setState(await fn());
      } catch (err) {
        setState({ status: "error", message: describeError(err), previous: null });
      } finally {
        timers.forEach(clearTimeout);
        clearTimeout(bail);
      }
    },
    [],
  );

  const create = useCallback(
    () => run(async () => ({ status: "ready", wallet: await createUserWallet(), session: null }), CREATE_NOTES, CREATE_TIMEOUT_MS),
    [run],
  );

  const recover = useCallback(
    () => run(async () => ({ status: "ready", wallet: await recoverUserWallet(), session: null }), CREATE_NOTES, CREATE_TIMEOUT_MS),
    [run],
  );

  const grant = useCallback(
    (spendLimitWei: bigint, lifetimeSeconds: number) =>
      run(async () => {
        if (state.status !== "ready") throw new Error("Create or recover a wallet first.");
        const session = await grantVeyraSession({ wallet: state.wallet, spendLimitWei, lifetimeSeconds });
        return { status: "ready", wallet: state.wallet, session };
      }, GRANT_NOTES, GRANT_TIMEOUT_MS),
    [run, state],
  );

  const revoke = useCallback(
    () =>
      run(async () => {
        if (state.status !== "ready" || !state.session) throw new Error("No active session to revoke.");
        await revokeVeyraSession(state.wallet, state.session);
        return { status: "ready", wallet: state.wallet, session: null };
      }, GRANT_NOTES, GRANT_TIMEOUT_MS),
    [run, state],
  );

  return { state, create, recover, grant, revoke };
}

/**
 * Relay and contract errors are written for developers. A visitor who just tapped a fingerprint
 * reader needs to know what to DO, so the failure modes we've actually hit get translated; the
 * rest fall through verbatim rather than being flattened into a useless generic message.
 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();

  // The relay surfaces an out-of-funds userOp as a bare empty revert with no reason string --
  // literally "Reason: 0x Details: 0x". Verified on BSC testnet: a new wallet's first admin
  // action carries a mandatory, fee-bearing initialRegisterKey prepend, so an empty wallet
  // always lands here. Treat it as the funding problem it almost always is, while saying so
  // rather than asserting it as certain.
  if (low.includes("reason: 0x") || low.includes("executing calls")) {
    return (
      "The transaction was rejected on-chain without a reason. This is almost always an unfunded " +
      "wallet: your first action also registers your account key with Altana, which charges a fee " +
      "in BNB. Add some testnet BNB to your address and try again."
    );
  }
  if (low.includes("insufficient") || low.includes("exceeds balance") || low.includes("funds")) {
    return (
      "Your wallet needs a small amount of testnet BNB to cover this transaction, and it's currently empty. " +
      "Grab some free tBNB from the BNB Chain faucet for your address above, then try again."
    );
  }
  if (low.includes("notallowed") || low.includes("aborted") || low.includes("timed out")) {
    return "The passkey prompt was dismissed or timed out. Try again and approve it on your device.";
  }
  if (low.includes("did not confirm")) {
    return "Altana's relay accepted the request but it never confirmed on-chain. This is usually transient — try again.";
  }
  return raw;
}

// The real user-facing wallet layer. A visitor creates a genuine Altana smart account in their
// own browser with a biometric prompt -- no extension, no seed phrase, no private key they have
// to manage -- then grants VEYRA a scoped, expiring, revocable session over their own position.
//
// This is Altana's own supported consumer path (createPasskeyWallet / recoverFromPasskey /
// grantSession / revokeSession). It deliberately does NOT use the injected-wallet signer path:
// @altananetwork/sdk v0.5.1 does not implement one -- its own error text says so explicitly
// ("Injected wallet signers (e.g. MetaMask) ... the current build of @altananetwork/sdk doesn't
// accept them as a signer type").

import { createClient, BNB_TESTNET } from "@altananetwork/sdk";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

/** Relying-party id for WebAuthn. Must match the site's own domain at runtime. */
const RP_ID = typeof window !== "undefined" ? window.location.hostname : "localhost";
const APP_NAME = "VEYRA";

export type AltanaClient = ReturnType<typeof createClient>;
export type UserWallet = Awaited<ReturnType<AltanaClient["createPasskeyWallet"]>>;
export type UserSession = Awaited<ReturnType<AltanaClient["grantSession"]>>;

let cachedClient: AltanaClient | null = null;
export function altanaClient(): AltanaClient {
  if (!cachedClient) cachedClient = createClient({ chains: [BNB_TESTNET] });
  return cachedClient;
}

/** First-time visitor: one biometric prompt creates a real smart account. */
export async function createUserWallet(): Promise<UserWallet> {
  return altanaClient().createPasskeyWallet({ name: APP_NAME, rpId: RP_ID });
}

/** Returning visitor: rebuilds the same wallet from on-chain state. No stored secret. */
export async function recoverUserWallet(): Promise<UserWallet> {
  return altanaClient().recoverFromPasskey({ rpId: RP_ID });
}

export interface GrantVeyraSessionOpts {
  wallet: UserWallet;
  /** The agent's own session-key public address, generated agent-side. */
  agentSessionSigner?: Parameters<AltanaClient["grantSession"]>[0]["sessionSigner"];
  /** Native-token spend ceiling for the whole session period. */
  spendLimitWei: bigint;
  /** Seconds from now. Kept short by default -- see relayRiskPolicy.ts for why. */
  lifetimeSeconds: number;
}

/**
 * Grants VEYRA a session scoped to PancakeSwap V3 position management only.
 *
 * The call allowlist is the NFPM (position manager) and the swap router -- nothing else. Note
 * that Altana's on-chain scoping stops at (contract, selector); it cannot constrain WHICH
 * tokenId or WHICH recipient. VEYRA's own argument-level policy (authorizeAltanaCall) is what
 * closes that gap before anything is broadcast.
 */
export async function grantVeyraSession(opts: GrantVeyraSessionOpts): Promise<UserSession> {
  const expiry = Math.floor(Date.now() / 1000) + opts.lifetimeSeconds;
  return altanaClient().grantSession({
    wallet: opts.wallet,
    signer: opts.wallet.signer,
    ...(opts.agentSessionSigner ? { sessionSigner: opts.agentSessionSigner } : {}),
    permissions: {
      calls: [
        { to: PANCAKE_V3_TESTNET.nonfungiblePositionManager as `0x${string}` },
        { to: PANCAKE_V3_TESTNET.swapRouter as `0x${string}` },
      ],
      spend: [{ limit: opts.spendLimitWei, period: "day" }],
    },
    expiry,
  });
}

export async function revokeVeyraSession(wallet: UserWallet, session: UserSession): Promise<void> {
  await altanaClient().revokeSession({ wallet, signer: wallet.signer, session });
}

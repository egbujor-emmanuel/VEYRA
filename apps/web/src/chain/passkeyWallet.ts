// The real user-facing wallet layer. A visitor creates a genuine Altana smart account in their
// own browser with a biometric prompt -- no extension, no seed phrase, no private key they have
// to manage -- then grants VEYRA a scoped, expiring, revocable session over their own position.
//
// This is Altana's own supported consumer path (createPasskeyWallet / recoverFromPasskey /
// grantSession / revokeSession). It deliberately does NOT use the injected-wallet signer path:
// @altananetwork/sdk v0.5.1 does not implement one -- its own error text says so explicitly
// ("Injected wallet signers (e.g. MetaMask) ... the current build of @altananetwork/sdk doesn't
// accept them as a signer type").

import { createClient, BNB_TESTNET, signerFromPasskey } from "@altananetwork/sdk";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";
import { VEYRA_AGENT_SESSION } from "../constants";

/** Relying-party id for WebAuthn. Must match the site's own domain at runtime. */
const RP_ID = typeof window !== "undefined" ? window.location.hostname : "localhost";
/**
 * The label the OS passkey picker shows. It MUST be unique per wallet: the SDK passes this
 * straight through as the WebAuthn credential label, and a device that has created several
 * wallets otherwise shows an unpickable list of identical "VEYRA" entries. A real tester hit
 * exactly that and could not tell which passkey belonged to which wallet.
 */
function passkeyLabel(): string {
  const stamp = new Date().toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `VEYRA · ${stamp}`;
}

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
  return altanaClient().createPasskeyWallet({ name: passkeyLabel(), rpId: RP_ID });
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
/**
 * VEYRA's agent session key as a PUBLIC-ONLY signer.
 *
 * grantSession never signs with the session key -- it only needs `publicKey` to build the key
 * descriptor and `address` to compute the key hash. The user's own passkey signs the
 * authorization. So the private half is genuinely absent from this bundle.
 *
 * signDigest therefore throws rather than being stubbed silently: if any future code path tries
 * to USE this session from the browser, it must fail loudly instead of appearing to work.
 */
function agentSessionSignerPublicOnly(): NonNullable<Parameters<AltanaClient["grantSession"]>[0]["sessionSigner"]> {
  return {
    type: "privateKey",
    address: VEYRA_AGENT_SESSION.address,
    publicKey: VEYRA_AGENT_SESSION.publicKey,
    async signDigest() {
      throw new Error(
        "VEYRA's agent session key cannot sign in the browser -- only its public half ships here. " +
          "Signing happens in services/agent-daemon, which holds the private key.",
      );
    },
  } as NonNullable<Parameters<AltanaClient["grantSession"]>[0]["sessionSigner"]>;
}

export async function grantVeyraSession(opts: GrantVeyraSessionOpts): Promise<UserSession> {
  const expiry = Math.floor(Date.now() / 1000) + opts.lifetimeSeconds;
  return altanaClient().grantSession({
    wallet: opts.wallet,
    signer: opts.wallet.signer,
    // Register the session key in Altana's public KeyStore.
    //
    // This was briefly disabled to dodge the registration fee, back when a brand-new wallet had
    // no balance and a registered grant failed outright. That was the wrong trade: registration
    // is what makes the session readable on-chain by anyone -- without it the key exists only
    // inside the account contract, and Altana's own explorer shows nothing. The funding gate now
    // accounts for the fee up front instead (see chain/keystoreFee.ts), which is the honest fix.
    //
    // Enforcement is identical either way; what registration buys is public verifiability.
    register: true,
    // Delegate to VEYRA's own agent session key rather than letting the SDK mint a throwaway one
    // in this tab. A browser-generated session dies with the tab and can never be used while the
    // user is away; this one is held by the daemon, so the grant actually means something.
    // Public-only by construction -- the private half is not in this bundle and never will be.
    sessionSigner: opts.agentSessionSigner ?? agentSessionSignerPublicOnly(),
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


/*
 * ---------------------------------------------------------------------------------------------
 * Local wallet handle.
 *
 * This exists to close a real dead window that a tester hit. recoverFromPasskey() rebuilds a
 * wallet by reading its admin key out of Altana's KeyStore -- but a wallet's KeyStore entry is
 * only written by initialRegisterKey, which is prepended to its FIRST on-chain action. So
 * between "wallet created" and "first transaction confirmed", recovery is impossible: the SDK
 * throws "Picked passkey resolves to wallet 0x..., but that wallet has no keys registered in
 * KeyStore yet." Reload the page in that window and the wallet is simply gone -- along with any
 * funds already sent to it.
 *
 * A Wallet is only { address }, and a webauthn PasskeyCredential is only { id, publicKey, rpId }.
 * None of that is secret -- the passkey's private key never leaves the authenticator, and the
 * credential id is what the browser hands out on every assertion. So persisting the handle
 * locally is safe, and lets us rebuild the signer with signerFromPasskey() without touching
 * KeyStore at all.
 * ---------------------------------------------------------------------------------------------
 */

const STORAGE_KEY = "veyra.wallet.handle.v1";

export function rememberWallet(wallet: UserWallet): void {
  const credential = (wallet.signer as { credential?: { kind?: string } }).credential;
  // Never persist a headless credential -- that variant carries a raw P256 private key. It is
  // only used by tests, but writing one to localStorage would be a genuine key leak.
  if (!credential || credential.kind !== "webauthn") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: wallet.address, credential }));
  } catch {
    // Private browsing / blocked storage. The session still works; only reload-survival is lost.
  }
}

/** Rebuilds the wallet handle saved by rememberWallet, or null if there isn't a usable one. */
export function loadRememberedWallet(): UserWallet | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { address, credential } = JSON.parse(raw);
    if (!address || credential?.kind !== "webauthn") return null;
    return { address, signer: signerFromPasskey(credential) } as UserWallet;
  } catch {
    return null;
  }
}

export function forgetWallet(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

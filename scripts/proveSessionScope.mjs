// Proves the custody claim the whole product rests on: a granted VEYRA session can do exactly
// what it was scoped to and nothing else, and revoking it takes effect immediately on-chain.
//
// Note on the call shape: the SDK overloads execute() as execute(session, calls) for the session
// path and execute(wallet, signer, calls) for the admin path. Passing { wallet, signer:
// session.signer } silently takes the ADMIN branch and fails with a generic "invalid parameters"
// RPC error for every call -- which looks exactly like scope enforcement and is not. The session
// path must be invoked as { session, calls }.
//
// This runs the SAME grantSession/execute code paths the browser uses. The only difference is the
// admin signer type: createHeadlessPasskey() holds a P256 key in memory instead of prompting a
// biometric, which is the SDK's own documented way to exercise this flow without a browser.
//
// Four assertions, in order:
//   1. IN-SCOPE call with the session               -> must SUCCEED
//   2. OUT-OF-SCOPE call with the session           -> must be REJECTED
//   3. revoke the session
//   4. the same IN-SCOPE call, after revocation     -> must be REJECTED
//
// Assertion 2 is the one that matters: a session that can do anything is not custody, it is a
// handover. Assertion 4 is what makes "revocable" a real property rather than a UI affordance.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, BNB_TESTNET, createHeadlessPasskey } from "@altananetwork/sdk";
import { createPublicClient, http, encodeFunctionData, formatEther, keccak256 } from "viem";

/** AltanaAccount's own key list -- the authoritative on-chain record of what may act. */
const ACCOUNT_ABI = [{
  name: "getKeys", type: "function", stateMutability: "view", inputs: [],
  outputs: [
    { name: "keys", type: "tuple[]", components: [
      { name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" },
      { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" }] },
    { name: "keyHashes", type: "bytes32[]" }],
}];

async function readAccountKeys(address) {
  try {
    const [keys, hashes] = await pub.readContract({ address, abi: ACCOUNT_ABI, functionName: "getKeys" });
    return keys.map((k, i) => ({ ...k, hash: hashes[i] }));
  } catch {
    return null;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC = "https://bsc-testnet-rpc.publicnode.com";

const NFPM = "0x427bF5b37357632377eCbEC9de3626C71A5396c1"; // in scope
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"; // deliberately NOT in scope

const SPEND_LIMIT_WEI = 50_000_000_000_000_000n; // 0.05 BNB/day, same as the app
const SESSION_SECONDS = 3600;
const FUND_AMOUNT = "0.004";

const pub = createPublicClient({ transport: http(RPC) });
const client = createClient({ chains: [BNB_TESTNET] });

const results = [];
const record = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};

/** An in-scope state change that needs no pre-existing position or token balance. */
const inScopeCall = {
  to: NFPM,
  data: encodeFunctionData({
    abi: [{ type: "function", name: "setApprovalForAll", stateMutability: "nonpayable",
            inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] }],
    functionName: "setApprovalForAll",
    args: ["0x000000000000000000000000000000000000dEaD", false],
  }),
};

/** Same shape, but aimed at a contract the session was never granted. */
const outOfScopeCall = {
  to: WBNB,
  data: encodeFunctionData({
    abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
            inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
            outputs: [{ type: "bool" }] }],
    functionName: "approve",
    args: ["0x000000000000000000000000000000000000dEaD", 0n],
  }),
};

console.log("=== 0. create a wallet (headless passkey admin) ===");
const signer = createHeadlessPasskey();
const wallet = await client.createWallet({ signer });
console.log(`wallet: ${wallet.address}`);

console.log("\n=== 1. fund it past the KeyStore registration fee ===");
execFileSync(
  process.execPath,
  [resolve(__dirname, "fundTestWallet.mjs"), wallet.address, FUND_AMOUNT, "--from=operator"],
  { stdio: "inherit" },
);

console.log("\n=== 2. grant a scoped session ===");
const session = await client.grantSession({
  wallet,
  signer,
  register: false,
  permissions: { calls: [{ to: NFPM }], spend: [{ limit: SPEND_LIMIT_WEI, period: "day" }] },
  expiry: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
});
console.log(`session key: ${session.publicKey.slice(0, 26)}…  expires ${new Date(session.expiry * 1000).toISOString()}`);

// The account-level key list is the ground truth for "what may act on this wallet". Capture the
// session's presence here so revocation can be verified against on-chain state rather than
// against an SDK error string -- error text is not evidence of enforcement.
const keysAfterGrant = await readAccountKeys(wallet.address);
const scopedAfterGrant = (keysAfterGrant ?? []).filter((k) => Number(k.expiry) > 0 && !k.isSuperAdmin);
record("session key present on-chain after grant", scopedAfterGrant.length === 1,
  `${scopedAfterGrant.length} scoped key(s); hash=${scopedAfterGrant[0]?.hash ?? "none"}`);

// --- assertion 1: in-scope succeeds -------------------------------------------------------
console.log("\n=== 3. IN-SCOPE call via the session (expect SUCCESS) ===");
try {
  const r = await client.execute({ session, calls: [inScopeCall] });
  record("in-scope call succeeds", r.status !== "FAILED", `status=${r.status} tx=${r.transactionHash ?? "n/a"}`);
} catch (e) {
  record("in-scope call succeeds", false, (e.shortMessage ?? e.message).slice(0, 160));
}

// --- assertion 2: out-of-scope is refused -------------------------------------------------
console.log("\n=== 4. OUT-OF-SCOPE call via the session (expect REJECTION) ===");
try {
  const r = await client.execute({ session, calls: [outOfScopeCall] });
  // A FAILED status is still a rejection; only a confirmed success is a security failure.
  record("out-of-scope call is refused", r.status === "FAILED", `status=${r.status} tx=${r.transactionHash ?? "n/a"}`);
} catch (e) {
  record("out-of-scope call is refused", true, `rejected: ${(e.shortMessage ?? e.message).slice(0, 120)}`);
}

// --- assertion 3+4: revoke, then the same in-scope call must fail --------------------------
console.log("\n=== 5. revoke the session ===");
let revoked = false;
try {
  await client.revokeSession({ wallet, signer, session });
  revoked = true;
  record("revoke completes", true);
} catch (e) {
  record("revoke completes", false, (e.shortMessage ?? e.message).slice(0, 160));
}

if (revoked) {
  // Verify revocation against the account's own key list, not against an SDK error string. The
  // post-revoke execute below fails with a generic "invalid parameters" RPC error, which is the
  // SAME text an incorrectly-shaped call produces -- so on its own it is not evidence that the
  // chain rejected anything. The key list is.
  console.log("\n=== 6a. verify on-chain that the session key is gone ===");
  const keysAfterRevoke = await readAccountKeys(wallet.address);
  const scopedAfterRevoke = (keysAfterRevoke ?? []).filter((k) => Number(k.expiry) > 0 && !k.isSuperAdmin);
  record(
    "session key removed on-chain after revoke",
    keysAfterRevoke !== null && scopedAfterRevoke.length === 0,
    `${scopedAfterRevoke.length} scoped key(s) remain of ${keysAfterRevoke?.length ?? "?"} total`,
  );

  console.log("\n=== 6b. the SAME in-scope call, after revocation (expect REJECTION) ===");
  try {
    const r = await client.execute({ session, calls: [inScopeCall] });
    record("revoked session is refused", r.status === "FAILED", `status=${r.status} tx=${r.transactionHash ?? "n/a"}`);
  } catch (e) {
    record("revoked session is refused", true, `rejected: ${(e.shortMessage ?? e.message).slice(0, 120)}`);
  }
}

console.log(`\nwallet balance left: ${formatEther(await pub.getBalance({ address: wallet.address }))} tBNB`);
console.log("\n================ SUMMARY ================");
for (const r of results) console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
const failed = results.filter((r) => !r.passed).length;
console.log(failed === 0 ? "\nAll custody assertions held." : `\n${failed} assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

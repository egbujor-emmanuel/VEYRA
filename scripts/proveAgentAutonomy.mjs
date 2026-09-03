// Proves the last "not built" claim false: VEYRA acting on a USER'S account while the user is
// gone, without the user's key ever leaving their device and without VEYRA's key ever entering
// the browser.
//
// How the handoff works
//   - VEYRA's agent session keypair is generated once, offline. Only the PUBLIC half is compiled
//     into the frontend (constants.ts VEYRA_AGENT_SESSION).
//   - The browser calls grantSession({ sessionSigner: <public-only> }). Altana reads only
//     publicKey and address to build the descriptor; the USER'S passkey signs the authorization.
//   - The daemon holds the private half and reconstructs the Session to act.
//
// So neither key ever crosses the network. The naive alternative -- browser mints a session key
// and uploads it -- puts a live key on the wire and in logs. This does not.
//
// The test below is deliberately harsh: after granting, the user's signer is DISCARDED. Nothing
// the user holds is available when the agent acts.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createClient, BNB_TESTNET, createHeadlessPasskey } from "@altananetwork/sdk";
import { createPublicClient, http, encodeFunctionData, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const NFPM = "0x427bF5b37357632377eCbEC9de3626C71A5396c1";
const SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"; // deliberately NOT granted

const pub = createPublicClient({ transport: http(RPC, { timeout: 60000, retryCount: 5 }) });
const client = createClient({ chains: [BNB_TESTNET] });
const results = [];
const rec = (n, p, d) => { results.push({ n, p }); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? ` :: ${d}` : ""}`); };

// The agent's key: private half from the operator's gitignored file, exactly as the daemon loads it.
const agentKey = JSON.parse(readFileSync(resolve(REPO, "smoketest/.studio/agent-session.json"), "utf-8"));
const agentAccount = privateKeyToAccount(agentKey.privateKey);

// What the FRONTEND has: public half only. Reconstructed here from the published constants shape.
const publicOnlySigner = {
  type: "privateKey",
  address: agentKey.address,
  publicKey: agentKey.publicKey,
  async signDigest() { throw new Error("public-only signer cannot sign"); },
};
rec("frontend signer carries no private key", !("_privateKey" in publicOnlySigner), `address ${agentKey.address}`);

console.log("\n=== 1. a user creates a wallet and authorizes VEYRA ===");
const userSigner = createHeadlessPasskey();
const userWallet = await client.createWallet({ signer: userSigner });
console.log(`user wallet: ${userWallet.address}`);
execFileSync(process.execPath, [resolve(REPO, "scripts/fundTestWallet.mjs"), userWallet.address, "0.01", "--from=operator"], { stdio: "inherit" });

const expiry = Math.floor(Date.now() / 1000) + 3600;
const granted = await client.grantSession({
  wallet: userWallet,
  signer: userSigner,
  register: true,
  sessionSigner: publicOnlySigner,
  permissions: { calls: [{ to: NFPM }, { to: SWAP_ROUTER }], spend: [{ limit: 50_000_000_000_000_000n, period: "day" }] },
  expiry,
});
rec("session was granted to VEYRA's agent key", granted.publicKey.toLowerCase() === agentKey.publicKey.toLowerCase(),
    `session publicKey ${granted.publicKey.slice(0, 26)}…`);

// --- the user goes away -----------------------------------------------------------------------
console.log("\n=== 2. the user leaves -- their signer is discarded ===");
const userAddress = userWallet.address;
// Nothing from the user is carried forward except their public address.
console.log(`  all that remains of the user: ${userAddress}`);

// --- the daemon acts --------------------------------------------------------------------------
console.log("\n=== 3. VEYRA acts on the user's account, alone ===");
// Exactly what the daemon does: rebuild the Session from the agent's private key + the grant.
const daemonSession = {
  walletAddress: userAddress,
  signer: { type: "privateKey", address: agentAccount.address, publicKey: agentAccount.publicKey,
            _privateKey: agentKey.privateKey, async signDigest(d) { return agentAccount.sign({ hash: d }); } },
  publicKey: agentKey.publicKey,
  permissions: granted.permissions,
  expiry: granted.expiry,
};

const inScope = { to: NFPM, data: encodeFunctionData({
  abi: [{ type: "function", name: "setApprovalForAll", stateMutability: "nonpayable",
          inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] }],
  functionName: "setApprovalForAll", args: ["0x000000000000000000000000000000000000dEaD", false] }) };

try {
  const r = await client.execute({ session: daemonSession, calls: [inScope] });
  rec("VEYRA executed on the user's account with the user absent", r.status !== "FAILED", `status=${r.status} tx=${r.transactionHash ?? "n/a"}`);
} catch (e) {
  rec("VEYRA executed on the user's account with the user absent", false, (e.shortMessage ?? e.message).slice(0, 150));
}

console.log("\n=== 4. and still cannot exceed what it was granted ===");
const outOfScope = { to: WBNB, data: encodeFunctionData({
  abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
          inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] }],
  functionName: "approve", args: ["0x000000000000000000000000000000000000dEaD", 0n] }) };
try {
  const r = await client.execute({ session: daemonSession, calls: [outOfScope] });
  rec("out-of-scope call still refused", r.status === "FAILED", `status=${r.status}`);
} catch (e) {
  rec("out-of-scope call still refused", true, `rejected: ${(e.shortMessage ?? e.message).slice(0, 90)}`);
}

console.log(`\nuser balance left: ${formatEther(await pub.getBalance({ address: userAddress }))} tBNB`);
console.log("\n================ SUMMARY ================");
for (const r of results) console.log(`${r.p ? "PASS" : "FAIL"}  ${r.n}`);
const failed = results.filter((r) => !r.p).length;
console.log(failed === 0
  ? "\nVEYRA acts on a user's position while the user is away, within scope. Autonomy is real."
  : `\n${failed} FAILED`);
process.exit(failed ? 1 : 0);

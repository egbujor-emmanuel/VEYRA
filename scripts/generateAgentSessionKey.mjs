// Generates VEYRA's permanent AGENT SESSION KEY -- the key users delegate to.
//
// This is what makes "the agent works while you are away" true without ever putting a private key
// in a browser or on a network. The keypair is generated here, once. Only the PUBLIC half is
// published into the frontend; the private half stays on the operator's machine, gitignored.
//
// The flow it enables:
//   1. The browser calls grantSession({ sessionSigner: { type, address, publicKey } }) -- a
//      PUBLIC-ONLY signer. Altana's keyDescriptorFromSigner reads only publicKey, and
//      keyHashForSigner only address, so no private key is required to authorize a session.
//   2. The user's passkey signs that authorization. The session key is registered on their
//      account (and in Altana's KeyStore).
//   3. The daemon, holding the private half, reconstructs the Session and acts within the
//      granted scope -- while the user's browser is closed.
//
// The private key therefore never crosses the network in either direction. Compare the naive
// design, where the browser generates a session key and uploads it: that puts a live key on the
// wire and in server logs. This does not.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(REPO, "smoketest/.studio/agent-session.json");

if (existsSync(OUT) && !process.argv.includes("--force")) {
  const existing = JSON.parse((await import("node:fs")).readFileSync(OUT, "utf-8"));
  console.log("An agent session key already exists -- NOT regenerating.");
  console.log("Regenerating would orphan every session users have already granted.");
  console.log(`  address   : ${existing.address}`);
  console.log(`  publicKey : ${existing.publicKey}`);
  console.log("\nPass --force only if you intend to invalidate all existing grants.");
  process.exit(0);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ address: account.address, publicKey: account.publicKey, privateKey }, null, 2));

console.log("Agent session key generated.");
console.log(`  written to : ${OUT}  (gitignored -- never commit this)`);
console.log(`\n  address   : ${account.address}`);
console.log(`  publicKey : ${account.publicKey}`);
console.log("\nPublish ONLY the address and publicKey into apps/web/src/constants.ts.");

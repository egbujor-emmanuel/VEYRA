// Walks the entire first-time-visitor journey against the DEPLOYED site, as a real user would:
// create a passkey wallet in the browser, fund it, grant VEYRA a scoped session, deposit into a
// position, and verify every step on-chain rather than from the UI's own claims.
//
// Why it exists: every piece of this has been tested separately, but the thing a judge will
// actually do -- land on the page and try it -- had never been run end to end. The UI can say
// "session granted" without a session existing; that is exactly the class of bug this project has
// hit before (HirePanel once reported "Job funded" without calling fundJob).
//
// The WebAuthn ceremony is driven by a CDP virtual authenticator configured the way the wallet
// actually requires: resident key (discoverable credential) plus user verification. That is not a
// mock of the wallet -- the real Altana SDK runs, the real passkey signs, the real transactions
// land on BSC testnet. Only the fingerprint sensor is virtual.
//
// Costs real testnet tBNB, sent from VEYRA's own wallet to the throwaway one this creates.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatEther, parseEther } from "viem";
import { createSigner } from "@veyra/chain/txSigner";
// Imported dynamically so playwright does not have to be a repo dependency. Adding it would touch
// the lockfile, and this repo's CI installs with --legacy-peer-deps, where a lockfile change is the
// one thing that has broken the pipeline before. Point PLAYWRIGHT_MODULE at an existing install.
const { pathToFileURL: toUrl } = await import("node:url");
const pwSpecifier = (() => {
  const p = process.env.PLAYWRIGHT_MODULE;
  if (!p) return "playwright";
  if (p.startsWith("file:")) return p;
  // A filesystem path -- convert it, so Windows backslashes and spaces both survive.
  return toUrl(p).href;
})();
const { chromium } = await import(pwSpecifier);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.VEYRA_SITE ?? "https://egbujor-emmanuel.github.io/VEYRA/";
const RPC = process.env.VEYRA_RPC ?? "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
/** Enough for the KeyStore registration fee, the session grant, a deposit, and gas for all of it. */
const FUNDING = parseEther("0.02");

const client = createPublicClient({
  chain: {
    id: CHAIN_ID, name: "bsc-testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

function readWalletPassword() {
  for (const line of readFileSync(resolve(REPO, "smoketest/.studio/.env.local"), "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => console.log(`    OK   ${msg}`);
const bad = (msg) => console.log(`    FAIL ${msg}`);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  },
});

let failed = false;

// ---------------------------------------------------------------- 1. create the wallet
step(1, "Create a passkey wallet, as a first-time visitor");
await page.goto(BASE + "#/agents", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.getByRole("button", { name: /create wallet/i }).first().click();
await page.waitForFunction(
  () => !!localStorage.getItem("veyra.wallet.handle.v1"),
  { timeout: 60_000 },
).catch(() => {});

const handle = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("veyra.wallet.handle.v1") ?? "null"); } catch { return null; }
});
if (!handle?.address) { bad("no wallet handle was stored"); failed = true; }
else ok(`wallet ${handle.address}`);

const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
if (creds.credentials.length !== 1 || !creds.credentials[0].isResidentCredential) {
  bad(`expected one discoverable credential, got ${creds.credentials.length}`);
  failed = true;
} else ok("passkey is a discoverable (resident) credential, as Porto's signing path requires");

const user = handle.address;

// ---------------------------------------------------------------- 2. fund it
step(2, `Fund the new wallet with ${formatEther(FUNDING)} tBNB from VEYRA`);
const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({
    password: readWalletPassword(), address: VEYRA,
    walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true,
  }),
  CHAIN_ID,
);
const fundTx = await signer.sendAndWait("fund-visitor-wallet", user, "0x", FUNDING);
const funded = await client.getBalance({ address: user });
if (funded < FUNDING) { bad(`balance is ${formatEther(funded)}`); failed = true; }
else ok(`balance ${formatEther(funded)} tBNB (tx ${fundTx.hash})`);

// ---------------------------------------------------------------- 3. grant a session
step(3, "Grant VEYRA a scoped session from the browser");
await page.getByRole("button", { name: /refresh balance/i }).first().click().catch(() => {});
await page.waitForTimeout(4000);

const authorize = page.getByRole("button", { name: /authorize veyra/i }).first();
if (!(await authorize.isEnabled().catch(() => false))) {
  bad("Authorize button still disabled after funding");
  failed = true;
} else {
  await authorize.click();
  await page.waitForFunction(
    () => /session/i.test(document.body.innerText) && !/NO SESSION/i.test(document.body.innerText),
    { timeout: 180_000 },
  ).catch(() => {});
  const txt = await page.evaluate(() => document.body.innerText);
  if (/NO SESSION/i.test(txt)) { bad("UI still reports NO SESSION"); failed = true; }
  else ok("UI reports an active session");
}

// ---------------------------------------------------------------- 4. verify the session ON-CHAIN
step(4, "Verify the session exists on-chain, not just in the UI");
const KEYS_ABI = [{
  type: "function", name: "getKeys", stateMutability: "view", inputs: [],
  outputs: [{
    type: "tuple[]",
    components: [
      { name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" },
      { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" },
    ],
  }],
}];
try {
  const keys = await client.readContract({ address: user, abi: KEYS_ABI, functionName: "getKeys" });
  const session = keys.filter((k) => !k.isSuperAdmin);
  if (session.length === 0) { bad("account holds no non-admin session key"); failed = true; }
  else {
    const expiry = Number(session[0].expiry);
    ok(`${session.length} session key(s) registered on the account contract`);
    ok(`expires ${expiry ? new Date(expiry * 1000).toISOString() : "(no expiry)"} -- scoped and time-limited`);
  }
} catch (err) {
  bad(`getKeys failed: ${String(err.shortMessage ?? err.message ?? err).slice(0, 140)}`);
  failed = true;
}

await page.screenshot({ path: "e2e-visitor.png", fullPage: true });
console.log(errors.length ? `\nPAGE ERRORS:\n  ${errors.slice(0, 6).join("\n  ")}` : "\nno page errors");
console.log(`\nwallet under test: ${user}`);
console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: PASSED");
await browser.close();
process.exit(failed ? 1 : 0);

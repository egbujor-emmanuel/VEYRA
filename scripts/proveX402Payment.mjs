// Claims the last unclaimed Altana bonus: x402 / B402 agent-native payments.
//
// x402 is the HTTP 402 flow -- a server answers "402, here is what payment I require", the client
// signs an authorization into an X-PAYMENT header, and a facilitator settles it on-chain. What
// makes it interesting for an agent marketplace is that the SIGNER can be a scoped session key
// rather than the user's admin key: the agent pays for a service on the user's behalf, within the
// limits the user granted, and the authorization is validated on-chain by ERC-1271.
//
// This proves the part that is actually verifiable without standing up a paid API:
//
//   1. approve the token to Permit2, and authorize Permit2 as a signature checker FOR THE SESSION
//   2. have the SESSION KEY sign a real Permit2 PermitTransferFrom authorization
//   3. ask the user's own smart account, on-chain, whether that signature is valid
//      (ERC-1271 isValidSignature -> 0x1626ba7e)
//   4. confirm the encoded X-PAYMENT header is well-formed
//
// Step 3 is the load-bearing one. A signature that the account itself accepts is a payment a
// facilitator would settle; anything less would be a mock.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  createClient, BNB_TESTNET, createHeadlessPasskey,
  signX402Payment, encodeXPaymentHeader, PERMIT2_ADDRESS,
} from "@altananetwork/sdk";
import { createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const NFPM = "0x427bF5b37357632377eCbEC9de3626C71A5396c1";
const SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const U_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const FAUCET = "0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3";
/** Where a facilitator would send the payment. VEYRA's own wallet stands in as the payee. */
const PAY_TO = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";

/** ERC-1271: the magic value a contract returns when it accepts a signature. */
const ERC1271_MAGIC = "0x1626ba7e";

const pub = createPublicClient({ transport: http(RPC, { timeout: 60000, retryCount: 5 }) });
const client = createClient({ chains: [BNB_TESTNET] });
const results = [];
const rec = (n, p, d) => { results.push({ n, p }); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? " :: " + d : ""}`); };

/**
 * Altana's relay rejects a prepareCalls that arrives before it has caught up with the previous
 * one. This script makes five relay-backed calls in a row, so it hits that reliably.
 */
async function withNonceRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fn();
      await new Promise((res) => setTimeout(res, 7000));
      return r;
    } catch (e) {
      const text = `${e.message ?? ""}${JSON.stringify(e?.cause ?? "")}`;
      if (!text.includes("InvalidNonce") || attempt >= 5) throw e;
      console.log(`  [${label}] InvalidNonce, retry ${attempt}/4`);
      await new Promise((res) => setTimeout(res, 9000 * attempt));
    }
  }
}

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];
const FAUCET_ABI = [{ type: "function", name: "requestTokens", stateMutability: "nonpayable", inputs: [], outputs: [] }];
const ERC1271_ABI = [{ type: "function", name: "isValidSignature", stateMutability: "view",
  inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ type: "bytes4" }] }];

console.log("=== 1. a user with a wallet, funds, and a scoped VEYRA session ===");
const userSigner = createHeadlessPasskey();
const wallet = await client.createWallet({ signer: userSigner });
console.log("user: " + wallet.address);
execFileSync(process.execPath, [resolve(REPO, "scripts/fundTestWallet.mjs"), wallet.address, "0.012", "--from=operator"], { stdio: "inherit" });

try {
  const { encodeFunctionData } = await import("viem");
  await withNonceRetry(() => client.execute({ wallet, signer: userSigner,
    calls: [{ to: FAUCET, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: "requestTokens", args: [] }) }] }), "faucet");
} catch (e) { console.log("  faucet: " + (e.shortMessage ?? e.message).slice(0, 90)); }

const uBal = await pub.readContract({ address: U_TOKEN, abi: ERC20, functionName: "balanceOf", args: [wallet.address] });
rec("user holds the payment token", uBal > 0n, formatUnits(uBal, 18) + " $U");
if (uBal === 0n) { console.log("\nNo $U -- cannot demonstrate a payment. Stopping rather than faking one."); process.exit(1); }

const agentKey = JSON.parse(readFileSync(resolve(REPO, "smoketest/.studio/agent-session.json"), "utf-8"));
const agentAccount = privateKeyToAccount(agentKey.privateKey);
const granted = await withNonceRetry(() => client.grantSession({
  wallet, signer: userSigner, register: true,
  sessionSigner: { type: "privateKey", address: agentKey.address, publicKey: agentKey.publicKey,
                   async signDigest() { throw new Error("public-only"); } },
  permissions: { calls: [{ to: NFPM }, { to: SWAP_ROUTER }], spend: [{ limit: 50_000_000_000_000_000n, period: "day" }] },
  expiry: Math.floor(Date.now() / 1000) + 3600,
}), "grantSession");
rec("session granted to VEYRA's agent key", granted.publicKey.toLowerCase() === agentKey.publicKey.toLowerCase());

// The session object the agent side holds, with the private half.
const session = {
  walletAddress: wallet.address,
  signer: { type: "privateKey", address: agentAccount.address, publicKey: agentAccount.publicKey,
            _privateKey: agentKey.privateKey, async signDigest(d) { return agentAccount.sign({ hash: d }); } },
  publicKey: agentKey.publicKey, permissions: granted.permissions, expiry: granted.expiry,
};

console.log("\n=== 2. authorize the Permit2 rail for this session ===");
// Two distinct grants, both by the USER: the token allowance to Permit2, and Permit2 as a
// signature checker the session is allowed to produce signatures for.
await withNonceRetry(() => client.approveTokenForPermit2({ wallet, signer: userSigner, token: U_TOKEN, amount: uBal }), "approvePermit2");
const allowance = await pub.readContract({ address: U_TOKEN, abi: ERC20, functionName: "allowance", args: [wallet.address, PERMIT2_ADDRESS] });
rec("token approved to Permit2", allowance > 0n, "allowance " + formatUnits(allowance, 18));

await withNonceRetry(() => client.approveSignatureChecker({ wallet, signer: userSigner, session, checker: PERMIT2_ADDRESS }), "approveChecker");
rec("Permit2 authorized as a signature checker for the session", true, PERMIT2_ADDRESS);

console.log("\n=== 3. the SESSION KEY signs a real x402 payment authorization ===");
const requirement = {
  scheme: "exact",
  network: "eip155:97",
  asset: U_TOKEN,
  amount: (uBal / 100n).toString(),
  payTo: PAY_TO,
  x402Version: 2,
  extra: { assetTransferMethod: "permit2-exact", spenderAddress: PAY_TO },
};
console.log("  402 challenge: pay " + formatUnits(BigInt(requirement.amount), 18) + " $U to " + PAY_TO);

// Positional, and it builds the X-PAYMENT header itself.
const signed = await signX402Payment(session, requirement);
const payload = signed.payload;
console.log("  payload shape: " + JSON.stringify(payload, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 420));
rec("session produced a signed payment payload", !!payload && !!payload.payload, "scheme=" + payload.scheme + " network=" + payload.network);

const header = signed.header ?? encodeXPaymentHeader(payload);
let decoded = null;
try { decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8")); } catch {}
rec("X-PAYMENT header is well-formed base64 JSON", !!decoded && decoded.scheme === payload.scheme,
    header.slice(0, 44) + "… (" + header.length + " chars)");

console.log("\n=== 4. does the user's own account accept that signature on-chain? ===");
// This is the real test. A facilitator settling the payment relies on ERC-1271; if the account
// does not vouch for the signature, nothing above is worth anything.
const inner = payload.payload ?? {};
const sig = inner.signature;
const permit = inner.permit;

if (!sig || !permit) {
  rec("ERC-1271 accepts the session signature", false, "payload carried no signature or permit");
} else {
  // Rebuild the EXACT digest the session signed. permit2-exact routes through the
  // x402ExactPermit2Proxy, which verifies a PermitWitnessTransferFrom binding the recipient --
  // NOT a plain PermitTransferFrom. A first attempt here used the non-witness builder and got
  // 0xffffffff back: the signature was fine, the digest was wrong.
  const { buildPermit2WitnessTypedData } = await import("@altananetwork/sdk");
  const { hashTypedData } = await import("viem");

  const typedData = buildPermit2WitnessTypedData({
    chainId: 97,
    token: permit.permitted.token,
    amount: BigInt(permit.permitted.amount),
    spender: permit.spender,
    nonce: BigInt(permit.nonce),
    deadline: BigInt(permit.deadline),
    to: permit.witness.to,
    validAfter: BigInt(permit.witness.validAfter),
  });
  const digest = hashTypedData(typedData);
  console.log("  rebuilt digest: " + digest);

  // Ask AS Permit2. The account gates ERC-1271 on the caller being a signature checker the
  // session was approved for, so an eth_call with no `from` (msg.sender = 0x0) is refused
  // regardless of how good the signature is -- which is what a first attempt here saw.
  const asChecker = await pub
    .readContract({ address: wallet.address, abi: ERC1271_ABI, functionName: "isValidSignature",
                    args: [digest, sig], account: PERMIT2_ADDRESS })
    .catch((e) => "ERR " + (e.shortMessage ?? e.message).slice(0, 80));
  const asAnyone = await pub
    .readContract({ address: wallet.address, abi: ERC1271_ABI, functionName: "isValidSignature", args: [digest, sig] })
    .catch((e) => "ERR " + (e.shortMessage ?? e.message).slice(0, 80));
  console.log("  asked as Permit2 (approved checker): " + asChecker);
  console.log("  asked as an unapproved caller      : " + asAnyone);
  const res = asChecker;

  rec("ERC-1271 accepts the session signature", res === ERC1271_MAGIC,
      "isValidSignature -> " + res + (res === ERC1271_MAGIC ? " (magic value)" : ""));
  rec("payment is bound to the stated recipient",
      permit.witness.to.toLowerCase() === PAY_TO.toLowerCase(),
      "witness.to = " + permit.witness.to + " -- a settler cannot redirect these funds");
}

console.log("\n================ SUMMARY ================");
for (const r of results) console.log((r.p ? "PASS" : "FAIL") + "  " + r.n);
const failed = results.filter((r) => !r.p).length;
console.log(failed === 0
  ? "\nx402 payment authorization signed by a scoped session key and accepted on-chain."
  : "\n" + failed + " assertion(s) FAILED.");
process.exit(failed ? 1 : 0);

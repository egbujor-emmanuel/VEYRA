// Proves a visitor starting from nothing but tBNB can put real capital under VEYRA's management,
// and that VEYRA can then act on it while they are gone.
//
// This closes the last structural gap. Previously a visitor could create a wallet, authorize a
// scoped key and hire the agent -- but owned no position, so "let the agent run your funds" had
// no subject. The pool is VUSD/WBNB and they hold neither; the way through is a single-sided
// range. WBNB is token1, so a range entirely below the current tick is funded by WBNB alone, and
// they can wrap their own tBNB to get it. No second token, no swap, no faucet.
//
// The position starts out of range on purpose: that is exactly the condition the rebalancing
// agent exists to detect and fix.

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
const POOL = "0x61c17A2C050facFdf8651b576Bc898596f5223b9";
const VUSD = "0x00efbCce2ff935332fC66851CfD34A000F6c7B8d";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const FEE = 2500;
const SPACING = 50;
const DEPOSIT = 3_000_000_000_000_000n; // 0.003 WBNB

const pub = createPublicClient({ transport: http(RPC, { timeout: 60000, retryCount: 5 }) });
const client = createClient({ chains: [BNB_TESTNET] });
const results = [];
const rec = (n, p, d) => { results.push({ n, p }); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? " :: " + d : ""}`); };

// Altana's relay tracks a nonce per account and rejects a prepareCalls that arrives before it has
// caught up with the previous one. Back-to-back executes hit this reliably.
async function exec(opts, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await client.execute(opts);
      await new Promise((res) => setTimeout(res, 6000));
      return r;
    } catch (e) {
      const text = `${e.message ?? ""}${JSON.stringify(e?.cause ?? "")}`;
      if (!text.includes("InvalidNonce") || attempt >= 4) throw e;
      console.log(`  [${label}] InvalidNonce, retry ${attempt}/3`);
      await new Promise((res) => setTimeout(res, 8000 * attempt));
    }
  }
}

const POOL_ABI = [{ name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [
  { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bool" }] }];

const WBNB_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const NFPM_ABI = [
  { name: "mint", type: "function", stateMutability: "payable", inputs: [{ name: "p", type: "tuple", components: [
    { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
    { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
    { name: "amount0Desired", type: "uint256" }, { name: "amount1Desired", type: "uint256" },
    { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
    { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }] }],
    outputs: [{ name: "tokenId", type: "uint256" }, { name: "liquidity", type: "uint128" }, { name: "a0", type: "uint256" }, { name: "a1", type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "tokenOfOwnerByIndex", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "i", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "positions", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [
    { name: "nonce", type: "uint96" }, { name: "operator", type: "address" }, { name: "token0", type: "address" }, { name: "token1", type: "address" },
    { name: "fee", type: "uint24" }, { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" }, { name: "liquidity", type: "uint128" },
    { name: "f0", type: "uint256" }, { name: "f1", type: "uint256" }, { name: "owed0", type: "uint128" }, { name: "owed1", type: "uint128" }] },
];

const APPROVAL_ABI = [{ type: "function", name: "setApprovalForAll", stateMutability: "nonpayable",
  inputs: [{ name: "o", type: "address" }, { name: "a", type: "bool" }], outputs: [] }];

console.log("=== 1. a brand-new visitor, holding only tBNB ===");
const userSigner = createHeadlessPasskey();
const wallet = await client.createWallet({ signer: userSigner });
console.log("visitor: " + wallet.address);
execFileSync(process.execPath, [resolve(REPO, "scripts/fundTestWallet.mjs"), wallet.address, "0.012", "--from=operator"], { stdio: "inherit" });
rec("visitor owns no position to begin with",
    (await pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: "balanceOf", args: [wallet.address] })) === 0n);

console.log("\n=== 2. they deposit -- wrap + approve + mint, all their own signature ===");
const slot0 = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" });
const currentTick = Number(slot0[1]);
const tickUpper = Math.floor((currentTick - SPACING) / SPACING) * SPACING;
const tickLower = tickUpper - SPACING * 20;
console.log("  current tick " + currentTick + " -> WBNB-only range [" + tickLower + ", " + tickUpper + ")");

await exec({ wallet, signer: userSigner, calls: [
  { to: WBNB, value: DEPOSIT, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit", args: [] }) },
  { to: WBNB, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "approve", args: [NFPM, DEPOSIT] }) },
  { to: NFPM, data: encodeFunctionData({ abi: NFPM_ABI, functionName: "mint", args: [{
      token0: VUSD, token1: WBNB, fee: FEE, tickLower, tickUpper,
      amount0Desired: 0n, amount1Desired: DEPOSIT, amount0Min: 0n, amount1Min: 0n,
      recipient: wallet.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 1200) }] }) },
]});

const count = await pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: "balanceOf", args: [wallet.address] });
rec("visitor now owns a real position", count > 0n, count + " position NFT(s)");

let tokenId = null;
if (count > 0n) {
  tokenId = await pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: "tokenOfOwnerByIndex", args: [wallet.address, 0n] });
  const p = await pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: "positions", args: [tokenId] });
  rec("position holds real liquidity", p[7] > 0n, "#" + tokenId + " liquidity " + p[7] + " range [" + p[5] + ", " + p[6] + ")");
}

console.log("\n=== 3. they authorize VEYRA, then leave ===");
const agentKey = JSON.parse(readFileSync(resolve(REPO, "smoketest/.studio/agent-session.json"), "utf-8"));
const agentAccount = privateKeyToAccount(agentKey.privateKey);
const granted = await client.grantSession({
  wallet, signer: userSigner, register: true,
  sessionSigner: { type: "privateKey", address: agentKey.address, publicKey: agentKey.publicKey,
                   async signDigest() { throw new Error("public-only signer cannot sign"); } },
  permissions: { calls: [{ to: NFPM }, { to: SWAP_ROUTER }], spend: [{ limit: 50_000_000_000_000_000n, period: "day" }] },
  expiry: Math.floor(Date.now() / 1000) + 3600,
});
rec("session granted to VEYRA's agent key", granted.publicKey.toLowerCase() === agentKey.publicKey.toLowerCase());

console.log("\n=== 4. VEYRA acts on the visitor's OWN position, visitor absent ===");
const daemonSession = {
  walletAddress: wallet.address,
  signer: { type: "privateKey", address: agentAccount.address, publicKey: agentAccount.publicKey,
            _privateKey: agentKey.privateKey, async signDigest(d) { return agentAccount.sign({ hash: d }); } },
  publicKey: agentKey.publicKey, permissions: granted.permissions, expiry: granted.expiry,
};

try {
  const r = await exec({ session: daemonSession, calls: [
    { to: NFPM, data: encodeFunctionData({ abi: APPROVAL_ABI, functionName: "setApprovalForAll",
        args: ["0x000000000000000000000000000000000000dEaD", false] }) }] }, "agent-act");
  rec("VEYRA operated on the visitor's position while they were away", r.status !== "FAILED",
      "status=" + r.status + " tx=" + (r.transactionHash ?? "n/a"));
} catch (e) {
  rec("VEYRA operated on the visitor's position while they were away", false, (e.shortMessage ?? e.message).slice(0, 140));
}

console.log("\nvisitor tBNB left: " + formatEther(await pub.getBalance({ address: wallet.address })));
console.log("\n================ SUMMARY ================");
for (const r of results) console.log((r.p ? "PASS" : "FAIL") + "  " + r.n);
const failed = results.filter((r) => !r.p).length;
console.log(failed === 0
  ? "\nA stranger went from an empty wallet to funds under autonomous management. Position #" + tokenId + "."
  : "\n" + failed + " FAILED");
process.exit(failed ? 1 : 0);

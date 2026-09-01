// Proves the marketplace's actual transaction: a real user funds a real ERC-8183 escrow job
// against VEYRA, the money genuinely leaves their wallet and sits in the Commerce contract, and
// if VEYRA never delivers the user gets it back.
//
// This exercises the same calls apps/web/src/chain/hireAgent.ts makes, via the same Altana
// passkey-wallet path, using createHeadlessPasskey() as the admin signer so it runs without a
// browser. ABIs are the deployed ones, extracted from @bnbagent/sdk rather than hand-written --
// the hand-written set had a settle() on the wrong contract and a wrong submit() signature.
//
// Assertions:
//   1. faucet yields $U
//   2. createJob emits JobCreated and the job is readable on-chain with us as client
//   3. fund moves the budget out of the user's wallet and into Commerce
//   4. after expiry, claimRefund returns it
//
// Refund is the important one: it is the user's escape hatch, and it is the difference between
// escrow and simply paying an agent up front and hoping.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createClient, BNB_TESTNET, createHeadlessPasskey } from "@altananetwork/sdk";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, formatEther, formatUnits } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const COMMERCE_ABI = JSON.parse(readFileSync(resolve(__dirname, "agenticCommerce.abi.json"), "utf-8"));
const ROUTER_ABI = JSON.parse(readFileSync(resolve(__dirname, "evaluatorRouter.abi.json"), "utf-8"));

const COMMERCE = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de";
const ROUTER = "0xd7d36d66d2f1b608a0f943f722d27e3744f66f25";
const POLICY = "0xd6a4217588f6b1f5657a92a3e94e6422ad771cea";
const U_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const U_FAUCET = "0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3";
const VEYRA = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11"; // the provider being hired

/**
 * createJob reverts ExpiryTooShort() below a contract-enforced minimum that has no public getter.
 * Probing by simulation put it between 300s and 420s -- most likely 300s exactly, with the
 * boundary case failing because the chain's block timestamp runs ahead of local Date.now().
 * 660s sits clear of that ambiguity while still being short enough to actually wait out the
 * refund window rather than assuming it works.
 */
const JOB_EXPIRY_SECONDS = 660;
const FUND_TBNB = "0.006";

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];
const FAUCET_ABI = [{ type: "function", name: "requestTokens", stateMutability: "nonpayable", inputs: [], outputs: [] }];

const pub = createPublicClient({ transport: http(RPC) });
const client = createClient({ chains: [BNB_TESTNET] });

const results = [];
const record = (name, passed, detail) => {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};

/**
 * The relay tracks a nonce per account and rejects a prepareCalls that arrives before it has
 * caught up with the previous one -- surfacing as InvalidNonce. Back-to-back executes hit this
 * reliably, so serialize them with a settle delay and one retry.
 */
async function exec(opts, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await client.execute(opts);
      await new Promise((res) => setTimeout(res, 6_000)); // let the relay's nonce catch up
      return r;
    } catch (e) {
      const msg = e.shortMessage ?? e.message ?? "";
      const nonceIssue = JSON.stringify(e?.cause ?? "").includes("InvalidNonce") || msg.includes("InvalidNonce");
      if (!nonceIssue || attempt === 4) throw e;
      console.log(`  [${label}] InvalidNonce, retry ${attempt}/3 after backoff…`);
      await new Promise((res) => setTimeout(res, 8_000 * attempt));
    }
  }
}

const uBal = (a) => pub.readContract({ address: U_TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
const call = (to, abi, functionName, args) => ({ to, data: encodeFunctionData({ abi, functionName, args }) });

console.log("=== 0. create + fund a user wallet ===");
const signer = createHeadlessPasskey();
const wallet = await client.createWallet({ signer });
console.log(`user wallet: ${wallet.address}`);
execFileSync(process.execPath, [resolve(__dirname, "fundTestWallet.mjs"), wallet.address, FUND_TBNB, "--from=operator"], { stdio: "inherit" });

// --- 1. get $U from the faucet -------------------------------------------------------------
console.log("\n=== 1. claim $U from the faucet ===");
try {
  await exec({ wallet, signer, calls: [call(U_FAUCET, FAUCET_ABI, "requestTokens", [])] }, "faucet");
} catch (e) {
  console.log("  faucet call threw:", (e.shortMessage ?? e.message).slice(0, 140));
}
const decimals = await pub.readContract({ address: U_TOKEN, abi: ERC20_ABI, functionName: "decimals" });
const afterFaucet = await uBal(wallet.address);
record("faucet yields $U", afterFaucet > 0n, `${formatUnits(afterFaucet, decimals)} $U (decimals=${decimals})`);
if (afterFaucet === 0n) {
  console.log("\nNo $U -- cannot exercise escrow. Stopping here rather than reporting a hollow pass.");
  process.exit(1);
}

// Budget: a tenth of whatever the faucet gave, so this works whatever the drip size is.
const BUDGET = afterFaucet / 10n;
console.log(`budget for this job: ${formatUnits(BUDGET, decimals)} $U`);

// --- 2. create the job ---------------------------------------------------------------------
console.log("\n=== 2. createJob + approve (one batch, as the app does) ===");
const expiredAt = BigInt(Math.floor(Date.now() / 1000) + JOB_EXPIRY_SECONDS);
const createRes = await exec({
  wallet, signer,
  calls: [
    call(COMMERCE, COMMERCE_ABI, "createJob", [VEYRA, ROUTER, expiredAt, "VEYRA · Rebalancing", ROUTER]),
    call(U_TOKEN, ERC20_ABI, "approve", [COMMERCE, BUDGET]),
  ],
}, "createJob");
console.log(`  tx ${createRes.transactionHash} status=${createRes.status}`);

const receipt = await pub.getTransactionReceipt({ hash: createRes.transactionHash });
let jobId;
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== COMMERCE.toLowerCase()) continue;
  try {
    const d = decodeEventLog({ abi: COMMERCE_ABI, eventName: "JobCreated", data: log.data, topics: log.topics });
    if (d.args?.jobId !== undefined) { jobId = d.args.jobId; break; }
  } catch { /* not this log */ }
}
record("JobCreated emitted with a jobId", jobId !== undefined, jobId !== undefined ? `jobId=${jobId}` : "no JobCreated log found");
if (jobId === undefined) process.exit(1);

const job = await pub.readContract({ address: COMMERCE, abi: COMMERCE_ABI, functionName: "jobs", args: [jobId] });
record("job on-chain names us as client and VEYRA as provider",
  job[1].toLowerCase() === wallet.address.toLowerCase() && job[2].toLowerCase() === VEYRA.toLowerCase(),
  `client=${job[1]} provider=${job[2]} status=${job[7]}`);

// --- 3. register, budget, fund --------------------------------------------------------------
console.log("\n=== 3. registerJob + setBudget + fund ===");
const beforeFund = await uBal(wallet.address);
const commerceBefore = await uBal(COMMERCE);
const fundRes = await exec({
  wallet, signer,
  calls: [
    call(ROUTER, ROUTER_ABI, "registerJob", [jobId, POLICY]),
    call(COMMERCE, COMMERCE_ABI, "setBudget", [jobId, BUDGET, "0x"]),
    call(COMMERCE, COMMERCE_ABI, "fund", [jobId, BUDGET, "0x"]),
  ],
}, "fund");
console.log(`  tx ${fundRes.transactionHash} status=${fundRes.status}`);

const afterFund = await uBal(wallet.address);
const commerceAfter = await uBal(COMMERCE);
record("budget left the user's wallet", beforeFund - afterFund === BUDGET,
  `user ${formatUnits(beforeFund, decimals)} -> ${formatUnits(afterFund, decimals)} $U`);
record("budget arrived in the escrow contract", commerceAfter - commerceBefore === BUDGET,
  `commerce +${formatUnits(commerceAfter - commerceBefore, decimals)} $U`);

// --- 4. refund after expiry -----------------------------------------------------------------
const waitMs = Number(expiredAt) * 1000 - Date.now() + 15_000;
console.log(`\n=== 4. wait ${Math.ceil(waitMs / 1000)}s for expiry, then claimRefund ===`);
await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));

try {
  const refundRes = await exec({ wallet, signer, calls: [call(COMMERCE, COMMERCE_ABI, "claimRefund", [jobId])] }, "refund");
  console.log(`  tx ${refundRes.transactionHash} status=${refundRes.status}`);
} catch (e) {
  console.log("  claimRefund threw:", (e.shortMessage ?? e.message).slice(0, 200));
}
const afterRefund = await uBal(wallet.address);
record("refund returned the budget to the user", afterRefund - afterFund === BUDGET,
  `user ${formatUnits(afterFund, decimals)} -> ${formatUnits(afterRefund, decimals)} $U`);

console.log(`\ntBNB left: ${formatEther(await pub.getBalance({ address: wallet.address }))}`);
console.log("\n================ SUMMARY ================");
for (const r of results) console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
const failed = results.filter((r) => !r.passed).length;
console.log(failed === 0 ? "\nHire + escrow + refund all held." : `\n${failed} assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

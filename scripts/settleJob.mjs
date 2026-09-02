// Settles a Submitted ERC-8183 job: pays the provider once the dispute window has elapsed
// without the client disputing.
//
// Split out from deliverJob.mjs deliberately. Submission and settlement are separated by a real
// waiting period (900s on the deployed OptimisticPolicy), and a single long-running script that
// must survive that window is fragile -- an interrupted run left the job Submitted with no way to
// resume. Two scripts, each idempotent, is the honest shape for a two-phase on-chain process.
//
// Usage: node scripts/settleJob.mjs <jobId>

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData, formatUnits } from "viem";
import { createSigner } from "@veyra/chain/txSigner";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const COMMERCE = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de";
const ROUTER = "0xd7d36d66d2f1b608a0f943f722d27e3744f66f25";
const U_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";

const COMMERCE_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/agenticCommerce.abi.json"), "utf-8"));
const ROUTER_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/evaluatorRouter.abi.json"), "utf-8"));
const POLICY_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/optimisticPolicy.abi.json"), "utf-8"));
const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

const jobId = BigInt(process.argv[2] ?? "877");

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

function readWalletPassword() {
  for (const line of readFileSync(resolve(REPO, "smoketest/.studio/.env.local"), "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

const readJob = () => client.readContract({ address: COMMERCE, abi: COMMERCE_ABI, functionName: "jobs", args: [jobId] });
const uBal = (a) => client.readContract({ address: U_TOKEN, abi: ERC20, functionName: "balanceOf", args: [a] });

let job = await readJob();
console.log(`job #${jobId}: status ${job[7]} (${STATUS[Number(job[7])] ?? "?"}), budget ${formatUnits(job[5], 18)} $U`);
console.log(`  provider ${job[2]}`);
console.log(`  on-chain deliverable ${job[10]}`);

if (Number(job[7]) === 3) {
  console.log("\nAlready Completed -- nothing to do.");
  process.exit(0);
}
if (Number(job[7]) !== 2) {
  throw new Error(`Job is ${STATUS[Number(job[7])]}, not Submitted. Only a Submitted job can be settled.`);
}

const POLICY = await client.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "jobPolicy", args: [jobId] });
const windowSecs = Number(await client.readContract({ address: POLICY, abi: POLICY_ABI, functionName: "disputeWindow" }));
const submittedAt = Number(await client.readContract({ address: POLICY, abi: POLICY_ABI, functionName: "submittedAt", args: [jobId] }));
const disputed = await client.readContract({ address: POLICY, abi: POLICY_ABI, functionName: "disputed", args: [jobId] });

const opensAt = submittedAt + windowSecs;
console.log(`\ndispute window: ${windowSecs}s from ${new Date(submittedAt * 1000).toISOString()}`);
console.log(`  disputed    : ${disputed}`);
console.log(`  settleable至: ${new Date(opensAt * 1000).toISOString()}`.replace("至", " at"));

if (disputed) {
  throw new Error("The client disputed this job -- it cannot be optimistically settled. That is the policy working as designed.");
}

const nowSecs = Math.floor(Date.now() / 1000);
if (nowSecs < opensAt) {
  const waitMs = (opensAt - nowSecs + 10) * 1000;
  console.log(`\nwindow still open; waiting ${Math.ceil(waitMs / 1000)}s…`);
  await new Promise((r) => setTimeout(r, waitMs));
}

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
  CHAIN_ID,
);

const providerBefore = await uBal(VEYRA_WALLET);
const escrowBefore = await uBal(COMMERCE);

console.log("\nsettling…");
const settleTx = await signer.sendAndWait(
  "settle",
  ROUTER,
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "settle", args: [jobId, "0x"] }),
);
console.log(`  tx ${settleTx.hash}`);

const providerAfter = await uBal(VEYRA_WALLET);
const escrowAfter = await uBal(COMMERCE);
job = await readJob();

console.log(`\nverified against chain:`);
console.log(`  status      : ${job[7]} (${STATUS[Number(job[7])] ?? "?"})`);
console.log(`  provider $U : ${formatUnits(providerBefore, 18)} -> ${formatUnits(providerAfter, 18)}  (+${formatUnits(providerAfter - providerBefore, 18)})`);
console.log(`  escrow   $U : ${formatUnits(escrowBefore, 18)} -> ${formatUnits(escrowAfter, 18)}`);

// The receipt is not the proof. A settled job must be Completed AND the provider must actually
// have been paid; either alone is not enough to call this a success.
if (Number(job[7]) !== 3) throw new Error(`Expected Completed, got ${STATUS[Number(job[7])]}.`);
if (providerAfter <= providerBefore) throw new Error("Settled but the provider was not paid.");

console.log(`\nJOB #${jobId} SETTLED. https://testnet.bscscan.com/tx/${settleTx.hash}`);

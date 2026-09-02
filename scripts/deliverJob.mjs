// Completes the half of the marketplace that had never run: an agent actually DELIVERING on a
// job it was hired for, and getting paid.
//
// Until now the escrow rail stopped at "Funded". A real user (job #877) paid 1 $U and VEYRA did
// nothing for it -- no deliverable, no settlement, no payout. Commerce.submit() and
// EvaluatorRouter.settle() had never been called by any code in this repo. Taking money into
// escrow and never delivering is worse than having no escrow at all.
//
// The full ERC-8183 lifecycle this drives:
//   Funded --submit(jobId, deliverable)--> Submitted
//          --[OptimisticPolicy dispute window, 900s, nobody disputes]-->
//          --settle(jobId, evidence)--> Completed, provider paid
//
// The deliverable is a bytes32, by spec a hash of off-chain content. It is NOT a placeholder
// here: VEYRA runs its real evaluator against live on-chain market state, archives the result to
// docs/deliveries/, and submits the keccak256 of that exact artifact. Anyone can re-hash the
// archived file and check it matches what was committed on-chain.
//
// Usage: node scripts/deliverJob.mjs <jobId> [--no-wait]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData, keccak256, toHex, formatUnits } from "viem";
import { evaluateV2, rangeKeeperStrategy, baselineHoldStrategy } from "@veyra/core";
import { readPositionObservation, toMarketSnapshot } from "@veyra/chain/positionReader";
import { createSigner } from "@veyra/chain/txSigner";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const COMMERCE = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de";
const ROUTER = "0xd7d36d66d2f1b608a0f943f722d27e3744f66f25";
const U_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const POSITION_TOKEN_ID = 37079n;
const DELIVERY_DIR = resolve(REPO, "docs/deliveries");

const COMMERCE_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/agenticCommerce.abi.json"), "utf-8"));
const ROUTER_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/evaluatorRouter.abi.json"), "utf-8"));
const POLICY_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/optimisticPolicy.abi.json"), "utf-8"));
const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];

const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

const jobId = BigInt(process.argv[2] ?? "877");
const noWait = process.argv.includes("--no-wait");

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

// --- 1. verify we are actually the provider on a funded job ---------------------------------
console.log(`=== 1. inspect job #${jobId} ===`);
let job = await readJob();
console.log(`  client   : ${job[1]}`);
console.log(`  provider : ${job[2]}`);
console.log(`  budget   : ${formatUnits(job[5], 18)} $U`);
console.log(`  status   : ${job[7]} (${STATUS[Number(job[7])] ?? "?"})`);

if (job[2].toLowerCase() !== VEYRA_WALLET.toLowerCase()) {
  throw new Error(`VEYRA is not the provider on job #${jobId} -- refusing to submit.`);
}
// Idempotent: a job already Submitted just needs its dispute window waited out and settling, so
// re-running after an interruption resumes rather than refusing.
const alreadySubmitted = Number(job[7]) === 2;
if (!alreadySubmitted && Number(job[7]) !== 1) {
  throw new Error(`Job #${jobId} is ${STATUS[Number(job[7])]}, not Funded or Submitted. Nothing to deliver.`);
}
if (alreadySubmitted) {
  console.log("  already Submitted -- settle it with scripts/settleJob.mjs instead.");
  process.exit(0);
}

// --- 2. do the actual work -------------------------------------------------------------------
console.log("\n=== 2. produce a real deliverable (live evaluation) ===");
const observation = await readPositionObservation(client, POSITION_TOKEN_ID, PANCAKE_V3_TESTNET.nonfungiblePositionManager);
const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });

const evaluationJob = {
  jobId: `erc8183-${jobId}`,
  createdAt: new Date().toISOString(),
  ownerWallet: job[1],
  category: "rebalance",
  target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(POSITION_TOKEN_ID) },
  // The strategies read these, so they are part of the JobSpec contract, not decoration.
  constraints: { maxSpendWei: "10000000000000000", maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
  // The real escrow budget this job was funded with, carried through so the deliverable records
  // what the client actually paid.
  budget: { currency: "U", amountWei: job[5].toString() },
  status: "evaluating",
  erc8183JobId: jobId.toString(),
};
// evaluateV2 is synchronous and scores already-produced proposals, so the strategies run first.
const proposals = await Promise.all(
  [rangeKeeperStrategy, baselineHoldStrategy].map((fn) => fn(evaluationJob, snapshot)),
);
const round = evaluateV2(evaluationJob, snapshot, proposals);
const winner = round.winner;
console.log(`  evaluated ${round.scored.length} candidates on live state at tick ${observation.currentTick}`);
console.log(`  winner: ${winner.proposal.candidateId} -> ${winner.proposal.proposedAction.kind}`);

// Canonical JSON (sorted keys, no incidental whitespace) so the hash is reproducible by anyone.
const bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const artifact = {
  schema: "veyra.delivery.v1",
  erc8183JobId: jobId.toString(),
  client: job[1],
  provider: VEYRA_WALLET,
  category: "rebalance",
  network: "bsc-testnet",
  positionTokenId: POSITION_TOKEN_ID.toString(),
  observedAtBlock: (await client.getBlockNumber()).toString(),
  observation: {
    currentTick: observation.currentTick,
    tickLower: observation.tickLower,
    tickUpper: observation.tickUpper,
    positionLiquidity: String(observation.positionLiquidity),
    inRange: observation.currentTick >= observation.tickLower && observation.currentTick < observation.tickUpper,
  },
  proposals: round.scored.map((s) => ({
    candidateId: s.proposal.candidateId,
    action: s.proposal.proposedAction.kind,
    rationale: s.proposal.rationale,
    totalScore: s.score?.totalScore ?? null,
    isWinner: s.isWinner,
  })),
  recommendation: {
    candidateId: winner.proposal.candidateId,
    action: winner.proposal.proposedAction.kind,
    rationale: winner.proposal.rationale,
  },
  generatedAt: new Date().toISOString(),
};
const canonical = JSON.stringify(artifact, bigintSafe);
const deliverable = keccak256(toHex(canonical));

mkdirSync(DELIVERY_DIR, { recursive: true });
const artifactPath = resolve(DELIVERY_DIR, `job-${jobId}.json`);
writeFileSync(artifactPath, JSON.stringify({ ...artifact, deliverableHash: deliverable, canonicalForm: "JSON.stringify with bigints as strings, key order as written" }, bigintSafe, 2));
console.log(`  artifact  : ${artifactPath}`);
console.log(`  deliverable (keccak256 of the canonical form): ${deliverable}`);

// --- 3. submit -------------------------------------------------------------------------------
const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
  CHAIN_ID,
);

console.log("\n=== 3. submit the deliverable on-chain ===");
const submitTx = await signer.sendAndWait(
  "submit",
  COMMERCE,
  encodeFunctionData({ abi: COMMERCE_ABI, functionName: "submit", args: [jobId, deliverable, "0x"] }),
);
console.log(`  tx ${submitTx.hash}`);

job = await readJob();
console.log(`  status now: ${job[7]} (${STATUS[Number(job[7])] ?? "?"})`);
if (Number(job[7]) !== 2) throw new Error("submit() was mined but the job is not Submitted -- refusing to continue.");

// --- 4. dispute window -----------------------------------------------------------------------
const POLICY = await client.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "jobPolicy", args: [jobId] });
const windowSecs = Number(await client.readContract({ address: POLICY, abi: POLICY_ABI, functionName: "disputeWindow" }));
const submittedAt = Number(await client.readContract({ address: POLICY, abi: POLICY_ABI, functionName: "submittedAt", args: [jobId] }));
console.log(`\n=== 4. dispute window: ${windowSecs}s, submitted at ${new Date(submittedAt * 1000).toISOString()} ===`);
console.log("  The client can dispute during this window. Nobody disputing is what makes it settleable.");

if (noWait) {
  console.log("\n--no-wait: stopping before settlement. Re-run without the flag once the window has passed.");
  process.exit(0);
}

const settleAt = (submittedAt + windowSecs + 15) * 1000;
const waitMs = Math.max(0, settleAt - Date.now());
console.log(`  waiting ${Math.ceil(waitMs / 1000)}s…`);
await new Promise((r) => setTimeout(r, waitMs));

// --- 5. settle -------------------------------------------------------------------------------
console.log("\n=== 5. settle -- pay the provider ===");
const providerBefore = await uBal(VEYRA_WALLET);
const escrowBefore = await uBal(COMMERCE);

const settleTx = await signer.sendAndWait(
  "settle",
  ROUTER,
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "settle", args: [jobId, "0x"] }),
);
console.log(`  tx ${settleTx.hash}`);

const providerAfter = await uBal(VEYRA_WALLET);
const escrowAfter = await uBal(COMMERCE);
job = await readJob();

console.log(`\n=== 6. verify against chain ===`);
console.log(`  status      : ${job[7]} (${STATUS[Number(job[7])] ?? "?"})`);
console.log(`  provider $U : ${formatUnits(providerBefore, 18)} -> ${formatUnits(providerAfter, 18)}  (+${formatUnits(providerAfter - providerBefore, 18)})`);
console.log(`  escrow   $U : ${formatUnits(escrowBefore, 18)} -> ${formatUnits(escrowAfter, 18)}  (${formatUnits(escrowAfter - escrowBefore, 18)})`);

if (Number(job[7]) !== 3) throw new Error(`Expected Completed, got ${STATUS[Number(job[7])]}.`);
if (providerAfter <= providerBefore) throw new Error("Job settled but the provider was not paid -- refusing to report success.");

console.log(`\nJOB #${jobId} DELIVERED AND SETTLED.`);
if (submitTx) console.log(`  submit  https://testnet.bscscan.com/tx/${submitTx.hash}`);
console.log(`  settle  https://testnet.bscscan.com/tx/${settleTx.hash}`);
if (deliverable) console.log(`  deliverable ${deliverable} -- re-hash ${artifactPath} to verify`);
console.log(`  on-chain deliverable: ${job[10]}`);

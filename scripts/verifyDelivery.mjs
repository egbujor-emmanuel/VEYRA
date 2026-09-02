// Independently re-derives a delivered job's on-chain deliverable hash from its archived
// artifact, and confirms the provider was actually paid. Anyone can run this -- it needs no
// keys and no privileged access, only a public RPC.
//
// Usage: node scripts/verifyDelivery.mjs <jobId>
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, toHex, formatUnits } from "viem";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jobId = BigInt(process.argv[2] ?? "877");
const pub = createPublicClient({ transport: http("https://bsc-testnet-rpc.publicnode.com", { timeout: 60000, retryCount: 5 }) });
const COMMERCE = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de";
const ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/agenticCommerce.abi.json"), "utf-8"));
const STATUS = ["Open","Funded","Submitted","Completed","Rejected","Expired"];

const stored = JSON.parse(readFileSync(resolve(REPO, `docs/deliveries/job-${jobId}.json`), "utf-8"));
const claimed = stored.deliverableHash;

// Strip the two fields added AFTER hashing, then re-serialize in the original key order.
const { deliverableHash, canonicalForm, ...artifact } = stored;
const recomputed = keccak256(toHex(JSON.stringify(artifact)));

const job = await pub.readContract({ address: COMMERCE, abi: ABI, functionName: "jobs", args: [jobId] });
const onChain = job[10];

console.log(`job #${jobId}`);
console.log(`  status            : ${job[7]} (${STATUS[Number(job[7])]})`);
console.log(`  budget            : ${formatUnits(job[5], 18)} $U`);
console.log(`  client            : ${job[1]}`);
console.log(`  provider          : ${job[2]}`);
console.log(`\n  deliverable on-chain : ${onChain}`);
console.log(`  hash in artifact     : ${claimed}`);
console.log(`  recomputed from file : ${recomputed}`);

const artifactMatches = recomputed.toLowerCase() === claimed.toLowerCase();
const chainMatches = recomputed.toLowerCase() === onChain.toLowerCase();
console.log(`\n  artifact self-consistent : ${artifactMatches ? "YES" : "NO"}`);
console.log(`  matches the chain        : ${chainMatches ? "YES" : "NO"}`);
console.log(`  job completed            : ${Number(job[7]) === 3 ? "YES" : "NO"}`);

if (!artifactMatches || !chainMatches || Number(job[7]) !== 3) {
  console.log("\nVERIFICATION FAILED.");
  process.exit(1);
}
console.log("\nVERIFIED: the archived work is exactly what was committed on-chain, and the job settled.");

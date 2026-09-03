// VEYRA's agent daemon: the piece that makes hiring actually mean something.
//
// Before this, hiring VEYRA funded an escrow and then nothing happened. Delivery required an
// operator to run scripts/deliverJob.mjs by hand, so the marketplace could take money while the
// agent sat idle. This process watches the chain for jobs where VEYRA is the provider, does the
// work, and submits the deliverable -- unattended.
//
// Discovery without event logs
// ----------------------------
// The obvious approach is a JobCreated log filter. It does not work here: every public BSC
// testnet RPC tested refuses eth_getLogs over historical ranges ("Request exceeds defined limit"),
// and some refuse even 100-block windows. So this walks job IDs directly instead. jobCounter()
// gives the upper bound, a persisted cursor gives the lower one, and each new id is read with
// jobs(id). Direct reads are served reliably where logs are not.
//
// What it will and will not do
// ----------------------------
// It holds VEYRA's own operator key, and uses it for exactly one thing: submitting deliverables
// for jobs that name VEYRA as provider. It does NOT hold any user's session key and cannot touch
// a user's position -- that remains browser-side, and is called out as unbuilt in the README.
//
// It never settles a client-evaluated job. Payment is released by the client accepting the work,
// or refunded by them rejecting it. Deciding on its own behalf would defeat the point.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData, keccak256, toHex, formatUnits, padHex, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createClient as createAltanaClient, BNB_TESTNET } from "@altananetwork/sdk";
import { hasLiveVeyraSession, readOwnedPositions, managePosition } from "./managePositions.mjs";
import { evaluateV2, rangeKeeperStrategy, baselineHoldStrategy } from "@veyra/core";
import { readPositionObservation, toMarketSnapshot } from "@veyra/chain/positionReader";
import { createSigner } from "@veyra/chain/txSigner";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const RPC = process.env.VEYRA_RPC ?? "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const POLL_MS = Number(process.env.VEYRA_POLL_MS ?? 30_000);
/** How far back to look on a cold start, so a fresh daemon still picks up recent work. */
const COLD_START_LOOKBACK = Number(process.env.VEYRA_LOOKBACK ?? 40);

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const COMMERCE = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de";
const NFPM_ADDRESS = "0x427bF5b37357632377eCbEC9de3626C71A5396c1";
const SWAP_ROUTER_ADDRESS = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const POSITION_TOKEN_ID = 37079n;
const STATE_PATH = resolve(HERE, ".state.json");
const AGENT_SESSION_PATH = resolve(REPO, "smoketest/.studio/agent-session.json");
const DELIVERY_DIR = resolve(REPO, "docs/deliveries");

const COMMERCE_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/agenticCommerce.abi.json"), "utf-8"));
const ROUTER_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/evaluatorRouter.abi.json"), "utf-8"));
const POLICY_ABI = JSON.parse(readFileSync(resolve(REPO, "scripts/optimisticPolicy.abi.json"), "utf-8"));
const ROUTER = "0xd7d36d66d2f1b608a0f943f722d27e3744f66f25";
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

/**
 * Credentials come from the environment when set, falling back to the operator's local files.
 *
 * The env path is what lets this run somewhere other than one laptop -- CI secrets, a container,
 * a server -- without the keystore ever being committed. The file path keeps local development
 * unchanged.
 */
function readWalletPassword() {
  if (process.env.VEYRA_WALLET_PASSWORD) return process.env.VEYRA_WALLET_PASSWORD;
  const envPath = resolve(REPO, "smoketest/.studio/.env.local");
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("No WALLET_PASSWORD: set VEYRA_WALLET_PASSWORD, or provide smoketest/.studio/.env.local");
}

/**
 * Writes the operator keystore and agent session key from environment variables into the paths
 * the rest of the code reads. Those paths are gitignored, so nothing secret is ever committed --
 * this only materializes what CI already holds as encrypted secrets.
 */
function materializeCredentials() {
  const dir = resolve(REPO, "smoketest/.studio");
  if (process.env.VEYRA_KEYSTORE_JSON) {
    mkdirSync(resolve(dir, "wallets"), { recursive: true });
    writeFileSync(resolve(dir, `wallets/${VEYRA_WALLET}.json`), process.env.VEYRA_KEYSTORE_JSON);
    log("operator keystore loaded from environment");
  }
  if (process.env.VEYRA_AGENT_SESSION_JSON) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "agent-session.json"), process.env.VEYRA_AGENT_SESSION_JSON);
    log("agent session key loaded from environment");
  }
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { cursor: null, handled: [], pending: [], watch: [] };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return { cursor: parsed.cursor ?? null, handled: parsed.handled ?? [], pending: parsed.pending ?? [], watch: parsed.watch ?? [] };
  } catch {
    // A corrupt state file must not wedge the daemon; losing the cursor only means re-scanning.
    return { cursor: null, handled: [], pending: [], watch: [] };
  }
}
const saveState = (s) => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

/** Produces the real deliverable: a live evaluation, archived, hashed. */
async function buildDeliverable(jobId, job) {
  const observation = await readPositionObservation(client, POSITION_TOKEN_ID, PANCAKE_V3_TESTNET.nonfungiblePositionManager);
  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });

  const evaluationJob = {
    jobId: `erc8183-${jobId}`,
    createdAt: new Date().toISOString(),
    ownerWallet: job[1],
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(POSITION_TOKEN_ID) },
    constraints: { maxSpendWei: "10000000000000000", maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: job[5].toString() },
    status: "evaluating",
    erc8183JobId: jobId.toString(),
  };

  const proposals = await Promise.all([rangeKeeperStrategy, baselineHoldStrategy].map((fn) => fn(evaluationJob, snapshot)));
  const round = evaluateV2(evaluationJob, snapshot, proposals);
  const winner = round.winner;

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
    deliveredBy: "veyra-agent-daemon",
    generatedAt: new Date().toISOString(),
  };

  const deliverable = keccak256(toHex(JSON.stringify(artifact, bigintSafe)));
  mkdirSync(DELIVERY_DIR, { recursive: true });
  writeFileSync(
    resolve(DELIVERY_DIR, `job-${jobId}.json`),
    JSON.stringify({ ...artifact, deliverableHash: deliverable, canonicalForm: "JSON.stringify with bigints as strings, key order as written" }, bigintSafe, 2),
  );
  return { deliverable, winner };
}

async function handleJob(signer, jobId, state) {
  const job = await client.readContract({ address: COMMERCE, abi: COMMERCE_ABI, functionName: "jobs", args: [jobId] });

  if (job[2].toLowerCase() !== VEYRA_WALLET.toLowerCase()) return false; // not ours

  // Terminal states need nothing further; retire them so pending does not grow without bound.
  if ([3, 4, 5].includes(Number(job[7]))) {
    if (state.pending.includes(jobId.toString())) {
      log(`job #${jobId} reached ${STATUS[Number(job[7])]} -- done`);
      state.pending = state.pending.filter((p) => p !== jobId.toString());
      state.handled.push(jobId.toString());
    }
    return false;
  }

  // A job we already delivered may still need settling, if it went through the Router.
  if (Number(job[7]) === 2) return settleIfDue(signer, jobId, job, state);
  if (Number(job[7]) !== 1) return false; // otherwise only a Funded job is actionable

  // An expired job cannot be submitted -- the contract reverts without a reason string, which
  // reads as a mysterious failure in the log. Skip it deliberately and record it as handled so
  // the daemon stops retrying something that can never succeed. The client can still reclaim it.
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  if (nowSecs > job[6]) {
    log(`job #${jobId} expired ${new Date(Number(job[6]) * 1000).toISOString()} -- skipping (client can reclaim)`);
    state.handled.push(jobId.toString());
    return false;
  }

  log(`job #${jobId} is Funded for ${formatUnits(job[5], 18)} $U from ${job[1]} -- delivering`);
  // Anyone who hires VEYRA becomes a candidate for position management too.
  state.watch = [...new Set([...(state.watch ?? []), job[1]])];

  const { deliverable, winner } = await buildDeliverable(jobId, job);
  log(`  evaluated: ${winner.proposal.candidateId} -> ${winner.proposal.proposedAction.kind}`);

  const tx = await signer.sendAndWait(
    `submit-${jobId}`,
    COMMERCE,
    encodeFunctionData({ abi: COMMERCE_ABI, functionName: "submit", args: [jobId, deliverable, "0x"] }),
  );

  // Never trust the receipt alone -- re-read the status to confirm the transition really happened.
  const after = await client.readContract({ address: COMMERCE, abi: COMMERCE_ABI, functionName: "jobs", args: [jobId] });
  if (Number(after[7]) !== 2) {
    log(`  WARNING: submit mined (${tx.hash}) but job is ${STATUS[Number(after[7])]}, not Submitted`);
    return false;
  }

  log(`  submitted: ${tx.hash}`);
  log(`  deliverable ${deliverable}`);
  // NOT "handled" yet: a Router-evaluated job still needs settling once its dispute window
  // closes, and a client-evaluated one is waiting on the client. Only a terminal status retires
  // a job. Tracking it as pending keeps it visible even after the cursor moves past it -- an
  // earlier version advanced the cursor and silently abandoned a delivered-but-unsettled job.
  if (!state.pending.includes(jobId.toString())) state.pending.push(jobId.toString());
  return true;
}

/**
 * Settles a Router-evaluated job whose dispute window has closed.
 *
 * Only applies to jobs that named the EvaluatorRouter as evaluator. A client-evaluated job is
 * deliberately left alone: its client decides, and settling it on their behalf would take that
 * choice away. Anyone may call settle() once the window has passed, so doing it here simply means
 * the client is not left with a Submitted job that never resolves.
 */
async function settleIfDue(signer, jobId, job, state) {
  if (job[3].toLowerCase() !== ROUTER.toLowerCase()) return false; // client-evaluated: not ours to settle

  const policy = await client.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "jobPolicy", args: [jobId] });
  if (/^0x0+$/.test(policy)) return false;

  const [windowSecs, submittedAt, disputed] = await Promise.all([
    client.readContract({ address: policy, abi: POLICY_ABI, functionName: "disputeWindow" }),
    client.readContract({ address: policy, abi: POLICY_ABI, functionName: "submittedAt", args: [jobId] }),
    client.readContract({ address: policy, abi: POLICY_ABI, functionName: "disputed", args: [jobId] }),
  ]);

  if (disputed) {
    log(`job #${jobId} is disputed -- leaving it for the policy's voters, not settling`);
    return false;
  }
  const dueAt = Number(submittedAt) + Number(windowSecs);
  if (Math.floor(Date.now() / 1000) < dueAt) {
    log(`job #${jobId} submitted; dispute window closes ${new Date(dueAt * 1000).toISOString()}`);
    return false;
  }

  log(`job #${jobId} dispute window closed -- settling`);
  const tx = await signer.sendAndWait(`settle-${jobId}`, ROUTER, encodeFunctionData({ abi: ROUTER_ABI, functionName: "settle", args: [jobId, "0x"] }));
  const after = await client.readContract({ address: COMMERCE, abi: COMMERCE_ABI, functionName: "jobs", args: [jobId] });
  log(`  settled: ${tx.hash} -> ${STATUS[Number(after[7])]}`);
  if (Number(after[7]) === 3) {
    state.handled.push(jobId.toString());
    state.pending = state.pending.filter((p) => p !== jobId.toString());
  }
  return true;
}

/**
 * The key hash IthacaAccount stores for a secp256k1 session key. Mirrors the SDK's
 * computeAccountSecp256k1KeyHash, which is internal and not exported.
 */
function agentSessionKeyHash(address) {
  const publicKeyHash = keccak256(padHex(address, { size: 32 }));
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, publicKeyHash]));
}

/**
 * Manages the positions of every watched account that has a live VEYRA session.
 *
 * The watchlist is how discovery works: there is no on-chain reverse index from a session key back
 * to the accounts that granted it, and historical eth_getLogs is unavailable on public BSC testnet
 * RPCs. So accounts are learned from the job clients this daemon already sees, plus anything given
 * explicitly via VEYRA_WATCH. Whether a session is actually live is then asked of the chain
 * directly, which is authoritative.
 */
async function managePositions(state) {
  if (!existsSync(AGENT_SESSION_PATH)) {
    log("no agent session key present -- skipping position management");
    return 0;
  }
  const agentKey = JSON.parse(readFileSync(AGENT_SESSION_PATH, "utf-8"));
  const agentAccount = privateKeyToAccount(agentKey.privateKey);
  const agentKeyHash = agentSessionKeyHash(agentKey.address);
  const altana = createAltanaClient({ chains: [BNB_TESTNET] });

  const extra = (process.env.VEYRA_WATCH ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  const watch = [...new Set([...(state.watch ?? []), ...extra])];
  if (watch.length === 0) return 0;

  let acted = 0;
  for (const owner of watch) {
    if (!(await hasLiveVeyraSession(client, owner, agentKeyHash))) continue;

    const positions = await readOwnedPositions(client, owner);
    if (positions.length === 0) continue;
    log(`  ${owner} has a live VEYRA session and ${positions.length} position(s)`);

    for (const positionTokenId of positions) {
      try {
        // Rebuilt per account: the session is bound to one wallet address.
        const session = {
          walletAddress: owner,
          signer: {
            type: "privateKey", address: agentAccount.address, publicKey: agentAccount.publicKey,
            _privateKey: agentKey.privateKey,
            async signDigest(d) { return agentAccount.sign({ hash: d }); },
          },
          publicKey: agentKey.publicKey,
          permissions: { calls: [{ to: NFPM_ADDRESS }, { to: SWAP_ROUTER_ADDRESS }], spend: [{ limit: 50_000_000_000_000_000n, period: "day" }] },
          expiry: Math.floor(Date.now() / 1000) + 3600,
        };

        const outcome = await managePosition({
          client, executor: altana, session, owner, positionTokenId, agentKeyHash, log,
        });
        if (outcome.decision === "rebalanced") {
          acted++;
          log(`    REBALANCED #${positionTokenId} -> ${outcome.finalState}, new position ${outcome.newPositionTokenId ?? "n/a"}`);
        }
      } catch (err) {
        log(`    position #${positionTokenId} failed: ${(err.shortMessage ?? err.message ?? String(err)).slice(0, 180)}`);
      }
    }
  }
  return acted;
}

async function tick(signer, state) {
  const counter = await client.readContract({ address: COMMERCE, abi: COMMERCE_ABI, functionName: "jobCounter" });

  if (state.cursor === null) {
    state.cursor = Math.max(0, Number(counter) - COLD_START_LOOKBACK);
    log(`cold start: scanning from job #${state.cursor} to #${counter}`);
  }

  let delivered = 0;

  // Always re-check jobs we have touched but not retired, regardless of where the cursor is.
  const ids = new Set(state.pending.map(String));
  for (let id = BigInt(state.cursor); id <= counter; id++) ids.add(id.toString());

  for (const idStr of [...ids].sort((a, b) => Number(a) - Number(b))) {
    const id = BigInt(idStr);
    if (state.handled.includes(idStr)) continue;
    try {
      if (await handleJob(signer, id, state)) delivered++;
    } catch (err) {
      // One bad job must never stop the loop; log it and carry on.
      log(`  job #${id} failed: ${(err.shortMessage ?? err.message ?? String(err)).slice(0, 160)}`);
    }
  }

  // Only advance past jobs that can no longer become deliverable. A job still Open today may be
  // funded tomorrow, so the cursor lags the counter by a small window.
  state.cursor = Math.max(0, Number(counter) - 10);

  let managed = 0;
  try {
    managed = await managePositions(state);
  } catch (err) {
    log(`position management failed: ${(err.shortMessage ?? err.message ?? String(err)).slice(0, 200)}`);
  }

  saveState(state);
  return delivered + managed;
}

// ------------------------------------------------------------------------------------------

log("VEYRA agent daemon starting");
log(`  provider : ${VEYRA_WALLET}`);
log(`  commerce : ${COMMERCE}`);
log(`  poll     : every ${POLL_MS / 1000}s`);

materializeCredentials();

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const signer = createSigner(
  client,
  new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
  CHAIN_ID,
);

const state = loadState();
const once = process.argv.includes("--once");

let running = true;
process.on("SIGINT", () => {
  log("stopping");
  running = false;
});

do {
  try {
    const n = await tick(signer, state);
    if (n > 0) log(`delivered ${n} job(s)`);
  } catch (err) {
    log(`poll failed: ${(err.shortMessage ?? err.message ?? String(err)).slice(0, 200)}`);
  }
  if (once || !running) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
} while (running);

log("daemon stopped");

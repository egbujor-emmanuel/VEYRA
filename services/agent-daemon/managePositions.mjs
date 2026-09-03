// The autonomous half of the product: VEYRA managing users' own positions, unattended.
//
// Everything else the daemon does is about jobs -- somebody hires the agent, it delivers, it gets
// paid. This is the other promise: you deposit capital, grant a scoped key, close the tab, and
// the agent keeps your position working.
//
// How users are discovered
// ------------------------
// There is no on-chain reverse index from a session key to the accounts that granted it, and
// every public BSC testnet RPC refuses eth_getLogs over historical ranges, so a Transfer/JobCreated
// scan is not available either. Instead the daemon keeps a watchlist, seeded from two honest
// sources: every client address it has already seen on an ERC-8183 job, and any address passed
// explicitly. For each watched account it then asks the chain directly whether VEYRA's session key
// is currently authorized -- that check is authoritative, cheap, and needs no logs.
//
// What it will not do
// -------------------
// It acts only where a live, unexpired session names VEYRA's agent key. It never grants token
// approvals -- the session signer verifies the user's own pre-approvals and refuses otherwise. And
// it only rebalances when the unmodified evaluator actually chooses to; a position that is fine is
// left alone.

import { encodeFunctionData } from "viem";
import { evaluateV2, rangeKeeperStrategy, baselineHoldStrategy, transition } from "@veyra/core";
import { readPositionObservation, toMarketSnapshot, isTickInRange } from "@veyra/chain/positionReader";
import { executeRebalanceForPosition } from "@veyra/chain/rebalanceExecutor";
import { createSessionSigner } from "@veyra/chain/sessionSigner";
import { PANCAKE_V3_TESTNET } from "@veyra/chain/testnetAddresses";

const NFPM = PANCAKE_V3_TESTNET.nonfungiblePositionManager;
const SWAP_ROUTER = PANCAKE_V3_TESTNET.swapRouter;

const NFPM_ENUM_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenOfOwnerByIndex", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "i", type: "uint256" }], outputs: [{ type: "uint256" }] },
];

const ACCOUNT_KEYS_ABI = [{
  name: "getKeys", type: "function", stateMutability: "view", inputs: [],
  outputs: [
    { name: "keys", type: "tuple[]", components: [
      { name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" },
      { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" }] },
    { name: "keyHashes", type: "bytes32[]" }],
}];

/**
 * Is VEYRA's session key currently authorized on this account?
 *
 * Compares the agent's own secp256k1 key hash against the account's authorized key list. An
 * expired key is treated as absent -- the chain would reject it anyway, and acting on one would
 * mean the daemon believed it had permission it did not have.
 */
export async function hasLiveVeyraSession(client, account, agentKeyHash) {
  try {
    const [keys, hashes] = await client.readContract({ address: account, abi: ACCOUNT_KEYS_ABI, functionName: "getKeys" });
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < keys.length; i++) {
      if (hashes[i].toLowerCase() !== agentKeyHash.toLowerCase()) continue;
      const expiry = Number(keys[i].expiry);
      return expiry === 0 || expiry > now;
    }
    return false;
  } catch {
    // Not an Altana smart account, or not yet delegated. Either way: nothing to manage.
    return false;
  }
}

export async function readOwnedPositions(client, owner) {
  const count = await client.readContract({ address: NFPM, abi: NFPM_ENUM_ABI, functionName: "balanceOf", args: [owner] });
  const ids = [];
  for (let i = 0n; i < count; i++) {
    ids.push(await client.readContract({ address: NFPM, abi: NFPM_ENUM_ABI, functionName: "tokenOfOwnerByIndex", args: [owner, i] }));
  }
  return ids;
}

/**
 * Evaluates one position and rebalances it if -- and only if -- the evaluator says so.
 *
 * The decision is made by the same unmodified strategies used everywhere else, scored against the
 * same live snapshot. If baseline-hold wins, nothing happens. Returns a short record of what was
 * decided either way, so a quiet pass is still auditable.
 */
export async function managePosition({ client, executor, session, owner, positionTokenId, agentKeyHash, log }) {
  const observation = await readPositionObservation(client, positionTokenId, NFPM);

  if (observation.positionLiquidity === 0n) {
    return { positionTokenId, decision: "skip", reason: "position holds no liquidity" };
  }

  const snapshot = toMarketSnapshot(observation, { recentVolatilityBps: 0 });
  const inRange = isTickInRange(observation.currentTick, observation.tickLower, observation.tickUpper);

  const job = {
    jobId: `managed-${owner}-${positionTokenId}`,
    createdAt: new Date().toISOString(),
    ownerWallet: owner,
    category: "rebalance",
    target: { protocol: "pancakeswap-v3", network: "bsc-testnet", positionTokenId: Number(positionTokenId) },
    constraints: { maxSpendWei: "10000000000000000", maxSlippageBps: 100, riskTolerance: "medium", deadlineSeconds: 600 },
    budget: { currency: "U", amountWei: "0" },
    status: "evaluating",
  };

  const proposals = await Promise.all([rangeKeeperStrategy, baselineHoldStrategy].map((fn) => fn(job, snapshot)));
  const round = evaluateV2(job, snapshot, proposals);
  const winner = round.winner;
  const action = winner.proposal.proposedAction;

  log?.(`    position #${positionTokenId}: ${inRange ? "in range" : "OUT OF RANGE"}, winner ${winner.proposal.candidateId} -> ${action.kind}`);

  if (action.kind !== "rebalance" || !action.targetRange) {
    return { positionTokenId, decision: "hold", reason: winner.proposal.rationale };
  }

  // Session-backed signer: the same execution path the admin flow uses, routed through the
  // user's granted session. It refuses to invent token approvals.
  const signer = createSessionSigner({
    client, executor, session,
    walletAddress: owner,
    expectedSpenders: [NFPM, SWAP_ROUTER],
    onStep: (step, detail) => log?.(`      ${step}: ${detail}`),
  });

  const plan = { targetRange: action.targetRange, rationale: winner.proposal.rationale };
  let run = { runId: job.jobId, state: "SIMULATED", history: [] };
  try {
    run = transition(run, "PLAN_OK");
  } catch {
    // The state machine's exact entry point is not load-bearing here; the executor drives it.
  }

  const result = await executeRebalanceForPosition({
    client, signer, job, plan,
    positionTokenId, observation,
    ownerWallet: owner,
    run,
  });

  return {
    positionTokenId,
    decision: "rebalanced",
    finalState: result.run?.state ?? "unknown",
    newPositionTokenId: result.newPositionTokenId ? result.newPositionTokenId.toString() : null,
    transactions: (result.txRecords ?? []).map((t) => ({ step: t.step, hash: t.hash })),
  };
}

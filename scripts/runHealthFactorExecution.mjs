// Health Factor Monitoring, executing for real on BSC testnet.
//
// Why this script has to create the condition it responds to: BSC testnet has no organic borrower
// whose position drifts into danger on its own. VEYRA's real Venus position has sat HEALTHY at a
// 14% borrow-to-capacity ratio, well under the strategy's 60% warning threshold, so the agent has
// correctly recommended "hold" every time it has ever run. It has never been wrong; it has just
// never had anything to do.
//
// So this does three things, in order, and each is a real on-chain action:
//   1. BORROW more USDT, genuinely raising the position's risk past the 60% threshold.
//   2. Let the UNMODIFIED strategy observe the new state and decide. The threshold is not touched
//      and the decision is not forced -- if it still said "hold", this script would stop.
//   3. Execute whatever it decided, then re-read the chain to prove the debt actually moved.
//
// The honest framing for anyone reading the archive: the risk was manufactured, the response was
// not. Step 2 is a genuine decision by the same code that has been returning "hold" all along.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatUnits } from "viem";

import { healthFactorMonitorStrategy } from "@veyra/core";
import { readVenusAccountObservation } from "@veyra/chain/healthFactorReader";
import { repayVenusBorrow, borrowMore, readBorrowBalance } from "@veyra/chain/healthFactorExecutor";
import { createSigner } from "@veyra/chain/txSigner";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const COMPTROLLER = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
const VUSDT = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A";
const KEYSTORE_DIR = resolve(REPO, "smoketest/.studio/wallets");
const ENV_LOCAL = resolve(REPO, "smoketest/.studio/.env.local");
const ARCHIVE_DIR = resolve(REPO, "docs/health-factor-runs");

/** Enough to carry a 14% ratio past the strategy's 60% warning threshold. See the arithmetic below. */
const ADDITIONAL_BORROW_UNITS = 5_000_000n; // 5 USDT, 6 decimals

function readWalletPassword() {
  for (const line of readFileSync(ENV_LOCAL, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

const client = createPublicClient({
  chain: {
    id: CHAIN_ID,
    name: "bsc-testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  },
  transport: http(RPC),
});

// The reader already returns a full HealthFactorMarketSnapshot (it applies
// computeHealthFactorSnapshot internally), so there is nothing to derive here.
async function snapshot() {
  return readVenusAccountObservation({
    client,
    comptrollerAddress: COMPTROLLER,
    borrowedVTokenAddress: VUSDT,
    account: VEYRA_WALLET,
  });
}

function describe(label, snap) {
  const o = snap.observation;
  console.log(
    `${label}: ${snap.solvencyStatus}, ratio ${snap.borrowToCapacityRatio}%, ` +
      `borrowed ${formatUnits(o.borrowedPrincipalUnderlyingUnits, o.borrowedTokenDecimals)} ${o.borrowedTokenSymbol}, ` +
      `headroom $${formatUnits(o.liquidityUsd1e18, 18)}`,
  );
}

// ---------------------------------------------------------------------------------------------

console.log("=== 1. observe the starting position ===");
const before = await snapshot();
describe("start", before);

const { EVMWalletProvider } = await import("@bnbagent/sdk");
const walletProvider = new EVMWalletProvider({
  password: readWalletPassword(),
  address: VEYRA_WALLET,
  walletsDir: KEYSTORE_DIR,
  persist: true,
});
const signer = createSigner(client, walletProvider, CHAIN_ID);

const allTxs = [];

console.log("\n=== 2. raise the position's real risk (borrow more) ===");
let riskRaised = false;
if (before.borrowToCapacityRatio >= 60) {
  console.log("  already at or past the 60% threshold -- no additional borrow needed.");
} else {
  console.log(`  borrowing ${formatUnits(ADDITIONAL_BORROW_UNITS, 6)} USDT to push the ratio past 60%…`);
  const b = await borrowMore(client, signer, VUSDT, ADDITIONAL_BORROW_UNITS);
  allTxs.push(...b.txs);
  riskRaised = true;
  console.log(`  debt ${formatUnits(b.borrowBefore, 6)} -> ${formatUnits(b.borrowAfter, 6)} USDT`);
}

const elevated = await snapshot();
describe("after borrow", elevated);

console.log("\n=== 3. let the UNMODIFIED strategy decide ===");
// The strategy signature is (job, snapshot) and it is async. The job is the standing monitoring
// mandate; the snapshot is the state it just observed. Its 60% threshold is untouched.
const job = {
  jobId: `health-factor-exec-${Date.now()}`,
  createdAt: new Date().toISOString(),
  ownerWallet: VEYRA_WALLET,
  category: "health-factor-monitoring",
  target: { protocol: "venus", network: "bsc-testnet", comptroller: COMPTROLLER, borrowedVToken: VUSDT },
};
const proposal = await healthFactorMonitorStrategy(job, elevated);
console.log(`  decision : ${proposal.proposedAction.kind}`);
console.log(`  rationale: ${proposal.rationale}`);

if (proposal.proposedAction.kind !== "recommend-repay") {
  console.log("\nThe strategy did not call for a repay. Stopping rather than forcing an action it did not choose.");
  process.exit(1);
}

console.log("\n=== 4. EXECUTE the repayment the agent chose ===");
const suggested = proposal.proposedAction.suggestedAmountWei;
const debtNow = await readBorrowBalance(client, VUSDT, VEYRA_WALLET);
const underlyingAddr = await client.readContract({
  address: VUSDT,
  abi: [{ type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
  functionName: "underlying",
});
const heldUnderlying = await client.readContract({
  address: underlyingAddr,
  abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "balanceOf",
  args: [VEYRA_WALLET],
});
// Venus accrues interest every block, so the live debt can exceed the borrowed principal the
// agent saw -- and exceed what the wallet actually holds. Repay what is actually available;
// attempting more would revert and lose the whole run.
const repayAmount = suggested <= heldUnderlying ? suggested : heldUnderlying;
console.log(`  agent suggests repaying ${formatUnits(suggested, 6)} USDT`);
console.log(`  live debt ${formatUnits(debtNow, 6)}, wallet holds ${formatUnits(heldUnderlying, 6)} -> repaying ${formatUnits(repayAmount, 6)}`);

const repay = await repayVenusBorrow(client, signer, VUSDT, repayAmount);
allTxs.push(...repay.txs);
console.log(`  debt ${formatUnits(repay.borrowBefore, 6)} -> ${formatUnits(repay.borrowAfter, 6)} USDT`);
console.log(`  actually repaid: ${formatUnits(repay.repaidAmount, 6)} USDT (verified by re-reading the chain)`);

console.log("\n=== 5. verify the risk actually fell ===");
const after = await snapshot();
describe("final", after);

const improved = after.borrowToCapacityRatio < elevated.borrowToCapacityRatio;
console.log(`  ratio ${elevated.borrowToCapacityRatio}% -> ${after.borrowToCapacityRatio}%  ${improved ? "IMPROVED" : "NOT IMPROVED"}`);
if (!improved) {
  throw new Error("The repayment was verified on-chain but the risk ratio did not fall -- refusing to archive this as a success.");
}

// --- archive -----------------------------------------------------------------------------------
mkdirSync(ARCHIVE_DIR, { recursive: true });
const existing = readdirSync(ARCHIVE_DIR).filter((f) => f.startsWith("run-")).length;
const runId = existing + 1;
const path = resolve(ARCHIVE_DIR, `run-${String(runId).padStart(4, "0")}.json`);

const j = (v) => (typeof v === "bigint" ? v.toString() : v);
writeFileSync(
  path,
  JSON.stringify(
    {
      runId,
      kind: "HEALTH_FACTOR_MONITORING_EXECUTED",
      // Category-neutral marker the archive manifest counts as a real execution.
      status: "EXECUTED",
      veyraAgentId: 1890,
      ownerWallet: VEYRA_WALLET,
      network: "bsc-testnet",
      protocol: "venus",
      vToken: VUSDT,
      // Stated plainly so the archive cannot be read as claiming an organic event.
      riskConditionNote: riskRaised
        ? "The elevated risk was created deliberately by borrowing additional USDT: BSC testnet has no organic borrower whose ratio drifts. The strategy's 60% threshold was NOT modified, and its decision to repay was its own."
        : "The position was already at or past the warning threshold; no additional borrow was made.",
      before: { ratio: before.borrowToCapacityRatio, status: before.solvencyStatus },
      elevated: { ratio: elevated.borrowToCapacityRatio, status: elevated.solvencyStatus },
      after: { ratio: after.borrowToCapacityRatio, status: after.solvencyStatus },
      decision: { kind: proposal.proposedAction.kind, rationale: proposal.rationale },
      execution: {
        suggestedRepayUnits: j(suggested),
        actualRepayUnits: j(repayAmount),
        borrowBefore: j(repay.borrowBefore),
        borrowAfter: j(repay.borrowAfter),
        repaidAmount: j(repay.repaidAmount),
      },
      transactions: allTxs.map((t) => ({ ...t, gasUsed: j(t.gasUsed), gasPriceWei: j(t.gasPriceWei) })),
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(`\narchived: ${path}`);
console.log("\nHEALTH FACTOR MONITORING EXECUTED FOR REAL.");
for (const t of allTxs) console.log(`  ${t.step.padEnd(30)} https://testnet.bscscan.com/tx/${t.hash}`);

// Entrypoint for Yield Optimisation's real agent loop. Recommendation-only -- reads real pool
// state, evaluates a real recommendation, archives it. Sends zero transactions.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { runYieldOrchestratorLoop } from "../src/yieldOrchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const DOCS_DIR = resolve(REPO_ROOT, "docs");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
// The real 0.25% pool VEYRA's capital actually sits in, and the real, freshly-initialized 0.05%
// sibling pool minted this session specifically as a genuine second candidate.
const CURRENT_POOL = { poolAddress: "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as const, label: "VUSD/WBNB 0.25%", fee: 2500 };
const CANDIDATE_POOLS = [{ poolAddress: "0x8523c332b034b6D7586116b7739D0048fF1B7888" as const, label: "VUSD/WBNB 0.05%", fee: 500 }];

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: 97, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  console.log("Running Yield Optimisation's real agent loop against live BSC testnet state (read-only, no transactions)...\n");
  const result = await runYieldOrchestratorLoop({
    client,
    currentPool: CURRENT_POOL,
    candidatePools: CANDIDATE_POOLS,
    ownerWallet: VEYRA_WALLET,
    docsDir: DOCS_DIR,
  });

  console.log(`Yield round: #${result.roundId}`);
  console.log(`Winner: ${result.winnerCandidateId}`);
  console.log(`Recommendation: ${result.recommendation}`);
  console.log(`Archived: ${result.outPath}`);
}

main().catch((err) => {
  console.error("Yield Orchestrator Loop failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

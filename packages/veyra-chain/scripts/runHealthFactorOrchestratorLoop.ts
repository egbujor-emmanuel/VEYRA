// Entrypoint for Health Factor Monitoring's real agent loop. Recommendation-only -- reads real
// Venus Protocol account state, evaluates a real recommendation, archives it. Sends zero
// transactions.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { runHealthFactorOrchestratorLoop } from "../src/healthFactorOrchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const DOCS_DIR = resolve(REPO_ROOT, "docs");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
// Real Venus testnet infrastructure, verified live this session against the actual Comptroller.
const COMPTROLLER = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D" as const;
const VUSDT = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A" as const; // the real vToken market VEYRA borrowed from this session

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: 97, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  console.log("Running Health Factor Monitoring's real agent loop against live Venus testnet state (read-only, no transactions)...\n");
  const result = await runHealthFactorOrchestratorLoop({
    client,
    comptrollerAddress: COMPTROLLER,
    borrowedVTokenAddress: VUSDT,
    account: VEYRA_WALLET,
    docsDir: DOCS_DIR,
  });

  console.log(`Health Factor round: #${result.roundId}`);
  console.log(`Winner: ${result.winnerCandidateId}`);
  console.log(`Recommendation: ${result.recommendation}`);
  console.log(`Archived: ${result.outPath}`);
}

main().catch((err) => {
  console.error("Health Factor Orchestrator Loop failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

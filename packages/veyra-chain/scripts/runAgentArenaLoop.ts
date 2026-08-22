// Entrypoint for the Agent Arena Loop (Slice 4): observe -> evaluate -> plan -> simulate ->
// [hold | blocked | execute -> verify] -> archive, driven by the real arena's actual winner.
//
// If the real arena's winner is hold (as it has been every round so far, since the isolated
// testnet pool has no trading activity), this naturally ends in HOLD with zero transactions --
// exactly the same honest outcome runLiveArenaEvaluation.ts has shown, now additionally
// formalized through the run state machine and archived to docs/agent-arena-runs/.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { runAgentArenaLoop } from "../src/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const SMOKETEST_ROOT = resolve(REPO_ROOT, "smoketest");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const DOCS_DIR = resolve(REPO_ROOT, "docs");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
// Position #37058 was decreased/collected/emptied by the Slice 3 controlled execution
// (docs/executions/execution-0002.json) and re-minted as position #37059, which is now the
// real, current, liquid position VEYRA holds. Pointing this loop at the old, empty #37058
// would be observing stale state, not the actual current position.
const VEYRA_POSITION_TOKEN_ID = 37059n;

function readWalletPassword(): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WALLET_PASSWORD=")) return trimmed.slice("WALLET_PASSWORD=".length);
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: 97, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  const { EVMWalletProvider } = await import("@bnbagent/sdk");
  const wallet = new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: KEYSTORE_DIR, persist: true });

  console.log("Running the Agent Arena Loop against live BSC testnet state...\n");
  const result = await runAgentArenaLoop({
    client,
    wallet,
    positionTokenId: VEYRA_POSITION_TOKEN_ID,
    ownerWallet: VEYRA_WALLET,
    docsDir: DOCS_DIR,
  });

  console.log(`Arena round: #${result.roundId}`);
  console.log(`Winner: ${result.winnerCandidateId}`);
  console.log(`Run transitions: ${result.run.transitions.map((t) => t.to).join(" -> ")}`);
  console.log(`Final state: ${result.run.currentState === "ARCHIVED" ? result.run.transitions.at(-2)!.to : result.run.currentState}`);
  if (result.newPositionTokenId) console.log(`New position: #${result.newPositionTokenId}`);
  console.log(`Archived: ${result.outPath}`);
}

main().catch((err) => {
  console.error("Agent Arena Loop failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

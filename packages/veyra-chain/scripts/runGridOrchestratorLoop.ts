// Entrypoint for Grid Trading's real agent loop (four-category expansion). Mirrors
// runAgentArenaLoop.ts's exact setup pattern (same wallet, same RPC override, same
// EVMWalletProvider-as-SigningWallet reuse) -- just pointed at gridOrchestrator.ts and the two
// real grid-slot positions minted for this category.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { runGridOrchestratorLoop } from "../src/gridOrchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const SMOKETEST_ROOT = resolve(REPO_ROOT, "smoketest");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const DOCS_DIR = resolve(REPO_ROOT, "docs");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
// Minted this session for Grid Trading: slot 0 (#37091) at the ladder's own current target.
// Slot 1 was originally #37092 (deliberately stale/narrow, to prove a real recenter on the first
// run) -- that run genuinely executed (decrease/collect/swap), needed two corrective-swap
// iterations to clear the ratio-mismatch threshold on this narrow, edge-of-price range, and
// re-minted as #37093 (see docs/grid-runs/run-0002.json + run-0002-resumed-mint.json for the
// full, honest record, including the first correction that still fell short). #37093 is the
// current, live slot-1 position going forward.
const GRID_POSITION_TOKEN_IDS = [37091n, 37093n];

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

  console.log("Running Grid Trading's real agent loop against live BSC testnet state...\n");
  const result = await runGridOrchestratorLoop({
    client,
    wallet,
    gridPositionTokenIds: GRID_POSITION_TOKEN_IDS,
    ownerWallet: VEYRA_WALLET,
    docsDir: DOCS_DIR,
  });

  console.log(`Grid round: #${result.roundId}`);
  console.log(`Winner: ${result.winnerCandidateId}`);
  for (const outcome of result.slotOutcomes) {
    console.log(`Slot ${outcome.slotIndex} (position #${outcome.positionTokenId}): ${outcome.finalState}${outcome.newPositionTokenId ? ` -> new position #${outcome.newPositionTokenId}` : ""}`);
  }
  console.log(`Archived: ${result.outPath}`);
}

main().catch((err) => {
  console.error("Grid Orchestrator Loop failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

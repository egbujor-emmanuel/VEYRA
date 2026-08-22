// One-time operational script: register the real VEYRA Agent identity on the
// BSC testnet ERC-8004 Identity Registry (architecture doc §5).
//
// Reuses the wallet created earlier during the bag-CLI smoke test
// (smoketest/.studio/wallets) rather than creating a new throwaway -- this
// keystore becomes VEYRA Agent's persistent identity wallet going forward.
// The keystore password is read from smoketest/.studio/.env.local and is
// NEVER logged; only the resulting address/agentId/agentURI are printed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ensureTestnetRpcOverride } from "../src/network.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname at runtime is dist/scripts/ (compiled), so this needs 4 levels up
// to reach the bnb-smart-money-era repo root: dist/scripts -> dist -> veyra-chain -> packages -> root.
const SMOKETEST_ROOT = resolve(__dirname, "../../../../smoketest");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const WALLET_ADDRESS = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";

function readWalletPassword(): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WALLET_PASSWORD=")) {
      return trimmed.slice("WALLET_PASSWORD=".length);
    }
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}

async function main() {
  ensureTestnetRpcOverride();

  // Imported after the RPC override is set -- resolveNetwork() reads the env
  // var lazily per-call, but importing first then calling later is also safe;
  // this ordering just keeps the intent obvious at the call site.
  const { EVMWalletProvider, ERC8004Agent } = await import("@bnbagent/sdk");

  const password = readWalletPassword();
  const walletProvider = new EVMWalletProvider({
    password,
    address: WALLET_ADDRESS,
    walletsDir: KEYSTORE_DIR,
    persist: true,
  });

  console.log(`Loaded wallet: ${walletProvider.address}`);

  const agent = await ERC8004Agent.create({
    walletProvider,
    network: "bsc-testnet",
  });

  console.log(`Connected to ERC-8004 registry: ${agent.contractAddress} (bsc-testnet)`);

  const existing = await agent.getLocalAgentInfo("VEYRA Agent").catch((err) => {
    console.warn(`Local-agent lookup failed (indexer flakiness is expected, per RECON §22) -- proceeding as if unregistered: ${err}`);
    return null;
  });

  if (existing) {
    console.log("VEYRA Agent is already registered:");
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  const agentUri = agent.generateAgentUri({
    name: "VEYRA Agent",
    description:
      "VEYRA's ERC-8004-registered strategy agent (internal codename RangeKeeper) for PancakeSwap V3 " +
      "concentrated-liquidity rebalancing on BSC testnet. Competes against clearly labeled baseline " +
      "strategies under a shared, transparent evaluator -- see architecture doc for the full loop. " +
      "Hackathon-build agent; no public HTTP endpoint deployed yet (endpoints will be added via " +
      "setAgentUri once one exists, rather than registering a placeholder URL now).",
    endpoints: [],
    supportedTrust: ["reputation"],
  });

  const result = await agent.registerAgent(agentUri);

  console.log("Registered VEYRA Agent on-chain:");
  console.log(JSON.stringify({ agentId: result.agentId, transactionHash: result.transactionHash }, null, 2));
  console.log("\nSet packages/veyra-core/src/strategies/rangeKeeper.ts's AGENT_ID_ON_CHAIN_PLACEHOLDER to this agentId.");
}

main().catch((err) => {
  console.error("Registration failed:", err);
  process.exitCode = 1;
});

// Compiles contracts/VeyraDemoUSD.sol to ABI + bytecode and writes the artifact to
// contracts/VeyraDemoUSD.json, for the mint script to deploy via viem.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const solc = require("solc");

// __dirname at runtime is dist/scripts/ -- contracts/ lives at the veyra-chain package root.
const CONTRACTS_DIR = resolve(__dirname, "../../contracts");
const SOURCE_PATH = resolve(CONTRACTS_DIR, "VeyraDemoUSD.sol");
const source = readFileSync(SOURCE_PATH, "utf-8");

const input = {
  language: "Solidity",
  sources: { "VeyraDemoUSD.sol": { content: source } },
  settings: {
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    optimizer: { enabled: true, runs: 200 },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
if (errors.length > 0) {
  console.error(JSON.stringify(errors, null, 2));
  throw new Error("Solidity compilation failed");
}

const contract = output.contracts["VeyraDemoUSD.sol"]["VeyraDemoUSD"];
const artifact = {
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
};

writeFileSync(resolve(CONTRACTS_DIR, "VeyraDemoUSD.json"), JSON.stringify(artifact, null, 2));
console.log("Compiled VeyraDemoUSD -> contracts/VeyraDemoUSD.json");

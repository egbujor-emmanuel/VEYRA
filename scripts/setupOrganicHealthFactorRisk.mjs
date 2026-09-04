// Replaces a manufactured risk trigger with an organic one.
//
// The problem this fixes
// ----------------------
// Health Factor's demo previously borrowed extra USDT to jump the ratio 14% -> 74%. The risk was
// real, but WE caused it. On vUSDT that was unavoidable: its borrowRatePerBlock is 0, so the debt
// never grows, and the Venus testnet oracle is static, so collateral never reprices. Nothing could
// carry that position across a threshold on its own, ever.
//
// The fix
// -------
// Surveying all 49 Venus testnet markets found borrowable ones that DO accrue interest. The
// high-rate markets (vTRX 30.75%, vUNI 26.68%) are at 100% utilization with no cash to lend, but
// Venus XVS pays 3.11% APY with 2.2M tokens available.
//
// So: open a real borrow, positioned just under the strategy's 60% threshold, and let interest
// carry it across. Choosing your own leverage is what every borrower does; the RISK EVENT is then
// caused by nothing but time. The daemon watches and will repay when it crosses, unprompted.
//
// The arithmetic that makes precise positioning possible: borrowing X dollars adds X to the debt
// and removes X from the headroom, so (debt + headroom) is invariant. That means
//
//     ratio = borrowedUsd / initialHeadroom
//
// which is directly solvable for a target ratio, rather than needing to be groped at by trial.
//
// Usage: node scripts/setupOrganicHealthFactorRisk.mjs [targetRatioPercent]

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createPublicClient, http, encodeFunctionData, formatUnits } from "viem";
import { createSigner } from "@veyra/chain/txSigner";
import { readVenusAccountObservation } from "@veyra/chain/healthFactorReader";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const VEYRA = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const COMPTROLLER = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
/** Venus XVS: 3.11% borrow APY and 2.2M tokens of available cash, unlike the 100%-utilised markets. */
const VXVS = "0x6d6F697e34145Bb95c54E77482d97cc261Dc237E";

/** Just under the strategy's 60% warning threshold, so interest alone carries it across. */
const TARGET_RATIO_PCT = Number(process.argv[2] ?? "59.9");

const VTOKEN = [
  { type: "function", name: "borrow", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowBalanceStored", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getCash", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowRatePerBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const ERC20 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const COMPT = [
  { type: "function", name: "getAccountLiquidity", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const ORACLE = [{ type: "function", name: "getUnderlyingPrice", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 60_000, retryCount: 5, retryDelay: 1_500 }),
});

function readWalletPassword() {
  for (const line of readFileSync(resolve(REPO, "smoketest/.studio/.env.local"), "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error("WALLET_PASSWORD not found");
}

/** The ratio at full precision. The snapshot floors it to an integer, which hides the drift. */
async function preciseRatio() {
  const snap = await readVenusAccountObservation({
    client, comptrollerAddress: COMPTROLLER, borrowedVTokenAddress: VXVS, account: VEYRA,
  });
  const o = snap.observation;
  const debtUsd = o.borrowedTokenPriceMantissa && o.borrowedTokenPriceMantissa > 0n
    ? (o.borrowedPrincipalUnderlyingUnits * o.borrowedTokenPriceMantissa) / 10n ** 18n
    : o.borrowedPrincipalUnderlyingUnits * 10n ** BigInt(18 - o.borrowedTokenDecimals);
  const total = debtUsd + o.liquidityUsd1e18;
  return {
    exact: total === 0n ? 0 : Number((debtUsd * 1000000n) / total) / 10000,
    integer: snap.borrowToCapacityRatio,
    debtUsd, headroomUsd: o.liquidityUsd1e18, status: snap.solvencyStatus,
    units: o.borrowedPrincipalUnderlyingUnits, symbol: o.borrowedTokenSymbol,
  };
}

console.log("=== 1. the market, and why this one ===");
const [cash, rate, underlying] = await Promise.all([
  client.readContract({ address: VXVS, abi: VTOKEN, functionName: "getCash" }),
  client.readContract({ address: VXVS, abi: VTOKEN, functionName: "borrowRatePerBlock" }),
  client.readContract({ address: VXVS, abi: VTOKEN, functionName: "underlying" }),
]);
const [dec, sym] = await Promise.all([
  client.readContract({ address: underlying, abi: ERC20, functionName: "decimals" }),
  client.readContract({ address: underlying, abi: ERC20, functionName: "symbol" }),
]);
const apy = (Number(rate) * 10512000) / 1e18 * 100;
console.log(`  ${sym} @ ${VXVS}`);
console.log(`  borrow APY ${apy.toFixed(2)}%  cash available ${formatUnits(cash, dec)}`);
if (apy <= 0) throw new Error("This market pays no borrow interest -- it cannot produce organic drift.");

const oracle = await client.readContract({ address: COMPTROLLER, abi: COMPT, functionName: "oracle" });
const price = await client.readContract({ address: oracle, abi: ORACLE, functionName: "getUnderlyingPrice", args: [VXVS] });
console.log(`  oracle price mantissa ${price}  (= $${Number(price) / 10 ** (36 - Number(dec))} per ${sym})`);

console.log("\n=== 2. where the position stands now ===");
const before = await preciseRatio();
const [, headroom] = await client.readContract({ address: COMPTROLLER, abi: COMPT, functionName: "getAccountLiquidity", args: [VEYRA] });
console.log(`  ratio ${before.exact}% (${before.status}), debt ${formatUnits(before.units, dec)} ${before.symbol}`);
console.log(`  headroom $${formatUnits(headroom, 18)}`);

// ratio = borrowedUsd / (borrowedUsd + headroom), and borrowing moves value from one to the other,
// so the denominator is invariant. Solve directly for the borrow that lands on the target.
const capacityUsd = before.debtUsd + headroom;
const targetDebtUsd = (capacityUsd * BigInt(Math.round(TARGET_RATIO_PCT * 10000))) / 1000000n;
const extraUsd = targetDebtUsd > before.debtUsd ? targetDebtUsd - before.debtUsd : 0n;
const extraUnits = (extraUsd * 10n ** 18n) / price;

console.log(`\n=== 3. borrow to sit just under the 60% threshold ===`);
console.log(`  capacity  $${formatUnits(capacityUsd, 18)}`);
console.log(`  target    ${TARGET_RATIO_PCT}% -> debt $${formatUnits(targetDebtUsd, 18)}`);
console.log(`  borrow    ${formatUnits(extraUnits, dec)} ${sym}`);

if (extraUnits === 0n) {
  console.log("  already at or past the target -- nothing to borrow.");
} else if (extraUnits > cash) {
  throw new Error(`Market has only ${formatUnits(cash, dec)} ${sym} of cash; cannot borrow ${formatUnits(extraUnits, dec)}.`);
} else {
  const { EVMWalletProvider } = await import("@bnbagent/sdk");
  const signer = createSigner(
    client,
    new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA, walletsDir: resolve(REPO, "smoketest/.studio/wallets"), persist: true }),
    CHAIN_ID,
  );
  const tx = await signer.sendAndWait("borrow", VXVS, encodeFunctionData({ abi: VTOKEN, functionName: "borrow", args: [extraUnits] }));
  console.log(`  tx ${tx.hash}`);
}

const after = await preciseRatio();
console.log(`\n=== 4. resulting position ===`);
console.log(`  ratio ${after.exact}% (integer ${after.integer}), debt ${formatUnits(after.units, dec)} ${after.symbol}`);
if (after.exact >= 60) {
  console.log("  NOTE: already at or past 60% -- the agent will repay on its next pass.");
} else {
  const gap = 60 - after.exact;
  // ratio grows at (APY x ratio) per year, since debt compounds and the denominator is fixed.
  const daysToCross = gap / ((apy / 100) * after.exact) * 365;
  console.log(`  ${gap.toFixed(4)} points below the 60% threshold`);
  console.log(`  at ${apy.toFixed(2)}% APY this crosses on its own in roughly ${daysToCross.toFixed(2)} days`);
  console.log(`  -- no further action by anyone; the daemon repays it when it does.`);
}

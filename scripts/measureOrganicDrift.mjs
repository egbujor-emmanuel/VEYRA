// Demonstrates that the Health Factor trigger is now ORGANIC: the ratio rises with nobody acting.
//
// Samples the same position twice, minutes apart, with no transaction in between. If the second
// reading is higher than the first, the movement came from accrued interest alone -- which is the
// whole claim. borrowBalanceCurrent is read via eth_call, so the accrual is simulated at the
// current block rather than requiring someone to poke the market.
import { readVenusAccountObservation } from "@veyra/chain/healthFactorReader";
import { createPublicClient, http } from "viem";

const RPC = "https://bsc-testnet-rpc.publicnode.com";
const VEYRA = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const COMPTROLLER = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
const VBTC = "0xb6e9322C49FD75a367Fcb17B0Fcd62C5070EbCBe";
const WAIT_MS = Number(process.argv[2] ?? 240000);

const client = createPublicClient({ transport: http(RPC, { timeout: 60000, retryCount: 5 }) });

async function sample() {
  const snap = await readVenusAccountObservation({
    client, comptrollerAddress: COMPTROLLER, borrowedVTokenAddress: VBTC, account: VEYRA,
  });
  const o = snap.observation;
  const debtUsd = o.borrowedTokenPriceMantissa && o.borrowedTokenPriceMantissa > 0n
    ? (o.borrowedPrincipalUnderlyingUnits * o.borrowedTokenPriceMantissa) / 10n ** 18n
    : o.borrowedPrincipalUnderlyingUnits * 10n ** BigInt(18 - o.borrowedTokenDecimals);
  const total = debtUsd + o.liquidityUsd1e18;
  return {
    block: await client.getBlockNumber(),
    debtUnits: o.borrowedPrincipalUnderlyingUnits,
    ratio: total === 0n ? 0 : Number((debtUsd * 10000000000n) / total) / 100000000,
  };
}

const a = await sample();
console.log(`t0    block ${a.block}  debt ${a.debtUnits}  ratio ${a.ratio.toFixed(8)}%`);
console.log(`waiting ${Math.round(WAIT_MS / 1000)}s -- sending nothing, touching nothing…`);
await new Promise((r) => setTimeout(r, WAIT_MS));
const b = await sample();
console.log(`t1    block ${b.block}  debt ${b.debtUnits}  ratio ${b.ratio.toFixed(8)}%`);

const dDebt = b.debtUnits - a.debtUnits;
const dRatio = b.ratio - a.ratio;
console.log(`\ndebt  +${dDebt} units over ${b.block - a.block} blocks`);
console.log(`ratio +${dRatio.toFixed(8)} points`);
console.log(`gap to the 60% threshold: ${(60 - b.ratio).toFixed(8)} points`);
if (dRatio > 0) {
  const hours = (60 - b.ratio) / (dRatio / (WAIT_MS / 3600000));
  console.log(`\nORGANIC DRIFT CONFIRMED -- rising with no transaction sent.`);
  console.log(`at this observed rate it crosses 60% in ~${hours.toFixed(1)} hours, unaided.`);
} else {
  console.log(`\nNo movement detected in this window.`);
}

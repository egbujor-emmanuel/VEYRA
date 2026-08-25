// Resume-and-complete the run archived as docs/agent-arena-runs-v2/run-0004.json, which
// correctly completed decreaseLiquidity, collect, and the ratio-fixing swap, but reverted on
// mint with "Price slippage check".
//
// ROOT CAUSE, found and fixed in orchestrator.ts: the post-swap ratio-mismatch re-check reused
// `freshSlot0`, a price read BEFORE the swap executed. A swap moves the pool's price by
// definition -- validating "is the held ratio close enough to mint" against the PRE-swap price
// checked the wrong price entirely. The real on-chain price (after the swap actually moved it)
// made the real achievable consumption worse than the stale-price check predicted, and mint()'s
// own amountMin floor correctly rejected it. Fixed by re-reading slot0 after the swap's receipt
// is confirmed, before any further ratio math.
//
// This script does NOT trust the failed run's old numbers. It re-verifies live: position
// liquidity is 0 (decrease succeeded), current wallet balances (what the swap actually left),
// current NFPM allowances (from the approve txs that already succeeded), and a BRAND-NEW slot0
// read taken right now -- price may have drifted further since the failed attempt. If the
// re-checked stranded fraction is STILL above the 1% threshold with today's price, this script
// refuses to mint, same as the live orchestrator would.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, type Address, type Hex } from "viem";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { readPositionObservation } from "../src/positionReader.js";
import { getLiveSwapQuote } from "../src/rebalanceQuote.js";
import { createSigner } from "../src/txSigner.js";
import { NFPM_ABI, ERC20_ABI, POOL_ABI, SWAP_ROUTER_ABI } from "../src/abis.js";
import { PANCAKE_V3_TESTNET } from "../src/testnetAddresses.js";
import { getLiquidityForAmounts, getAmountsForLiquidity, computeRebalanceSwapRequirement, RATIO_MISMATCH_THRESHOLD } from "@veyra/core";

const SWAP_ROUTER = PANCAKE_V3_TESTNET.swapRouter as Address;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const SMOKETEST_ROOT = resolve(REPO_ROOT, "smoketest");
const KEYSTORE_DIR = resolve(SMOKETEST_ROOT, ".studio/wallets");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const RUNS_DIR = resolve(REPO_ROOT, "docs/agent-arena-runs-v2");
const PREDECESSOR_PATH = resolve(RUNS_DIR, "run-0004.json");

const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;
const VEYRA_POSITION_TOKEN_ID = 37059n;
const NFPM_ADDRESS = PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address;
const CHAIN_ID = 97;
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;
const TARGET_TICK_LOWER = -59150;
const TARGET_TICK_UPPER = -57150;
const MAX_SLIPPAGE_BPS = 100;

function readWalletPassword(): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WALLET_PASSWORD=")) return trimmed.slice("WALLET_PASSWORD=".length);
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}
function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
  return value;
}
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;
  const client = createPublicClient({
    chain: { id: CHAIN_ID, name: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });

  section("Pre-flight: verify live state, trust nothing from the failed run's old numbers");
  const pos = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "positions", args: [VEYRA_POSITION_TOKEN_ID] });
  if (pos[7] !== 0n) throw new Error(`expected position #37059 liquidity to be 0 (already decreased), got ${pos[7]}`);
  console.log(`position #${VEYRA_POSITION_TOKEN_ID} liquidity: 0 (confirmed already decreased)`);

  const observation = await readPositionObservation(client, VEYRA_POSITION_TOKEN_ID);

  // NOT the wallet's absolute balance -- VEYRA's wallet holds a large pre-existing token0
  // balance unrelated to this operation (the demo token minted in bulk when the pool was first
  // created), the EXACT same class of bug the original Slice 3 incident already taught this
  // project to avoid (see resumeExecutionMint.ts's own root-cause comment). The correct amounts
  // are the DELTA-based ones the orchestrator already computed correctly against its
  // pre-decrease baseline during the failed run -- reuse those, don't re-derive from an absolute
  // balance read. (First attempt at this script made exactly this mistake; caught harmlessly by
  // the allowance check below before anything was signed -- see the chat record for this slice.)
  // CHECKPOINT, not the predecessor's original pre-swap numbers: this script already ran once
  // and executed one REAL corrective swap (fixed-formula, tx confirmed on-chain) before
  // correctly refusing to mint (1.6% still above threshold -- the swap's own price impact
  // overshot slightly, an expected first-order-approximation effect, not a bug). Re-reading the
  // ORIGINAL predecessor amounts here would silently redo that already-executed swap. Instead:
  // token1 has NO pre-existing dust (verified repeatedly this session -- the wallet's absolute
  // token1 balance IS this operation's amount, no ambiguity), so it was read live and confirmed
  // to exactly equal 16492046244623475, the value that run's own console output logged right
  // before it exited. token0 was cross-checked arithmetically: current absolute balance
  // (9494427645700379813822) minus the balance recorded just before that swap
  // (9493888347845058311320) equals 539297855321502502 -- exactly the real quote.amountOut that
  // swap used, confirming 6106591060789784897 + 539297855321502502 = 6645888916111287399 is the
  // correct current delta-based token0 amount, not a guess.
  const ALREADY_SWAPPED_ONCE = true; // one of MAX_CORRECTIVE_SWAP_ATTEMPTS already spent, in the previous run
  let mintAmount0 = 6_645_888_916_111_287_399n;
  let mintAmount1 = 16_492_046_244_623_475n;
  console.log(`mint amounts, resuming from the verified post-first-corrective-swap checkpoint: token0=${mintAmount0}, token1=${mintAmount1}`);

  const [walletBalance0, walletBalance1, allowance0, allowance1] = await Promise.all([
    client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
    client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
    client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "allowance", args: [VEYRA_WALLET, NFPM_ADDRESS] }),
    client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "allowance", args: [VEYRA_WALLET, NFPM_ADDRESS] }),
  ]);
  console.log(`current wallet balances (informational -- includes the unrelated pre-existing token0 balance): token0=${walletBalance0}, token1=${walletBalance1}`);
  if (walletBalance0 < mintAmount0) throw new Error(`wallet token0 balance ${walletBalance0} is less than the amount to mint ${mintAmount0}`);
  if (walletBalance1 < mintAmount1) throw new Error(`wallet token1 balance ${walletBalance1} is less than the amount to mint ${mintAmount1}`);
  // Allowances are NOT asserted here (only logged) -- they only need to cover whatever amounts
  // exist AFTER any further corrective swap below, and the mint section already tops up
  // whichever allowance falls short of the final amounts right before minting.
  console.log(`current allowances (informational, may still need topping up below): allowance0=${allowance0}, allowance1=${allowance1}`);

  const { EVMWalletProvider } = await import("@bnbagent/sdk");
  const walletProvider = new EVMWalletProvider({ password: readWalletPassword(), address: VEYRA_WALLET, walletsDir: KEYSTORE_DIR, persist: true });
  const signer = createSigner(client, walletProvider, CHAIN_ID);

  function checkRatio(sqrtPriceX96: bigint, amount0: bigint, amount1: bigint) {
    const achievableLiquidity = getLiquidityForAmounts(sqrtPriceX96, TARGET_TICK_LOWER, TARGET_TICK_UPPER, amount0, amount1);
    const consumed = getAmountsForLiquidity(sqrtPriceX96, TARGET_TICK_LOWER, TARGET_TICK_UPPER, achievableLiquidity);
    const fraction0 = amount0 === 0n ? 0 : Number(amount0 - consumed.amount0) / Number(amount0);
    const fraction1 = amount1 === 0n ? 0 : Number(amount1 - consumed.amount1) / Number(amount1);
    return { fraction0, fraction1, ok: fraction0 <= RATIO_MISMATCH_THRESHOLD && fraction1 <= RATIO_MISMATCH_THRESHOLD };
  }

  section("Re-check the ratio against a BRAND-NEW price read right now -- the actual root-cause fix, applied here too");
  let freshSlot0 = await client.readContract({ address: observation.poolAddress, abi: POOL_ABI, functionName: "slot0" });
  console.log(`fresh sqrtPriceX96: ${freshSlot0[0]}, tick: ${freshSlot0[1]}`);

  let check = checkRatio(freshSlot0[0], mintAmount0, mintAmount1);
  console.log(`re-checked stranded fractions (fresh price): token0=${(check.fraction0 * 100).toFixed(3)}%, token1=${(check.fraction1 * 100).toFixed(3)}%`);

  // Bounded, not unlimited: each corrective swap has its OWN price impact (the formula ignores
  // that, by design -- see rebalanceSwap.ts's doc comment), so one swap can overshoot into a
  // small residual imbalance in the OTHER direction, needing a small follow-up. Observed live,
  // this session: 16.257% -> 1.600% in one swap -- clearly convergent, not divergent. A hard cap
  // of 3 attempts still refuses to mint (and refuses to keep swapping) if it somehow doesn't
  // converge, rather than looping indefinitely.
  const MAX_CORRECTIVE_SWAP_ATTEMPTS = 3;
  const correctiveSwaps: Record<string, unknown>[] = [];
  let attempt = ALREADY_SWAPPED_ONCE ? 1 : 0; // count the swap already spent in the previous run toward the same cumulative cap
  while (!check.ok) {
    attempt += 1;
    if (attempt > MAX_CORRECTIVE_SWAP_ATTEMPTS) {
      throw new Error(
        `${MAX_CORRECTIVE_SWAP_ATTEMPTS} corrective swap attempts did not converge below ${RATIO_MISMATCH_THRESHOLD * 100}% (last: ${(check.fraction0 * 100).toFixed(3)}%/${(check.fraction1 * 100).toFixed(3)}%) -- refusing to keep swapping, refusing to mint`,
      );
    }
    section(`CORRECTIVE SWAP attempt ${attempt}/${MAX_CORRECTIVE_SWAP_ATTEMPTS} (using the just-fixed formula) -- re-verified with yet another fresh price before minting`);
    const swapRequirement = computeRebalanceSwapRequirement(mintAmount0, mintAmount1, TARGET_TICK_LOWER, TARGET_TICK_UPPER, freshSlot0[0]);
    console.log(`corrective swap requirement: ${JSON.stringify(bigintsToStrings(swapRequirement))}`);
    if (swapRequirement.direction === "NO_SWAP_REQUIRED") {
      throw new Error("ratio check says a fix is needed but the (fixed) swap calculator found none -- inconsistent, refusing rather than guessing");
    }

    const [tokenIn, tokenOut] = swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1" ? [observation.token0, observation.token1] : [observation.token1, observation.token0];
    const quote = await getLiveSwapQuote({ client, tokenIn, tokenOut, fee: observation.fee, amountIn: swapRequirement.amountIn });
    const amountOutMinimum = (quote.amountOut * BigInt(10_000 - MAX_SLIPPAGE_BPS)) / 10_000n;
    console.log(`live quote: ${swapRequirement.amountIn} in -> ${quote.amountOut} out (amountOutMinimum ${amountOutMinimum})`);

    const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER, swapRequirement.amountIn] });
    const approveTx = await signer.sendAndWait(`approve-swaprouter-corrective-${swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1" ? "token0" : "token1"}`, tokenIn, approveData);

    const swapDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{ tokenIn, tokenOut, fee: observation.fee, recipient: VEYRA_WALLET, deadline: swapDeadline, amountIn: swapRequirement.amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
    });
    const swapTx = await signer.sendAndWait("corrective-ratio-fix-swap", SWAP_ROUTER, swapData);

    const [postSwapBalance0, postSwapBalance1] = await Promise.all([
      client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
      client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [VEYRA_WALLET] }),
    ]);
    // mintAmount0/1 were already DELTA-based (from the predecessor's own correct computation);
    // the swap changes them by exactly its own in/out amounts -- no absolute-balance read needed.
    mintAmount0 = swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1" ? mintAmount0 - swapRequirement.amountIn : mintAmount0 + quote.amountOut;
    mintAmount1 = swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1" ? mintAmount1 + quote.amountOut : mintAmount1 - swapRequirement.amountIn;
    console.log(`post-corrective-swap mint amounts: token0=${mintAmount0}, token1=${mintAmount1}`);

    // Re-read slot0 AGAIN -- this swap also moves price; reusing anything from before it would
    // repeat the exact bug that caused run-0004 to fail in the first place.
    freshSlot0 = await client.readContract({ address: observation.poolAddress, abi: POOL_ABI, functionName: "slot0" });
    console.log(`fresh sqrtPriceX96 after corrective swap: ${freshSlot0[0]}, tick: ${freshSlot0[1]}`);
    check = checkRatio(freshSlot0[0], mintAmount0, mintAmount1);
    console.log(`re-checked stranded fractions (post-corrective-swap, fresh price): token0=${(check.fraction0 * 100).toFixed(3)}%, token1=${(check.fraction1 * 100).toFixed(3)}%`);

    correctiveSwaps.push({
      attempt,
      swapRequirement: bigintsToStrings(swapRequirement),
      quote: bigintsToStrings(quote),
      amountOutMinimum: amountOutMinimum.toString(),
      approveTx,
      swapTx,
      postSwapMintAmount0: mintAmount0.toString(),
      postSwapMintAmount1: mintAmount1.toString(),
      postSwapStrandedFraction0: check.fraction0,
      postSwapStrandedFraction1: check.fraction1,
    });
  }
  console.log(`re-check PASSES against today's price after ${attempt} corrective swap(s) -- safe to proceed to mint`);

  const amount0Min = (mintAmount0 * BigInt(10_000 - MAX_SLIPPAGE_BPS)) / 10_000n;
  const amount1Min = (mintAmount1 * BigInt(10_000 - MAX_SLIPPAGE_BPS)) / 10_000n;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const mintArgs = {
    token0: observation.token0,
    token1: observation.token1,
    fee: observation.fee,
    tickLower: TARGET_TICK_LOWER,
    tickUpper: TARGET_TICK_UPPER,
    amount0Desired: mintAmount0,
    amount1Desired: mintAmount1,
    amount0Min,
    amount1Min,
    recipient: VEYRA_WALLET,
    deadline: BigInt(deadline),
  };
  console.log(`mint args: ${JSON.stringify(bigintsToStrings(mintArgs))}`);

  // The corrective swap changes mintAmount0/1 -- re-check NFPM allowances cover the NEW amounts
  // (the original approve-token0/1 txs from the failed run only covered the OLD, pre-swap
  // amounts) and top up whichever fell short. Never approve less than what's about to be spent.
  const [currentAllowance0, currentAllowance1] = await Promise.all([
    client.readContract({ address: observation.token0, abi: ERC20_ABI, functionName: "allowance", args: [VEYRA_WALLET, NFPM_ADDRESS] }),
    client.readContract({ address: observation.token1, abi: ERC20_ABI, functionName: "allowance", args: [VEYRA_WALLET, NFPM_ADDRESS] }),
  ]);
  if (currentAllowance0 < mintAmount0) {
    const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, mintAmount0] });
    await signer.sendAndWait("approve-token0-topup", observation.token0, approveData);
    console.log(`topped up NFPM token0 allowance to ${mintAmount0}`);
  }
  if (currentAllowance1 < mintAmount1) {
    const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NFPM_ADDRESS, mintAmount1] });
    await signer.sendAndWait("approve-token1-topup", observation.token1, approveData);
    console.log(`topped up NFPM token1 allowance to ${mintAmount1}`);
  }

  section("MINT (pre-flight gas estimate first -- must succeed BEFORE signing anything)");
  const data = encodeFunctionData({ abi: NFPM_ABI, functionName: "mint", args: [mintArgs] });
  const [nonce, gasPriceWei, gasEstimate] = await Promise.all([
    client.getTransactionCount({ address: VEYRA_WALLET, blockTag: "pending" }),
    client.getGasPrice(),
    client.estimateGas({ account: VEYRA_WALLET, to: NFPM_ADDRESS, data, value: 0n }),
  ]);
  const gas = (gasEstimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
  console.log(`gas estimate succeeded (${gasEstimate} units, +20% buffer = ${gas}) -- confirmed correct BEFORE signing`);

  const signed = await walletProvider.signTransaction({ to: NFPM_ADDRESS, data, value: 0n, gas, gasPrice: gasPriceWei, nonce, chainId: CHAIN_ID });
  const hash: Hex = await client.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
  console.log(`mint tx hash: ${hash} -- waiting for receipt...`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`receipt: status=${receipt.status}, block=${receipt.blockNumber}, gasUsed=${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error(`mint transaction reverted (hash ${hash})`);

  section("VERIFY NEW POSITION");
  let newTokenId: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: NFPM_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "IncreaseLiquidity" && log.address.toLowerCase() === NFPM_ADDRESS.toLowerCase()) {
        newTokenId = (decoded.args as { tokenId: bigint }).tokenId;
        break;
      }
    } catch {
      // non-NFPM logs don't decode against NFPM_ABI -- expected, skip
    }
  }
  if (newTokenId === null) throw new Error("mint succeeded but no IncreaseLiquidity event found in its receipt");
  console.log(`new tokenId: ${newTokenId}`);

  const newPositionObservation = await readPositionObservation(client, newTokenId);
  const newOwner = await client.readContract({ address: NFPM_ADDRESS, abi: NFPM_ABI, functionName: "ownerOf", args: [newTokenId] });
  console.log(`ownerOf(${newTokenId}): ${newOwner}`);
  console.log(`range: [${newPositionObservation.tickLower}, ${newPositionObservation.tickUpper})`);
  console.log(`liquidity: ${newPositionObservation.positionLiquidity}`);

  const verified =
    newOwner.toLowerCase() === VEYRA_WALLET.toLowerCase() &&
    newPositionObservation.tickLower === TARGET_TICK_LOWER &&
    newPositionObservation.tickUpper === TARGET_TICK_UPPER &&
    newPositionObservation.fee === observation.fee &&
    newPositionObservation.token0.toLowerCase() === observation.token0.toLowerCase() &&
    newPositionObservation.token1.toLowerCase() === observation.token1.toLowerCase() &&
    newPositionObservation.positionLiquidity > 0n;
  console.log(`VERIFIED: ${verified}`);
  if (!verified) throw new Error("post-mint verification FAILED -- new position parameters do not match the plan");

  const predecessor = JSON.parse(readFileSync(PREDECESSOR_PATH, "utf-8"));
  const contentRecord = {
    kind: "AGENT_ARENA_LOOP_RESUMED_MINT",
    label: "Resume-and-complete run-0004 (v2 evaluator, RangeKeeper winner) after a stale-price ratio-check bug fix. Real, controlled -- not autonomous.",
    generatedAt: new Date().toISOString(),
    network: "bsc-testnet",
    predecessorRunArchiveId: predecessor.runArchiveId,
    predecessorArtifactHash: predecessor.artifactHash,
    rootCause:
      "orchestrator.ts's post-swap ratio-mismatch re-check reused `freshSlot0`, a price read BEFORE the swap executed. A swap moves price by definition -- checking the post-swap ratio against a pre-swap price checked the wrong price entirely, so the 0.7% stranded-fraction result it produced did not reflect what mint() would actually see. Fixed by reading slot0 again after the swap's receipt confirms, before any further ratio math. This script additionally re-verified against a THIRD, brand-new price read (taken now, further after the original failure) before proceeding.",
    veyraAgentId: predecessor.veyraAgentId,
    ownerWallet: VEYRA_WALLET,
    winningProposal: predecessor.winningProposal,
    correctiveSwaps,
    finalStrandedFractionBeforeMint: { token0: check.fraction0, token1: check.fraction1 },
    mintArgs: bigintsToStrings(mintArgs),
    reusedFromPredecessor: {
      decreaseLiquidityTx: predecessor.transactions.find((t: any) => t.step === "decreaseLiquidity"),
      collectTx: predecessor.transactions.find((t: any) => t.step === "collect"),
      approveSwapRouterTx: predecessor.transactions.find((t: any) => t.step.startsWith("approve-swaprouter")),
      swapTx: predecessor.transactions.find((t: any) => t.step === "ratio-fix-swap"),
      approveToken0Tx: predecessor.transactions.find((t: any) => t.step === "approve-token0"),
      approveToken1Tx: predecessor.transactions.find((t: any) => t.step === "approve-token1"),
    },
    mintTx: {
      step: "mint",
      hash,
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: gasPriceWei.toString(),
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
    },
    oldPosition: { tokenId: VEYRA_POSITION_TOKEN_ID.toString() },
    newPosition: { tokenId: newTokenId.toString(), ...(bigintsToStrings(newPositionObservation) as Record<string, unknown>) },
    verified,
    status: "EXECUTED",
  };
  const artifactHash = sha256(JSON.stringify(contentRecord));
  const fullRecord = { artifactHash, ...contentRecord };
  mkdirSync(RUNS_DIR, { recursive: true });
  const outPath = resolve(RUNS_DIR, "run-0004-resumed-mint.json");
  writeFileSync(outPath, JSON.stringify(fullRecord, null, 2));
  console.log(`\nArchived: docs/agent-arena-runs-v2/run-0004-resumed-mint.json`);
  console.log(`artifact hash: ${artifactHash}`);
}

main().catch((err) => {
  console.error("\nResume failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

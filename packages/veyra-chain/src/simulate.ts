// Live simulation layer (Slice 2, the network-touching half). Deliberately separate from
// @veyra/core's simulatePlan() -- that module is pure and must stay that way; THIS module is
// the only place a PublicClient enters the simulation story. Still zero transaction
// submission: estimateContractGas simulates a call as if `account` sent it, without ever
// requiring a private key or a signature.

import type { PublicClient, Address } from "viem";
import { simulatePlan, computeRebalanceSwapRequirement, getLiquidityForAmounts, getAmountsForLiquidity, RATIO_MISMATCH_THRESHOLD, type ExecutionPlan, type PureSimulationResult, type RebalanceSwapRequirement } from "@veyra/core";
import { NFPM_ABI } from "./abis.js";
import { PANCAKE_V3_TESTNET } from "./testnetAddresses.js";
import { getLiveSwapQuote } from "./rebalanceQuote.js";

export type LiveCheckStatus = "VALID" | "INVALID" | "NOT_ATTEMPTED";

export interface LiveStepCheck {
  status: LiveCheckStatus;
  detail: string;
  gasEstimateWei?: bigint;
}

export interface RatioFixLiveCheck {
  status: LiveCheckStatus; // NOT_ATTEMPTED when no fix was needed at all; VALID only when a REAL quote projects clearing the threshold
  detail: string;
  swapRequirement?: RebalanceSwapRequirement; // the pure, pre-quote estimate
  realQuoteAmountOut?: bigint;
  realQuoteGasEstimateWei?: bigint;
  projectedAmount0AfterRealSwap?: bigint;
  projectedAmount1AfterRealSwap?: bigint;
  projectedStrandedFraction0AfterRealSwap?: number;
  projectedStrandedFraction1AfterRealSwap?: number;
}

export interface LiveSimulationResult extends PureSimulationResult {
  decreaseLiquidityLive: LiveStepCheck;
  collectLive: LiveStepCheck;
  ratioFixLive: RatioFixLiveCheck;
  mintLive: LiveStepCheck; // always NOT_ATTEMPTED this slice -- see the detail string for why
  liveGasEstimateWei: bigint | null; // decrease+collect only; null unless BOTH succeeded live
  // Final verdict: the pure layer's NON-ratio checks ANDed with the live layer's (decrease,
  // collect, AND the ratio-fix's real quote). A pure check can never be overridden back to true
  // by a live success -- except the ratio-fix specifically, which is the ONE thing the live
  // layer is authoritative over (the pure layer only knows "not implemented," never "a swap
  // would fix this," since it has no quote to check that claim against).
  executable: boolean;
  executableReasons: string[];
}

async function tryEstimateGas(fn: () => Promise<bigint>, gasPriceWei: bigint): Promise<LiveStepCheck> {
  try {
    const gasUnits = await fn();
    return {
      status: "VALID",
      detail: "live eth_estimateGas succeeded against current BSC testnet chain state",
      gasEstimateWei: gasUnits * gasPriceWei,
    };
  } catch (err) {
    return {
      status: "INVALID",
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
    };
  }
}

export interface SimulateLiveOpts {
  client: PublicClient;
  plan: ExecutionPlan;
  currentSqrtPriceX96: bigint;
  tickSpacing: number;
  account: Address; // the wallet that would eventually sign -- no private key needed here
  nfpmAddress?: Address;
}

export async function simulateLive(opts: SimulateLiveOpts): Promise<LiveSimulationResult> {
  const pure = simulatePlan({ plan: opts.plan, currentSqrtPriceX96: opts.currentSqrtPriceX96, tickSpacing: opts.tickSpacing });
  const nfpm = opts.nfpmAddress ?? (PANCAKE_V3_TESTNET.nonfungiblePositionManager as Address);

  const notApplicable = (): LiveStepCheck => ({ status: "NOT_ATTEMPTED", detail: "hold requires no transaction" });

  if (opts.plan.targetRange === null) {
    return {
      ...pure,
      decreaseLiquidityLive: notApplicable(),
      collectLive: notApplicable(),
      ratioFixLive: { status: "NOT_ATTEMPTED", detail: "hold requires no transaction" },
      mintLive: notApplicable(),
      liveGasEstimateWei: null,
      executable: pure.pureExecutable,
      executableReasons: pure.pureExecutableReasons,
    };
  }

  const decreaseStep = opts.plan.steps.find((s) => s.kind === "decreaseLiquidity");
  const collectStep = opts.plan.steps.find((s) => s.kind === "collect");
  if (!decreaseStep || decreaseStep.kind !== "decreaseLiquidity" || !collectStep || collectStep.kind !== "collect") {
    throw new Error("a rebalance ExecutionPlan must contain decreaseLiquidity and collect steps");
  }

  const gasPriceWei = await opts.client.getGasPrice();

  const decreaseLiquidityLive = await tryEstimateGas(
    () =>
      opts.client.estimateContractGas({
        address: nfpm,
        abi: NFPM_ABI,
        functionName: "decreaseLiquidity",
        args: [
          {
            tokenId: BigInt(decreaseStep.tokenId),
            liquidity: decreaseStep.liquidity,
            amount0Min: decreaseStep.amount0Min,
            amount1Min: decreaseStep.amount1Min,
            deadline: BigInt(decreaseStep.deadline),
          },
        ],
        account: opts.account,
      }),
    gasPriceWei,
  );

  const collectLive = await tryEstimateGas(
    () =>
      opts.client.estimateContractGas({
        address: nfpm,
        abi: NFPM_ABI,
        functionName: "collect",
        args: [
          {
            tokenId: BigInt(collectStep.tokenId),
            recipient: collectStep.recipient as Address,
            amount0Max: collectStep.amount0Max,
            amount1Max: collectStep.amount1Max,
          },
        ],
        account: opts.account,
      }),
    gasPriceWei,
  );

  // Deliberately NOT attempted: mint's real gas/validity depends on token0/token1 balances and
  // an NFPM ERC20 approval that only exist AFTER decreaseLiquidity+collect actually run.
  // Simulating it right now, against the wallet's CURRENT (pre-decrease) balances, would test
  // the wrong precondition and could produce a misleadingly INVALID or misleadingly VALID
  // result. Honest boundary, not a shortcut -- see the architecture note in execution.ts.
  const mintLive: LiveStepCheck = {
    status: "NOT_ATTEMPTED",
    detail:
      "mint's gas/validity depends on token balances and an NFPM approval that only exist after decreaseLiquidity + collect actually execute -- not simulatable against current pre-decrease wallet state without a state-override eth_call (not attempted this slice).",
  };

  // The ratio-fix check is the ONE place a live result may lift a pure-layer block: the pure
  // simulatePlan() only knows "no swap is implemented," never "a real swap would fix this" --
  // it has no quote to check that claim against. This block gets a REAL QuoterV2 quote and
  // recomputes the SAME stranded-fraction math simulatePlan() uses, against the REAL quoted
  // output -- never against the pure, fee-free estimate.
  let ratioFixLive: RatioFixLiveCheck;
  if (!pure.ratioAdjustment.ratioFixRequired) {
    ratioFixLive = { status: "NOT_ATTEMPTED", detail: "no ratio-fixing swap is needed for this plan" };
  } else {
    const mintStep = opts.plan.steps.find((s) => s.kind === "mint");
    if (!mintStep || mintStep.kind !== "mint") {
      throw new Error("a rebalance ExecutionPlan with a ratio mismatch must contain a mint step");
    }
    const swapRequirement = computeRebalanceSwapRequirement(
      opts.plan.expectedAmounts.amount0,
      opts.plan.expectedAmounts.amount1,
      opts.plan.targetRange.tickLower,
      opts.plan.targetRange.tickUpper,
      opts.currentSqrtPriceX96,
    );
    if (swapRequirement.direction === "NO_SWAP_REQUIRED") {
      ratioFixLive = {
        status: "INVALID",
        detail: "pure ratio check says a fix is required but the swap calculator found none needed -- inconsistent, refusing rather than guessing",
        swapRequirement,
      };
    } else {
      const [tokenIn, tokenOut] =
        swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1" ? [mintStep.token0, mintStep.token1] : [mintStep.token1, mintStep.token0];
      try {
        const quote = await getLiveSwapQuote({ client: opts.client, tokenIn: tokenIn as Address, tokenOut: tokenOut as Address, fee: mintStep.fee, amountIn: swapRequirement.amountIn });

        const projected0 =
          swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1"
            ? opts.plan.expectedAmounts.amount0 - swapRequirement.amountIn
            : opts.plan.expectedAmounts.amount0 + quote.amountOut;
        const projected1 =
          swapRequirement.direction === "SWAP_TOKEN0_FOR_TOKEN1"
            ? opts.plan.expectedAmounts.amount1 + quote.amountOut
            : opts.plan.expectedAmounts.amount1 - swapRequirement.amountIn;

        const achievableLiquidity = getLiquidityForAmounts(opts.currentSqrtPriceX96, opts.plan.targetRange.tickLower, opts.plan.targetRange.tickUpper, projected0, projected1);
        const consumed = getAmountsForLiquidity(opts.currentSqrtPriceX96, opts.plan.targetRange.tickLower, opts.plan.targetRange.tickUpper, achievableLiquidity);
        const fraction0 = projected0 === 0n ? 0 : Number(projected0 - consumed.amount0) / Number(projected0);
        const fraction1 = projected1 === 0n ? 0 : Number(projected1 - consumed.amount1) / Number(projected1);
        const clears = fraction0 <= RATIO_MISMATCH_THRESHOLD && fraction1 <= RATIO_MISMATCH_THRESHOLD;

        ratioFixLive = {
          status: clears ? "VALID" : "INVALID",
          detail: clears
            ? `real quote (${quote.amountOut} out for ${swapRequirement.amountIn} in) projects clearing the ratio-mismatch threshold`
            : `even with a real quote, the projected post-swap ratio still strands ~${(fraction0 * 100).toFixed(1)}%/${(fraction1 * 100).toFixed(1)}% (token0/token1) -- refusing rather than minting anyway`,
          swapRequirement,
          realQuoteAmountOut: quote.amountOut,
          realQuoteGasEstimateWei: quote.gasEstimate,
          projectedAmount0AfterRealSwap: projected0,
          projectedAmount1AfterRealSwap: projected1,
          projectedStrandedFraction0AfterRealSwap: fraction0,
          projectedStrandedFraction1AfterRealSwap: fraction1,
        };
      } catch (err) {
        ratioFixLive = {
          status: "INVALID",
          detail: `live QuoterV2 quote failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
          swapRequirement,
        };
      }
    }
  }

  // Reconstruct the pure layer's NON-ratio blockers directly from its structured fields (never
  // by string-matching pureExecutableReasons) -- the ratio-fix verdict above is what supersedes
  // simulatePlan()'s own, always-true "not implemented" statement about that ONE specific check.
  const nonRatioPureBlockers: string[] = [];
  if (pure.targetRangeValidity.status === "INVALID") nonRatioPureBlockers.push(`target range invalid: ${pure.targetRangeValidity.detail}`);
  if (pure.mintStructuralValidity.status === "INVALID") nonRatioPureBlockers.push(`mint structurally invalid: ${pure.mintStructuralValidity.detail}`);
  if (pure.slippageProtection.status === "INVALID") nonRatioPureBlockers.push(`slippage protection missing: ${pure.slippageProtection.detail}`);
  if (!opts.plan.feasible) nonRatioPureBlockers.push(...opts.plan.feasibilityReasons);

  const ratioOk = ratioFixLive.status !== "INVALID";

  const executableReasons = [...nonRatioPureBlockers];
  if (!ratioOk) executableReasons.push(`ratio-fixing swap check failed: ${ratioFixLive.detail}`);
  if (decreaseLiquidityLive.status === "INVALID") {
    executableReasons.push(`live decreaseLiquidity simulation failed: ${decreaseLiquidityLive.detail}`);
  }
  if (collectLive.status === "INVALID") {
    executableReasons.push(`live collect simulation failed: ${collectLive.detail}`);
  }

  const liveGasEstimateWei =
    decreaseLiquidityLive.gasEstimateWei !== undefined && collectLive.gasEstimateWei !== undefined
      ? decreaseLiquidityLive.gasEstimateWei + collectLive.gasEstimateWei
      : null;

  return {
    ...pure,
    decreaseLiquidityLive,
    collectLive,
    ratioFixLive,
    mintLive,
    liveGasEstimateWei,
    executable: nonRatioPureBlockers.length === 0 && ratioOk && decreaseLiquidityLive.status !== "INVALID" && collectLive.status !== "INVALID",
    executableReasons,
  };
}

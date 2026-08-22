// Live simulation layer (Slice 2, the network-touching half). Deliberately separate from
// @veyra/core's simulatePlan() -- that module is pure and must stay that way; THIS module is
// the only place a PublicClient enters the simulation story. Still zero transaction
// submission: estimateContractGas simulates a call as if `account` sent it, without ever
// requiring a private key or a signature.

import type { PublicClient, Address } from "viem";
import { simulatePlan, type ExecutionPlan, type PureSimulationResult } from "@veyra/core";
import { NFPM_ABI } from "./abis.js";
import { PANCAKE_V3_TESTNET } from "./testnetAddresses.js";

export type LiveCheckStatus = "VALID" | "INVALID" | "NOT_ATTEMPTED";

export interface LiveStepCheck {
  status: LiveCheckStatus;
  detail: string;
  gasEstimateWei?: bigint;
}

export interface LiveSimulationResult extends PureSimulationResult {
  decreaseLiquidityLive: LiveStepCheck;
  collectLive: LiveStepCheck;
  mintLive: LiveStepCheck; // always NOT_ATTEMPTED this slice -- see the detail string for why
  liveGasEstimateWei: bigint | null; // decrease+collect only; null unless BOTH succeeded live
  // Final verdict: the pure layer's executable ANDed with the live layer's. A pure check can
  // never be overridden back to true by a live success -- only further restricted.
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

  const executableReasons = [...pure.pureExecutableReasons];
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
    mintLive,
    liveGasEstimateWei,
    executable: pure.pureExecutable && decreaseLiquidityLive.status !== "INVALID" && collectLive.status !== "INVALID",
    executableReasons,
  };
}

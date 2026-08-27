// Grid Trading's LIVE simulation layer -- the piece simulationGrid.ts (pure-only) was missing.
// Reuses simulate.ts's `simulateLive` unmodified, once per slot: that's the layer that gets a
// REAL QuoterV2 quote and supersedes the pure layer's always-true "ratio-fixing swap not
// implemented" blocker with an actual live check, exactly the way the single-position path
// already does. Without this, any grid slot that needs a ratio-fixing swap (which is most real
// rebalances, since a recentered range rarely matches the held token ratio) would be
// permanently unexecutable -- not a simplification, a real correctness gap, found by actually
// running this for real rather than assumed away.

import type { PublicClient, Address } from "viem";
import { simulateLive, type LiveSimulationResult } from "./simulate.js";
import type { GridExecutionPlan } from "@veyra/core";

export interface GridSlotLiveSimulationResult {
  slotIndex: number;
  result: LiveSimulationResult;
}

export interface GridLiveSimulationResult {
  jobId: string;
  candidateId: string;
  slotResults: GridSlotLiveSimulationResult[];
  executable: boolean;
  executableReasons: string[];
}

export interface SimulateGridPlanLiveOpts {
  client: PublicClient;
  plan: GridExecutionPlan;
  currentSqrtPriceX96: bigint;
  tickSpacing: number;
  account: Address;
}

export async function simulateGridPlanLive(opts: SimulateGridPlanLiveOpts): Promise<GridLiveSimulationResult> {
  const { plan, currentSqrtPriceX96, tickSpacing, account, client } = opts;

  const slotResults: GridSlotLiveSimulationResult[] = await Promise.all(
    plan.slotPlans.map(async ({ slotIndex, plan: slotPlan }) => ({
      slotIndex,
      result: await simulateLive({ client, plan: slotPlan, currentSqrtPriceX96, tickSpacing, account }),
    })),
  );

  const executableReasons = slotResults
    .filter((sr) => !sr.result.executable)
    .flatMap((sr) => sr.result.executableReasons.map((r) => `slot ${sr.slotIndex}: ${r}`));

  if (!plan.feasible) executableReasons.push(...plan.feasibilityReasons);

  return {
    jobId: plan.jobId,
    candidateId: plan.candidateId,
    slotResults,
    executable: executableReasons.length === 0,
    executableReasons,
  };
}

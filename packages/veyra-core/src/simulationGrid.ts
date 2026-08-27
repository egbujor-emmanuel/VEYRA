// Grid Trading simulation. Reuses simulation.ts's `simulatePlan` unmodified, once per slot plan,
// then aggregates -- the whole grid plan is pureExecutable only if EVERY slot's plan is.

import { simulatePlan, type PureSimulationResult } from "./simulation.js";
import type { GridExecutionPlan } from "./executionGrid.js";

export interface GridSlotSimulationResult {
  slotIndex: number;
  result: PureSimulationResult;
}

export interface GridSimulationResult {
  jobId: string;
  candidateId: string;
  slotResults: GridSlotSimulationResult[];
  pureExecutable: boolean;
  pureExecutableReasons: string[];
  status: "SIMULATED";
}

export interface SimulateGridPlanOpts {
  plan: GridExecutionPlan;
  /** Current sqrtPriceX96 for the ONE pool every slot lives on, and its tickSpacing. */
  currentSqrtPriceX96: bigint;
  tickSpacing: number;
}

export function simulateGridPlan(opts: SimulateGridPlanOpts): GridSimulationResult {
  const { plan, currentSqrtPriceX96, tickSpacing } = opts;

  const slotResults: GridSlotSimulationResult[] = plan.slotPlans.map(({ slotIndex, plan: slotPlan }) => ({
    slotIndex,
    result: simulatePlan({ plan: slotPlan, currentSqrtPriceX96, tickSpacing }),
  }));

  const pureExecutableReasons = slotResults
    .filter((sr) => !sr.result.pureExecutable)
    .flatMap((sr) => sr.result.pureExecutableReasons.map((r) => `slot ${sr.slotIndex}: ${r}`));

  if (!plan.feasible) pureExecutableReasons.push(...plan.feasibilityReasons);

  return {
    jobId: plan.jobId,
    candidateId: plan.candidateId,
    slotResults,
    pureExecutable: pureExecutableReasons.length === 0,
    pureExecutableReasons,
    status: "SIMULATED",
  };
}

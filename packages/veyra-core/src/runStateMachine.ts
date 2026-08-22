// Formal run state machine (architecture doc's Slice 4): every arena-to-execution run is a
// sequence of explicit states with explicit transitions, not just "a script that runs
// functions in order." Invalid transitions throw immediately rather than silently happening --
// e.g. nothing can jump straight from OBSERVE to EXECUTED. Every terminal failure state
// requires a reason string; nothing fails silently.

export type RunState =
  | "OBSERVE"
  | "EVALUATE"
  | "PLAN"
  | "SIMULATE"
  | "HOLD" // terminal: the arena's winner was hold -- nothing to execute, not a failure
  | "EXECUTION_BLOCKED" // terminal: simulation.executable was false
  | "DECREASE_PENDING"
  | "DECREASE_FAILED" // terminal
  | "COLLECT_PENDING"
  | "COLLECT_FAILED" // terminal
  | "MINT_PENDING"
  | "MINT_FAILED" // terminal
  | "VERIFYING"
  | "VERIFICATION_FAILED" // terminal
  | "EXECUTED" // terminal: success
  | "ARCHIVED"; // terminal: the record has been written -- the true end of every run

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "HOLD",
  "EXECUTION_BLOCKED",
  "DECREASE_FAILED",
  "COLLECT_FAILED",
  "MINT_FAILED",
  "VERIFICATION_FAILED",
  "EXECUTED",
  "ARCHIVED",
]);

export const FAILURE_STATES: ReadonlySet<RunState> = new Set([
  "EXECUTION_BLOCKED",
  "DECREASE_FAILED",
  "COLLECT_FAILED",
  "MINT_FAILED",
  "VERIFICATION_FAILED",
]);

/** The only state each key is allowed to transition to. Anything not listed here is rejected. */
export const VALID_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  OBSERVE: ["EVALUATE"],
  EVALUATE: ["PLAN"],
  PLAN: ["SIMULATE"],
  SIMULATE: ["HOLD", "EXECUTION_BLOCKED", "DECREASE_PENDING"],
  HOLD: ["ARCHIVED"],
  EXECUTION_BLOCKED: ["ARCHIVED"],
  DECREASE_PENDING: ["DECREASE_FAILED", "COLLECT_PENDING"],
  DECREASE_FAILED: ["ARCHIVED"],
  COLLECT_PENDING: ["COLLECT_FAILED", "MINT_PENDING"],
  COLLECT_FAILED: ["ARCHIVED"],
  MINT_PENDING: ["MINT_FAILED", "VERIFYING"],
  MINT_FAILED: ["ARCHIVED"],
  VERIFYING: ["VERIFICATION_FAILED", "EXECUTED"],
  VERIFICATION_FAILED: ["ARCHIVED"],
  EXECUTED: ["ARCHIVED"],
  ARCHIVED: [],
};

export interface StateTransition {
  from: RunState;
  to: RunState;
  timestamp: string;
  reason?: string; // REQUIRED (enforced below) for every transition into a failure state
}

export interface RunRecord {
  runId: string;
  transitions: readonly StateTransition[];
  currentState: RunState;
}

export function createRun(runId: string): RunRecord {
  return { runId, transitions: [], currentState: "OBSERVE" };
}

/**
 * @throws if `to` is not a valid transition from the run's current state, or if `to` is a
 * failure state and no `reason` was given. Returns a NEW RunRecord -- the input is never
 * mutated, so a rejected transition can never have partially applied.
 */
export function transition(run: RunRecord, to: RunState, reason?: string): RunRecord {
  const allowed = VALID_TRANSITIONS[run.currentState];
  if (!allowed.includes(to)) {
    throw new Error(`invalid transition: ${run.currentState} -> ${to} (allowed from ${run.currentState}: ${allowed.join(", ") || "none, this is terminal"})`);
  }
  if (FAILURE_STATES.has(to) && !reason) {
    throw new Error(`transition to failure state ${to} requires a reason -- nothing may fail silently`);
  }

  const record: StateTransition = { from: run.currentState, to, timestamp: new Date().toISOString(), ...(reason ? { reason } : {}) };
  return { runId: run.runId, transitions: [...run.transitions, record], currentState: to };
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isFailure(state: RunState): boolean {
  return FAILURE_STATES.has(state);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun, transition, isTerminal, isFailure } from "../src/index.js";

test("a fresh run starts in OBSERVE with no transitions", () => {
  const run = createRun("run-1");
  assert.equal(run.currentState, "OBSERVE");
  assert.deepEqual(run.transitions, []);
  assert.equal(isTerminal(run.currentState), false);
});

test("the happy-path HOLD run: OBSERVE -> EVALUATE -> PLAN -> SIMULATE -> HOLD -> ARCHIVED", () => {
  let run = createRun("run-hold");
  run = transition(run, "EVALUATE");
  run = transition(run, "PLAN");
  run = transition(run, "SIMULATE");
  run = transition(run, "HOLD"); // hold is not a failure -- no reason required
  assert.equal(run.currentState, "HOLD");
  assert.equal(isTerminal(run.currentState), true);
  assert.equal(isFailure(run.currentState), false);

  run = transition(run, "ARCHIVED");
  assert.equal(run.currentState, "ARCHIVED");
  assert.equal(run.transitions.length, 5);
});

test("the happy-path EXECUTED run: full sequence through DECREASE/COLLECT/MINT/VERIFYING to EXECUTED", () => {
  let run = createRun("run-executed");
  run = transition(run, "EVALUATE");
  run = transition(run, "PLAN");
  run = transition(run, "SIMULATE");
  run = transition(run, "DECREASE_PENDING");
  run = transition(run, "COLLECT_PENDING");
  run = transition(run, "MINT_PENDING");
  run = transition(run, "VERIFYING");
  run = transition(run, "EXECUTED");
  assert.equal(run.currentState, "EXECUTED");
  assert.equal(isFailure(run.currentState), false);
  run = transition(run, "ARCHIVED");
  assert.equal(run.currentState, "ARCHIVED");
});

test("every failure state requires an explicit reason -- nothing fails silently", () => {
  let run = createRun("run-blocked");
  run = transition(run, "EVALUATE");
  run = transition(run, "PLAN");
  run = transition(run, "SIMULATE");
  assert.throws(() => transition(run, "EXECUTION_BLOCKED"), /requires a reason/);

  const withReason = transition(run, "EXECUTION_BLOCKED", "ratio-fixing swap required but not implemented");
  assert.equal(withReason.currentState, "EXECUTION_BLOCKED");
  assert.equal(withReason.transitions.at(-1)!.reason, "ratio-fixing swap required but not implemented");
});

test("DECREASE_FAILED / COLLECT_FAILED / MINT_FAILED / VERIFICATION_FAILED are all reachable and all terminal failure states", () => {
  for (const failureState of ["DECREASE_FAILED", "COLLECT_FAILED", "MINT_FAILED", "VERIFICATION_FAILED"] as const) {
    let run = createRun(`run-${failureState}`);
    run = transition(run, "EVALUATE");
    run = transition(run, "PLAN");
    run = transition(run, "SIMULATE");
    run = transition(run, "DECREASE_PENDING");
    if (failureState === "DECREASE_FAILED") {
      run = transition(run, "DECREASE_FAILED", "transaction reverted");
    } else {
      run = transition(run, "COLLECT_PENDING");
      if (failureState === "COLLECT_FAILED") {
        run = transition(run, "COLLECT_FAILED", "transaction reverted");
      } else {
        run = transition(run, "MINT_PENDING");
        if (failureState === "MINT_FAILED") {
          run = transition(run, "MINT_FAILED", "transaction reverted");
        } else {
          run = transition(run, "VERIFYING");
          run = transition(run, "VERIFICATION_FAILED", "post-mint parameters did not match the plan");
        }
      }
    }
    assert.equal(run.currentState, failureState);
    assert.equal(isTerminal(run.currentState), true);
    assert.equal(isFailure(run.currentState), true);
  }
});

test("invalid transitions are rejected -- cannot skip states", () => {
  const run = createRun("run-invalid");
  assert.throws(() => transition(run, "EXECUTED"), /invalid transition/);
  assert.throws(() => transition(run, "MINT_PENDING"), /invalid transition/);
  assert.throws(() => transition(run, "ARCHIVED"), /invalid transition/);
});

test("ARCHIVED has no further valid transitions -- it is the true end of every run", () => {
  let run = createRun("run-terminal");
  run = transition(run, "EVALUATE");
  run = transition(run, "PLAN");
  run = transition(run, "SIMULATE");
  run = transition(run, "HOLD");
  run = transition(run, "ARCHIVED");
  assert.throws(() => transition(run, "OBSERVE"), /invalid transition/);
  assert.throws(() => transition(run, "EXECUTED"), /invalid transition/);
});

test("transition() never mutates the input record", () => {
  const run = createRun("run-immutable");
  const before = JSON.stringify(run);
  transition(run, "EVALUATE");
  assert.equal(JSON.stringify(run), before, "the original run record must be unchanged after calling transition()");
});

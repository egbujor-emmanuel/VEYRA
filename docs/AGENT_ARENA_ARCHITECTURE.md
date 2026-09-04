# Agent Arena — Competition Loop Architecture

**Status:** Pre-implementation design. Grounded entirely in verified findings from `RECON_REPORT.md` §1–22 — no re-litigation of stack choice (TS/Node, per §15 Option A), security model (Altana session as the real enforcement boundary, per §13), or data tiering (SOURCE/DERIVED/USER-GENERATED, per §11). This document extends those decisions to cover one thing: the smallest credible end-to-end "job → candidates → evaluator → execution → track record" loop.

**Scope decision, stated once:** this loop is built for the **Rebalancing** category only. The same shared core is architected to extend to Grid Trading / Yield Optimisation / Health Factor Monitoring later (different `StrategyFn`s and read logic over the same job/evaluation/execution skeleton) — but building those is explicitly deferred (§9).

**Naming (product decision, locked):** the public-facing product is **VEYRA** — *"The intelligence layer for autonomous finance."* This file keeps its internal filename; only the vocabulary below is binding on code/UI/pitch:

| Term | Refers to |
|---|---|
| **VEYRA** | the platform as a whole |
| **VEYRA Core** | the evaluation/orchestration engine — the job → candidates → evaluator → execution loop described in this document |
| **VEYRA Agent** | our one real ERC-8004-registered agent ("RangeKeeper" is its internal/display name) — never called just "the agent" in UI copy, to keep it visually distinct from baselines |
| **Job** | what §1 calls `JobSpec` |
| **Strategy** | what §2 calls a candidate / `StrategyProposal` |
| **Baseline** | a `StrategyProposal` with `displayLabel: "Baseline Strategy"` — never implied to be an independent third party |
| **Track Record** | the §4 `track_record` table, surfaced as "Verified Track Record" in UI |

Use these names in all code identifiers, UI copy, and pitch materials going forward — "Agent Arena" stays as this document's internal working title only.

---

## 1. Job Schema

A `Job` is "manage this specific PancakeSwap V3 position within these constraints." Tracked in our own Postgres table (per §15's architecture) — **not** funded through the on-chain ERC-8183 escrow contract for MVP (see §6 for why, and §9 for the deferred stretch path).

```ts
interface JobSpec {
  jobId: string;                 // our own uuid
  createdAt: string;              // ISO timestamp
  ownerWallet: string;             // the wallet the position belongs to (client role, ERC-8183 terms)
  category: "rebalance";           // MVP: only value. Field exists so grid/yield/health-factor slot in later without a schema change.
  target: {
    protocol: "pancakeswap-v3";
    network: "bsc-testnet";
    positionTokenId: number;       // existing NonfungiblePositionManager tokenId — MVP always manages an existing position, never "deploy fresh capital"
  };
  constraints: {
    maxSpendWei: string;           // mirrors the Altana session spend cap (§6) — evaluator must treat any proposal exceeding this as infeasible
    maxSlippageBps: number;
    riskTolerance: "low" | "medium" | "high"; // the only lever that's allowed to shift scoring weights (§3)
    deadlineSeconds: number;        // evaluation + execution must complete inside this window
  };
  budget: {
    currency: "U";                  // testnet 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565 (RECON §22)
    amountWei: string;               // informational for MVP — see §6 on why this isn't a real ERC-8183 escrow yet
  };
  status: "open" | "evaluating" | "awarded" | "executing" | "completed" | "failed" | "expired";
  erc8183JobId: string | null;      // always null in MVP; reserved for the deferred on-chain-escrow path (§9)
}
```

---

## 2. Candidate / Strategy Interface

Every competitor — real or baseline — implements one interface. This is what makes the "competition" mechanically fair and honest: same inputs in, same shape out, regardless of which candidate produced it.

```ts
type CandidateLabel = "Our Agent" | "Baseline Strategy" | "Reference Strategy";

interface StrategyProposal {
  candidateId: string;             // "rangekeeper-v1" | "baseline-hold" | "baseline-symmetric-range"
  displayLabel: CandidateLabel;     // rendered verbatim in the UI — never implies an independent third party
  agentIdOnChain: number | null;    // ERC-8004 agentId — populated ONLY for "Our Agent"; null for baselines (§5)
  proposedAction: RebalanceAction | HoldAction;
  rationale: string;                 // natural-language summary — an LLM may write this sentence, but never originate the numbers inside it (§11 rule: LLM summarizes DERIVED data, never produces it)
  inputsUsed: EvaluationInputs;      // exact snapshot of what this candidate saw — logged verbatim as evidence
}

type RebalanceAction = { kind: "rebalance"; newRange: { tickLower: number; tickUpper: number }; estimatedGasWei: string };
type HoldAction = { kind: "hold" };

type StrategyFn = (job: JobSpec, inputs: EvaluationInputs) => Promise<StrategyProposal>;
```

**MVP ships exactly three `StrategyFn`s:**

1. **`rangeKeeperStrategy`** → `displayLabel: "Our Agent"`, `agentIdOnChain` = our real registered ERC-8004 agentId. Deterministic range-width logic informed by recent price volatility, centered on current tick. This is the only candidate backed by a real on-chain identity.
2. **`baselineHoldStrategy`** → `displayLabel: "Baseline Strategy"`. Always proposes `{kind: "hold"}`. A legitimate, honest comparison point — sometimes it should win, and if it does, that's a demo strength (proves the evaluator isn't rigged), not a failure.
3. **`baselineSymmetricRangeStrategy`** → `displayLabel: "Baseline Strategy"`. Naive fixed-width symmetric range around current price, no volatility awareness. Deterministic, no LLM involved at all.

**Implementation refinement (made while coding, not a re-open):** a `StrategyFn` returns only `{candidateId, displayLabel, agentIdOnChain, proposedAction, rationale}` — it does **not** self-report `inputsUsed`/metrics. The evaluator (§3) computes fee-efficiency, gas, slippage, and risk for every proposal itself, from the same formulas, off a shared `MarketSnapshot` handed identically to all candidates. This is what "common evaluator" in the original instruction actually requires: no candidate grades its own homework.

No candidate is sourced from the ERC-8004 registry. RECON §22 found that registry dominated by test/placeholder junk on testnet (1,749 entries, sampled ones like `"My Testnet Agent 02"` and raw `"user-8abd198e"` strings) — not a reliable source of genuine competitors. Labeling baselines honestly is the correct choice, not a fallback.

---

## 3. Evaluation Inputs and Scoring Formula

### Inputs (every field tagged SOURCE or DERIVED, per §11's tiering rule)

| Field | Tier | Source |
|---|---|---|
| `currentTick`, `currentSqrtPriceX96` | SOURCE | `pool.slot0()` |
| `currentRange`, `currentLiquidity` | SOURCE | `NonfungiblePositionManager.positions(tokenId)` |
| `recentVolatility` | DERIVED | our own short polling window of pool price (testnet pools won't have deep history — see §7 labeling requirement) |
| `estimatedFeeEfficiency` (for a *proposed* range) | DERIVED | our own deterministic concentrated-liquidity formula — **not a historical backtest**, see §7 |
| `estimatedGasWei` | SOURCE | live gas estimate from the RPC provider |
| `estimatedSlippageBps` (if the rebalance requires a swap leg to fix token ratio) | DERIVED | computed from current pool liquidity depth |
| `executionFeasible` | DERIVED | `1` if the proposal fits inside `job.constraints` (spend cap, slippage bound), else `0` |

### v1 scoring formula — explicitly simple, explicitly labeled

Per the user's instruction and RECON §12/§20: **no invented precision-looking weights.** Equal weighting across four components, normalized 0–100 by min-max **within the candidate set for that job** (a relative ranking for this job's specific conditions, not a cross-job absolute score):

```
score = 0.25 × normalized(estimatedFeeEfficiency)
      + 0.25 × normalized(inverseRiskScore)       // narrower range = more IL/rebalance risk = lower score
      + 0.25 × normalized(inverseGasCost)
      + 0.25 × normalized(executionFeasible)       // 0 or 100, hard-gates infeasible proposals to the bottom
```

- `HoldAction` proposals are scored on the *current* position's own metrics (no fee-efficiency delta assumed, full feasibility, current range's own risk score) — a neutral baseline, not artificially penalized for "doing nothing."
- **The only permitted weight deviation:** if `job.constraints.riskTolerance === "low"`, shift to `0.40 × risk, 0.10 × feeEfficiency, 0.25 × gas, 0.25 × feasibility`. One documented rule, applied identically every time — not a per-job invented number.
- Winner = highest total score. Ties broken by lowest `estimatedGasWei`.
- **Observed limitation (rounds 2-7, real archives).** When score *and* gas both tie, the reduce keeps
  the first-listed candidate — which is ours. In rounds 2-7 `rangekeeper-v1` and
  `baseline-symmetric-range` both scored 75 on identical gas, so evaluation order decided every one
  of those rounds; in round 1 `baseline-hold` outscored ours 100-75. Our strategy has therefore never
  outscored a baseline under this formula. That is a fact about the axes (they cannot separate a
  tick-aware range from a naive symmetric one at the same width and gas), not about the run records.
  `scoreProposals` now sets `wonByTiebreak` on such a winner, and the Arena History page labels those
  rounds "tied - order decided" rather than counting them as wins.
- Every score, every component, every input is persisted (§4) — "why Agent B won" is always a query away, never a re-derived guess.

Label this in the UI, verbatim: **"v1 scoring — equal-weighted, deterministic, no historical backtest data yet."** That sentence is doing real work: it pre-empts the exact criticism a judge would otherwise raise.

---

## 4. Track-Record Data Model

Extends §11's `AgentExecution`/`AgentPerformance` tables, scoped to this loop. Four tables:

```
jobs                 — JobSpec fields as-is, + status history timestamps
strategy_proposals    — jobId FK, candidateId, displayLabel, agentIdOnChain (nullable),
                        proposedAction (json), inputsUsed (json), rationale (text),
                        scoreBreakdown (json — all 4 components + weights used), totalScore, isWinner, createdAt
executions            — jobId FK, winningCandidateId FK, txHashes (text[]), onchainStatus,
                        startedAt, completedAt, actualGasWei, actualResultingRange, outcome
track_record           — agentIdOnChain FK (NOT NULL — see below), jobsWon, jobsCompleted,
                        jobsFailed, avgScoreWhenWon, totalCapitalManagedWei, lastUpdatedAt
```

**Design rule, deliberate:** `track_record` is keyed to `agentIdOnChain` and only real ERC-8004-registered agents get a row. Baselines never accumulate a track record — structurally, not by convention — because reputation is an identity-linked concept (§5) and baselines hold no identity. This one constraint is what keeps "Verified Track Record" honest: there is no code path that lets a baseline's numbers grow.

`track_record` is 100% DERIVED, computed only by replaying our own `executions` table. **Never seeded with synthetic history.** If the real count on demo day is "3 jobs completed," the UI shows 3 — per the user's explicit instruction, no manufactured "184 jobs" backfill.

---

## 5. ERC-8004 Identity Linkage

- Register **one** real agent ("RangeKeeper") via `@bnbagent/sdk`'s `ERC8004Agent.register_agent()` (TS build, per §15) against the BSC testnet registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` (RECON §22). One real transaction, one real agentId.
- Its `agentURI` JSON must be genuinely descriptive — a real `services[]` endpoint pointing at wherever the agent runtime is reachable, a real name/description. The entire point of §22's finding (the registry is full of `"My Testnet Agent 02"`-style junk) is to make sure ours is not another one of those.
- The UI's "Verified Track Record" card is a join, rendered as two visually distinct blocks so SOURCE and DERIVED are never conflated (§11 rule): **identity** (agentId → on-chain `agentURI` → name/description, read live from the registry) sitting beside **performance** (the `track_record` row, computed only from our logged executions).
- Baseline candidates render with `agentIdOnChain: null` and get no "Verified" badge, no track-record card slot — visually impossible to mistake for a registered participant.
- **Deferred, schema-compatible:** posting the evaluator's score to the ERC-8004 Reputation Registry (`giveFeedback()`) after each completed job, so part of "verified" becomes directly chain-readable rather than only our DB. Not built for MVP; nothing above blocks adding it later.

---

## 6. Execution Flow (BSC Testnet PancakeSwap Infrastructure)

Uses only the contracts already confirmed live in RECON §22 — no new address lookups needed.

1. **Setup (once, before any job runs):** our agent's wallet mints one real, unfarmed WBNB/testnet-token position via `NonfungiblePositionManager` at a chosen fee tier. Unfarmed on purpose — §8's farmed-position nuance (`MasterChefV3.withdraw()` before removal, restake after) is real added complexity, deliberately out of MVP scope (§9).
2. **Job created** against that `positionTokenId`. *(Why not a real ERC-8183 on-chain job/escrow: funding, submit, and complete states add a second multi-step on-chain flow on top of an already multi-step demo — position read → 3 candidates → scoring → Altana session → multi-step rebalance tx. Keeping the job itself in our own DB for MVP keeps the live demo to one on-chain critical path, not two. The `erc8183JobId` field exists specifically so this is a additive stretch, not a rearchitecture — see §9.)*
3. **Read phase** (SOURCE only, no tx): `pool.slot0()`, `NonfungiblePositionManager.positions(tokenId)`, our own polled volatility log.
4. **Candidate generation:** all three `StrategyFn`s run against the same input snapshot.
5. **Evaluation:** scoring formula (§3) runs, winner recorded. If the winner is `HoldAction`, the job completes here — no transaction, which is itself a valid, demoable, honest outcome (keep this path available even if the scripted demo picks a scenario where rebalancing wins).
6. **Altana session grant:** a session key scoped narrowly to `{NonfungiblePositionManager address, SwapRouter address}` only, `spend.limit = job.constraints.maxSpendWei`, short `expiry`. This is the hard Altana bar from §7/§13 — the session, not our backend, is the actual enforcement boundary.
7. **Execution — explicitly NOT atomic (§8's direct warning):** `decreaseLiquidity()` → `collect()` → `mint()` at the winning candidate's proposed range. Each step's tx hash captured as it lands.
8. **`revokeSession()`** immediately after — the full grant → scoped use → revoke lifecycle, visible in the Altana explorer, satisfies the hard judging bar in one flow.
9. **Result recorded** to `executions`: real tx hashes, real gas used, real resulting range read back from the position post-mint.
10. **`track_record` updated** only if the winner was "Our Agent." A baseline win updates nothing in `track_record` — and that asymmetry is worth narrating live, not hiding.

---

## 7. On-Chain vs. Simulated/Backtested — Explicit Ledger

This table is what a skeptical judge should be handed directly.

**Genuinely on-chain, real BSC testnet transactions:**
- Agent registration (ERC-8004 `register()`)
- Pool/position reads (`slot0()`, `positions()`) — live contract state, not cached
- The rebalance execution itself (`decreaseLiquidity → collect → mint`) — real tx hashes
- Altana session grant, execute, and revoke — visible in the Altana explorer
- Post-execution gas cost and resulting range — read back from chain, not estimated

**Simulated / estimated — must be labeled as such in the UI, never implied to be historical fact:**
- `estimatedFeeEfficiency` for a *proposed* (not-yet-executed) range — a deterministic formula, because a freshly minted testnet position has no meaningful historical fee-accrual data to backtest against. Label: *"estimated, not historical."*
- `recentVolatility` — computed from our own short polling window. Label: *"recent testnet observation window, not a market-representative history."*
- Demo-day track-record counts — real, but small (§4's no-synthetic-backfill rule means "3 jobs completed" is the honest number, not a stand-in for something bigger).

**Not included at all in MVP (deferred, §9), not faked:**
- Aave/Venus health-factor data (separate category)
- Registry-sourced third-party competing agents (§22 finding)
- On-chain reputation feedback posting

---

## 8. The 3–5 Minute Judge Demo Flow

Target: ~4 minutes, leaving buffer inside a 5-minute slot.

**0:00–0:30 — Identity.** Show RangeKeeper's real ERC-8004 registration (agentId, live registry read of its `agentURI`) and its real existing BSC testnet LP position (current range, current price) on a block explorer.

**0:30–1:15 — Post the job.** Show the `JobSpec` for that position (constraints: max spend, risk tolerance = medium) going in.

**1:15–2:15 — Agent Arena.** All three candidates generate proposals live on screen — RangeKeeper's real proposal alongside the two clearly labeled baselines — each with its proposed range, rationale, and full 4-component score breakdown (labeled "v1 — equal-weighted"). Winner highlighted with the score that won it.

**2:15–3:15 — Execution.** Altana session grant shown live (scoped, capped, expiring) → the real `decrease → collect → mint` transaction sequence executing on BSC testnet, tx hashes appearing linked to BscScan testnet and the Altana explorer → session revoked on screen immediately after.

**3:15–3:45 — Track record.** RangeKeeper's Verified Track Record card increments by one real completed job. State plainly: *"this number is real, not simulated."* Contrast against the baselines, which structurally have no track-record card at all.

**3:45–4:00 — Close.** *"Agents compete. Evidence decides. Users stay in control."* One sentence: this same job → candidates → evaluator → Altana-gated execution → track-record loop is the shared core Grid Trading, Yield Optimisation, and Health Factor Monitoring would plug into next — not rebuilt per category.

---

## 9. MVP vs. Explicitly Deferred

**MVP — must work live, end to end:**
- One real ERC-8004-registered agent, real `agentURI`, real testnet registration tx
- One real, unfarmed PancakeSwap V3 position on BSC testnet, pre-minted before the demo
- `JobSpec` + all 3 `StrategyFn`s implemented and running against live pool/position reads
- v1 equal-weighted transparent scoring, every input/output logged
- Real Altana session grant → real multi-step rebalance execution → real revoke, all visible on-chain/in-explorer
- `track_record` table, updated only from real executions (even if the count is 1–3 by demo day)
- Minimal UI: job spec view, arena/candidates view with score breakdown, execution status with tx links, track-record card

**Explicitly deferred (documented, not silently dropped):**
- Grid Trading / Yield Optimisation / Health Factor Monitoring — same shared core, different `StrategyFn`s and read logic; architecturally supported, not built this pass
- On-chain ERC-8004 Reputation Registry `giveFeedback()` posting — track record stays DB-only for MVP; schema doesn't block adding it
- Real on-chain ERC-8183 job/escrow funding (`erc8183JobId`) — job lifecycle stays in our own DB for MVP; field reserved, not wired up
- TermiX registration of our agent — additive per original recon, not required for this loop
- Farmed-position handling (`MasterChefV3` withdraw/restake) — demo position is deliberately unfarmed
- Any multi-position or "deploy fresh idle capital" flow — MVP manages exactly one existing position
- Per-job configurable scoring weights beyond the single documented risk-tolerance rule (§3)

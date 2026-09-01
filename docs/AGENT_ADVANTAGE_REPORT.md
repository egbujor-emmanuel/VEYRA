# VEYRA — Agent Advantage Report

**Agent:** VEYRA, ERC-8004 agent `#1890` · **Network:** BNB Smart Chain Testnet (chain 97)
**Operator wallet:** `0x9429BE71274b9E5fB56EE7C57C58298FFF720f11`
**Report date:** 2026-09-01

Four tasks, each run **with the agent** and **without it**, on identical live market state. Every
"with agent" outcome below is a real on-chain transaction whose hash is given, verifiable on
BscScan. Tasks 1 and 2 are trading tasks.

---

## How the comparison is constructed

The without-agent baseline is not a rhetorical device or an after-the-fact estimate. Every
category runs a real **baseline strategy** as a competing candidate inside the same evaluation
round, handed **byte-identical market state** at the same block as the agent. Both produce a
proposal; the evaluator scores both on the same weighted metrics and picks a winner. The
archived round records both proposals, both scores, and the winner.

The baselines are:

| Category | Baseline candidate | Behaviour |
|---|---|---|
| Rebalancing | `baseline-hold`, `baseline-symmetric-range` | never rebalance / always centre symmetrically |
| Grid Trading | `baseline-hold-grid` | never recentre a slot |
| Yield Optimisation | `baseline-hold-yield` | never migrate |
| Health Factor | `baseline-hold-health-factor` | never repay, regardless of solvency |

"Without agent" therefore means: *what would have happened to this exact position, at this exact
block, under the do-nothing policy a passive holder actually follows.*

### An honest statement about what these numbers are

These are **testnet** positions. BSC testnet has no organic trading volume, so fee income is not
a meaningful measure of profit here and this report does not claim any. What it measures is what
can be measured honestly:

- **whether the agent took a correct action a passive holder would have missed**, and
- **the real cost (gas) and real time of taking it**, and
- **the verified on-chain state change** that resulted.

Where a condition had to be created for an agent to have anything to act on, that is stated
plainly in the task, not hidden. Profit claims are absent by choice, not by oversight.

---

## Task 1 — Rebalancing a PancakeSwap V3 LP position (trading)

**Task:** a concentrated-liquidity position has drifted; decide whether to recentre it, and if so,
do it.

| | Without agent (`baseline-hold`) | With agent (`rangekeeper-v1`) |
|---|---|---|
| Decision | `hold` — no change | `rebalance` to `[-59150, -57150)` |
| Evaluator score | **50** | **75** |
| Fee efficiency | 50 | 100 |
| Risk score | 100 | 50 |
| Gas cost | 0 | 3,000,000,000,000,000 wei est. |
| Outcome | position left as-is | **executed on-chain** |

A third candidate, `baseline-symmetric-range`, also proposed a rebalance and also scored **75** —
it tied the agent on score and lost only on the gas tiebreak. That is recorded here rather than
omitted: on this task the agent's advantage over a *naive but non-passive* baseline was marginal.
Its clear advantage was over doing nothing.

**Actual output — real transactions:**

| Step | Hash | Gas |
|---|---|---|
| decreaseLiquidity | `0x4528b2034cef3a3a3914925f21d42eb26eca943706b7dd1e873cae893c56cbc4` | 144,720 |
| collect | `0x7345f0a3c088282c7df1cc50667b46ba861ca4c0e84a041b29a3d1a1966d8470` | 101,593 |
| approve token0 | `0x1b9244fc98148c4bfc3d2e48caff00ca7a3af8f68195172548d487564b68b4a1` | 29,099 |
| approve token1 | `0x6a1235ea0eee6cf0e0e43f16f78b6a3cfd3ee34f4c9d424b18c99de5a3a46176` | 46,064 |
| mint | `0x3974ed94c16c4f0140402de2a19bc0941813462d774d03536d1cb3fd5c89f140` | 451,933 |

Resulting position: **#37079**. Total gas 773,409.

**Note on honesty:** the first attempt at this task **aborted** (`docs/executions/execution-0001.json`,
status `ABORTED`) after the collect step, because the held token ratio did not match the target
range. It is archived as a failure and shown in the app's Execution History rather than deleted.
The completion is a separate, linked record.

---

## Task 2 — Recentring a grid-trading ladder slot (trading)

**Task:** one slot of a multi-position grid has gone out of range; decide whether to recentre it.

| | Without agent (`baseline-hold-grid`) | With agent (`gridkeeper-v1`) |
|---|---|---|
| Decision | `hold` | `grid-rebalance` |
| Evaluator score | **50** | **75** |
| Fee efficiency | 50 | 52.125 |
| Risk score | 100 | 97.875 |
| Outcome | slot stays out of range, earning nothing | **executed on-chain** |

**Actual output:** slot 1 recentred, ending as position **#37093**, mint
`0xeceb7da8f0cce225211923d01a20b986afc22fa20b8afe910b269c029f380f78`.

**Note on honesty:** the first execution of this slot ended `SWAP_FAILED`
(`docs/grid-runs/run-0002.json`) — the ratio-fixing swap left 2.35% of value stranded, over the
1% threshold, so the agent **refused to mint** rather than proceed with a bad position. A second
corrective swap brought it to 0.11% and the mint went through
(`run-0002-resumed-mint.json`). Both records are kept.

This is itself an agent advantage worth naming: the guard that stopped a bad mint is the agent's,
and a passive holder has no equivalent.

---

## Task 3 — Repaying lending debt before liquidation risk (high-stakes)

**Task:** monitor a real Venus Protocol borrow position and repay if solvency risk rises.

| | Without agent (`baseline-hold-health-factor`) | With agent (`health-factor-monitor-v1`) |
|---|---|---|
| Observed | borrow-to-capacity **74%** | borrow-to-capacity **74%** |
| Decision | `hold` — never repays, by construction | `recommend-repay` (threshold 60%) |
| Action | none | **repaid 11.5 USDT** |
| Final ratio | would remain **74%** | **0%**, `NO_BORROW_POSITION` |
| Gas cost | 0 | 232,787 |

**Actual output — real transactions:**

| Step | Hash | Gas |
|---|---|---|
| approve underlying | `0xa50f8efad541bc43ae780a084812a73efda16843baef52f756bb45f2eea5ba45` | 46,018 |
| repayBorrow | `0x221c326b5d1231bb24132109cd6e0c4bc3e555b2d8d3bd1618cccfaf84a23167` | 186,769 |

Verified by re-reading the borrow balance: `11500000 → 0` (6-decimal USDT).

**Condition disclosure:** BSC testnet has no borrower whose ratio drifts on its own, so the
elevated risk was created deliberately — VEYRA borrowed additional USDT against its own real
collateral, moving the ratio from a long-standing 14% to 74%. **The 60% threshold was not
modified and the decision to repay was the strategy's own**; the runner aborts if it returns
anything else. Full disclosure is in `docs/health-factor-runs/run-0001.json`.

**Why this measurement is trustworthy:** Venus is a Compound fork — `repayBorrow` returns an error
code instead of reverting, so a transaction can be mined "successfully" and change nothing. The
executor re-reads the debt after every operation and reports the delta, never the receipt.

---

## Task 4 — Migrating liquidity to a better-yielding pool

**Task:** compare candidate pools by observed fee growth and move capital if one is genuinely better.

| | Without agent (`baseline-hold-yield`) | With agent (`yield-optimiser-v1`) |
|---|---|---|
| Pool A score (0.25%) | 5.68464e35 | 5.68464e35 |
| Pool B score (0.05%) | 5.74247e35 | 5.74247e35 |
| Decision | `hold` | `recommend-migrate` → pool B |
| Action | capital stays in the worse pool | **migrated on-chain** |
| Gas cost | 0 | 1,163,475 |

**Actual output — real transactions:**

| Step | Hash | Gas |
|---|---|---|
| mint source position | `0x165630526a5707a377fcec5ca219745f41628d7180fa1b3143bfa162d1f0bf76` | 466,981 |
| decreaseLiquidity | `0x81ecc1f581c80b575f31a760354b5007fad9de3f724870c86dfb289996714ae1` | 149,962 |
| collect | `0x53671453ae8ce10bad682c0c9a98672a6c9abe55bc2e3b4d52f73f06892c569e` | 84,493 |
| mint in target pool | `0x348c128e276c0bee0fc2f89603602108c3c23bf9e9718fae417b7462c7ef87f8` | 462,039 |

Position **#37140** (pool A) drained to zero liquidity; **#37141** minted in pool B with
liquidity 5,413,976,855,467,466,509. Recovered and redeployed 1.9897 VUSD + 0.006 WBNB.

**Condition disclosure:** the candidate pool had zero liquidity and zero fees, so it could never
win. Real liquidity was minted there and 25 real swaps routed through it, paying real fees at the
pool's real rate, until its score genuinely exceeded pool A's. **The evaluator and its scoring
were not modified.**

**Defect found by this run, since fixed:** at the time of this migration the evaluator scored
cumulative fee growth alone and **ignored liquidity depth**. Fee growth is measured *per unit of
liquidity*, so a nearly-empty pool posts a spectacular score while being the worst possible place
for capital — during seeding, single 300-VUSD swaps repeatedly drove this pool's price to
`MIN_TICK (-887272)`. The evaluator would have recommended migrating into exactly that.

A depth gate now rejects any candidate holding under **25%** of the current pool's liquidity, and
reports *why* it held rather than holding silently — an operator must be able to distinguish
"nothing better exists" from "something scored better but was too thin to trust". Three regression
tests cover it. The migration above still qualifies under the gate.

---

## Summary

| # | Task | Without agent | With agent | Verified on-chain |
|---|---|---|---|---|
| 1 | LP rebalancing (trading) | hold, score 50 | rebalance, score 75 | 5 txs, 773,409 gas |
| 2 | Grid recentre (trading) | hold, score 50 | recentre, score 75 | mint `0xeceb7da8…` |
| 3 | Lending repayment (high-stakes) | 74% risk retained | **74% → 0%** | 2 txs, 232,787 gas |
| 4 | Yield migration | stays in worse pool | migrated | 4 txs, 1,163,475 gas |

**In all four tasks the without-agent policy took no action.** In three of the four, the agent's
action produced a verified state change that a passive holder would not have achieved. In task 1
a non-passive baseline matched the agent's score and lost only on gas — reported rather than
buried.

## What this report does not claim

- **No profit or APR figures.** Testnet has no organic volume; any yield number would be fabricated.
- **No timing advantage claims.** Each run was operator-triggered, not continuously scheduled.
  VEYRA does not yet act autonomously on a user's behalf while they are away — the session key is
  generated in the user's browser and there is no backend holding it.
- **Tasks 3 and 4 had their conditions deliberately created**, as disclosed above. The decisions
  were not.

## Reproducing this

```
node scripts/runHealthFactorExecution.mjs   # task 3
node scripts/runYieldMigration.mjs          # task 4
node scripts/proveSessionScope.mjs          # session scoping + revocation
node scripts/proveHireFlow.mjs              # escrow hire, fund, refund
```

Archives: `docs/executions/`, `docs/grid-runs/`, `docs/yield-runs/`, `docs/health-factor-runs/`,
`docs/arena-rounds-v2/`.

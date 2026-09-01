# VEYRA

**An autonomous DeFi agent marketplace on BNB Smart Chain.** A stranger can open the site, create
a wallet with their fingerprint, grant VEYRA a scoped and expiring key over their own funds, hire
an agent through on-chain escrow, and revoke everything at any time.

**Live:** https://egbujor-emmanuel.github.io/VEYRA/
**Identity:** ERC-8004 agent `#1890` · **Network:** BNB Smart Chain Testnet (chain 97)
**Operator wallet:** [`0x9429BE71…720f11`](https://testnet.bscscan.com/address/0x9429BE71274b9E5fB56EE7C57C58298FFF720f11)

---

## The four agents

All four execute for real on-chain. None is a mock.

| Agent | What it does | Proof |
|---|---|---|
| **Rebalancing** | Recentres a PancakeSwap V3 LP position as price drifts, including a ratio-fixing swap when held tokens don't match the new range | position #37079, 5 txs |
| **Grid Trading** | Maintains a ladder of narrow-range positions, recentring only slots that are both out of range and drifted | positions #37091 / #37093 |
| **Yield Optimisation** | Compares observed fee-growth across pools and migrates capital to the better one | #37140 → #37141, 4 txs |
| **Health Factor Monitoring** | Watches a real Venus borrow position and repays before liquidation risk develops | 74% → 0%, 2 txs |

Every transaction hash is listed in **[docs/AGENT_ADVANTAGE_REPORT.md](docs/AGENT_ADVANTAGE_REPORT.md)**,
which compares each agent against a do-nothing baseline on identical market state.

## Custody: what VEYRA can and cannot do with your money

This is the part that matters, and it is enforced on-chain rather than promised in a README.

You create an **Altana smart account** with a passkey — no extension, no seed phrase. You then
grant VEYRA a **session key** scoped to PancakeSwap V3 position calls, capped at 0.05 BNB/day, and
expiring in one hour. It cannot touch anything else.

That claim is tested, not asserted. `scripts/proveSessionScope.mjs` runs six assertions against
a real wallet on chain 97:

```
PASS  session key present on-chain after grant
PASS  in-scope call succeeds                    CONFIRMED, real tx
PASS  out-of-scope call is refused
PASS  revoke completes
PASS  session key removed on-chain after revoke   1 scoped key -> 0
PASS  revoked session is refused
```

A session granted over PancakeSwap's position manager **could not touch WBNB**, and after
revocation the identical call that had just succeeded stopped working.

## Hiring an agent

Payment runs through **ERC-8183 escrow** in `$U`. The agent is paid only after delivering; if it
never does, you reclaim the full amount. `scripts/proveHireFlow.mjs` proves the whole path
including the refund (verified with job **#854**):

```
PASS  faucet yields $U                          10 $U
PASS  JobCreated emitted with a jobId           jobId=854
PASS  job names us as client, VEYRA as provider
PASS  budget left the user's wallet             10 -> 9 $U
PASS  budget arrived in the escrow contract     commerce +1 $U
PASS  refund returned the budget to the user    9 -> 10 $U
```

## What is NOT built

Stated here rather than left to be discovered:

- **VEYRA cannot act while you are away.** The session key is generated in your browser and never
  leaves it. There is no backend holding it, so every run today is operator-triggered. "Autonomous
  agent working for you in the background" is not true yet.
- **Tasks 3 and 4 in the Advantage Report had their conditions deliberately created**, because BSC
  testnet has no organic borrower drifting into risk and no trading volume. The conditions were
  manufactured; the agents' decisions were not, and the strategies were not modified.
- **Testnet only.** No mainnet deployment, no real funds.

## Running it

```bash
npm install
npm test                       # 150 core + 40 chain tests
npm run build --workspace @veyra/web
npm run dev  --workspace @veyra/web
```

Live on-chain scripts (require `smoketest/.studio/`, which is gitignored and not in this repo):

```bash
node scripts/proveSessionScope.mjs           # custody: scope enforcement + revocation
node scripts/proveHireFlow.mjs               # escrow: hire, fund, refund
node scripts/runHealthFactorExecution.mjs    # Venus repayment
node scripts/runYieldMigration.mjs           # pool migration
node scripts/fundTestWallet.mjs 0x<address>  # top up a new tester's wallet
```

## Using it as a visitor

1. Open https://egbujor-emmanuel.github.io/VEYRA/#/agents
2. **Create wallet** — approve the passkey prompt (~6–15s for the on-chain account upgrade)
3. Fund it with a little testnet BNB. Your first action also registers your key in Altana's
   KeyStore, which charges a live fee (~0.00072 BNB) — the UI shows the exact amount required and
   disables Authorize until you have it.
4. **Authorize VEYRA** — 45–90s, most of which is a deliberate wait for BSC nodes to agree the key
   exists. The UI explains each stage.
5. **Hire an agent** — claim free testnet `$U` in the panel first.

> **On Windows 10:** choose **"Use a phone or tablet"** at the passkey prompt. Windows 10's
> Windows Hello cannot store the discoverable credentials this requires (that arrived in Windows
> 11), so "this device" will hang and time out. Not a bug in this app; the UI says so on-screen.

## Layout

```
apps/web/              React + Vite frontend (Tailwind v4 + shadcn primitives)
packages/veyra-core/   Strategies, evaluators, snapshots, policy gates — pure, tested
packages/veyra-chain/  On-chain readers, executors, signing
scripts/               Live on-chain proofs and operational tools
docs/                  Run archives, custody architecture, Agent Advantage Report
```

The split matters: `veyra-core` holds no I/O, so every strategy and safety gate is unit-testable
against fixtures, and `veyra-chain` is the only place that can touch a key.

## Verification

- **Altana KeyStore explorer:** https://testnet.altana.network/account/0xb6f9fD8b1E33613bdc00ff21F22dd43DD46593d0
  — a real visitor's key registration, `Root` / `Active` / BNB Smart Chain
- **BscScan:** every hash in the Advantage Report
- **ERC-8004 registry:** `0x8004A818BFB912233c491871b3d84c89A494BD9e`, agent `#1890`

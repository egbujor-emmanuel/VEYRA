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

### A job delivered and paid, end to end

Job **#877** is a real hire by a real visitor, driven through the whole ERC-8183 lifecycle:

```
Funded --submit(deliverable)--> Submitted --[15-min dispute window]--> Completed --> provider paid
```

The deliverable is not a placeholder hash. VEYRA ran its real evaluator against live on-chain
position state, archived the result to `docs/deliveries/job-877.json`, and committed the
keccak256 of that exact artifact on-chain. Anyone can re-derive it, with no keys and no
privileged access:

```bash
node scripts/verifyDelivery.mjs 877
```

```
deliverable on-chain : 0x68c74e5658b7c46064e1f2bdc98ce739d98af76d5f9b21d8eb6e1da1ccf2e1a2
recomputed from file : 0x68c74e5658b7c46064e1f2bdc98ce739d98af76d5f9b21d8eb6e1da1ccf2e1a2
artifact self-consistent : YES   matches the chain : YES   job completed : YES
```

The client's 1 $U left their wallet, sat in escrow, and was released to VEYRA only after the
dispute window passed without challenge.

### Disputes — the client decides

Jobs created by this app name **the client as their own evaluator**, which under ERC-8183 makes
the person who paid the sole authority on `complete()` and `reject()`. When VEYRA submits work,
the client gets two buttons: **Accept & pay**, or **Reject & refund**.

That required getting past a deadlock in the deployed contracts. Originally every job had to name
the EvaluatorRouter as evaluator, because the Router's hook rejects `fund()` with `PolicyNotSet()`
on any job it does not evaluate, while `registerJob()` (which sets that policy) reverts
`RouterNotEvaluator()` otherwise. Rejection then had to go through
`OptimisticPolicy.voteReject()`, restricted to operator-granted voters — 2 of them, administered
by `0x1001b2C0…`, with `addVoter()` admin-only. A client could raise a dispute but never resolve
one, and could not get their money back before expiry.

The fix is `contracts/OpenSettlementHook.sol` — a 455-byte hook with no owner, no funds, no
upgrade path and two empty methods. It imposes no policy, which lets a job name the client as
evaluator. Proven end-to-end on job **#919**:

```
PASS  job names the CLIENT as evaluator
PASS  job funded
PASS  job reaches Submitted            (VEYRA submitted a deliverable)
PASS  job is Rejected                  (the client refused it)
PASS  client got their money back      9 -> 10 $U
PASS  VEYRA was NOT paid
```

**The trade-off, stated plainly:** a client-evaluated job trusts the client. A dishonest one can
reject good work and reclaim the budget. That is the mirror of the Router flow, where the provider
is protected but the client is powerless. Neither is universally right; VEYRA offers the one that
puts the user in control and says so.

### Delivery is automatic

`services/agent-daemon/` watches the chain for jobs naming VEYRA as provider, does the work, and
submits the deliverable unattended. It discovers jobs by walking job IDs rather than event logs,
because every public BSC testnet RPC tested refuses `eth_getLogs` over historical ranges.

```bash
node services/agent-daemon/index.mjs          # poll forever
node services/agent-daemon/index.mjs --once   # single pass
```

It holds VEYRA's own operator key and uses it for exactly one thing: submitting deliverables for
jobs where VEYRA is the provider. It settles Router-evaluated jobs once their dispute window
closes, and never settles a client-evaluated one — that decision belongs to the client.

**It is hosted.** `.github/workflows/agent-daemon.yml` runs it on a schedule, so hiring works with
nobody at a keyboard. Credentials come from repository secrets
(`VEYRA_WALLET_PASSWORD`, `VEYRA_KEYSTORE_JSON`, `VEYRA_AGENT_SESSION_JSON`) — the keystore is
never committed, and the workflow skips with a warning rather than failing if they are unset.
Cron granularity is ~10 minutes and scheduled runs can be delayed under load, so this is "checked
every few minutes", not instant — which is fine against 24-hour job expiries.

Verified end to end: the daemon discovered jobs #924 and #939 on its own, delivered both, then on
a later pass settled #924 once its dispute window closed — `Completed`, and VEYRA was paid.

### Putting funds under management

A new passkey wallet holds a little tBNB and owns no PancakeSwap position, so "let the agent run
your position" previously had no subject for anyone starting from zero. The **Put funds under
management** panel closes that.

The pool is VUSD/WBNB and a visitor has neither token — but a concentrated-liquidity range sitting
entirely below the current price is funded by **token1 alone**, and WBNB is token1 here. So the
visitor wraps their own tBNB and deposits it single-sided: no second token, no swap, no faucet.

Wrapping, approving and minting are all signed by **the visitor**. VEYRA has no permission to
touch their BNB or create a position — its session covers only the position manager and the swap
router. It can manage what you deposit; it could never have deposited it.

The position starts just below the current price, so it sits out of range and earns nothing where
it is. That is deliberate — it is exactly the condition the Rebalancing agent exists to fix.

`scripts/proveUserDeposit.mjs` walks the whole path for a brand-new wallet:

```
PASS  visitor owns no position to begin with
PASS  visitor now owns a real position
PASS  position holds real liquidity        #37196, range [-59300, -58300)
PASS  session granted to VEYRA's agent key
PASS  VEYRA operated on the visitor's position while they were away   CONFIRMED on-chain
```

### VEYRA acts while you are away

Authorizing VEYRA delegates to its **permanent agent session key**, whose private half lives with
the daemon and whose public half is the only part compiled into the site. Neither key ever crosses
the network:

- `grantSession()` needs only `publicKey` and `address` to authorize a session — **your passkey**
  signs the grant, not VEYRA's key.
- The daemon reconstructs the session from its private half and acts within your scope.

Compare the obvious alternative — the browser mints a session key and uploads it — which puts a
live key on the wire and in server logs. This does not. The public-only signer in the bundle has a
`signDigest` that throws, so any attempt to sign in the browser fails loudly rather than silently.

`scripts/proveAgentAutonomy.mjs` proves it, and is deliberately harsh: after granting, **the
user's signer is discarded entirely** before VEYRA acts.

```
PASS  frontend signer carries no private key
PASS  session was granted to VEYRA's agent key
PASS  VEYRA executed on the user's account with the user absent   CONFIRMED on-chain
PASS  out-of-scope call still refused
```

Scope still holds with the user gone: the same session that managed a PancakeSwap position could
not touch WBNB.

## What is NOT built

Stated here rather than left to be discovered:

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
node scripts/deliverJob.mjs 877              # agent delivers a hired job, then settles
node scripts/verifyDelivery.mjs 877          # re-derive the deliverable hash (no keys needed)
node scripts/proveClientEvaluator.mjs        # client rejects a delivery and is refunded
node services/agent-daemon/index.mjs --once  # agent finds and delivers funded jobs by itself
node scripts/proveAgentAutonomy.mjs          # VEYRA acts on a user's account, user absent
node scripts/proveUserDeposit.mjs            # empty wallet -> funds under autonomous management
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

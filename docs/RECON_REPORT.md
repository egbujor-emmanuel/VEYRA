# BNB Chain "Smart Money Era" Hackathon — Technical Reconnaissance Report

**Prepared for:** Engineering/product lead, Mission 01
**Date:** 2026-08-21
**Build period:** August 5 – September 9, 2026 UTC+0. **19 days remain** (not 20 — the brief's "today = Aug 20" is one day off from the actual current date, 2026-08-21).
**Method:** Six parallel research passes against official sources only (bnbchain.org, docs.bnbchain.org, github.com/bnb-chain, 8004scan.io, docs.altana.network + github.com/altananetwork, developer.pancakeswap.finance + docs.pancakeswap.finance, termix.ai + docs.termix.ai), plus local repository inspection. Every claim below is tagged **VERIFIED** / **PARTIALLY VERIFIED** / **UNKNOWN**, per the evidence standard requested. No code was written. No endpoints, addresses, or SDK methods were invented — where sources didn't have an answer, it's marked UNKNOWN.

---

## 1. Executive Summary

**Build a real, narrow, four-category agent marketplace on BNB Chain that reads identity/reputation from 8004scan, executes real DeFi actions through Altana-scoped sessions, and treats TermiX as a second, separately-registered distribution channel rather than an integration partner** — because the research surfaced a hard architectural fact that changes the shape of the whole submission: **BNB's own agent-commerce contracts (`apex-contracts` — `AgenticCommerceUpgradeable`) and TermiX's AACP contracts (`TermixEscrow`) are two different deployments**, both loosely describable as "ERC-8183," with no documented bridge between them. TermiX does not ingest external agent registries — an agent only becomes hireable *through TermiX* by minting an ERC-8004 NFT via TermiX's own API. That means "qualify for TermiX" and "build the BNB Agent Studio marketplace" are two separate integration surfaces, not one.

Given ~19 days, the winning strategy is **not** to chase deep integration with every partner simultaneously. It is to:
- Build one excellent, real marketplace on the BNB Agent Studio / ERC-8004 / ERC-8183 (apex-contracts) stack, covering all four categories with genuinely different real-transaction depth (not four reskins of a swap button).
- Make **Health Factor Monitoring** the flagship, since it's the only category where read-only, zero-risk, always-demoable value (liquidation risk alerts) is trivial to get real and where Altana's shipped skills leave the biggest, most defensible gap for us to fill (no Altana skill exposes borrow-side health-factor data — see §7).
- Bolt on Altana for the wallet/session/spend-cap layer specifically because the hackathon's own rubric requires "live onchain transactions in the Altana explorer" as a hard bar, not a nice-to-have.
- Treat TermiX as an **additional registration**, not a rebuild: mint our agents as TermiX providers via TermiX's own 3-step API once the core marketplace works, and generate the Agent Advantage Report from real logs the marketplace already produces.
- Treat the PancakeSwap challenge as **already satisfied** by the Rebalancing + Grid Trading categories, since PancakeSwap's own docs describe exactly this as agent-composable, no-partnership-required smart-contract usage.

This is achievable in the time available **only** if the team stops treating "four equally deep categories" as "four independent builds." All four should share one execution/policy/session core; only the read/decision logic (what to read, what threshold triggers what tx) differs per category.

---

## 2. Current Repository State

- **Working directory** (`C:\Users\Yoma Maroh`) is the user's home directory, **not a project repository** — `git status` returns "fatal: not a git repository." **This is greenfield: no existing frontend, backend, contracts, or agent code for this hackathon exists yet.**
- Runtimes available locally: **Node v24.18.0**, **Python 3.14.6** (and a second 3.11.15 install present). No `bag` CLI on PATH. No `bnbagent-sdk`/`bnbagent` pip package installed. Global npm packages present are unrelated to this project (`@okxweb3/a2a-node`, `@railway/cli`, `openclaw`, `skills`, `vercel`).
- Found `.onchainos` and `.openclaw` directories — these are pre-existing, unrelated personal agent-tooling setups (wallet/session state, audit logs) from other projects. **Not part of this hackathon's stack**; do not assume they provide reusable infra without separately auditing them, and do not touch them.
- Found `Documents/Hackathon Build Guide - DeepSeek.html` — a prior AI-generated (DeepSeek) planning document already in the user's files. **Not treated as a source of truth anywhere in this report** (per the brief's own instruction not to rely on outdated non-official material) — flagging its existence only so the team knows it exists and can consult it for prior thinking, with the same skepticism applied to everything else that isn't an official doc.
- **Created this session:** `bnb-smart-money-era/docs/RECON_REPORT.md` (this file) as the first artifact of an actual project directory — no other files were created or modified.

---

## 3. BNB Agent Studio

| Claim | Status | Detail |
|---|---|---|
| What it is | PARTIALLY VERIFIED | A toolkit combining wallet functionality, LLM access, on-chain agent identity (ERC-8004), task interfaces (ERC-8183), and a cloud runtime; agents can be scaffolded via natural language. Source: bnbchain.org/en/bnb-agent-studio |
| Install method | **CONFLICT, unresolved** | Marketing page says `npm install -g @bnbagent/studio-cli`. Docs quickstart says `pip install bnbagent-studio` (or `uv tool install bnbagent-studio`) plus `npm install -g @aws/agentcore` as a prerequisite. **`bnbagent-studio` is confirmed to exist on PyPI, v0.0.5** (released 2026-07-07) — described there as providing the `bag` CLI. The npm package's existence could not be independently confirmed (npmjs.com blocked automated fetch). **Action: run both install commands directly and see which actually produces a working `bag` binary before building the submission around either.** |
| CLI command groups | PARTIALLY VERIFIED (single-source page summary — verify by running `bag --help` yourself) | `init`, `scan`, `recipe` (list/show/code), `skills` (list/install/uninstall), `wallet` (new/show/list/sign), `erc8004` (register/show/resolve/update-endpoint), `erc8183` (publish/list/status/buy/submit/fetch/settle), `x402` (quote/buy), `agents` (list/show/forget/register), `config` (show/get/set/list-keys), `env` (set/get), `dev`, `doctor`, `deploy` (prepare/agent/package/verify/status/destroy/logs), `mcp` (serve/tools), `bundle`, `budget` (show/enable/disable), `audit` (ls/tail/show), `llm` (test/activate/status/topup/allocate/rotate/list-models/usage). All 19 requested groups were reported present; treat completeness as unconfirmed until verified live. |
| Claude Code / MCP connection | **CONFLICT** | The quickstart page's worked example shows `bag mcp serve --transport stdio` with a concrete IDE config (`command: bag`, `args: ["mcp","serve","--transport","stdio"]`, env `WALLET_PASSWORD`), and states the server exposes ~15 **read-only** tools (no signing). The flag-level CLI reference page, however, does **not** show a `--transport` flag under `mcp serve` in its documented flag table. **Do not assume `--transport stdio` is a stable flag — run `bag mcp serve --help` directly to confirm before wiring Claude Code to it.** The separate demo page describes IDE integration only as "open the repo, ask your AI IDE to install workspace packages" — no explicit transport directive there either. |
| MVP status | PARTIALLY VERIFIED | Marketing page states "MVP is live as of June 8, 2026" with a roadmap (TWAK wallet integration, Azure support, enterprise security) targeted "through July 2026" — that roadmap window has already passed relative to today; whether those items shipped is UNKNOWN. |
| GitHub repo | PARTIALLY VERIFIED | Marketing page links to `github.com/bnb-chain/bnbagent-sdk` — i.e., there does not appear to be a separate "Studio" repo distinct from the SDK repo; worth double-checking there isn't a second repo the marketing page simply omitted. |

**Net assessment:** BNB Agent Studio's CLI/MCP tooling is real but under-verified in the docs the team can currently read remotely. Before relying on `bag` for anything demo-critical, **actually install it** (try both `npm install -g @bnbagent/studio-cli` and `pip install bnbagent-studio`) and run `bag doctor`, `bag --help`, `bag mcp serve --help` locally — this is a same-day task, not a research task, and it resolves three of the biggest open conflicts in one sitting.

---

## 4. BNB Agent SDK

| Claim | Status | Detail |
|---|---|---|
| Packages/versions | VERIFIED (PyPI direct) / PARTIALLY VERIFIED (npm) | `bnbagent` on PyPI, confirmed **v0.4.3** (release date shown as 2026-08-19 on PyPI vs. 2024 on a GitHub-releases fetch — **the 2024 date is almost certainly a fetch/summarization artifact**, not a real inconsistency; re-check `github.com/bnb-chain/bnbagent-sdk/releases` directly in a browser before citing any date). `@bnbagent/sdk` on npm reported at v0.5.1 (not independently confirmed against the npm registry directly — 403 on fetch). |
| Language | VERIFIED | Both Python and TypeScript, in one monorepo (`python/`, `typescript/` directories). Install: `pip install bnbagent` (extras: `[server,ipfs]`) or `npm install @bnbagent/sdk`. |
| ERC-8004 wrapper | PARTIALLY VERIFIED | `ERC8004Agent(network="bsc-testnet", wallet_provider=...)` with `.generate_agent_uri(name, description, endpoints=[AgentEndpoint(...)])`, `.register_agent(...)`, `.get_agent_info()`, `.get_all_agents()`. Registration is **gas-sponsored via MegaFuel paymaster** on both testnet and mainnet — VERIFIED wording from docs. |
| ERC-8183 wrapper | PARTIALLY VERIFIED | Server: `create_erc8183_app(on_job=...)` exposing `/erc8183/job/{id}`, `/erc8183/negotiate`, `/erc8183/status`, `/erc8183/health`. Client: `ERC8183Client.create({walletProvider, network})` → `.createJob()`, `.registerJob()` (binds OptimisticPolicy), `.fund()`, `.settle()`, `.getJob()`, `.policy.disputeWindow()`. Provider-side helper `ERC8183JobOps` with `submitResult()` and a `fundedJobWatcher()` poll loop. Exact negotiation/dispute method names beyond `claimRefund()` are UNKNOWN — not surfaced in any fetched page. |
| Wallet providers | PARTIALLY VERIFIED | Three: `EVMWalletProvider` (local key, Keystore V3 scrypt+AES-128-CTR, full signing), `TWAKProvider` (Trust Wallet Agent Kit, self-broadcasting, x402 delegation), `AltanaWalletProvider` (TS-only, EIP-7702 on-chain sessions, relay broadcasting) — this last one is the direct integration point with the Altana track (§7). |
| Storage | PARTIALLY VERIFIED | Async `StorageProvider` ABC — `LocalStorageProvider` (filesystem) and `IPFSStorageProvider` (Pinata-compatible HTTP), sync bridge via `upload_sync()`. |
| Networks | VERIFIED | `bsc-testnet` (97), `bsc-mainnet` (56) only. |
| Contract addresses | **VERIFIED (real addresses found — see §14 table)** | The SDK's own `networks/` docs page explicitly does **not** list addresses inline and instead points to `github.com/bnb-chain/apex-contracts#deployments` for ERC-8183/APEX contracts. That repo's README (raw-fetched, byte-for-byte, org ownership confirmed as `bnb-chain`) **does** publish real testnet and mainnet addresses for `AgenticCommerceUpgradeable`, `EvaluatorRouterUpgradeable`, `OptimisticPolicy`, and a payment token per network (full table in §14). The README explicitly states `scripts/addresses.ts` in that repo is the ultimate source of truth if it ever drifts from the README table — pull it fresh at build time, don't hardcode from this report. The ERC-8004 Identity Registry address is **not** published as a static value anywhere reachable; it's resolved dynamically in SDK code with an `ERC8004_REGISTRY_ADDRESS` env override — the literal default was not retrievable without reading SDK source files directly (a follow-up task, not done in this pass to avoid guessing a path). |
| Config env vars | PARTIALLY VERIFIED | `PRIVATE_KEY`, `WALLET_PASSWORD` (required), `WALLET_ADDRESS`, `NETWORK` (default `bsc-testnet`), `RPC_URL`, `ERC8183_COMMERCE_ADDRESS`, `ERC8183_ROUTER_ADDRESS`, `ERC8183_POLICY_ADDRESS`, `ERC8004_REGISTRY_ADDRESS`, `ERC8183_SERVICE_PRICE` (default 1 unit), `ERC8183_MAX_RESPONSE_BYTES` (default 5MB), `ERC8183_MAX_METADATA_BYTES` (default 256KB), `STORAGE_API_KEY`, `STORAGE_LOCAL_PATH` (default `.agent-data`), `ERC8183_AGENT_URL`. |
| Security model / limitations | VERIFIED (direct quote) | README states plainly: **"The SDKs are under active development and may introduce breaking changes. Use them at your own risk."** Also: no plaintext secrets retained in config after construction; retry-with-backoff on 429/nonce conflicts; per-account nonce manager; dispute-window settlement with a permissionless `claimRefund()` expiry escape hatch; strict module isolation (no cross-module imports). |
| ERC-8183 architecture | PARTIALLY VERIFIED | Described as three layers: **AgenticCommerce** (job lifecycle/escrow kernel) + **EvaluatorRouter** (routing/policy) + **OptimisticPolicy** (UMA-style optimistic dispute resolution). This is BNB's own dispute-window design layered on top of the (dispute-window-free) base EIP-8183 standard — see §5. |

**Unresolved question worth flagging loudly:** whether `github.com/BRC8004/brc8004-contracts` (a separate, not-officially-claimed Identity/Reputation Registry implementation found during research) is what bnbagent-sdk's ERC-8004 calls actually hit on BSC. **UNKNOWN** — resolve by comparing the SDK's resolved registry address (once found in source) against BRC8004's deployed address.

---

## 5. ERC-8004

**Primary source used:** the actual draft EIP text at `eips.ethereum.org/EIPS/eip-8004` (not a paraphrase — read directly).

- **Status: Draft**, not finalized/ratified, despite some secondary sources (blogs) describing it as "live since October 2025." **Do not describe ERC-8004 in the submission as a ratified standard.** — VERIFIED / flagging a real conflict with secondary sources.
- **Registration:** on-chain `register(agentURI, metadata[]) → agentId`, emits `Registered(agentId, agentURI, owner)`. — VERIFIED
- **agentId:** simply the auto-incrementing ERC-721 tokenId. Not derived from a hash or address. — VERIFIED
- **Metadata:** `agentURI` resolves to an off-chain "Agent Registration File" JSON (fields: `type`, `name`, `description`, `image`, `services[]`, `active`, `registrations[]`; optional `x402Support`, `supportedTrust`). A small amount of metadata (notably the `agentWallet` key) can additionally live **on-chain** via `getMetadata`/`setMetadata`, verified through EIP-712/ERC-1271 when changed. — VERIFIED
- **Endpoints:** entries in the `services[]` array (`name` such as `"web"`, `"A2A"`, `"MCP"`, `"OASF"`, `"ENS"`, `"DID"`, `"email"`, plus a URL/identifier and optional version/capability fields). — VERIFIED
- **Storage model — genuinely hybrid:** the `agentURI` pointer is on-chain (ERC-721 URIStorage); it may resolve to `ipfs://`, `https://`, or a base64 data URI, so the actual JSON payload is typically off-chain. Optional domain verification via `https://{domain}/.well-known/agent-registration.json`. — VERIFIED
- **Resolution:** agentId → query registry → `agentURI` → fetch/parse JSON. — VERIFIED
- **Discovery is explicitly NOT part of the base standard.** The spec itself says discovery/search is an ecosystem/indexer responsibility ("subgraphs... indexers... improve UX") — this is exactly the gap 8004scan fills (§6). **Do not build assuming any base-protocol discovery/search API exists** — it doesn't; only enumerability via standard NFT tooling is guaranteed. — VERIFIED
- **Reputation (protocol level):** a Reputation Registry contract with `giveFeedback(agentId, value, decimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`, `getSummary()`, `readFeedback()`, `readAllFeedback()`. The spec explicitly states **aggregation beyond raw feedback storage is out of scope** ("more complex reputation aggregation will happen off-chain") — so any single "reputation score" your marketplace shows must be your own or 8004scan's derived score, never a protocol-native number. — VERIFIED
- **Validation (protocol level):** a Validation Registry with `validationRequest()`/`validationResponse()` (0–100 score) — a generic hook; incentives/slashing/mechanism (TEE, zkML, staking) are explicitly out of scope of the registry itself. — VERIFIED
- **On-chain-readable vs. 8004scan-required:** directly readable from BSC — agentId→agentURI, raw feedback entries, raw validation records, `agentWallet`. Requires an indexer (8004scan) — aggregated scores, semantic/full-text search, category/capability filtering, trending/leaderboards. — VERIFIED (logical + explicit spec language)
- A WebSearch-sourced claim that "agent addresses use CAIP-10 format" could **not** be confirmed in the fetched spec text (the spec instead used a custom `{namespace}:{chainId}:{identityRegistry}` string). — UNKNOWN, flagging the conflict rather than picking a side.

**BNB's SDK wrapper adds no reputation/validation logic beyond the base registries** — confirmed absent on the docs pages checked.

---

## 6. ERC-8183

**Primary source used:** `eips.ethereum.org/EIPS/eip-8183` (draft text read directly).

- **Status: Draft**, created 2026-02-25. Chain-agnostic by design (no network is mandated by the EIP itself — BNB's specific deployment choosing bsc-testnet/bsc-mainnet is an implementation decision, not a spec requirement). — VERIFIED
- **Job lifecycle — six named states:** Open → Funded → Submitted → Completed / Rejected / Expired (three of these are terminal). Some secondary sources collapse the last three into one "Terminal" bucket — use the six-state model from the primary spec for anything you implement. — VERIFIED
- **Roles:** Client (creates job, sets budget, funds escrow, can reject only while Open, refunded on Rejected/Expired), Provider (submits deliverable, paid on Completed), Evaluator (sole authority to `complete()`/`reject()` once Submitted; may equal the client for self-evaluation, or be a contract). — VERIFIED
- **State transitions (exact):** `setBudget()` → `fund(jobId, expectedBudget)` (Open→Funded); client `reject()` (Open→Rejected); provider `submit(jobId, deliverable)` (Funded→Submitted); evaluator `reject()` (Funded→Rejected, or Submitted→Rejected); evaluator `complete()` (Submitted→Completed); anyone `claimRefund(jobId)` post-`expiredAt` (→Expired). — VERIFIED
- **Payment:** a single ERC-20 token required by spec (no native BNB support in the base standard). — VERIFIED
- **Contract shape (reference impl):** `AgenticCommerce.sol` — UUPS-upgradeable, `AccessControl`, transient reentrancy guard, `mapping(uint256 => Job)`, no separate registry contract. Optional `IACPHook` (`beforeAction`/`afterAction`) for extensibility (e.g., reputation posting). `Job` struct: `id, client, provider, evaluator, description, budget, expiredAt (mandatory), status, hook (optional)`. — VERIFIED
- **Expiration:** `expiredAt` mandatory at creation, must be in the future, minimum enforced window of 5 minutes; `claimRefund()` deliberately not hookable (prevents a malicious hook from blocking refunds). — VERIFIED
- **No built-in dispute window in the base standard** — once Submitted, only the evaluator decides; the spec explicitly warns "a malicious evaluator can complete or reject arbitrarily" and only *recommends* (doesn't require) mitigating via reputation (pointing at ERC-8004) or staking for high-value jobs. — VERIFIED. **BNB's `OptimisticPolicy` (§4) is exactly the kind of dispute-window extension the base spec anticipates but doesn't define — it is BNB-specific, not part of the EIP.**
- **On-chain vs. off-chain per spec:** on-chain = all Job struct fields, hook address, escrowed balances, state. Off-chain (optional) = `deliverable` (bytes32 hash/CID reference), `reason` (bytes32 optional attestation hash), `optParams` (opaque bytes for hooks). Spec explicitly frames this as a minimal surface — "no additional ledger is required." — VERIFIED
- **Fees:** optional, basis-points, deducted only on Completed (never on refund), to a configurable treasury. — VERIFIED
- **Is ERC-8004 required for ERC-8183? No — explicitly independent.** Spec text: *"Agentic Commerce is intentionally minimal and does not embed a reputation system... implementations are RECOMMENDED to integrate with ERC-8004... "* — recommended, not required. BNB's own architecture doc corroborates this: each protocol package is "independently importable — no framework, registry, or required composition root." **Practical read for this hackathon:** you *can* run ERC-8183 jobs without ERC-8004 identity, but since the whole hackathon premise (8004scan-driven discovery feeding a marketplace) assumes agent identity exists, ERC-8004 registration is the intended on-ramp even though the two standards aren't technically coupled. — VERIFIED

**Critical cross-check, flagged in §14/§16:** BNB's own `apex-contracts` deployment (AgenticCommerceUpgradeable) and TermiX's AACP/`TermixEscrow` deployment (§9) both implement "ERC-8183"-shaped job/escrow semantics **on different, unconfirmed-to-be-related contracts**. A job created via `bnbagent-sdk`'s `ERC8183Client` almost certainly does **not** appear inside TermiX Market, and vice versa. Treat these as two separate commerce rails until proven otherwise.

---

## 7. Altana

This is the best-documented partner integration of the three, and the most load-bearing for the hackathon's own judging bar ("must show live onchain transactions in the Altana explorer").

**Hard requirements, verbatim from the hackathon tracks page:**
> "Agents on their own Altana wallets. Sessions with real limits: call allowlist, spend cap, expiry. Sessions registered in Keystore, so integration is read onchain rather than from the pitch. Real onchain transactions through a session key. Testnet counts, mainnet is stronger. User-facing control: a user can see what their agent may do, and revoke it, inside the product."

### Architecture — VERIFIED / PARTIALLY VERIFIED
- **Wallet:** an "Altana smart agentic wallet" — a smart-contract account, self-custodial, one address reused across BNB Smart Chain / Ethereum / Base. Confirmed to authorize via **ERC-1271** (`isValidSignature`), wrapping signatures as `innerSig ‖ keyHash ‖ prehash`. **ERC-4337 (account abstraction / UserOperations) is neither confirmed nor denied** — an earlier fetch pass hallucinated a "userOperation" reference that a targeted re-fetch of the same page did not corroborate; treat AA-standard compliance as genuinely UNKNOWN, not assumed.
- **Keystore:** a **public on-chain registry** recording which session keys currently have authority over a wallet — **audited by CertiK, completed 2026-07-15**, deployed identically on Ethereum/BSC/Base (cross-chain reads use an OP-Stack-style storage-proof cache for Base). This is a genuine on-chain source of truth, satisfying the hackathon's "read onchain rather than from the pitch" bar. — VERIFIED
- **Sessions (SDK, `client.grantSession(opts)`):**
```typescript
type ClientGrantSessionOptions = {
  wallet: Wallet; signer: Signer;
  permissions: SessionPermissions;  // .calls (allowlist), .spend ([{limit, period:"day", token}])
  expiry: number;                   // unix seconds
  sessionSigner?: Signer;
  register?: boolean;               // default true — writes to Keystore
  feeToken?: Address; chainId?: number;
};
```
- **Revocation:** `client.revokeSession()` — access-controlled, **monotonic** (a revoked key can never be reactivated). Reads (`isValidKey(user, keyId)`) are free, unlimited `eth_call`s. — VERIFIED
- **Explorer:** `explorer.altana.network` — appears to be a **Keystore-specific** explorer (live/revoked/expired key counts, per-chain breakdown, a registration/revocation activity feed with tx hashes/fees), not necessarily a full general-purpose transaction explorer. **UNKNOWN** whether this is the same surface as a docs-nav `/explorer` link or two different pages — worth confirming which one judges actually check.
- **SDK:** TypeScript, `npm install @altananetwork/sdk viem`. Confirmed exports: `createClient({chains:[BNB]})`, `createPasskeyWallet()`, `createWallet({signer})`, `signerFromPrivateKey()`, `grantSession()`, `execute()` (session-key or admin-key calls), `revokeSession()`, `balances()`, `recoverFromPasskey()`.
- **Related packages in the same monorepo:** `@altananetwork/mcp` (general MCP server), `@altananetwork/x402-server` (seller side of x402), `@altananetwork/hypersigner-keystore-mcp` (a **separate**, non-custodial MCP server that only verifies/registers/timeboxes/revokes keys — never holds a key or signs). Don't conflate the two MCP packages.
- **MCP install:** `claude mcp add altana -- bunx @altananetwork/mcp` (requires Bun ≥1.1); `ALTANA_CHAIN` env var selects network (default BNB mainnet 56). Tool count reported inconsistently across fetches (17 vs 20) — **verify by actually installing it.**

### Production skills — VERIFIED (pulled the raw JSON from `skills.altana.network` directly)

| Skill | In-scope contracts | Spend cap | May / May not |
|---|---|---|---|
| PancakeSwap Trading | V2 Router, WBNB, USDT | 50 USDT | Trade only, no other tokens/apps |
| Four.meme Trading | TokenManager2/Helper3 | 0.1 BNB | Buy/sell curves only |
| PancakeSwap Liquidity | V2 Router, pair tokens | 50 USDT | Add/remove liquidity only |
| Copy Trade | V2 Router, traded tokens | 50 USDT | Per-trade + total cap; cannot follow un-authorized wallets |
| Venus Lending | vUSDT market, USDT | 100 USDT | **Supply/withdraw only — no borrow defined** |
| x402 API Payments | Permit2, USDT | 25 USDT | Per-request + total budget |
| Lista Liquid Staking | StakeManager, slisBNB | 0.5 BNB | Stake/request-withdraw only |
| Aave V3 Lending | Aave V3 Pool, USDT | 50 USDT | **Explicit "mayNot: Borrow" — supply/withdraw only** |
| Token Radar | none (read-only) | none | Research only, no transactions |
| Wallet Tracker | none (read-only) | none | Research only, no transactions |

**ANALYSIS (ours, not a doc claim) — mapping to the four categories:**
- **Rebalancing:** PancakeSwap Trading + PancakeSwap Liquidity give execution primitives; rebalance *decision* logic (when/how to move a range) is entirely ours to build, on top of `session_execute`.
- **Grid Trading:** weakest fit — only PancakeSwap Trading as an execution primitive, Token Radar for price screening. No skill implements grid/ladder logic; this is fully custom logic on raw session-key execution.
- **Yield Optimisation:** strongest fit — Aave V3, Venus, Lista are explicitly yield-framed skills.
- **Health Factor Monitoring — a genuine, confirmed gap.** Both lending skills are scoped supply/withdraw-only with borrowing explicitly excluded. **No Altana skill exposes borrow-side positions or health-factor data.** To build this category for real, we must read Aave V3 / Venus contracts' own view functions directly (health factor, collateral, debt) — outside any Altana-provided skill. This is actually good news competitively: it's real, defensible engineering work a shallow submission won't have done, and it's the natural flagship category (see §1, §10).

### ERC-8183 buyer-side + x402 (VERIFIED)
- Altana ships **both buyer and seller** ERC-8183 SDK sides. Buyer flow: `createJob → registerJob (binds dispute policy) → setBudget → approve → fund`; helper functions `hireErc8183Agent()`, `getErc8183Job()`, `getErc8183DeliverableUrl()`, `settleErc8183Job()`, `buildClaimRefundCall()`. Escrow currency referred to only as "$U" in docs — its literal token identity is **UNKNOWN**, but note this may plausibly be the same payment-token pattern seen in `apex-contracts` (§14) — unconfirmed, flag before assuming equivalence.
- x402 server: `createX402Merchant()` + `guard()` middleware, settlement via **EIP-3009** or **Permit2** (USDT), supports both raw-EOA and ERC-1271 (smart-account) buyer signatures.

---

## 8. PancakeSwap

**Track requirement is outcome-based, not integration-checklist-based:** *"deliver a real benefit to PancakeSwap traders or liquidity providers... smarter liquidity management, finding better yields... or executing safe automated swaps... without ever putting user funds at risk."* No specific SDK/contract is mandated. Prize: 1,000 CAKE.

| Claim | Status | Detail |
|---|---|---|
| SDKs (versions confirmed live on npm registry) | VERIFIED | `@pancakeswap/sdk` 5.9.1, `@pancakeswap/v3-sdk` 3.10.1, `@pancakeswap/smart-router` 7.7.0 |
| "No integration required" for agents | VERIFIED (direct quote, docs.pancakeswap.finance) | *"PancakeSwap requires no integration for this to work. V3 pools and farms are permissionless smart contracts."* This is the single most useful line for hackathon planning — it means the whole PancakeSwap challenge can be satisfied purely through direct contract calls, no partnership/API-key process needed. |
| Named agent patterns in official docs | VERIFIED | **Range Rebalancing** (monitor LP position, withdraw/re-mint near range edge), Farm APR Routing, Swap/Quote Bots. Contracts named: `NonfungiblePositionManager`, `SmartRouter`, `MasterChefV3`, V3 Quoter, Permit2. |
| Rebalancing is NOT atomic | VERIFIED (direct quote) | *"There is no atomic 'rebalance' function. Moving a range is a composed sequence (remove → collect → mint). Removal and the new mint happen in separate transactions."* Directly shapes our Rebalancing category's transaction design — it must handle a multi-step, partially-completable flow, not a single call. |
| Farmed-position nuance | VERIFIED | Must `MasterChefV3.withdraw()` before removing liquidity; `safeTransferFrom()` to restake after minting; unfarmable pools revert `InvalidPid`. |
| Safety guidance (explicit, in docs) | VERIFIED | Scope Permit2 approvals tightly (never unbounded), real non-zero slippage minimums ("a zero minimum is an open invitation to sandwich bots"), short tx deadlines (~5 min). |
| Mainnet V3 addresses | PARTIALLY VERIFIED | Found via independent BscScan index snippets (not PancakeSwap's own address page directly, which blocked automated fetch): Factory `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`, Smart Router `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`, Swap Router `0x1b81D678ffb9C0263b24A97847620C99d213eB14`, Pool Deployer `0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9`, Position Manager (NFT) `0x46a15b0b27311cedf172ab29e4f4766fbe7f4364`, Universal Router 2 `0xd9c500dff816a1da21a48a732d3498bf09dc9aeb`. **Re-confirm every one of these directly against `developer.pancakeswap.finance/contracts/v3/addresses` before wiring them into code** — this report could not independently verify them against PancakeSwap's own canonical table (403 on fetch). |
| **BSC testnet V3 feasibility** | **UNKNOWN — material planning risk** | No currently-live, PancakeSwap-published V3 (concentrated liquidity) testnet address table was found. V2 (non-concentrated) testnet addresses exist but are unusable for a Rebalancing agent that needs tick ranges. The V3 contracts repo supports deploying to `bscTestnet` as a build target, which is not the same as "a maintained public testnet deployment exists today." **Plan for a mainnet demo with small real funds, or a local mainnet-state fork (Hardhat/Anvil), rather than assuming testnet V3 works** — confirm this directly and early, since it gates whether Rebalancing/Grid Trading can be demoed without real capital. |
| PancakeSwap Infinity (v4-equivalent) | VERIFIED existence / UNKNOWN deployment status | Hooks-based architecture confirmed in docs (Singleton, Flash Accounting, Hooks, native token support, ERC-6909, `donate()`). Deployment status and addresses not confirmed — not needed for MVP. |

**Smallest real integration surface (both categories can share this):**
- Grid Trading: RPC + `@pancakeswap/v3-sdk`/`@pancakeswap/smart-router` for routing/price + direct calls to the SwapRouter contract. No PancakeSwap-hosted API required.
- Rebalancing: RPC + `@pancakeswap/v3-sdk` for tick/price math + direct `NonfungiblePositionManager` calls (decrease→collect→burn→mint) + `MasterChefV3` if farmed + optional SmartRouter swap to fix token ratio pre-mint.

---

## 9. TermiX

**Verbatim track requirements (bnbchain.org tracks page):** Prizes $6,000/$3,000/$1,000. Judging: Value of services 30%, Proven agent advantage 30%, High-stakes categories & track record 20%, Marketplace quality 20%. Hard eligibility line: **"Agents surfaced on your marketplace must be live on BSC."** Required deliverable: the **Agent Advantage Report** — ≥3 real tasks run both with and without an agent hired through our marketplace, each reporting time/cost/output-quality with actual outputs attached, at least one task from trading/stock/security. No TermiX-specific guidance exists anywhere on report structure/format beyond this text (confirmed absent, not merely unsearched).

### What TermiX actually is
- **TermiX Market** = the marketplace UI (listings, requests, orders, bounties, disputes). Built on **AACP** ("Agent Autonomous Commerce Protocol"), documented via a public whitepaper on GitHub (`TermiX-official/aacp-whitepaper`). **agent.family** appears to be a related consumer-facing app/brand (confirmed linked from termix.ai's own nav; a July 2026 press piece describes it as "BNB Chain Agent.family Release" tied to TermiX's mainnet launch) — the precise institutional relationship between "TermiX," "AACP," "agent.family," and "CryptoClaw" (a name that appears in the whitepaper's own integration section, describing an existing tool system AACP interoperates with) is **not stated in one authoritative place** — worth a direct check before naming any of these in the submission.
- Two GitHub repos under `TermiX-official` (`bsc-mcp`, `binance-mcp`) are real MCP servers, but they're blockchain-operations tools (transfers, swaps, exchange trading) — **unrelated** to agent listing/hiring. Don't conflate.

### Discovery/listing — the critical gap
**No mechanism exists for TermiX to crawl 8004scan, ingest a manifest, or pull in agents from an external registry.** Confirmed absent across the full public doc index, not merely unsearched. The only documented path to becoming hireable on TermiX is to **register directly through TermiX's own API**:
1. `GET /api/v1/agents/name-availability?name=...`
2. `POST /api/v1/agents/prepare` — submit `name`, `displayName`, `category` (fixed 8-value enum), `tags`, `description` → backend returns an unsigned mint intent.
3. Client signs/broadcasts; poll `GET /api/v1/agents/by-tx/:txHash` until `CONFIRMED` — agent now holds an ERC-8004 NFT and is listed.

**Practical implication:** there is no "push our registry to TermiX" integration to build. To have agents live on TermiX, **each agent must be registered a second time, directly through TermiX's flow** — our marketplace becomes the orchestration layer in front of agents that are also independently TermiX-registered, not a feed TermiX subscribes to.

### Hiring/payment
Identity = ERC-8004 NFT + Reputation Registry. Escrow = ERC-8183-shaped job flow **extended by AACP** with a staking layer (own `AACPHook`/`AACPStaking`), settled in **USDC or USDT on BNB Chain (56) and Base (8453)** via a distinct `TermixEscrow` contract (e.g. USDC rail on BNB Chain confirmed at `0x6A52ba4C84b348FaEAe13dDC7A97b4F6af23913C`). **Not x402-based** (zero hits for "x402" anywhere in the whitepaper). Six-plus states: Open→Funded→Submitted→Completed/Rejected/Expired, plus Disputed→Arbitrated for the escalation path. Fee split on completion: 2% platform + 3–4% evaluator, remainder to provider.

### Evaluator role
Operator-granted (not self-assigned), sits on a 3-seat panel for challenged deliveries; **blind evaluation** — sees job spec, pre-committed verification rubric, and the deliverable, but provider identity/reputation is hidden until after scoring. Disputes escalate to a VRF-seeded 3-arbitrator pool (reputation ≥90, ≥50 completed jobs, no financial relationship to either party).

**UNKNOWNs to resolve directly with TermiX (Discord/devrel) before building:** whether external marketplaces can ever list agents without each independently minting a TermiX NFT; live status of zkVM/TEE verification vs. the simpler rubric path; exact relationship between TermiX/AACP/agent.family/CryptoClaw; API rate limits (undocumented); exact hour/timezone the Sep 9 close actually happens.

---

## 10. Four Agent Categories

Hackathon page's own one-line definitions: **Rebalancing** — "manages LP ranges, resets positions automatically." **Grid Trading** — "places and manages automated grid orders." **Yield Optimisation** and **Health Factor Monitoring** are named but not further defined on the page itself beyond the brief's own working descriptions.

### 10.1 Rebalancing
- **Functionality:** monitor a PancakeSwap V3 LP position's tick range vs. current pool tick; when price drifts near/past the range edge, close and re-mint a new range.
- **Required data:** position (`NonfungiblePositionManager.positions(tokenId)`), pool current tick (`slot0`-equivalent), farm status (`MasterChefV3`).
- **Protocols:** PancakeSwap V3 only for MVP.
- **Transactions:** `decreaseLiquidity → collect → burn` (+ optional swap to rebalance token ratio) → `mint` new position; `MasterChefV3.withdraw/restake` if farmed. Multi-tx, not atomic (§8).
- **Complexity:** Medium-high (tick math, multi-step sequencing, partial-failure handling).
- **Testnet:** UNKNOWN/unconfirmed live V3 testnet deployment — plan mainnet-small-funds or local fork.
- **Mainnet:** feasible; addresses need re-verification at build time (§8 table).
- **Risks:** slippage/sandwich exposure if minimums are set to zero (explicitly warned against in PancakeSwap's own docs); multi-tx flow can leave a position in an intermediate state if the agent crashes mid-sequence — needs idempotent resume logic.
- **Recommended MVP scope:** single pool (e.g. WBNB/USDT), fixed rebalance-trigger threshold (e.g. tick drifts >X% from range center), manual "confirm" step visible in UI showing all three/four sub-transactions before signing via an Altana session.

### 10.2 Grid Trading
- **Functionality:** place a ladder of buy/sell trigger levels around current price; execute a swap when price crosses a level.
- **Required data:** live price/pool state (on-chain read, since PancakeSwap's own hosted subgraph/API status is unconfirmed — §8).
- **Protocols:** PancakeSwap V2/V3 swap execution.
- **Transactions:** simple `SwapRouter` calls per triggered level; no PancakeSwap-side grid primitive exists — the ladder/state machine is entirely ours.
- **Complexity:** Medium (grid logic is straightforward; execution reliability and gas/slippage handling matter more than protocol depth).
- **Testnet:** same V3 testnet caveat as Rebalancing if using concentrated pools; V2 testnet swaps are more reliably available if the design uses simple pairs instead.
- **Mainnet:** feasible, low capital needed per trade if bounded tightly.
- **Risks:** this is the category most likely to become "a bot pretending to be a grid" if under-built — weakest-fit category per Altana's own skill catalog (§7); needs real, visible price-trigger logic and real executed trades to avoid being the shallowest of the four.
- **Recommended MVP scope:** one pair, N fixed grid levels within a bounded range, spend-capped via an Altana session, visible per-level fill history.

### 10.3 Yield Optimisation
- **Functionality:** compare yield across supported protocols (Aave V3, Venus, Lista per Altana's skill catalog), reallocate to the highest real APY within policy limits.
- **Required data:** protocol-reported supply APY (each protocol's own view functions/contracts — no single BNB-official oracle for this was found; §14).
- **Protocols:** Aave V3 Lending, Venus Lending, Lista Liquid Staking — all three already have Altana skills scoped supply/withdraw-only, which fits this category cleanly (no borrow needed).
- **Transactions:** withdraw from protocol A → supply to protocol B, both real on-chain lending calls, all executable through existing Altana skills without new contract scoping.
- **Complexity:** Medium — mostly a comparison/decision engine; execution primitives already exist via Altana skills.
- **Testnet/Mainnet:** both plausible; Aave V3 and Venus are established BSC deployments — testnet availability for Aave V3/Venus needs a direct check (not covered by this pass — same-day verification task).
- **Risks:** APY comparison across protocols needs a real, defensible calculation (not an LLM guess) — treat each protocol's own reported rate as source data, and clearly label anything computed (blended/projected yield) as derived, per §11's data provenance rule.
- **Recommended MVP scope:** two-protocol comparison (e.g., Aave V3 vs. Venus on the same asset), single reallocation trigger rule, full transaction visible pre-sign.

### 10.4 Health Factor Monitoring (recommended flagship)
- **Functionality:** read a user's lending position (collateral, debt, liquidation threshold) from a lending protocol directly, compute/display health factor, alert and optionally take a protective action (e.g., partial repay) as risk rises.
- **Required data:** collateral/debt/liquidation-threshold view functions read **directly from the lending protocol's own contracts** (Aave V3 / Venus) — **confirmed NOT available through any Altana skill**, since both lending skills are scoped supply/withdraw-only with borrowing explicitly excluded (§7). This is real, protocol-level integration work, not skill composition.
- **Protocols:** Aave V3 and/or Venus (both live on BSC).
- **Transactions:** read-only for the monitoring/alerting core (zero risk, always demoable); an optional protective-action tier (e.g., auto-repay to restore health factor above a threshold) is a real transaction, gated behind the same Altana session/spend-cap/allowlist machinery as the other three categories.
- **Complexity:** Medium for read-only monitoring, higher for the protective-action tier (needs careful spend-cap and allowlist scoping since it's touching borrow-side state that Altana's shipped skills deliberately avoid).
- **Testnet:** likely the easiest category to demo on testnet, since the core value (reading + alerting) needs no transaction at all — verify Aave V3/Venus testnet contract availability directly.
- **Mainnet:** straightforward for reads; protective-action tx needs the same real-funds caveat as the other categories.
- **Risks:** lowest execution risk of the four (read-only core), but requires getting the health-factor math exactly right — this is a place where an LLM-invented formula would be actively dangerous; use the protocol's own on-chain health-factor view function/formula, never a re-derived approximation.
- **Recommended MVP scope:** read-only dashboard (real health factor, real liquidation threshold, real collateral/debt) for a connected wallet on Aave V3 BSC, with a threshold-triggered alert; protective auto-repay as a stretch goal once the read path is solid. **This is the strongest "flagship" candidate**: zero-risk to demo, most clearly differentiated from what Altana's skills already give competitors for free, and directly matches TermiX's own "trading/stock/security" Agent Advantage Report requirement.

---

## 11. Data Model

Distinguish three tiers for every field: **SOURCE** (read verbatim from chain/8004scan/protocol — never computed), **DERIVED** (our deterministic scoring/aggregation over source data), **USER-GENERATED** (entered by the marketplace's own users — reviews, manual tags). An LLM must never originate a SOURCE or DERIVED value; it may only summarize them in natural language for display.

| Entity | Key fields | Tier | Actual source (per this recon) |
|---|---|---|---|
| AgentIdentity | agentId, agentURI, owner, name, description, services[] | SOURCE | ERC-8004 Identity Registry (on-chain) + resolved agentURI JSON (§5) |
| AgentEndpoint | name (web/A2A/MCP/...), url, version | SOURCE | `services[]` array inside the agentURI JSON (§5) |
| AgentCapability | declared capability tags | SOURCE (raw tags) / DERIVED (any normalized taxonomy we build) | 8004scan's documented fields are thin here — capability filtering is **not confirmed to exist** as an actual API parameter (§12); category taxonomy will likely need to be ours |
| AgentReputation | raw feedback entries (value, tags, revoked flag) | SOURCE | ERC-8004 Reputation Registry (on-chain) or 8004scan `/feedbacks` |
| AgentReputation (score) | aggregated score | DERIVED | Our own scoring engine — protocol explicitly leaves aggregation off-chain/out of scope (§5); do not present 8004scan or on-chain data as if it already contains "the" reputation score unless 8004scan's own docs confirm a scoring field (unresolved — §12) |
| AgentExecution | job id, state, timestamps, tx hashes | SOURCE | ERC-8183/apex-contracts Job struct (on-chain) — **note two separate deployments exist (§6, §9), record which rail each job came from** |
| AgentPerformance | success rate, avg time, avg cost | DERIVED | Computed from our own AgentExecution records only — never invented |
| AgentPermission / AgentSession | call allowlist, spend cap, expiry, revoked | SOURCE | Altana Keystore (on-chain registry, §7) — this is the one place the brief's "on-chain source of truth vs. marketplace cache" distinction is unambiguous: Keystore IS the source, our DB is a cache |
| AgentPricing | declared price/quote | SOURCE (if declared on-chain/agentURI) or USER-GENERATED (if agent operator sets it in our UI) | Depends on whether the agent declares pricing via ERC-8183/x402 quote flows or only within our own listing form — verify per integration |
| AgentBenchmark (Advantage Report data) | task, time, cost, output, with/without-agent | USER-GENERATED (the task run) / SOURCE (the tx/execution logs backing it) | Our own instrumented task runs (§17) — must be real, logged executions, never fabricated numbers |

**Marketplace cache vs. on-chain source of truth — explicit split:**
- **Canonical on-chain:** agent identity/agentURI, raw feedback/validation records, session/Keystore state, job/escrow state, all transaction hashes.
- **Our cache/index:** search index, normalized categories, computed scores, UI-facing aggregates, benchmark history. Cache must be invalidateable/refreshable against the chain at any time — never treated as more authoritative than a live read.

---

## 12. Agent Score

**Do not implement a single opaque "Agent Score" yet.** Only these signals are objectively measurable from what this recon actually confirmed exists:

| Signal | Measurable? | Source |
|---|---|---|
| Raw feedback (value/tags) | Yes | ERC-8004 Reputation Registry / 8004scan `/feedbacks` |
| Feedback volume | Yes | Count of above |
| Execution success rate | Yes, but only for jobs run through our marketplace (or independently indexed apex-contracts job events) | Our own AgentExecution log |
| Activity recency | Yes | Timestamps on the above |
| Capability match to category | Partially — no confirmed capability-filter field exists in 8004scan's documented API (§6 topic 3); would need our own tag normalization over agentURI `services[]`/description | Ours (derived) |
| Cost | Yes, once quote/x402/job-budget data is captured | ERC-8183 job budget or x402 quote |
| Data completeness | Yes (structural — does the agent's agentURI have all recommended fields) | Ours (derived) |
| On-chain validation records | Yes (raw) | ERC-8004 Validation Registry |

**Recommendation:** ship a **generic score** built only from feedback volume + feedback value average + execution success rate + data completeness — all objectively computable, no arbitrary weight invented without evidence (start 25/25/25/25 explicitly labeled as an initial, adjustable weighting, not a discovered truth). Add a **category-specific score** later only once each category has enough real executions logged to make success-rate meaningful per category — don't fake it with global data before then.

---

## 13. Security Architecture

Default-deny chain, mapped to actual enforcement points found in this research:

| Layer | Enforced where | Status |
|---|---|---|
| Protocol/contract allowlist | Altana session `permissions.calls` | **On-chain** (Keystore) — VERIFIED mechanism |
| Contract/function allowlist | Same `permissions.calls` field | **On-chain** (Keystore) |
| Token/asset allowlist | Implicit in `permissions.calls` (scoped to specific token contracts per skill, e.g. Aave skill scoped only to its Pool + USDT) | **On-chain**, per Altana's skills catalog (§7) |
| Amount/spend cap | `permissions.spend` ({limit, period, token}) | **On-chain** (Keystore) |
| Session expiry | `expiry` (unix), auto-expiring, no tx needed | **On-chain** |
| Revocation | `revokeSession()`, monotonic | **On-chain** |
| User permission/visibility | Reading session state via `isValidKey()` / the Altana explorer | **On-chain read**, surfaced in our UI |
| LLM proposes action | Our agent runtime (Claude/BNB Agent SDK) | **Off-chain**, must never be the last check |
| Policy engine / final gate before signing | Our backend, wrapping every `execute()` call through the already-scoped Altana session — the session itself is the actual enforcement backstop, not just our backend's discretion | **Off-chain orchestration, on-chain enforcement** |

**Key insight:** unlike a typical "trust the backend" security model, Altana's session design means the **hard security boundary is genuinely on-chain** (Keystore-enforced allowlist/cap/expiry) — even if our backend or the LLM is compromised or misbehaves, a session key literally cannot call outside its allowlist, spend past its cap, or act past its expiry, because the smart-contract wallet itself checks this on every `execute()`, not just our application layer. Our backend's job is to *choose* narrow, correct scopes when granting sessions — not to be the last line of defense.

---

## 14. On-chain / Off-chain Architecture

| Data/logic | Where | Evidence |
|---|---|---|
| Agent identity (agentId, agentURI, wallet) | **On-chain** | ERC-8004 Identity Registry (§5) |
| Session permissions (allowlist/cap/expiry/revocation) | **On-chain** | Altana Keystore (§7) |
| Job/escrow lifecycle + payment | **On-chain** | apex-contracts `AgenticCommerceUpgradeable` (BNB rail) or TermiX `TermixEscrow` (TermiX rail) — **two separate rails, see §6/§9** |
| Raw feedback/validation records | **On-chain** | ERC-8004 Reputation/Validation Registries |
| DeFi transactions (swaps, LP mint/burn, lending supply/withdraw, repay) | **On-chain** | PancakeSwap V3, Aave V3, Venus, Lista contracts directly |
| Search index / capability normalization | **Off-chain** | Ours, since no confirmed capability-search field exists upstream (§6) |
| Cached agent metadata (for fast UI) | **Off-chain cache of on-chain source** | Refresh against chain/8004scan on a schedule; never the write path |
| Ranking / scoring | **Off-chain** | Ours, computed only from source data (§12) |
| Analytics / benchmark aggregation (Advantage Report) | **Off-chain** | Ours, backed by real logged executions |
| UI state, recommendation copy | **Off-chain** | Ours |

**Verified contract addresses (apex-contracts, raw README, `bnb-chain` org-owned repo) — pull `scripts/addresses.ts` fresh at build time rather than hardcoding from this table:**

| Contract | BSC Testnet (97) | BSC Mainnet (56) |
|---|---|---|
| AgenticCommerceUpgradeable | `0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE` | `0xEa4DAa3100A767e86FDed867729ae7446476EBA6` |
| EvaluatorRouterUpgradeable | `0xd7d36d66d2f1b608a0f943f722d27e3744f66f25` | `0x51895229E12F9876011789B04f8698af06cCD6DA` |
| OptimisticPolicy | `0x4f4678d4439fec812ac7674bb3efb4c8f5fb78a6` | `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5` |
| Payment token | `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565` | `0xcE24439F2D9C6a2289F741120FE202248B666666` |

Note: testnet `OptimisticPolicy` runs a deliberately **shorter dispute window** than mainnet, per the repo's own README — don't assume timing parity when testing.

---

## 15. Architecture Options

### Option A — Single Node/TypeScript monolith (backend + agent runtime + BFF), Next.js frontend
- **Advantages:** one language across the whole stack (matches `@bnbagent/sdk`, `@altananetwork/sdk`, `@pancakeswap/*` all being TS-first); simplest deployment; fastest to MVP; smallest surface area to secure.
- **Disadvantages:** background job execution (grid triggers, rebalance monitoring, health-factor polling) competing with request handling unless a worker process is split out early.
- **Complexity:** low. **Integration risk:** low (everything needed is TS-native). **Scalability:** adequate for a hackathon demo; would need a real queue for production. **Time to MVP:** fastest of the two options.
- **Security:** all signing still routed through Altana sessions regardless of monolith vs. split — no weaker than Option B here.

### Option B — Python agent-runtime services (using `bnbagent` Python SDK) + separate Node/Next.js frontend + Postgres
- **Advantages:** if the team wants to lean on `bnbagent` Python SDK's ERC-8004/ERC-8183 wrappers directly (both languages are supported per §4) plus any Python-side data/ML tooling for scoring.
- **Disadvantages:** the Altana SDK and its MCP servers are **TypeScript-only** (§7) — a Python runtime would need to shell out to or wrap a TS process for session/Keystore operations, adding a cross-language boundary exactly at the most security-critical layer (signing). More moving parts, more integration risk, slower to MVP with 19 days left.
- **Complexity:** medium-high. **Integration risk:** medium-high (cross-language boundary at the signing layer). **Time to MVP:** slower.

### Recommendation: **Option A** — one TypeScript codebase (Next.js frontend + Node backend/agent-runtime, a small worker process for polling/monitoring loops), Postgres for the marketplace index/cache, all four categories sharing one execution/session core.

Rationale: every partner SDK that touches the signing/session/security-critical path (`@altananetwork/sdk`, `@bnbagent/sdk`'s JS build, `@pancakeswap/*`) is TypeScript-native; Python only adds value if the team specifically wants `bnbagent`'s Python ergonomics, which isn't worth a cross-language security boundary with 19 days left. This is a time-and-risk call, not a language-preference call.

---

## 16. Technology Stack

| Layer | Recommendation | Why |
|---|---|---|
| Frontend | Next.js (React), TypeScript | Fast to build, matches BNB Agent Studio's own scaffolding conventions (React seller-agent templates referenced in demo docs) |
| Backend/agent runtime | Node.js/TypeScript, a small worker process (BullMQ or a simple cron-style loop) for grid/rebalance/health-factor polling | Keeps the signing-critical path in one language; worker separates polling load from request handling |
| Database | PostgreSQL | Standard, well-supported or cache/index layer described in §11/§14 |
| Blockchain client | `viem` (required peer dep of `@altananetwork/sdk`) | Already the mandated dependency for the Altana SDK — don't introduce a second client library (ethers/web3.py) unless something specifically needs it |
| Identity/commerce | `@bnbagent/sdk` (TS build) for ERC-8004/ERC-8183 | Official BNB SDK; use its network config rather than hardcoding addresses (§4) |
| Wallets/sessions | `@altananetwork/sdk` | Only documented way to satisfy the hackathon's own Altana judging bar (§7) |
| DeFi execution | `@pancakeswap/v3-sdk`, `@pancakeswap/smart-router` for PancakeSwap; direct contract calls (via viem) for Aave V3/Venus/Lista | No official SDKs found for Aave V3/Venus/Lista integration beyond their own public contract ABIs — use viem + public ABIs directly |
| Discovery/indexing | 8004scan Pro API (free for hackathon participants — sign up via the Pro-Tier Upgrade Form, §6) for identity/feedback/ownership reads; supplement with direct on-chain reads for anything 8004scan's documented API doesn't cover (capability filtering, exact response schema — both unconfirmed, §6) | Only real, documented discovery layer beyond raw chain reads |
| Agent scaffolding / MCP | BNB Agent Studio `bag` CLI, once install method is confirmed locally (§3) | For scaffolding/registering our own agents; Claude Code MCP wiring needs local verification of the `--transport stdio` flag before depending on it |
| TermiX integration | Direct registration through TermiX's own 3-step agent API (§9), separate from our core marketplace registry | No ingestion path exists; this is an additive integration, not a shared one |

---

## 17. Blockers / Risks

| Risk | Severity | Detail |
|---|---|---|
| Two separate "ERC-8183" contract deployments (apex-contracts vs. TermiX AACP/TermixEscrow), no documented bridge | **CRITICAL** | Directly affects whether a single job/hire flow can satisfy both the main marketplace and the TermiX track simultaneously — assume it can't, and build TermiX as a separate registration path (§9). **Refinement, §22:** this holds for the *commerce/job* layer specifically — the *identity* layer may not be as separate (a live-sampled TermiX agent was found registered on the same base ERC-8004 registry contract). |
| ~~BNB Agent Studio install method conflict (npm vs pip) and unconfirmed `mcp serve --transport stdio` flag~~ | **RESOLVED, §22** | `npm i -g @bnbagent/studio-cli` (v0.0.12) is the working install. `bag mcp serve` **does not exist** — confirmed by direct invocation. Claude Code integration is via `bag skills install` (drops `.claude/skills/`, driven by a `/bnbagent-studio` slash command), not a standalone MCP server. |
| ~~PancakeSwap V3 testnet deployment status unconfirmed~~ | **RESOLVED, §22** | Confirmed live via direct `eth_getCode` on BSC testnet: Factory, PoolDeployer, NonfungiblePositionManager, SwapRouter, SmartRouter, MasterChefV3, QuoterV2, TickLens all have real deployed bytecode. Full address table in §22. |
| 8004scan capability-search / response schema / auth header undocumented (JS-rendered docs page unreachable) | **MEDIUM** | Limits how sophisticated discovery/filtering can be at launch; capability filtering may need to be built client-side over raw agent records |
| ERC-8004 status is Draft, not ratified | **MEDIUM** | Affects how we describe the standard in the submission narrative — don't claim it's finalized; judges may know this |
| Altana's lending skills exclude borrow-side data entirely | **MEDIUM** (also an opportunity, §10.4) | Health Factor Monitoring must be built directly against Aave V3/Venus contracts, not composed from Altana skills |
| **NEW, §22:** `bnbagent` pip package (v0.4.3) hardcodes a dead default BSC-testnet RPC (`data-seed-prebsc-2-s2.binance.org`) — `ERC8004Agent`/`ERC8183Client` fail to construct out of the box | **MEDIUM** | Verified workaround: set env var `RPC_URL_BSC_TESTNET` (or global `RPC_URL`) before instantiating, per the documented override precedence in `bnbagent/config.py`. Must be set in every deploy/runtime environment, not just noted once. |
| **NEW, §22:** ERC-8004 registry is real but overwhelmingly populated with test/placeholder registrations, not genuine differentiated third-party agents | **MEDIUM** | Directly affects any "agents compete" demo narrative — do not assume the registry can supply real competitors; see §22 and updated §20. |
| ~~ERC-8004 registry contract address not statically published (dynamic/env-resolved in SDK)~~ | **RESOLVED, §22** | Testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e`, mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` — read directly from `bnbagent/config.py` source (not the `networks` module, which omits them). |
| ~~"$U" token identity in Altana's ERC-8183 buyer flow unconfirmed~~ | **RESOLVED, §22** | Confirmed from a live `bag init` scaffold's `studio.toml`: testnet `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`, mainnet `0xcE24439F2D9C6a2289F741120FE202248B666666` — matches apex-contracts' payment token exactly. |
| Hackathon page's own "Phase 2" timeline details were not readable during this pass | **LOW** | Someone should open the live tracks page in an actual browser to confirm exact post-submission dates |

---

## 18. Unknowns Requiring Testing

1. ~~Whether `npm install -g @bnbagent/studio-cli` or `pip install bnbagent-studio` is the current, working `bag` CLI (§3).~~ **RESOLVED, §22** — npm package, v0.0.12.
2. ~~Whether `bag mcp serve --transport stdio` is a real, stable flag (§3).~~ **RESOLVED, §22** — it isn't real; see §22 for the actual Claude Code integration mechanism.
3. ~~Whether PancakeSwap V3 (concentrated liquidity) has a live, current BSC testnet deployment (§8).~~ **RESOLVED, §22** — yes, full address table verified live.
4. 8004scan's exact response schema, pagination parameters, and API-key header name (the `/developers/docs` page is JS-rendered and was unreachable via automated fetch) (§6). *(Still open — this pass bypassed 8004scan entirely by reading the registry contract directly; see §22.)*
5. Whether 8004scan's API actually supports capability/category filtering as a queryable parameter, vs. only the confirmed `q` semantic-search param (§6). *(Still open.)*
6. ~~Literal default `ERC8004_REGISTRY_ADDRESS` value baked into `bnbagent-sdk` per network (§4).~~ **RESOLVED, §22** — read directly from `bnbagent/config.py`.
7. Whether `BRC8004/brc8004-contracts` is the actual registry bnbagent-sdk resolves to (§4). *(Still open — not re-checked this pass.)*
8. Altana explorer surface: is `explorer.altana.network` the same thing as the docs-nav `/explorer` link (§7)? *(Still open.)*
9. ~~Literal identity of the "$U" settlement token in Altana's ERC-8183/x402 flows (§7).~~ **RESOLVED, §22.**
10. Whether Aave V3 and Venus have usable BSC testnet deployments for the Health Factor Monitoring category. *(Still open — out of scope for this pass, which focused on PancakeSwap/CLI/SDK.)*
11. Exact relationship between "TermiX," "AACP," "agent.family," and "CryptoClaw" (§9). *(Still open, though §22 found one live TermiX-registered agentId sharing the base ERC-8004 registry — a partial data point, not a full answer.)*
12. Whether external marketplaces can ever list agents on TermiX without each independently minting a TermiX-issued ERC-8004 NFT (§9). *(Still open.)*
13. **NEW:** How many genuinely distinct, capability-differentiated third-party agents actually exist on BSC (any network) vs. test/placeholder noise — §22's sampling was a handful of testnet IDs, not a systematic survey. Directionally answered (noise-dominated) but not exhaustively.

---

## 19. Recommended MVP

Must exist for a competitive submission, in priority order:

1. **Health Factor Monitoring**, read-only core: real health factor/collateral/debt for a connected wallet on Aave V3 (BSC), computed from the protocol's own contracts, with a threshold alert. Zero-transaction risk, always demoable, hardest for a shallow competitor to replicate.
2. **One real Altana-session-gated DeFi transaction**, end to end, visible in the Altana explorer — this single flow (grant session → execute a scoped swap or lending action → show it on-chain) satisfies the Altana track's hard bar and should be reused across whichever category demos it first.
3. **ERC-8004 registration + 8004scan-backed discovery** for whatever agents the marketplace lists — even a short list of 3-5 real registered agents beats a fake directory.
4. **Yield Optimisation**, using the already-available Aave/Venus/Lista Altana skills directly — cheapest category to make real given existing skill scoping.
5. **Rebalancing and Grid Trading**, built on direct PancakeSwap contract calls (no partnership needed) — can share one execution core (swap primitive) with different decision logic on top.
6. **TermiX registration** of our agents through TermiX's own API, once the core marketplace works — additive, not blocking.
7. **Agent Advantage Report**, generated from real logged executions the marketplace already produces by #1-#5 (see §20 task 5) — at least one task must be trading/security-flavored, which Health Factor Monitoring or Rebalancing naturally satisfies.

---

## 20. What NOT to Build

- **Do not build a fifth, generic "chat with any agent" feature** — not required by any track, and dilutes focus from the four categories that are actually judged.
- **Do not attempt deep TermiX protocol integration** (staking, VRF arbitration, custom evaluator contracts) — undocumented and likely unstable to build against in 19 days; direct registration through their existing API is sufficient (§9).
- **Do not build a custom reputation-aggregation algorithm before real feedback data exists to test it against** — ship the simple, evenly-weighted generic score first (§12).
- **Do not attempt to implement Grid Trading or Rebalancing against PancakeSwap Infinity (v4-equivalent)** — deployment status/addresses unconfirmed; stick to V3, which is documented and (on mainnet) address-confirmable.
- **Do not build our own arbitrage/dispute-resolution logic for ERC-8183 jobs** — both apex-contracts' `OptimisticPolicy` and TermiX's AACP staking layer already provide this; reinventing it wastes scarce time.
- **Do not hand health-factor math, reputation scores, or any other SOURCE/DERIVED numeric field to an LLM to estimate** — every number the marketplace shows must trace to a contract read or a deterministic formula (§11, §12).
- **Do not assume BSC testnet parity across all four categories** — PancakeSwap V3 testnet status specifically is unconfirmed; don't build the whole demo plan around testnet-only until that's resolved (§8, §18). *(PancakeSwap V3 itself is now resolved — see §22 — but this caution still stands for Aave V3/Venus, unchecked this pass.)*
- **NEW, §22: Do not design the competition/demo narrative around discovering real, independent third-party competing agents from the ERC-8004 registry.** A live check found the BSC testnet registry dominated by test/placeholder junk (`"My Testnet Agent 02"`, raw `"user-8abd198e"` strings). Use our own registered agent(s) vs. clearly labeled baseline/reference strategies as the competition model instead — this is the honest option, not a fallback.
- **NEW, §22: Do not invent precision-looking weighted scoring formulas before real execution data exists.** Ship an explicitly-labeled, simple, transparent v1 (equal weighting unless the job objective specifically demands otherwise) — consistent with §12's original guidance, restated here because it's the exact failure mode a plausible-sounding AI-generated scoring rubric falls into.

---

## 21. Next 5 Engineering Tasks

**Task 1 — Verify and stand up local BNB Agent Studio / SDK tooling**
- Objective: resolve the npm-vs-pip install conflict, confirm `bag doctor`/`bag --help`/`bag mcp serve --help` actually work, wire Claude Code to the MCP server if the stdio transport flag is real.
- Files/systems: local machine only (no repo changes yet beyond a scratch install).
- Dependencies: none.
- Acceptance criteria: `bag` runs, MCP server connects from Claude Code (or a documented reason why not), decision recorded on which install path is canonical.
- Complexity: Low. Parallelizable: Yes (independent of everything else).

**Task 2 — Register a real ERC-8004 test agent + resolve the registry address**
- Objective: use `@bnbagent/sdk` to register one real agent on BSC testnet, confirm gas sponsorship via MegaFuel works, extract the literal `ERC8004_REGISTRY_ADDRESS` default from SDK source, resolve the `BRC8004/brc8004-contracts` question.
- Files/systems: new `bnb-smart-money-era/` project scaffold, `packages/agent-sdk-poc/`.
- Dependencies: Task 1 (needs `bag`/SDK installed).
- Acceptance criteria: one agentId resolvable via 8004scan, registry address confirmed and documented.
- Complexity: Medium. Parallelizable: Yes, alongside Task 3.

**Task 3 — Stand up one real Altana session → one real scoped transaction**
- Objective: `grantSession()` with a tight allowlist/spend-cap/expiry, execute one real scoped call (e.g., a small PancakeSwap Trading skill swap) on testnet or mainnet, confirm it's visible in the Altana explorer, then `revokeSession()` and confirm the revocation is visible too.
- Files/systems: `packages/altana-poc/`.
- Dependencies: none (can start immediately).
- Acceptance criteria: a real tx hash, visible session grant/revoke in the Keystore/explorer, screenshot/log for the eventual Altana track submission.
- Complexity: Medium. Parallelizable: Yes, alongside Task 2.

**Task 4 — Confirm PancakeSwap V3 and Aave V3/Venus testnet feasibility**
- Objective: directly test whether `NonfungiblePositionManager`/Factory/Router respond on BSC testnet, and whether Aave V3/Venus have testnet deployments with readable health-factor data; document the answer either way.
- Files/systems: `packages/protocol-probes/` (throwaway scripts, viem calls against testnet RPC).
- Dependencies: none.
- Acceptance criteria: a written yes/no per protocol, with the actual testnet addresses used, committed to `docs/`.
- Complexity: Low-medium. Parallelizable: Yes, alongside Tasks 2/3.

**Task 5 — Design the shared execution/session core and instrument it for the Agent Advantage Report from day one**
- Objective: build the one shared module all four categories will call through (propose action → policy check → Altana session execute → log to AgentExecution), and make sure every execution logs task/time/cost/output from the start, so real Advantage Report data accumulates automatically rather than being reconstructed later.
- Files/systems: `apps/backend/src/execution-core/`, `apps/backend/src/db/schema` (AgentExecution table per §11).
- Dependencies: Tasks 2 and 3 (needs a working identity + session path to wrap).
- Acceptance criteria: one category (recommend Health Factor Monitoring, per §19) running end-to-end through this shared core with real logged output.
- Complexity: Medium-high. Parallelizable: No — depends on Tasks 2/3 landing first; this is the critical-path task that unblocks everything else.

---

## 22. Live Verification Addendum (2026-08-22)

Everything below was verified this session by actually running the tools/RPC calls, not by reading docs. Where it contradicts an earlier §1–21 finding, this addendum wins (later date, direct verification).

### BNB Agent Studio CLI — resolved
`npm install -g @bnbagent/studio-cli` is the working install (v0.0.12 at verification time; blocked initially by a full disk, resolved with `npm cache clean --force`). Confirmed real top-level commands: `init, dev, deploy, scan, skills, recipe, agents, config, env, budget, audit, wallet, erc8004, erc8183, x402, llm, doctor, platform, bundle`.

**`bag mcp serve --transport stdio` does not exist** — confirmed by direct invocation (`bag mcp --help` / `bag mcp serve --help` both fall through to top-level help, no error, no MCP-specific output). Do not depend on it.

**Actual Claude Code integration mechanism:** `bag init --ide claude-code` writes `.claude/skills/<name>/SKILL.md`; the CLI's own onboarding text says *"in Claude Code / Cursor, type `/bnbagent-studio` — the skill drives all of the above for you."* This is a skill/slash-command, not a local MCP server. MCP still exists in this architecture, but as a **protocol face the deployed agent itself exposes** (`bag init --protocols A2A,MCP,X402`; the scaffolded `studio.toml` documents it as a streamable-HTTP `/mcp` endpoint serving `negotiate`/`notify_funded`/read-only chain tools) — a server the running agent hosts, not a CLI dev-tool.

**End-to-end scaffold smoke test, all real:** `bag init smoketest --network bsc-testnet --wallet-kind evm-local --no-onboard --no-install` → `bag wallet new` (address generated, private key never exposed, only the encrypted keystore path shown) → `bag doctor` → every core check PASS, including live RPC reachability to `bsc-testnet-rpc.publicnode.com`.

**$U token resolved** from the scaffold's generated `studio.toml`: testnet `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`, mainnet `0xcE24439F2D9C6a2289F741120FE202248B666666` — matches apex-contracts' payment token exactly (cross-checked against `bnbagent`'s own `networks.BNB_CHAIN_ADDRESSES`, below).

### PancakeSwap V3 on BSC testnet — resolved, live
`developer.pancakeswap.finance` blocks WebFetch's default user agent (403) but serves plain `curl` with a browser UA fine. Pulled the real address table, then independently confirmed every contract has live bytecode via `eth_getCode` against `data-seed-prebsc-1-s1.bnbchain.org` (chainId `0x61` = 97 confirmed):

| Contract | BSC testnet address | Bytecode confirmed |
|---|---|---|
| PancakeV3Factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` | ✅ |
| PancakeV3PoolDeployer | `0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9` | ✅ |
| NonfungiblePositionManager | `0x427bF5b37357632377eCbEC9de3626C71A5396c1` | ✅ |
| SwapRouter (v3) | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | ✅ |
| SmartRouter | `0x9a489505a00cE272eAa5e07Dba6491314CaE3796` | ✅ |
| MasterChefV3 | `0x4c650FB471fe4e0f476fD3437C3411B1122c4e3B` | ✅ |
| QuoterV2 | `0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2` | ✅ |
| TickLens | `0xac1cE734566f390A94b00eb9bf561c2625BF44ea` | ✅ |

**Verdict: a real V3 rebalancing/grid agent on BSC testnet is feasible.** No pre-existing pool with liquidity was checked or assumed — plan for the agent to create its own pool and seed its own liquidity as part of the build, which is normal and in fact makes a better demo (shows the full lifecycle, not just interaction with someone else's pool).

### `bnbagent` Python SDK (pip, v0.4.3) — installed and smoke-tested; one real bug found
Confirmed exports, all at **top level** (not submodules as earlier assumed): `ERC8004Agent, ERC8183Client, EVMWalletProvider, AgentEndpoint, NetworkConfig`-equivalent (`bnbagent.config.NetworkConfig`), `WalletProvider, X402Signer, networks, ...`.

**Real, reproduced bug:** the hardcoded default BSC-testnet RPC (`bnbagent/config.py`, `NETWORKS["bsc-testnet"].rpc_url`) is `https://data-seed-prebsc-2-s2.binance.org:8545` — dead (`NameResolutionError`, DNS doesn't resolve). Constructing `ERC8004Agent(wallet_provider=..., network="bsc-testnet")` or `ERC8183Client(...)` with defaults **fails out of the box**. Reproduced with a throwaway ephemeral key (generated locally via `secrets.token_hex`, never printed or persisted).

**Verified workaround:** `bnbagent/config.py`'s `resolve_network()` reads an env override with documented precedence — per-network `RPC_URL_<NETWORK>` (e.g. `RPC_URL_BSC_TESTNET`) first, then global `RPC_URL`, then the dead default. Setting `RPC_URL_BSC_TESTNET=https://bsc-testnet-rpc.publicnode.com` before instantiating fixed all three classes (`EVMWalletProvider`, `ERC8004Agent`, `ERC8183Client`) — re-ran the smoke test, all PASS. **Action item: set this env var in every environment (dev, CI, deploy) that constructs these classes for bsc-testnet — don't rely on the SDK default.**

**ERC-8004 registry addresses resolved** — not in the `networks` module (which only has payment/commerce/router/policy/treasury addresses), but hardcoded in `bnbagent/config.py`'s `NETWORKS` dict:
- BSC testnet registry: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- BSC mainnet registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`

(Commerce/router/policy addresses in this same file match `networks.BNB_CHAIN_ADDRESSES` case-insensitively — cross-validated, no conflict.)

### ERC-8004 registry population — live-checked, changes the demo plan
Rather than trust the 8004scan indexer (a JS SPA that returned inconsistent/flaky embedded state across repeated fetches — its `selectedChainId` default is `"all"` sorted by `created_at`, so its front page is dominated by whichever chains are seeing registration bursts, not necessarily representative), went straight to the registry contracts on-chain. `agentId` is just an auto-incrementing ERC-721 tokenId (confirmed in §5), so the real count is the highest tokenId for which `ownerOf()` doesn't revert — found by exponential probe + binary search:

- **BSC testnet** (`0x8004A818...4BD9e`): **1,749 registered agents** (id 1–1749 exist, 1750 doesn't; `totalSupply()` reverts — this registry doesn't implement ERC-721 Enumerable, so binary search was necessary).
- **BSC mainnet** (`0x8004A169...539a432`): between 200,000 and 300,000 (not narrowed further — order of magnitude was sufficient).

**Sampled testnet `agentURI` content (decoded via `tokenURI`, ABI-decoded, base64 `data:application/json` payloads inline-decoded):**

| agentId | Content |
|---|---|
| 1 | `{"name": "My Testnet Agent 02", "description": "A test agent running on BSC Testnet", "endpoints": [{"endpoint": "https://agent.example/..."}]}` — placeholder, fake endpoint |
| 500 | `{"name": "Test041001", "description": "Purr-Fect Claw cloud instance agent", "x402Support": true, ...}` — dev/test registration |
| 1000 | literally the raw string `"user-8abd198e"` — not even valid JSON |
| 1749 | resolves to `https://termix-aacp-avatar.s3.ap-southeast-1.amazonaws.com/platform/agents/....json` — a **real TermiX AACP-platform agent** |

**Conclusion:** registration is free (gas-sponsored via MegaFuel paymaster, per §4), so the registry is dominated by test/placeholder noise. Real, capability-differentiated third-party agents exist but are a minority, not reliably discoverable at demo time. **Do not design the demo around real third-party agent competition** (already reflected in the updated §20).

**Side finding, refines §6/§9:** agentId 1749 being a genuine TermiX agent shows TermiX registers agent *identity* through this same base ERC-8004 registry contract, even though its *commerce/job* execution stays on TermiX's own separate, unbridged AACP/TermixEscrow rail. The "two separate deployments, no bridge" finding in §6/§9 is correct for commerce — it does not necessarily hold for identity. Not confirmed as a general rule (one data point), but worth remembering if the marketplace ever wants to *display* TermiX agents without being able to *hire* them through our own commerce rail.

### Net effect on the plan
- PancakeSwap V3 testnet risk (previously HIGH) — closed.
- CLI/MCP install risk (previously HIGH) — closed; the actual integration path (skills, not MCP-serve) is simpler than what was planned around.
- New MEDIUM risk: the SDK's dead default RPC must be worked around explicitly in every environment.
- New MEDIUM risk (really a product-decision input, not a blocker): the registry can't supply real competing agents for a marketplace/competition demo — plan the competition model accordingly (own agent vs. labeled baseline/reference strategies).

# VEYRA Custody & Authorization Architecture

Running, dated record of VEYRA's custody/authorization architecture decision and the research
behind it. Every claim below is labeled by how it was established -- independently verified
on-chain or from primary source, confirmed by the user, or unverified/disproven -- per this
project's standing rule: never present partial or unconfirmed information as settled fact.

## Locked architectural decision (2026-08-26)

**VEYRA uses Altana session delegation (EIP-7702) for custody/authorization.** The user's existing
wallet keeps ownership of the existing PancakeSwap V3 position; VEYRA's automation process never
receives the user's private key, only a scoped Altana session.

Governing invariant, locked alongside the decision:

> Altana permits the CLASS of call (contract + function selector, via its own on-chain permission
> model) -> VEYRA independently validates the EXACT PARAMETERS (tokenId, recipient, pool/token
> pair, fee, amounts, deadline) -> only then does execution proceed.

Altana's own on-chain scoping is confirmed (see Gate 2 below) to stop at `(target, selector)` --
it enforces no argument-level constraint at all. VEYRA's own policy layer is therefore load-bearing,
not defense-in-depth.

## The four production gates

| Gate | What it covers | Status |
|---|---|---|
| 1 | Argument-level policy (`authorizeAltanaCall`) wired as a real pre-broadcast boundary | **PASS** -- integrated, 48 dedicated tests, live-verified on BSC testnet (valid call reached the executor; a tampered one was rejected before the executor was touched, broadcast count 0) |
| 2 | Independent security assessment of the underlying account/permission contracts | **PARTIAL -- research-complete (2026-08-26), production-security approval NOT PASSED.** See the frozen closure section below for the exact, named reasons this is not yet PASS. |
| 3 | Relay-centralization risk | **Buildable mitigations shipped** (session-lifetime cap, relay health check) **; the single-operator dependency itself remains unremoved and unresolved.** |
| 4 | User authorization/revocation UX + multi-session emergency pause | **Buildable primitive shipped** (`pauseAllSessions`) **; the actual user-facing product does not exist.** No user beyond the single test wallet should be onboarded. |

None of Gates 1-4's code is wired into `orchestrator.ts`. Production Altana execution is **not
enabled**. Real-user funds are **blocked** pending all four gates and a separate, explicit
authorization to connect this to the live execution path.

Full write-ups: [Gate 2 manual review](https://claude.ai/code/artifact/f8b64e08-26f6-421d-9665-ca8caac05a5f)
(includes the Ithaca/Porto sunsetting finding and the Solidity-level review of `GuardedExecutor.sol`
/ `IthacaAccount.sol`).

## Verified on-chain facts

**BSC Testnet (chain 97) -- confirmed live, matches Altana's own public documentation
(`docs.altana.network/concepts/networks/testnet`) exactly, and matches the contracts this
project's own real transactions actually touched:**

| Role | Address |
|---|---|
| Orchestrator | `0xcb5CEf3C54aa90e9A7ad602A258D3d360cC862B9` |
| Delegation proxy | `0x4F4ddE38Da9F8AbBb96C48cA520b992D4bADc3D6` |
| Account implementation | `0x33aD2F49ab9f122f5F0FDF579f575724EfF353DE` |
| KeyStore | `0x6b8361C29d05D498b1a12B54A37310f94171E94A` |
| KeyStoreController | `0xb530D1971f5453F3359518343F05D0AedFfF7e12` |
| Relay URL | `https://testnet-relay.altana.network` |

**BSC Mainnet (chain 56) -- partially verified:**

| Role | Address | Status |
|---|---|---|
| KeyStore | `0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a` | **Confirmed**: has real contract code (8756 bytes) on BSC mainnet; matches Altana's own public docs |
| KeyStoreController | `0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555` | **Confirmed**: has real contract code (3609 bytes) on BSC mainnet; matches Altana's own public docs |
| Orchestrator | *(no such role documented for BSC mainnet)* | **Resolved, not merely disproven -- see the frozen closure section below.** Two independent primary sources (Altana's own `docs.altana.network/concepts/networks` and the shipped `@altananetwork/sdk` v0.5.1 config) agree BSC mainnet has exactly two contracts: KeyStore and KeyStoreController. No third "Orchestrator"/account-implementation/delegation-proxy contract is documented for this chain. The address `0x30a188Eecf14F4142B0d828ce838C9E1134e7FaA` that was supplied for this role is real, but is Ethereum mainnet's `keyStoreController` -- confirmed identically from both of the same two primary sources. **Do not use this address for anything on BSC.** |

## Independent CertiK audit (real, but only partially confirmed)

Altana's `KeyStore.sol` / `KeyStoreCacheOPStack.sol` + 6 further files were audited by CertiK,
completed 2026-07-15 (`docs.altana.network/security/audits`, full report on CertiK Skynet). Solidly
confirmed from the page itself: 0 critical, 0 major, 1 medium (resolved), 2 minor (acknowledged),
4 informational (resolved), contracts source-verified on Ethereum/BSC/Base.

**Not confirmed:** an earlier pass reported a specific "Centralization Issue -- Privilege, Partially
Resolved" finding as part of this audit. Attempting to verify the exact finding text against
CertiK Skynet's own page directly, this could not be confirmed -- Skynet scores projects across
several separate dimensions (Code Security, Centralization, etc.) and it was not possible to
confirm whether the item seen belongs to the audit's finding list or a separate, unrelated
centralization-risk score. **This specific claim was retracted** and should not be treated as
established until a human reads the primary CertiK report directly.

## Unverified support-channel response (2026-08-26)

The user received a response, via a Telegram bot (`t.me/bnbchain_official_bot`), to a set of
production-architecture questions about Altana's relay operator, mainnet contract addresses,
audit status, and relay-failure recovery. The user independently confirmed this bot is BNB
Chain's official channel.

**Channel legitimacy and factual accuracy were verified separately, and do not imply each other.**
Two specific claims were independently checked and found accurate (the mainnet KeyStore and
KeyStoreController addresses -- see table above). Two specific claims were independently checked
and found **false**:

- **The claimed mainnet "Altana Orchestrator" address (`0x30a188Eecf14F4142B0d828ce838C9E1134e7FaA`)
  has no contract code on BSC mainnet at all** -- confirmed via a direct `eth_getCode` read at the
  time of this writing. This is not a wrong address for a real contract; nothing is deployed there.
- **The claim that BEP-153 governs `receive`/`fallback` handling for cross-chain delegation
  failures is incorrect.** BEP-153 is BNB Chain's native-staking proposal, unrelated to EIP-7702 or
  delegation fallback handling.

An official channel relaying incorrect information is possible whether or not the channel itself
is genuine -- this is a known limitation of AI-assisted or automated support responses. The
discrepancy is worth reporting back to the same channel; it has not yet been reported. **The real,
current-production mainnet Orchestrator address remains unconfirmed as of this writing.**

## Recommended answers on custody pattern (from the same response, consistent with existing work)

The response's description of the recommended pattern for existing user-owned V3 positions --
Altana contract/function scoping plus VEYRA-side argument validation (tokenId, recipient, amounts,
deadlines) -- is **consistent with, and does not change**, the architecture and invariant already
locked above and already implemented in `packages/veyra-core/src/altanaCallPolicy.ts`. This
consistency is corroborating, not confirming; it was not independently re-derived from this
response.

## Follow-up on the support-channel discrepancy (2026-08-26) -- elevated to a suspected social-engineering attempt

The two disproven claims above were reported back to the same Telegram channel, asking for a
correction. The reply:

- **Did not correct or acknowledge either disproven claim.** No revised Orchestrator address was
  given; the BEP-153 question was deflected to "join the BNB Chain Dev Community... for direct
  interaction with the core team" rather than answered.
- **Introduced a third unverifiable/false claim.** It cited `https://skynet.certik.com/projects/altana-network`
  as the CertiK Skynet report URL. Checked directly: **this URL 404s -- it does not exist.** The
  correct, working URL (used earlier in this same research, see above) is
  `https://skynet.certik.com/projects/altana` (no `-network` suffix).
- **Closed with an unsolicited offer of template code for a security-critical function**: *"Do you
  have the specific implementation of your receive() method ready, or should we look at the
  standard Altana template for that?"* -- volunteered immediately after failing to substantiate
  anything else in the exchange, and unprompted by any request for implementation help.

**Assessment: this pattern -- an "official" channel giving repeated unverifiable or false
technical claims, deflecting when directly confronted with a concrete on-chain falsification, and
then offering to supply code for a wallet-security-relevant function -- is consistent with a
social-engineering / malicious-code-injection attempt, independent of whether the Telegram
account itself is genuinely operated by BNB Chain.** Recommendation, followed at the time of this
writing: do not request or accept any "standard Altana template" or other implementation code from
this channel; any `receive()`/fallback or account-upgrade logic VEYRA eventually needs should be
verified against Altana's own public GitHub source directly, the same way every other claim in
this document was verified, not accepted from a chat channel.

## Gate 2 — frozen research closure (2026-08-26)

This section is the authoritative, final record of Gate 2's primary-source research. This line of
research is now closed; remaining items are production security/engineering requirements, not
open research questions, and should not be re-investigated by further web/documentation searching.

**Confirmed from primary sources (Altana's own docs and/or the shipped SDK's own config, not the
Telegram support channel):**

- BSC Mainnet KeyStore: `0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a` -- deployed, real code, matches
  both `docs.altana.network/concepts/networks` and `@altananetwork/sdk` v0.5.1's `BNB` config
  constant.
- BSC Mainnet KeyStoreController: `0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555` -- same, both
  sources agree.
- **There is currently no separately documented BSC Mainnet "Orchestrator" contract** in either
  Altana's official docs or the installed SDK configuration. BSC mainnet's addressable surface, per
  every primary source checked, is exactly KeyStore + KeyStoreController.
- The address `0x30a188Eecf14F4142B0d828ce838C9E1134e7FaA`, originally supplied as a "BSC Mainnet
  Orchestrator," **must not be used for anything on BSC.** It is Ethereum Mainnet's
  `keyStoreController` address, confirmed identically from both `docs.altana.network` and the SDK's
  own `ETHEREUM` config constant. The earlier support-channel label for this address was incorrect.
- CertiK audit of "Altana Network" (KeyStore.sol, KeyStoreCacheOPStack.sol + 6 further files),
  completed 2026-07-15: 0 critical, 0 major, 1 medium (resolved), 2 minor (acknowledged), 4
  informational (resolved), plus one Centralization-category finding -- **full text now obtained
  directly from the primary CertiK PDF report (2026-08-27), see below.**
- The audit page itself links directly to the BscScan/Etherscan/Basescan `#code` pages for these
  addresses as its own cited exact-match evidence.
- Alternative/self-hosted broadcasting is technically supported by the on-chain signed-intent
  authorization model (the account validates against KeyStore state, not against a specific
  broadcaster's identity) -- confirmed independently from reading `GuardedExecutor.sol` /
  `IthacaAccount.sol` directly, not merely asserted by the support channel.

**Update (2026-08-27): the commit/version hash is now confirmed** -- see the frozen closure section
below. It required the primary PDF's own Codebase page, which was not reachable through automated
fetching of the Skynet dashboard; a human opening the PDF directly is what closed this.

**Remains out of scope, not a research gap:** independent audit coverage of the relay software
itself, or of a BSC-mainnet account/delegation contract distinct from KeyStore -- because, per the
finding above, no such distinct contract appears to exist on this chain, this is likely not a gap
so much as a non-applicable question.

### FUA-01 -- Centralization Related Risks (full text, obtained directly from the primary CertiK PDF, 2026-08-27)

**Location:** `KeyStore.sol` lines 115, 124, 136, 153, 204, 257, 281; `KeyStoreController.sol` lines
93, 99, 111, 117, 124, 129, 135. **Category:** Centralization.

**The risk, as described by CertiK:** in `KeyStore.sol`, the `owner` role controls
`transferOwnership` and `setAuthorizedContract` -- a compromised or malicious owner could authorize
arbitrary contracts to register keys, indirectly controlling account bootstrapping and key issuance
system-wide. The `pendingOwner` role (two-step transfer) and the `authorizedContracts` role (granted
by the owner) carry corresponding risks -- an authorized contract can create keys for arbitrary
users within the registry's constraints, though it cannot revoke keys, overwrite existing
registrations, or act before an account has a root key. In `KeyStoreController.sol`, the `owner`
role controls `transferOwnership`, `setTreasury`, `setRegistrationFee`, and `setPriceFeed` -- a
compromised owner could set arbitrary fees, point fee calculation at an untrusted oracle, or
redirect fee flows via a malicious treasury nomination. `pendingOwner`/`pendingTreasury` carry the
matching two-step-transfer risk.

**CertiK's recommendation** (short-term: timelock + multisig; long-term: timelock + DAO; permanent:
renounce ownership or remove the functionality entirely) explicitly frames this as a design
property that "in most cases cannot be resolved entirely at the present stage," recommending
mitigation rather than elimination.

**Altana's alleviation response** [2026-06-30]: "Acknowledged. Mitigating via timelock + multisig
as planned for mainnet deployment."

**CertiK's re-check** [2026-07-09] confirms this was actually implemented, not just promised. As of
that date, both `KeyStore` (`0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a`) and `KeyStoreController`
(`0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555`) -- both independently confirmed deployed earlier in
this document -- are owned by a **Timelock contract**, itself controlled by a **4-of-6 Gnosis Safe
multisig (Safe 1.4.1+L2)**, with a **48-hour minimum delay** on privileged operations. Roles per the
report: `DEFAULT_ADMIN_ROLE` and timelock ownership at `0x8BA02c99178c58D49747ed4f42b4e5DB3584da20`
(self-referential -- the timelock administers itself); `PROPOSER_ROLE`/`CANCELLER_ROLE` at the Safe
multisig `0x83E49c976389A6D708504499aFf2DAfC665637B6` (six named signer addresses, in the report);
`EXECUTOR_ROLE` open to anyone (the zero address) -- a normal pattern meaning execution after the
48h delay is permissionless, not a gap. CertiK's closing note: "strongly encourages the project
team to periodically revisit the private key security management of all addresses related to
centralized roles."

**Independent on-chain verification: CONFIRMED (2026-08-27).** The first transcription (from a
lower-resolution image) had two character errors; a clearer image of the same PDF page gave the
correct addresses, both verified live via `eth_getCode`:
- Timelock `0xB8A02c99176c58D49747ed4f42b4e5DB3684da2D` -- real contract, 5448 bytes, a plausible
  size for an OpenZeppelin `TimelockController`.
- 4/6 Safe multisig `0x83Ee9c976389A6D708504490eFf2DAfC665637B6` -- real contract, 171 bytes,
  exactly the expected footprint of a Gnosis Safe proxy (delegatecalls to a shared singleton) --
  corroborating, not just "has code."

Both addresses, and the mitigation they represent, are now independently confirmed on-chain, not
merely asserted by the PDF.

**Important scope distinction:** this finding concerns Altana's *protocol-level* governance (who
controls system-wide fee parameters and authorized key-registrars) and does not change, mitigate,
or relate to the separate, already-documented fact (from this project's own manual review of
`IthacaAccount.sol`) that an individual user's own admin key can instantly revoke/authorize/redelegate
*that user's own account*, with no timelock. That is a different privileged role (the end user's
own key acting on their own account) and remains accurate as previously recorded.

**The distinction this project is holding itself to:** "research complete" (true, as of this
freeze), "security review complete" (true, for the manual review), "independent audit evidence
exists" (true, real and corroborated), and "production security approval" (**not** true) are four
different claims. Gate 2 satisfies the first three. It does not satisfy the fourth, and nothing
above should be read as claiming otherwise.

**Update (2026-08-27):** the user obtained and provided the primary CertiK PDF directly, including
its Codebase/Audit Scope/Approach & Methods/Review Notes pages and the full CertiK Skynet project
dashboard. This closes every remaining item from the research phase, including the one thought
unresolvable (the commit hash).

**The audited repository is `functornetwork/keystore`, not any `altananetwork` repo.** This
independently confirms a detail from the earlier, otherwise-unreliable Telegram support response --
it described the stack as "Altana (formerly Functor Network)," which at the time could not be
corroborated and was reasonably set aside along with that response's fabricated claims. The
CertiK PDF's own Review Notes section repeatedly refers to "the Functor deployment lifecycle,"
confirming this specific detail was true even though other specifics in the same conversation were
not. (Neither `github.com/functornetwork/keystore` nor `github.com/altananetwork/keystore` resolves
publicly -- likely a private repo, not a red flag given this fact came from the primary PDF itself.)

**Audited commits (from the PDF's own Codebase page):**
- `607a71d68099e6981e3da699b627ef332c06852f`
- `11e1a8db5beaa11882df0a9095279dcce633cb4d`

Two commits correspond to the audit's two stages shown on the same page ("Requested 6/22/2026" /
preliminary comments 6/25/2026, and the final report 7/15/2026). **Neither matches the `4689626`
value from the Telegram support response** -- that claim is now conclusively wrong, not merely
unconfirmed, on top of everything else already documented about that channel.

**Full audit scope, from the PDF's Audit Scope page:** exactly three contracts, each tracked across
both commits (matching Skynet's "View 6 Audited Files" -- 3 files x 2 commit versions, not 8
distinct files as earlier assumed): `KeyStore.sol`, `KeyStoreController.sol`,
`cache/KeyStoreCacheOPStack.sol`.

**Architecture, from the PDF's Review Notes (real detail, not previously available):**
- `KeyStore.sol` -- stores public keys and metadata (nonce, expiry, revocation, root flag);
  registration is only via `authorizedContracts`.
- `KeyStoreController.sol` -- the paid registration entry point: reads a price feed, converts a
  USD fee to native token, registers via `KeyStore`, forwards the fee to `treasury`, refunds excess.
- `KeyStoreCacheOPStack.sol` -- an OP Stack L2 cache (relevant to the Base deployment specifically):
  anyone can call `populateKey` with L1 Merkle-Patricia-Trie proofs anchored to the OP Stack
  `L1Block` predeploy (`0x4200000000000000000000000000000000000015`); mirrors L1 key state to L2;
  `isValidKey` checks anchor freshness.

**All 8 findings, now fully named** (FUA-01 was already documented in full above):
FUA-01 Centralization Related Risks; FUA-02 Deprecated Usage Of Chainlink API `latestAnswer`;
FUA-03 Unbounded Registration Fee Can Halt Key Registration; FUA-04 Missing Freshness Checks In
Contract Data Queries; FUA-05 Confirmation On `validator` Of `Key` In `KeyStore`; FUA-06 Issue
Regarding Expiry Validation In `KeyStoreCacheOPStack`; FUA-07 `populateKey` Emits Events Even When
No Actual State Change Occurs; FUA-08 L1 `KeyStore.getKeys` And L2 `KeyStoreCacheOPStack.getKeys`
Potentially Return Inconsistent Key Sets. Only FUA-01's full text has been obtained; the other 7
are named but not yet read in full (all non-critical/non-major, per the severity table already
confirmed).

**Corrected understanding of the "Code Security" score.** The earlier-reported bare "10%" figure,
previously flagged as uninterpretable, sat in a narrow audit-report widget whose exact meaning is
still not established. The full CertiK Skynet project dashboard shows a much more legible,
multi-dimensional score: **Code Security 91.50/100**, Operational 65.50/100 (No CertiK bug bounty,
no 3rd-party bounty, no CertiK/3rd-party KYC -- "Not Verified By CertiK"), Fundamental 49.53/100
(project is ~1 month old, no token, minimal GitHub/social footprint), Community 92.86/100,
Governance and Market both unscored/not applicable -- rolling up to an overall grade of **BBB
(73.40), "Pre-Launch."** This is a materially fuller and fairer picture than the bare 10% figure
suggested: strong on the code itself, weak on maturity/operational-trust signals (unsurprising for
a project this young), not a red flag on the audit's substance.

**Final Gate 2 classification: PARTIAL -- research is now genuinely complete, production-security
gate not passed.** Every item this research phase could resolve is resolved. What remains --
commissioning an audit of VEYRA's own integration code, and a formal decision to accept the relay
and Altana/Functor's operational youth (1-month-old project, no bug bounty, not KYC-verified) as
residual risk -- are business/security decisions, not research questions.

## A credible team response (2026-08-27) -- corroborates, doesn't add new facts

The user posted the project's production-architecture questions to what appears to be an official
Altana channel and received a reply from (apparently) team handles `@attritoofficial`/`@dorisG_xyz`.
Applying the same verify-don't-trust standard as the earlier Telegram exchange: this response is a
meaningfully different quality of source. Point by point:

1. **Relay**: "`relay.altana.network` -- this is our official relay, we operate and host it." Matches
   exactly the `RELAY_URL` constant in the actual installed `@altananetwork/sdk`'s own shipped
   config (confirmed earlier this session). Also directly answers "who operates it" -- Altana
   itself, not a third party.
2. **KeyStore/KeyStoreController docs**: points to `docs.altana.network/concepts/networks` -- the
   exact primary source already independently confirmed on-chain in this document. Critically,
   this response does **not** repeat the earlier bot's fabricated mainnet "Orchestrator" address --
   it says the missing production contracts "will be added shortly," consistent with this
   document's own finding that no such address exists in any primary source yet.
3. **Audit**: cites `skynet.certik.com/projects/altana` (correct -- no `-network` suffix, unlike the
   earlier bot's 404ing URL) and `docs.altana.network/security/audits` (correct).
4. **Architecture recommendation for existing NFT positions**: honestly deferred to a named
   colleague rather than answered speculatively -- still open, and the one item worth following up
   on directly, since it's the actual architecture-pattern question this whole investigation has
   been circling.
5. **Uptime**: "redundancy... 99.99% uptime" -- an unverifiable business claim, neither confirmed
   nor contradicted by anything independently checked.

**Assessment**: this response gets right exactly what the earlier Telegram exchange got wrong or
fabricated (the Orchestrator address, the Skynet URL), and honestly defers what it doesn't have a
ready answer for. That's a real, meaningful difference in reliability, not proof of authenticity on
its own -- but it corroborates facts already independently established here rather than
introducing new ones to take on faith. Item 4 remains the genuinely open question.

## Open items before production

1. ~~Confirm the real mainnet Orchestrator address~~ **Resolved by the frozen Gate 2 closure above:
   no such contract is documented for BSC mainnet by any primary source; the address once supplied
   for this role is Ethereum's KeyStoreController and must not be used on BSC.**
2. ~~Read the full CertiK Skynet report directly~~ **Fully resolved (2026-08-27)**: the user
   obtained the primary PDF directly. Full finding text (FUA-01) documented above, including
   confirmation that Altana actually deployed the timelock+multisig mitigation, not just
   acknowledged it, and both addresses independently confirmed on-chain.
3. Resolve the open question from the Gate 2 review: whether Altana's own relay is built on the
   now-archived `ithacaxyz/relay` reference implementation, or maintained independently.
   **Partially addressed (2026-08-27)**: the credible team response above confirms Altana itself
   operates `relay.altana.network` directly (not a third party) -- the specific "built on the
   archived reference code or not" sub-question remains unanswered.
4. Wire Gates 1-4 into `orchestrator.ts` -- explicitly not done, and not authorized as part of this
   record.
5. Report the two disproven claims back to the support channel that provided them. **Done** --
   the reply introduced a third false claim and an unsolicited code-template offer; see above.
6. Do not accept or implement any code, template, or specific technical implementation (especially
   anything wallet/security-related, e.g. `receive()`/fallback logic) sourced from the Telegram
   support channel, given the pattern documented above. Verify independently against Altana's own
   public GitHub/docs before implementing anything of that nature.
7. Commission an independent review of VEYRA's own integration code (not just Altana's contracts).
   Draft engagement scope for vendor outreach: `docs/VEYRA_AUDIT_ENGAGEMENT_SCOPE.md` (2026-08-27).

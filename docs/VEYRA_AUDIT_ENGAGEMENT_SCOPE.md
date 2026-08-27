# VEYRA — Security Review Engagement Scope (Draft, for vendor outreach)

Draft scope-of-work for commissioning an independent review of VEYRA's own Altana-integration
code. Not an audit itself -- this is the document to send to candidate firms to get quotes/RFPs.
Written 2026-08-27, following the closure of Gate 2's primary-source research
(`docs/VEYRA_CUSTODY_ARCHITECTURE.md`).

## Why this engagement, and why it's different from the existing CertiK audit

CertiK has already audited Altana/Functor's own on-chain contracts (`KeyStore.sol`,
`KeyStoreController.sol`, `KeyStoreCacheOPStack.sol` -- see `docs/VEYRA_CUSTODY_ARCHITECTURE.md` for
the full finding-by-finding record). That audit does not, and cannot, say anything about **VEYRA's
own code** -- the TypeScript application logic VEYRA wrote on top of Altana to constrain what an
authorized session is actually allowed to do. That gap is what this engagement is for.

**Important scoping note:** this is not a smart-contract audit. VEYRA deploys no contracts of its
own -- it calls existing, already-audited PancakeSwap V3 and Altana contracts from off-chain
TypeScript. The right engagement type is an **application/integration security review** of
TypeScript code that will eventually authorize real financial transactions, not a Solidity audit.
Some firms that do Solidity audits (CertiK included) also do this kind of review; some don't --
worth confirming with any candidate firm before engaging.

## What's in scope

**Core policy logic** (`packages/veyra-core/src/`):
- `altanaCallPolicy.ts` -- `authorizeAltanaCall()`, the argument-level authorization gate (Gate 1).
  This is the single most security-critical file in the codebase: it's what stands between "Altana
  says this class of call is allowed" and "this specific call, with these specific parameters, is
  the one that was actually meant."
- `relayRiskPolicy.ts` -- `validateSessionLifetime()`, the pre-grant session-lifetime cap (Gate 3).
- `executionPolicy.ts` -- `authorizeExecution()`, the pre-existing timing/gas/freshness gate this
  all builds on top of.
- `simulation.ts` -- pre-execution safety checks (ratio-mismatch threshold, etc.).

**Execution boundary** (`packages/veyra-chain/src/`):
- `altanaExecutor.ts` -- `executeAltanaOperation()`, the actual pre-broadcast boundary: where the
  policy check is invoked and where a rejection must provably prevent the executor from ever being
  called. This is the file to try hardest to break.
- `relayHealthCheck.ts` -- `checkRelayHealth()`, the pre-grant relay reachability check (Gate 3).
- `sessionPause.ts` -- `pauseAllSessions()`, the multi-session emergency-pause primitive (Gate 4).
- `txSigner.ts` -- the existing, previously-unaudited transaction build/sign/broadcast path this
  project already relies on for direct-signed execution.

**Explicitly out of scope** (already covered elsewhere, or not yet built):
- Altana/Functor's own on-chain contracts -- covered by the existing CertiK audit.
- The evaluator, strategies, and archive/reporting code -- no path to moving funds, out of scope.
- `orchestrator.ts` -- **not yet wired to any of the above** (see `docs/VEYRA_CUSTODY_ARCHITECTURE.md`);
  see the phasing note below on whether to review before or after that integration lands.
- Any user-facing authorization/revocation product -- doesn't exist yet (Gate 4's full scope).

## What we need the reviewer to verify

These map directly to the properties this project has already built tests around (see
`packages/veyra-core/test/altanaCallPolicy.test.ts`,
`packages/veyra-chain/test/altanaExecutor.test.ts`) -- the ask is independent verification that
these hold, not a first-principles rediscovery of what the code is supposed to do:

1. **No call reaches the Altana session executor without first passing `authorizeAltanaCall()`.**
   This is the core invariant; ideally verified structurally (can a code path be constructed that
   bypasses the check?), not just by reading the current call sites.
2. **Every operation's authorized parameters are actually load-bearing** -- `tokenId`, `recipient`,
   pool/token-pair/fee, per-call amount ceilings, deadline bounds -- and none can be satisfied by a
   value an attacker (a compromised relay, a tampered call) controls.
3. **The `decreaseLiquidity`/`mint`/`swap`/`collect` distinctions are correct** -- e.g., that
   `decreaseLiquidity` genuinely has no fund-redirection surface (no recipient field), that
   `swap`'s `amountOutMinimum` floor is actually enforced against an independently-sourced
   reference price, not a value the call itself supplies.
4. **Failure modes fail closed, not open** -- a thrown error, a malformed input, an unexpected
   Altana SDK response should all result in "no execution," never a silent bypass.
5. **The relay-risk mitigations are actually effective as designed** -- does
   `validateSessionLifetime` genuinely bound exposure the way intended; does `checkRelayHealth`
   actually gate new session grants (verify this once it's wired in) rather than merely logging.
6. **General TypeScript/Node security hygiene** around anything handling key material or session
   data -- even though private keys never leave the wallet provider's own encapsulation by design
   (see `txSigner.ts`'s own header comment), a reviewer should confirm that's actually true in
   practice, not just asserted in a comment.

## Context to share with the reviewer

- `docs/VEYRA_CUSTODY_ARCHITECTURE.md` -- the full research record: the locked architecture
  decision, the CertiK audit findings on the underlying Altana contracts, and the governing
  invariant this code is supposed to enforce.
- The Gate 1 threat-model and Gate 2 manual-review artifacts linked from that document.
- This project's own test suites, as a starting point for what's already covered -- the ask is to
  find what these tests *don't* cover, not to duplicate them.

## Phasing question for whoever runs this engagement

`orchestrator.ts` doesn't call any of this code yet (see Gate 1's status). Two reasonable options:
- **Review now**, on the standalone modules, to catch design-level issues before integration work
  is built on top of them (cheaper to fix now).
- **Wait until integration lands**, so the reviewer sees the real, complete call path rather than
  reasoning about hypothetical call sites.

No recommendation is fixed here -- worth deciding based on the chosen firm's availability and cost
structure. A reasonable middle ground: scope the initial engagement to the standalone modules now,
with a cheaper follow-up review scoped specifically to the integration diff once it exists.

## Deliverable format requested

A written report, findings ranked by severity, in a format comparable to the existing CertiK report
structure already in this project's records (Critical/Major/Medium/Minor/Informational, plus any
Centralization-style findings for privileged-role concerns) -- for ease of directly comparing
against the existing Altana-side audit.

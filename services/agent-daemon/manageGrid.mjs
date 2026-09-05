// Autonomous Grid Trading: recenter grid slots that price has left behind, with nobody watching.
//
// Grid Trading had real executed history but nothing scheduled -- it only ever ran when an
// operator invoked the orchestrator by hand. Meanwhile every category page carried the same
// "VEYRA does not need this tab open" claim. For rebalancing and health-factor monitoring that
// was true; for grid it was not. This module is what makes it true rather than editing the claim
// down.
//
// It delegates to runGridOrchestratorLoop unchanged -- the same OBSERVE -> EVALUATE -> PLAN ->
// SIMULATE -> authorize -> execute path, with the same execution policy gate, that produced the
// archived grid run. Nothing here decides anything; the strategy does.

/**
 * Runs one grid pass. Returns a small record either way, so a quiet pass is still auditable --
 * "we looked and every slot was in range" is a result.
 *
 * Archives land in docsDir, which on CI is the runner's ephemeral checkout: the durable artifact
 * is the on-chain transaction and this log line, exactly as it already is for the health-factor
 * repays and the session-scoped rebalances.
 */
export async function manageGrid({ client, wallet, account, docsDir, log, gridPositionTokenIds }) {
  // Passed in, never hardcoded. Recentering a slot burns it and mints a new token id, so a literal
  // list here is wrong the moment this function succeeds -- which is exactly what happened when
  // #37091 became #37270 and three separate files still named the old one.
  if (!gridPositionTokenIds || gridPositionTokenIds.length === 0) {
    log?.("  grid: no slots discovered -- skipping");
    return { decision: "skip", executed: 0 };
  }

  // Imported dynamically, inside the caller's try/catch, on purpose. A static import that fails
  // to resolve is a LOAD-time error: it kills the process before any handler can see it, which is
  // exactly what happened when this module first shipped without a matching entry in
  // @veyra/chain's exports map -- one missing line took the whole daemon red, including the job
  // delivery and health-factor work that had nothing to do with grid. Dynamic import makes the
  // isolation real rather than assumed.
  const { runGridOrchestratorLoop } = await import("@veyra/chain/gridOrchestrator");

  const result = await runGridOrchestratorLoop({
    client,
    wallet,
    gridPositionTokenIds,
    ownerWallet: account,
    docsDir,
  });

  const executed = result.slotOutcomes.filter((o) => o.finalState === "EXECUTED");
  const blocked = result.slotOutcomes.filter((o) => o.finalState !== "EXECUTED");

  if (result.slotOutcomes.length === 0) {
    // Not "all slots in range" -- a correctly placed grid slot is a resting one-sided order and
    // is therefore out of range by design. What zero adjustments means is that none of them needed
    // repositioning.
    log?.(`  grid: no slot needed repositioning -> hold`);
    return { decision: "hold", executed: 0 };
  }

  for (const o of result.slotOutcomes) {
    const txs = o.transactions?.length ?? 0;
    log?.(
      `  grid slot ${o.slotIndex} (#${o.positionTokenId}): ${o.finalState}` +
        (o.newPositionTokenId ? ` -> new position #${o.newPositionTokenId}` : "") +
        (txs ? ` (${txs} txs)` : ""),
    );
  }

  return {
    decision: executed.length > 0 ? "recentered" : "blocked",
    executed: executed.length,
    blocked: blocked.length,
    winner: result.winnerCandidateId,
  };
}

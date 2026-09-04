// Autonomous Health Factor monitoring: watch a real Venus borrow and repay it before liquidation
// risk develops, with nobody watching.
//
// Until now this category only ran when an operator invoked a script, which meant the risk had to
// be created and answered in the same breath. With the daemon watching, the sequence becomes the
// honest one: a position drifts on real accrued interest, crosses the threshold on its own, and
// the agent responds -- unprompted, minutes later.
//
// The threshold is the strategy's, not the daemon's. This module observes, asks the unmodified
// strategy what to do, and does only that. If the strategy says hold, nothing happens.

import { readVenusAccountObservation } from "@veyra/chain/healthFactorReader";
import { repayVenusBorrow, readBorrowBalance } from "@veyra/chain/healthFactorExecutor";
import { healthFactorMonitorStrategy } from "@veyra/core";

const COMPTROLLER = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";

/**
 * The markets worth watching. vUSDT is the historical position; XVS is the one that actually
 * accrues interest (3.11% APY) and can therefore drift into risk without anyone pushing it.
 */
const WATCHED_MARKETS = [
  // vBTC is where the live position sits: 1.32% APY, and the only market that passes all three
  // borrow gates (cap > 0, cap > totalBorrows, cash > 0). Its debt grows on its own, which is
  // what lets a threshold crossing happen with nobody acting.
  { label: "vBTC", vToken: "0xb6e9322C49FD75a367Fcb17B0Fcd62C5070EbCBe" },
  // The historical position. Kept watched, though vUSDT pays 0% so it can never drift.
  { label: "vUSDT", vToken: "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A" },
];

/**
 * Checks each watched market and repays where the strategy says to.
 *
 * Returns a record per market so a quiet pass is still auditable -- "we looked and it was fine"
 * is a result, and a monitor that only logs when it acts cannot be distinguished from one that
 * is not running.
 */
export async function manageHealthFactor({ client, signer, account, log }) {
  const outcomes = [];

  for (const market of WATCHED_MARKETS) {
    let snapshot;
    try {
      snapshot = await readVenusAccountObservation({
        client,
        comptrollerAddress: COMPTROLLER,
        borrowedVTokenAddress: market.vToken,
        account,
      });
    } catch (err) {
      log?.(`  ${market.label}: could not read -- ${(err.shortMessage ?? err.message ?? String(err)).slice(0, 90)}`);
      continue;
    }

    const obs = snapshot.observation;
    if (obs.borrowedPrincipalUnderlyingUnits === 0n) {
      outcomes.push({ market: market.label, decision: "no-position" });
      continue;
    }

    const job = {
      jobId: `health-factor-daemon-${market.label}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ownerWallet: account,
      category: "health-factor-monitoring",
      target: { protocol: "venus", network: "bsc-testnet", comptroller: COMPTROLLER, borrowedVToken: market.vToken },
    };
    const proposal = await healthFactorMonitorStrategy(job, snapshot);

    log?.(
      // computeHealthFactorSnapshot now carries fractional resolution itself, so this no longer
      // recomputes the ratio alongside it -- one source, one number.
      `  ${market.label}: ratio ${snapshot.borrowToCapacityRatio.toFixed(5)}% (${snapshot.solvencyStatus}), ` +
        `debt ${obs.borrowedPrincipalUnderlyingUnits} ${obs.borrowedTokenSymbol} -> ${proposal.proposedAction.kind}`,
    );

    if (proposal.proposedAction.kind !== "recommend-repay") {
      outcomes.push({ market: market.label, decision: "hold", ratio: snapshot.borrowToCapacityRatio });
      continue;
    }

    // Repay what is actually held: Venus accrues interest per block, so the live debt can exceed
    // the principal the strategy saw, and asking for more than the wallet holds reverts.
    try {
      const { encodeFunctionData } = await import("viem");
      const underlying = await client.readContract({
        address: market.vToken,
        abi: [{ type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "underlying",
      });
      const held = await client.readContract({
        address: underlying,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [account],
      });
      void encodeFunctionData;

      const suggested = proposal.proposedAction.suggestedAmountWei;
      const amount = suggested <= held ? suggested : held;
      if (amount === 0n) {
        log?.(`    cannot repay: wallet holds none of ${obs.borrowedTokenSymbol}`);
        outcomes.push({ market: market.label, decision: "blocked", reason: "no underlying held" });
        continue;
      }

      log?.(`    REPAYING ${amount} units of ${obs.borrowedTokenSymbol}…`);
      const result = await repayVenusBorrow(client, signer, market.vToken, amount);
      const after = await readBorrowBalance(client, market.vToken, account);
      log?.(`    repaid ${result.repaidAmount}; debt now ${after}`);

      outcomes.push({
        market: market.label,
        decision: "repaid",
        repaid: result.repaidAmount.toString(),
        borrowAfter: after.toString(),
        transactions: result.txs.map((t) => ({ step: t.step, hash: t.hash })),
      });
    } catch (err) {
      log?.(`    repay failed: ${(err.shortMessage ?? err.message ?? String(err)).slice(0, 140)}`);
      outcomes.push({ market: market.label, decision: "failed", error: String(err.shortMessage ?? err.message ?? err).slice(0, 200) });
    }
  }

  return outcomes;
}

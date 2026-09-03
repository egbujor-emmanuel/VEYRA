// Lets a visitor put real capital under VEYRA's management.
//
// Without this the headline claim had no subject: a new passkey wallet holds a little tBNB and
// owns no PancakeSwap position, so "grant VEYRA a scoped key and let it run your position" was
// unreachable for anyone starting from zero.
//
// The deposit is single-sided WBNB, because the visitor has no VUSD and there is no VUSD faucet.
// A concentrated-liquidity range that sits entirely below the current price is funded by token1
// alone, and WBNB is token1 here -- so wrapping their own tBNB is enough.

import { useCallback, useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { ExternalLink, RotateCw } from "lucide-react";
import {
  depositIntoManagedPosition,
  computeDepositRange,
  readOwnedPositions,
  type DepositRange,
} from "../chain/deposit";
import type { UserWallet } from "../chain/passkeyWallet";

const PRESETS = ["0.002", "0.005", "0.01"];
/** Leave enough native tBNB behind to pay for the deposit itself and a later revoke. */
const GAS_RESERVE_WEI = 3_000_000_000_000_000n; // 0.003

type State =
  | { status: "idle" }
  | { status: "working"; note: string }
  | { status: "done"; txHash?: string }
  | { status: "error"; message: string };

export function DepositPanel({ wallet, nativeBalanceWei }: { wallet: UserWallet | null; nativeBalanceWei: bigint | null }) {
  const [amount, setAmount] = useState(PRESETS[0]!);
  const [state, setState] = useState<State>({ status: "idle" });
  const [range, setRange] = useState<DepositRange | null>(null);
  const [positions, setPositions] = useState<bigint[] | null>(null);

  const refresh = useCallback(() => {
    computeDepositRange().then(setRange, () => setRange(null));
    if (wallet) readOwnedPositions(wallet.address).then(setPositions, () => setPositions(null));
  }, [wallet]);

  useEffect(refresh, [refresh]);

  const amountWei = (() => {
    try {
      return parseEther(amount);
    } catch {
      return 0n;
    }
  })();

  // Depositing everything would leave nothing to pay gas with, stranding the position.
  const affordable = nativeBalanceWei === null || amountWei + GAS_RESERVE_WEI <= nativeBalanceWei;

  async function submit() {
    if (!wallet || amountWei === 0n) return;
    setState({ status: "working", note: "Confirm on your device…" });
    try {
      const r = await depositIntoManagedPosition(wallet, amountWei);
      setState({ status: "done", ...(r.transactionHash ? { txHash: r.transactionHash } : {}) });
      refresh();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setState({
        status: "error",
        message: /reason: 0x|executing calls/i.test(raw)
          ? "The deposit was rejected on-chain without a reason. The usual cause is too little testnet BNB to cover both the deposit and its gas."
          : /InvalidNonce/i.test(raw)
            ? "Altana's relay was still catching up from your last transaction. Wait a few seconds and try again."
            : raw,
      });
    }
  }

  if (!wallet) return null;

  return (
    <div className="panel">
      <h2>Put funds under management</h2>

      <p className="rationale">
        Deposits some of your testnet BNB into a real PancakeSwap V3 position that you own. VEYRA can then
        manage it under the session you granted — and only within that scope. Wrapping and depositing are
        signed by <strong>you</strong>; VEYRA has no permission to touch your BNB or create a position.
      </p>

      {positions && positions.length > 0 && (
        <div className="hero-grid" style={{ marginBottom: 18 }}>
          <div className="hero-stat">
            <span className="k">Positions you own</span>
            <span className="v">{positions.map((p) => `#${p}`).join(", ")}</span>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <button
            key={p}
            className={`btn ${amount === p ? "btn-accent" : "btn-secondary"}`}
            onClick={() => setAmount(p)}
          >
            {p} BNB
          </button>
        ))}
      </div>

      {range && (
        <p className="freshness" style={{ marginBottom: 16 }}>
          Current tick {range.currentTick} · your range will be [{range.tickLower}, {range.tickUpper}) — entirely
          below the current price, so it needs only BNB and no second token.
        </p>
      )}

      {!affordable && (
        <div className="notice-box" style={{ marginBottom: 16 }}>
          That would leave too little BNB for gas. You hold{" "}
          {nativeBalanceWei !== null ? formatEther(nativeBalanceWei) : "…"} tBNB; keep at least{" "}
          {formatEther(GAS_RESERVE_WEI)} back.
        </div>
      )}

      {state.status === "error" && <div className="error-box" style={{ marginBottom: 16 }}>{state.message}</div>}

      {state.status === "done" ? (
        <div className="hero-stat">
          <span className="k">Deposited</span>
          <span className="v">
            {state.txHash ? (
              <a href={`https://testnet.bscscan.com/tx/${state.txHash}`} target="_blank" rel="noreferrer">
                {state.txHash.slice(0, 18)}… <ExternalLink size={13} />
              </a>
            ) : (
              "submitted"
            )}
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            disabled={state.status === "working" || !affordable || amountWei === 0n}
            onClick={submit}
          >
            {state.status === "working" ? state.note : `Deposit ${amount} BNB`}
          </button>
          <button className="btn btn-secondary" onClick={refresh}>
            <RotateCw size={15} /> Refresh
          </button>
        </div>
      )}

      <p className="rationale" style={{ marginTop: 16, marginBottom: 0 }}>
        Your position starts just below the current price, so it sits out of range and earns nothing where it
        is. That is deliberate: it is exactly the condition the Rebalancing agent exists to detect and correct.
      </p>
    </div>
  );
}

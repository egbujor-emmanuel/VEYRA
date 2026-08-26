import type { TxRecord } from "../data/types";
import { BSCSCAN_TESTNET_TX_BASE } from "../constants";

export function TxEvidenceList({ transactions }: { transactions: TxRecord[] }) {
  if (transactions.length === 0) return <p className="subtitle">No transactions — nothing was sent.</p>;
  return (
    <table className="tx-list">
      <thead>
        <tr><th>Step</th><th>Tx Hash</th><th>Status</th><th>Block</th><th>Gas Used</th></tr>
      </thead>
      <tbody>
        {transactions.map((tx) => (
          <tr key={tx.hash}>
            <td>{tx.step}</td>
            <td><a href={`${BSCSCAN_TESTNET_TX_BASE}${tx.hash}`} target="_blank" rel="noreferrer">{tx.hash.slice(0, 10)}…{tx.hash.slice(-6)}</a></td>
            <td><span className={`status-pill ${tx.status === "success" ? "status-good" : "status-bad"}`}>{tx.status}</span></td>
            <td>{tx.blockNumber}</td>
            <td>{tx.gasUsed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

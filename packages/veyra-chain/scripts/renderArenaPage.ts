// Renders the arena/demo page from docs/veyra-live-evaluation.json (the latest round
// produced by runLiveArenaEvaluation.ts). This script does NOT recompute or re-derive any
// score, metric, or ranking -- it only reads the already-evaluated record and formats it.
// There is exactly one evaluator in this system (@veyra/core's evaluate()); this file is a
// renderer, not a second one.
//
// Output is a single self-contained static HTML file -- no client-side JavaScript, no fetch,
// no build step, no server required. Every number on the page is either interpolated
// directly from the round record or is a fixed, honestly-labeled placeholder (the track
// record's empty state) -- nothing here invents a value.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, "../../../../docs");
const RECORD_PATH = resolve(DOCS_DIR, "veyra-live-evaluation.json");
const ROUNDS_DIR = resolve(DOCS_DIR, "arena-rounds");
const LATEST_HTML_PATH = resolve(DOCS_DIR, "arena.html");

interface RoundRecord {
  roundId: number;
  artifactHash: string;
  veyraAgentId: number;
  ownerWallet: string;
  positionTokenId: string;
  observedAtBlock: string;
  observed: {
    poolAddress: string;
    token0: string;
    token1: string;
    token0Decimals: number;
    token1Decimals: number;
    fee: number;
    tickLower: number;
    tickUpper: number;
    positionLiquidity: string;
    poolLiquidity: string;
    currentTick: number;
    sqrtPriceX96: string;
  };
  marketSnapshot: {
    currentTick: number;
    currentRange: { tickLower: number; tickUpper: number };
    currentLiquidity: string;
    tickSpacing: number;
    recentVolatilityBps: number;
    recentVolatilityBpsProvenance: string;
  };
  job: Record<string, unknown>;
  proposals: Array<{
    candidateId: string;
    displayLabel: "Our Agent" | "Baseline Strategy" | "Reference Strategy";
    agentIdOnChain: number | null;
    proposedAction: { kind: "rebalance"; newRange: { tickLower: number; tickUpper: number } } | { kind: "hold" };
    rationale: string;
    metrics: {
      estimatedGasWei: string;
      estimatedFeeEfficiency: number;
      estimatedSlippageBps: number;
      riskScore: number;
      executionFeasible: boolean;
      provenanceNote: string;
    };
    score: {
      weights: { feeEfficiency: number; risk: number; gas: number; feasibility: number };
      normalized: { feeEfficiency: number; risk: number; gas: number; feasibility: number };
      totalScore: number;
    };
    isWinner: boolean;
  }>;
  winnerCandidateId: string;
  generatedAt: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function actionText(action: RoundRecord["proposals"][number]["proposedAction"]): string {
  return action.kind === "hold"
    ? "Hold — no rebalance"
    : `Rebalance to [${action.newRange.tickLower}, ${action.newRange.tickUpper})`;
}

function badge(tier: "OBSERVED" | "DERIVED" | "SUPPLIED" | "SIMULATED"): string {
  return `<span class="tag tag-${tier.toLowerCase()}">${tier}</span>`;
}

function candidateCard(p: RoundRecord["proposals"][number]): string {
  const labelClass = p.displayLabel === "Our Agent" ? "candidate-agent" : "candidate-baseline";
  const winnerClass = p.isWinner ? "candidate-winner" : "";
  const agentTag = p.agentIdOnChain !== null ? `<span class="agent-id">ERC-8004 #${p.agentIdOnChain}</span>` : "";
  const feasBadge = p.metrics.executionFeasible
    ? `<span class="feas feas-yes">feasible</span>`
    : `<span class="feas feas-no">infeasible</span>`;
  const barWidth = Math.max(0, Math.min(100, p.score.totalScore));

  return `
  <article class="card ${labelClass} ${winnerClass}">
    ${p.isWinner ? `<div class="winner-ribbon">WINNER</div>` : ""}
    <header class="card-head">
      <span class="label-badge">${esc(p.displayLabel)}</span>
      ${agentTag}
    </header>
    <h3 class="candidate-name">${esc(p.candidateId)}</h3>
    <p class="action">${esc(actionText(p.proposedAction))}</p>
    <p class="rationale">${esc(p.rationale)}</p>

    <div class="score-row">
      <div class="score-bar-track"><div class="score-bar-fill" style="width:${barWidth}%"></div></div>
      <div class="score-value">${p.score.totalScore.toFixed(2)}</div>
    </div>

    <table class="metrics">
      <tbody>
        <tr><td>fee efficiency</td><td>${p.metrics.estimatedFeeEfficiency.toFixed(1)}</td><td>${p.score.normalized.feeEfficiency.toFixed(0)} norm</td><td>${badge("DERIVED")}</td></tr>
        <tr><td>risk score</td><td>${p.metrics.riskScore.toFixed(1)}</td><td>${p.score.normalized.risk.toFixed(0)} norm</td><td>${badge("DERIVED")}</td></tr>
        <tr><td>gas (wei)</td><td>${p.metrics.estimatedGasWei}</td><td>${p.score.normalized.gas.toFixed(0)} norm</td><td>${badge("DERIVED")}</td></tr>
        <tr><td>feasibility</td><td colspan="2">${feasBadge}</td><td>${badge("DERIVED")}</td></tr>
      </tbody>
    </table>
    <p class="fine-print">Fee efficiency is a tick-width heuristic — <strong>not amount-aware</strong> (no token-amount/decimal data reaches the evaluator yet). Not a historical backtest.</p>
  </article>`;
}

function render(record: RoundRecord): string {
  const winner = record.proposals.find((p) => p.isWinner)!;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>VEYRA Arena — Round #${record.roundId}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #0b0e14; --panel: #12151f; --panel-2: #171b28; --border: #262b3a;
    --text: #e6e8ee; --muted: #8b91a7; --accent: #4f8cff; --good: #2fbf71;
    --warn: #e0a530; --bad: #e05a4f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 32px 20px 80px;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .subtitle { color: var(--muted); font-size: 0.9rem; margin: 0 0 24px; }
  .lede { font-size: 1.05rem; line-height: 1.5; color: #cfd3e0; margin: 0 0 28px; padding: 16px 18px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 20px; }
  .panel h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 14px; }
  .kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px 24px; font-size: 0.88rem; }
  .kv div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed var(--border); padding: 4px 0; }
  .kv span.k { color: var(--muted); }
  .kv span.v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; word-break: break-all; text-align: right; }
  .tag { display: inline-block; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.03em; padding: 2px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle; }
  .tag-observed { background: rgba(79,140,255,0.18); color: #8fb4ff; }
  .tag-derived { background: rgba(155,109,255,0.18); color: #c4a9ff; }
  .tag-supplied { background: rgba(224,165,48,0.18); color: var(--warn); }
  .tag-simulated { background: rgba(139,145,167,0.18); color: var(--muted); }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 0.8rem; color: var(--muted); }
  .legend b { color: var(--text); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { position: relative; background: var(--panel-2); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  .candidate-winner { border-color: var(--good); box-shadow: 0 0 0 1px var(--good), 0 0 24px rgba(47,191,113,0.15); }
  .winner-ribbon { position: absolute; top: -1px; right: 16px; background: var(--good); color: #04150c; font-size: 0.65rem; font-weight: 800; letter-spacing: 0.06em; padding: 3px 10px; border-radius: 0 0 6px 6px; }
  .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .label-badge { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.03em; padding: 3px 8px; border-radius: 20px; }
  .candidate-agent .label-badge { background: rgba(79,140,255,0.2); color: #8fb4ff; }
  .candidate-baseline .label-badge { background: rgba(139,145,167,0.2); color: var(--muted); }
  .agent-id { font-size: 0.7rem; color: var(--muted); font-family: ui-monospace, monospace; }
  .candidate-name { margin: 0 0 6px; font-size: 1rem; font-family: ui-monospace, monospace; }
  .action { margin: 0 0 8px; font-size: 0.92rem; }
  .rationale { margin: 0 0 14px; font-size: 0.82rem; color: var(--muted); line-height: 1.4; }
  .score-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .score-bar-track { flex: 1; height: 8px; background: #23283a; border-radius: 4px; overflow: hidden; }
  .score-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--good)); }
  .score-value { font-family: ui-monospace, monospace; font-weight: 700; min-width: 46px; text-align: right; }
  table.metrics { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  table.metrics td { padding: 4px 2px; border-bottom: 1px solid var(--border); color: #cfd3e0; }
  table.metrics td:first-child { color: var(--muted); }
  .feas-yes { color: var(--good); }
  .feas-no { color: var(--bad); }
  .fine-print { font-size: 0.7rem; color: var(--muted); margin: 10px 0 0; line-height: 1.4; }
  .winner-banner { display: flex; align-items: center; gap: 14px; padding: 16px 20px; }
  .winner-banner .name { font-size: 1.15rem; font-weight: 700; }
  .winner-banner .score { margin-left: auto; font-family: ui-monospace, monospace; font-size: 1.3rem; font-weight: 800; color: var(--good); }
  .empty-state { color: var(--muted); font-size: 0.88rem; line-height: 1.5; }
  footer { color: var(--muted); font-size: 0.75rem; margin-top: 30px; }
  code.hash { font-family: ui-monospace, monospace; word-break: break-all; }
</style>
</head>
<body>
<div class="wrap">

  <h1>VEYRA Arena — Round #${record.roundId}</h1>
  <p class="subtitle">BSC Testnet · generated ${esc(record.generatedAt)}</p>

  <p class="lede">
    VEYRA doesn't decide what to do and then justify it. It gives every strategy the same
    live market state, evaluates every proposal with the same rules, and accepts whichever
    proposal actually scores best — even when that means its own registered agent doesn't win.
  </p>

  <div class="panel">
    <h2>Provenance legend</h2>
    <div class="legend">
      <span>${badge("OBSERVED")} <b>read directly from BSC testnet</b>, verbatim</span>
      <span>${badge("DERIVED")} <b>calculated</b> from observed state by a deterministic formula</span>
      <span>${badge("SUPPLIED")} <b>explicitly provided input</b> — not read from chain</span>
      <span>${badge("SIMULATED")} <b>projected/estimated</b> outcome — none appear in this round</span>
    </div>
  </div>

  <div class="panel">
    <h2>VEYRA Agent #${record.veyraAgentId} ${badge("OBSERVED")}</h2>
    <div class="kv">
      <div><span class="k">Owner wallet</span><span class="v">${esc(record.ownerWallet)}</span></div>
      <div><span class="k">ERC-8004 registry</span><span class="v">BSC testnet</span></div>
    </div>
  </div>

  <div class="panel">
    <h2>Position #${record.positionTokenId} — observed at block ${record.observedAtBlock} ${badge("OBSERVED")}</h2>
    <div class="kv">
      <div><span class="k">Pool</span><span class="v">${esc(record.observed.poolAddress)}</span></div>
      <div><span class="k">Fee tier</span><span class="v">${record.observed.fee}</span></div>
      <div><span class="k">token0</span><span class="v">${esc(record.observed.token0)} (${record.observed.token0Decimals}d)</span></div>
      <div><span class="k">token1</span><span class="v">${esc(record.observed.token1)} (${record.observed.token1Decimals}d)</span></div>
      <div><span class="k">Position range</span><span class="v">[${record.observed.tickLower}, ${record.observed.tickUpper})</span></div>
      <div><span class="k">Current tick</span><span class="v">${record.observed.currentTick}</span></div>
      <div><span class="k">Position liquidity</span><span class="v">${record.observed.positionLiquidity}</span></div>
      <div><span class="k">Pool liquidity</span><span class="v">${record.observed.poolLiquidity}</span></div>
    </div>
  </div>

  <div class="panel">
    <h2>Market Snapshot — the exact input handed to all three candidates</h2>
    <div class="kv">
      <div><span class="k">currentTick ${badge("OBSERVED")}</span><span class="v">${record.marketSnapshot.currentTick}</span></div>
      <div><span class="k">currentRange ${badge("OBSERVED")}</span><span class="v">[${record.marketSnapshot.currentRange.tickLower}, ${record.marketSnapshot.currentRange.tickUpper})</span></div>
      <div><span class="k">currentLiquidity ${badge("OBSERVED")}</span><span class="v">${record.marketSnapshot.currentLiquidity}</span></div>
      <div><span class="k">tickSpacing ${badge("DERIVED")}</span><span class="v">${record.marketSnapshot.tickSpacing}</span></div>
      <div><span class="k">recentVolatilityBps ${badge("SUPPLIED")}</span><span class="v">${record.marketSnapshot.recentVolatilityBps} — ${esc(record.marketSnapshot.recentVolatilityBpsProvenance)}</span></div>
    </div>
  </div>

  <div class="panel">
    <h2>Round result</h2>
    <div class="winner-banner">
      <span class="label-badge" style="background:rgba(47,191,113,0.2);color:#7fe0a8;">🏆 ${esc(winner.displayLabel)}</span>
      <span class="name">${esc(winner.candidateId)}</span>
      <span class="score">${winner.score.totalScore.toFixed(2)}</span>
    </div>
  </div>

  <div class="cards">
    ${record.proposals.map(candidateCard).join("\n")}
  </div>

  <div class="panel">
    <h2>Verified Track Record</h2>
    <p class="empty-state">
      No track record exists yet for VEYRA Agent #${record.veyraAgentId}. Jobs completed: <strong>0</strong>.
      Reputation only accumulates from real, logged executions — none have run yet, so none are
      shown. This section will not display a number until a real completed job produces one.
    </p>
  </div>

  <footer>
    No execution occurred this round — this is <code>observe → propose → evaluate → rank</code>,
    not <code>observe → execute → rebalance</code>.<br />
    Artifact hash (sha256 of round content): <code class="hash">${record.artifactHash}</code><br />
    Full machine-readable record: <code>docs/arena-rounds/round-${String(record.roundId).padStart(4, "0")}.json</code>
  </footer>

</div>
</body>
</html>
`;
}

function main() {
  const record: RoundRecord = JSON.parse(readFileSync(RECORD_PATH, "utf-8"));
  const html = render(record);

  mkdirSync(ROUNDS_DIR, { recursive: true });
  const roundHtmlPath = resolve(ROUNDS_DIR, `round-${String(record.roundId).padStart(4, "0")}.html`);
  writeFileSync(roundHtmlPath, html);
  writeFileSync(LATEST_HTML_PATH, html);

  console.log(`Wrote docs/arena-rounds/round-${String(record.roundId).padStart(4, "0")}.html`);
  console.log(`Wrote docs/arena.html (latest round pointer)`);
}

main();

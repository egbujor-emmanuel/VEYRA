import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AGENT_CATALOG, type JobCategory } from "../data/agentCatalog";
import { MaturityBadge } from "../components/MaturityBadge";
import { useLiveAgentState } from "../hooks/useLiveAgentState";
import { fetchLiveGridState } from "../chain/liveReads.gridTrading";
import { fetchLiveYieldState } from "../chain/liveReads.yieldOptimisation";
import { fetchLiveHealthFactorState } from "../chain/liveReads.healthFactor";
import { HirePanel } from "../components/HirePanel";
import { JobsPanel } from "../components/JobsPanel";
import { useConnectedWallet } from "../hooks/walletContext";

/**
 * What "activate" actually means, stated accurately.
 *
 * This previously said scheduled autonomous execution was "a documented next step, not yet
 * built". That stopped being true: the daemon runs on a schedule, holds VEYRA's agent session
 * key, and acts on positions whose owner has granted a live session -- proven on-chain with the
 * user's own signer discarded first (scripts/proveAgentAutonomy.mjs). Leaving the old wording up
 * would have told visitors the headline capability did not exist, on the page where they came to
 * look for it.
 */
function ActivateToggle() {
  const [active, setActive] = useState(false);
  return (
    <div className="panel">
      <h2>Activate</h2>
      <p className="rationale">
        VEYRA acts on positions whose owner has granted it a live, scoped session — it does not need this
        tab open. Activating here just turns on live on-chain reads so you can watch the state it is
        working from.
      </p>
      <button className="btn btn-secondary" onClick={() => setActive((a) => !a)}>
        {active ? "Stop watching" : "Watch live state"}
      </button>
      {active && (
        <p className="freshness" style={{ marginTop: 12 }}>
          Reading live from BSC testnet. The agent itself runs on a schedule against every account that has
          authorized it — grant a session from the marketplace and it will pick your position up.
        </p>
      )}
    </div>
  );
}

function RebalanceDetail() {
  return (
    <div className="panel">
      <p>Rebalancing has its own full dashboard, with live position state, arena history, and execution history.</p>
      <Link to="/">View the Rebalancing Dashboard &rarr;</Link>
    </div>
  );
}

function GridTradingDetail() {
  const { query, refetch } = useLiveAgentState(fetchLiveGridState);
  if (query.status === "loading") return <div className="panel">Loading live grid state…</div>;
  if (query.status === "error") {
    return (
      <div className="error-box">
        <p>{query.message}</p>
        <button className="retry-btn" onClick={refetch}>Retry</button>
      </div>
    );
  }
  const { snapshot, fetchedAt } = query.data;
  return (
    <>
      <div className="hero-grid">
        {snapshot.slots.map((slot, i) => (
          <div className="hero-stat" key={i}>
            <div className="label-badge">Slot {i}</div>
            <div>Range [{slot.currentRange.tickLower}, {slot.currentRange.tickUpper})</div>
            <div>Liquidity: {slot.currentLiquidity.toString()}</div>
            <div>Current tick: {slot.currentTick}</div>
          </div>
        ))}
      </div>
      <p className="freshness">Fetched live at {fetchedAt}</p>
      <ActivateToggle />
    </>
  );
}

function YieldOptimisationDetail() {
  const { query, refetch } = useLiveAgentState(fetchLiveYieldState);
  if (query.status === "loading") return <div className="panel">Loading live pool state…</div>;
  if (query.status === "error") {
    return (
      <div className="error-box">
        <p>{query.message}</p>
        <button className="retry-btn" onClick={refetch}>Retry</button>
      </div>
    );
  }
  const { snapshot, fetchedAt } = query.data;
  return (
    <>
      <div className="hero-grid">
        {snapshot.pools.map((pool) => (
          <div className="hero-stat" key={pool.poolAddress}>
            <div className="label-badge">{pool.label}{pool.poolAddress === snapshot.currentPoolAddress ? " (current)" : ""}</div>
            <div>Fee tier: {pool.fee / 10000}%</div>
            <div>Liquidity: {pool.currentLiquidity.toString()}</div>
            <div>Cumulative fee-growth (token0): {pool.feeGrowthGlobal0X128.toString()}</div>
            <div>Cumulative fee-growth (token1): {pool.feeGrowthGlobal1X128.toString()}</div>
          </div>
        ))}
      </div>
      <p className="freshness">Fetched live at {fetchedAt} -- cumulative since pool creation, not an APR.</p>
      <ActivateToggle />
    </>
  );
}

function HealthFactorDetail() {
  const { query, refetch } = useLiveAgentState(fetchLiveHealthFactorState);
  if (query.status === "loading") return <div className="panel">Loading live Venus account state…</div>;
  if (query.status === "error") {
    return (
      <div className="error-box">
        <p>{query.message}</p>
        <button className="retry-btn" onClick={refetch}>Retry</button>
      </div>
    );
  }
  const { snapshot, fetchedAt } = query.data;
  const statusCls = snapshot.solvencyStatus === "HEALTHY" ? "status-good" : snapshot.solvencyStatus === "SHORTFALL" ? "status-bad" : "status-muted";
  return (
    <>
      <div className="hero-grid">
        <div className="hero-stat">
          <div className="label-badge">Solvency status (Venus's own signal)</div>
          <span className={`status-pill ${statusCls}`}>{snapshot.solvencyStatus}</span>
        </div>
        <div className="hero-stat">
          <div className="label-badge">Borrow-to-capacity ratio</div>
          <div>{snapshot.borrowToCapacityRatio.toFixed(1)}%</div>
        </div>
        <div className="hero-stat">
          <div className="label-badge">Borrowed</div>
          <div>{(Number(snapshot.observation.borrowedPrincipalUnderlyingUnits) / 10 ** snapshot.observation.borrowedTokenDecimals).toFixed(4)} {snapshot.observation.borrowedTokenSymbol}</div>
        </div>
        <div className="hero-stat">
          <div className="label-badge">Liquidity headroom (USD, 1e18-scaled)</div>
          <div>{snapshot.observation.liquidityUsd1e18.toString()}</div>
        </div>
      </div>
      <p className="freshness">Fetched live at {fetchedAt} -- not called a "health factor": Venus is a Compound fork and doesn't expose Aave's single number.</p>
      <ActivateToggle />
    </>
  );
}

export function AgentDetail() {
  const { categoryId } = useParams<{ categoryId: string }>();
  const agent = AGENT_CATALOG.find((a) => a.id === categoryId);
  const wallet = useConnectedWallet();

  if (!agent) {
    return (
      <div className="mx-auto w-full max-w-[1180px] px-6 pt-16">
        <p>Unknown category "{categoryId}".</p>
        <Link to="/agents">&larr; Back to the marketplace</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 pt-10 pb-4">
      <Link to="/agents" className="text-sm text-muted-foreground no-underline hover:text-foreground">
        &larr; Back to the marketplace
      </Link>

      <header className="mt-6 mb-10">
        <h1 className="text-display text-[clamp(2rem,5vw,3rem)] text-foreground">{agent.displayName}</h1>
        <div className="mt-4">
          <MaturityBadge maturity={agent.maturity} />
        </div>
        <p className="mt-5 max-w-[70ch] text-[16px] leading-relaxed text-muted-foreground">
          {agent.longDescription}
        </p>
      </header>

      {renderDetail(agent.id)}

      {/* The paid rail. Mounted here rather than on the marketplace because a job is funded
          against one specific agent, and the escrow description records which. */}
      <HirePanel wallet={wallet} agentName={agent.displayName} />

      {/* Every job this browser has funded, with a reclaim button for anything undelivered. */}
      <JobsPanel wallet={wallet} agentName={agent.displayName} />
    </div>
  );
}

function renderDetail(id: JobCategory) {
  switch (id) {
    case "rebalance":
      return <RebalanceDetail />;
    case "grid-trading":
      return <GridTradingDetail />;
    case "yield-optimisation":
      return <YieldOptimisationDetail />;
    case "health-factor-monitoring":
      return <HealthFactorDetail />;
  }
}

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AGENT_CATALOG, type JobCategory } from "../data/agentCatalog";
import { MaturityBadge } from "../components/MaturityBadge";
import { AgentTrackRecord } from "../components/AgentTrackRecord";
import { useLiveAgentState } from "../hooks/useLiveAgentState";
import { fetchLivePositionState } from "../chain/liveReads";
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
/**
 * The thresholds each agent actually acts on, quoted from the strategy that owns them.
 *
 * Stated on the page because "what will this refuse to do" is the part a visitor cannot infer
 * from a live number, and it is the part that makes the agent trustworthy rather than merely
 * active. Kept in sync with the named constants by comment, not duplicated silently.
 */
const WARNING_THRESHOLD_PCT = 60; // strategies/healthFactorMonitor.ts WARNING_THRESHOLD_PCT
const MIN_RELATIVE_LIQUIDITY_PCT = 25; // strategies/yieldOptimiser.ts MIN_RELATIVE_LIQUIDITY_BPS (2500 bps)
const RATIO_MISMATCH_PCT = 1; // simulation.ts RATIO_MISMATCH_THRESHOLD (0.01)

function Loading({ what }: { what: string }) {
  return (
    <div className="panel">
      <p className="rationale">Reading live {what} from BSC testnet — a public RPC, so this takes a few seconds.</p>
    </div>
  );
}

/** A short "here is the rule this agent applies" line under the live state. */
function DecisionRule({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel">
      <h2>What it does with this</h2>
      <p className="rationale">{children}</p>
    </div>
  );
}

/**
 * What "activate" means, per category, stated accurately.
 *
 * This panel used to render the same sentence on all four pages: VEYRA acts on a schedule and
 * does not need the tab open. That is true of rebalancing and health-factor monitoring, which the
 * daemon runs on a schedule. It was not true of grid trading or yield optimisation, which only
 * ever ran when an operator invoked the orchestrator. Rather than qualify it vaguely, each page
 * now says which of the two it is, and why.
 */
type Scheduling = "scheduled" | "on-demand";

/**
 * What the schedule actually delivers, measured rather than assumed.
 *
 * The cron asks for every ten minutes, and quoting that as the real cadence was wrong by more than a
 * factor of twenty: GitHub throttles scheduled workflows hard on free runners. The figures below
 * come from the ten consecutive scheduled runs in this repo's own Actions history, which anyone
 * can check.
 */
const CADENCE =
  "The workflow asks for every ten minutes; GitHub delivers scheduled runs far less often than that on free runners. Measured across ten consecutive scheduled runs on 3-4 Sep 2026: median 2h48m between passes, fastest 2h01m, slowest 4h50m.";

const SCHEDULING: Record<JobCategory, { mode: Scheduling; note: string }> = {
  rebalance: {
    mode: "scheduled",
    note:
      "The daemon runs against every account that has granted VEYRA a live, scoped session, and does not need this tab open — activating here only turns on live reads so you can watch the state it works from. " +
      CADENCE +
      " Adequate against 24-hour job expiries, but it is a few times a day, not continuous, and saying otherwise would overstate it.",
  },
  "health-factor-monitoring": {
    mode: "scheduled",
    note:
      "The daemon reads this position and repays without being asked once the ratio crosses the threshold. It does not need this tab open. " +
      CADENCE +
      " The position drifts on accrued interest by roughly a ten-thousandth of a percent per pass, so hours between checks is comfortably inside the margin.",
  },
  "grid-trading": {
    mode: "on-demand",
    note: "Grid runs when the orchestrator is invoked, not on a schedule. It was put under the daemon and taken back out: the first scheduled pass decreased and collected a slot as the strategy asked, then the ratio-fixing swap failed and the executor's own guard refused to mint a position at the wrong ratio. The slot was restored, and this stays operator-invoked until that path is fixed. The guard behaving correctly is why the damage stopped at one slot.",
  },
  "yield-optimisation": {
    mode: "on-demand",
    note: "Deliberately not scheduled. A migration moves the whole position, and this run's own record states the advantage it responded to was seeded rather than observed — BSC testnet has too little volume for a candidate to overtake organically. Automating a capital move on a signal the record itself calls unreliable would be the wrong thing to build.",
  },
};

function ActivateToggle({ category }: { category: JobCategory }) {
  const [active, setActive] = useState(false);
  const { mode, note } = SCHEDULING[category];
  return (
    <div className="panel">
      <h2>Activate</h2>
      <span className={`status-pill ${mode === "scheduled" ? "status-good" : "status-muted"}`}>
        {mode === "scheduled" ? "RUNS ON A SCHEDULE" : "OPERATOR-INVOKED"}
      </span>
      <p className="rationale" style={{ marginTop: 10 }}>{note}</p>
      <button className="btn btn-secondary" onClick={() => setActive((a) => !a)}>
        {active ? "Stop watching" : "Watch live state"}
      </button>
      {active && (
        <p className="freshness" style={{ marginTop: 12 }}>
          Reading live from BSC testnet.
        </p>
      )}
    </div>
  );
}

function RebalanceDetail() {
  const { query, refetch } = useLiveAgentState(fetchLivePositionState);
  if (query.status === "loading") return <Loading what="position state" />;
  if (query.status === "error") {
    return (
      <div className="error-box">
        <p>{query.message}</p>
        <button className="retry-btn" onClick={refetch}>Retry</button>
      </div>
    );
  }
  const { observation: o, inRange, ownershipVerified, fetchedAt } = query.data;
  return (
    <>
      <div className="hero-grid">
        <div className="hero-stat">
          <div className="label-badge">Position</div>
          <div>#{o.positionTokenId.toString()}</div>
        </div>
        <div className="hero-stat">
          <div className="label-badge">Range vs current tick</div>
          <div>
            [{o.tickLower}, {o.tickUpper}) · tick {o.currentTick}
          </div>
          <span className={`status-pill ${inRange ? "status-good" : "status-bad"}`}>
            {inRange ? "IN RANGE" : "OUT OF RANGE"}
          </span>
        </div>
        <div className="hero-stat">
          <div className="label-badge">Owner verified</div>
          <span className={`status-pill ${ownershipVerified ? "status-good" : "status-bad"}`}>
            {ownershipVerified ? "VERIFIED" : "MISMATCH"}
          </span>
        </div>
      </div>
      <p className="freshness">Fetched live at {fetchedAt}</p>

      <DecisionRule>
        Out of range does not by itself trigger a rebalance. The proposal still has to outscore every
        baseline on the same axes, and the execution policy still has to authorize it — three of the four
        recorded runs were blocked at exactly that gate. When it does proceed, the ratio-fixing swap runs
        only if a stranded fraction would exceed {RATIO_MISMATCH_PCT}% of either token.
      </DecisionRule>

      <div className="panel">
        <p>Rebalancing has its own full dashboard, with live position state, arena history, and execution history.</p>
        <Link to="/">View the Rebalancing Dashboard &rarr;</Link>
      </div>
      <ActivateToggle category="rebalance" />
    </>
  );
}


function GridTradingDetail() {
  const { query, refetch } = useLiveAgentState(fetchLiveGridState);
  if (query.status === "loading") return <Loading what="grid state" />;
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
        {snapshot.slots.map((slot, i) => {
          // The one fact that decides whether this slot is a candidate for recentering.
          const inRange =
            slot.currentTick >= slot.currentRange.tickLower && slot.currentTick < slot.currentRange.tickUpper;
          return (
            <div className="hero-stat" key={i}>
              <div className="label-badge">Slot {i}</div>
              <div>
                [{slot.currentRange.tickLower}, {slot.currentRange.tickUpper}) · tick {slot.currentTick}
              </div>
              <span className={`status-pill ${inRange ? "status-good" : "status-muted"}`}>
                {inRange ? "IN RANGE" : "OUT OF RANGE"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="freshness">Fetched live at {fetchedAt}</p>

      <DecisionRule>
        A slot is only recentered when it is <em>both</em> out of range <em>and</em> drifted from where the
        ladder would now place it. An out-of-range slot that the ladder still agrees with is left alone —
        recentering it would spend gas to arrive back where it already is.
      </DecisionRule>
      <ActivateToggle category="grid-trading" />
    </>
  );
}

function YieldOptimisationDetail() {
  const { query, refetch } = useLiveAgentState(fetchLiveYieldState);
  if (query.status === "loading") return <Loading what="pool state" />;
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
        {snapshot.pools.map((pool) => {
          const isCurrent = pool.poolAddress.toLowerCase() === snapshot.currentPoolAddress.toLowerCase();
          // Raw X128 fee-growth is a 39-digit integer -- unreadable, and meaningful only against the
          // other candidates. Shown as a share of the largest instead, with the raw value on hover.
          const growth = pool.feeGrowthGlobal0X128 + pool.feeGrowthGlobal1X128;
          const maxGrowth = snapshot.pools.reduce(
            (m, q) => (q.feeGrowthGlobal0X128 + q.feeGrowthGlobal1X128 > m ? q.feeGrowthGlobal0X128 + q.feeGrowthGlobal1X128 : m),
            0n,
          );
          const growthPct = maxGrowth === 0n ? 0 : Number((growth * 1000n) / maxGrowth) / 10;
          // The depth gate: a candidate must hold at least 25% of the current pool's liquidity.
          const currentPool = snapshot.pools.find(
            (q) => q.poolAddress.toLowerCase() === snapshot.currentPoolAddress.toLowerCase(),
          );
          const depthPct =
            !currentPool || currentPool.currentLiquidity === 0n
              ? null
              : Number((pool.currentLiquidity * 1000n) / currentPool.currentLiquidity) / 10;
          const passesDepth = isCurrent || (depthPct !== null && depthPct >= MIN_RELATIVE_LIQUIDITY_PCT);
          return (
            <div className="hero-stat" key={pool.poolAddress}>
              {/* "Reference pool", not "capital is here": these three are organic pools the agent
                  compares, chosen precisely because it had no hand in their trading history. The
                  deployed yield position sits elsewhere -- see the note below. */}
              <div className="label-badge">
                {pool.label}
                {isCurrent ? " (reference)" : ""}
              </div>
              <div>Fee tier: {pool.fee / 10000}%</div>
              <div title={`token0 ${pool.feeGrowthGlobal0X128} / token1 ${pool.feeGrowthGlobal1X128}`}>
                Fee growth: {growthPct.toFixed(1)}% of the best candidate
              </div>
              <div>
                Depth: {depthPct === null ? "n/a" : `${depthPct.toFixed(1)}% of the reference pool`}
              </div>
              {!isCurrent && (
                <span className={`status-pill ${passesDepth ? "status-good" : "status-muted"}`}>
                  {passesDepth ? "PASSES DEPTH GATE" : `REJECTED — UNDER ${MIN_RELATIVE_LIQUIDITY_PCT}%`}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="freshness">Fetched live at {fetchedAt} -- cumulative since pool creation, not an APR.</p>

      <DecisionRule>
        Fee growth is measured <em>per unit of liquidity</em>, so a nearly-empty pool can post the highest
        score while being unable to absorb the trade. Any candidate holding under{" "}
        {MIN_RELATIVE_LIQUIDITY_PCT}% of the reference pool's liquidity is rejected on depth and named as
        rejected, rather than quietly held. That gate has fired on real testnet pools — one of the three
        above is failing it right now.
      </DecisionRule>

      <div className="panel">
        <h2>Where the capital actually is</h2>
        <p className="rationale">
          The pools above are read for their organic trading history — the agent had no hand in producing
          it. They are not where VEYRA's yield capital sits. The one executed migration on record moved a
          real position into <span className="mono">#37141</span> on a VUSD/WBNB pool, and that run's own
          record states the condition it responded to was seeded by us rather than observed: BSC testnet
          has too little volume for a candidate to overtake organically. Both facts are kept — the
          execution was real, and so was the manufactured setup that triggered it.
        </p>
      </div>
      <ActivateToggle category="yield-optimisation" />
    </>
  );
}

function HealthFactorDetail() {
  const { query, refetch } = useLiveAgentState(fetchLiveHealthFactorState);
  if (query.status === "loading") return <Loading what="Venus account state" />;
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
          <div>
            {snapshot.borrowToCapacityRatio.toFixed(2)}%{" "}
            <span style={{ color: "var(--muted)" }}>of {WARNING_THRESHOLD_PCT}% threshold</span>
          </div>
          {/* The gap to the threshold is the whole point of watching: the position drifts toward it
              on accrued interest, and the daemon acts when it crosses. */}
          <div className="score-bar-track" style={{ marginTop: 6 }}>
            <div
              className="score-bar-fill"
              style={{
                width: `${Math.max(0, Math.min(100, (snapshot.borrowToCapacityRatio / WARNING_THRESHOLD_PCT) * 100))}%`,
                background:
                  snapshot.borrowToCapacityRatio >= WARNING_THRESHOLD_PCT ? "var(--warn)" : undefined,
              }}
            />
          </div>
        </div>
        <div className="hero-stat">
          <div className="label-badge">Borrowed</div>
          {/* A BTC-denominated debt is ~0.0000027 -- four fixed decimals rendered it as "0.0000",
              i.e. as no debt at all. Significant digits keep small balances legible. */}
          <div>
            {(() => {
              const amt =
                Number(snapshot.observation.borrowedPrincipalUnderlyingUnits) /
                10 ** snapshot.observation.borrowedTokenDecimals;
              return amt === 0 ? "0" : amt < 0.0001 ? amt.toPrecision(3) : amt.toFixed(4);
            })()}{" "}
            {snapshot.observation.borrowedTokenSymbol}
          </div>
        </div>
        <div className="hero-stat">
          <div className="label-badge">Borrowing headroom left</div>
          {/* Venus reports this 1e18-scaled; printing the raw integer told the reader nothing. */}
          <div>
            ${(Number(snapshot.observation.liquidityUsd1e18) / 1e18).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}
          </div>
        </div>
      </div>
      <p className="freshness">Fetched live at {fetchedAt} -- not called a "health factor": Venus is a Compound fork and doesn't expose Aave's single number.</p>

      <DecisionRule>
        At {WARNING_THRESHOLD_PCT}% the agent repays, unprompted — well short of Venus's own liquidation
        point, so it acts before the position is in danger rather than after. The debt grows on its own
        from accrued interest, which is what lets a crossing happen with nobody watching. Every repay is
        verified by re-reading the debt afterwards, because a Compound fork returns an error code instead
        of reverting: a mined transaction can change nothing.
      </DecisionRule>
      <ActivateToggle category="health-factor-monitoring" />
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
        <AgentTrackRecord category={agent.id} />
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

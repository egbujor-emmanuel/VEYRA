import { HashRouter, Routes, Route, NavLink, Link } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { ArenaHistory } from "./pages/ArenaHistory";
import { ArenaRoundDetail } from "./pages/ArenaRoundDetail";
import { ExecutionHistory } from "./pages/ExecutionHistory";
import { ExecutionDetail } from "./pages/ExecutionDetail";
import { Marketplace } from "./pages/Marketplace";
import { AgentDetail } from "./pages/AgentDetail";
import { HowItWorks } from "./pages/HowItWorks";
import { Button } from "./components/ui/button";
import { Logo } from "./components/Logo";
import { cn } from "./lib/utils";
import { WalletProvider } from "./hooks/walletContext";

const NAV = [
  { to: "/agents", label: "Agents", end: false },
  { to: "/", label: "Dashboard", end: true },
  { to: "/how-it-works", label: "How it works", end: false },
  { to: "/arena", label: "Arena", end: false },
  { to: "/executions", label: "Executions", end: false },
];

function TopNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-[68px] w-full max-w-[1180px] items-center gap-10 px-6">
        <Link to="/agents" className="flex items-center gap-2.5 no-underline">
          <Logo size={28} />
          <span className="text-[18px] font-semibold tracking-[-0.03em] text-foreground">VEYRA</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "rounded-full px-3 py-1.5 text-sm no-underline transition-colors",
                  isActive
                    ? "bg-white/[0.07] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Button asChild size="sm" variant="primary">
            <Link to="/agents" className="no-underline">
              Get started
            </Link>
          </Button>
        </div>
      </div>

      {/* Small screens lose the inline nav above, so it wraps onto its own scrollable row. */}
      <nav className="flex gap-1 overflow-x-auto border-t border-white/[0.06] px-6 py-2 md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "shrink-0 rounded-full px-3 py-1.5 text-[13px] no-underline transition-colors",
                isActive ? "bg-white/[0.07] text-foreground" : "text-muted-foreground",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-14 border-t border-white/[0.07]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-[13px] text-muted-foreground">
        <span>VEYRA · ERC-8004 agent #1890</span>
        <span className="opacity-40">·</span>
        <span>BNB Smart Chain Testnet</span>
        <a
          className="ml-auto no-underline hover:text-foreground"
          href="https://testnet.bscscan.com/address/0x9429BE71274b9E5fB56EE7C57C58298FFF720f11"
          target="_blank"
          rel="noreferrer"
        >
          View on BscScan →
        </a>
      </div>
    </footer>
  );
}

export function App() {
  return (
    <HashRouter>
      <WalletProvider>
      <TopNav />
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<Marketplace />} />
          <Route path="/agents/:categoryId" element={<AgentDetail />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/arena" element={<ArenaHistory />} />
          <Route path="/arena/:roundId" element={<ArenaRoundDetail />} />
          <Route path="/executions" element={<ExecutionHistory />} />
          <Route path="/executions/:runArchiveId" element={<ExecutionDetail />} />
        </Routes>
      </main>
      <Footer />
      </WalletProvider>
    </HashRouter>
  );
}

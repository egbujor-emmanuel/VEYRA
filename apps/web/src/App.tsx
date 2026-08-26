import { HashRouter, Routes, Route, NavLink } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { ArenaHistory } from "./pages/ArenaHistory";
import { ArenaRoundDetail } from "./pages/ArenaRoundDetail";
import { ExecutionHistory } from "./pages/ExecutionHistory";
import { ExecutionDetail } from "./pages/ExecutionDetail";

export function App() {
  return (
    <HashRouter>
      <div className="topnav">
        <span className="brand">VEYRA</span>
        <span className="tagline">autonomous finance, verified</span>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/arena">Arena</NavLink>
          <NavLink to="/executions">Executions</NavLink>
        </nav>
      </div>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/arena" element={<ArenaHistory />} />
        <Route path="/arena/:roundId" element={<ArenaRoundDetail />} />
        <Route path="/executions" element={<ExecutionHistory />} />
        <Route path="/executions/:runArchiveId" element={<ExecutionDetail />} />
      </Routes>
    </HashRouter>
  );
}

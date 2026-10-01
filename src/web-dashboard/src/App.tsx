import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { dashboardAPI } from './api';
import type { DashboardData } from './types';
import Layout from './components/Layout';
import Overview from './components/Overview';
import HelpPage from './components/HelpPage';
import DAGView from './components/DAGView';
import CostDashboard from './components/CostDashboard';
import BenchmarkCharts from './components/BenchmarkCharts';
import HealthPanel from './components/HealthPanel';
import ModelsPanel from './components/ModelsPanel';
import RoutingInsightsPanel from './components/RoutingInsightsPanel';
import RequestsPanel from './components/RequestsPanel';
import TracePanel from './components/TracePanel';
import AdminPanel from './components/AdminPanel';
import AgentHub from './components/AgentHub';
import TasksPage from './components/TasksPage';
import ChatPage from './components/ChatPage';
import EvalsPage from './components/EvalsPage';
import GatewayPage from './components/GatewayPage';
import PlatformsPage from './components/PlatformsPage';
import BedrockOnboarding from './components/BedrockOnboarding';
import ContactsPage from './components/ContactsPage';
import ModelTimeline from './components/ModelTimeline';
// Memory + conversation history were being COMPUTED and SERVED by the server
// (`readMemoryData()` / `readHistoryData()` in the /api payload) but no route
// rendered them, so the panels sat unreachable and the data reached nobody.
import MemoryPanel from './components/MemoryPanel';
import HistoryBrowser from './components/HistoryBrowser';
// Skill executions were invisible end to end: this panel and the audit backend
// behind `/api/executions` were both complete and both unreferenced, so a skill
// run left no trace a user could inspect. `onClear`/`onExport` are intentionally
// left off — the panel guards them and hides those actions, so this is a
// complete integration of the panel's view capability rather than dead buttons.
import { ExecutionHistory } from './components/ExecutionHistory';
// The env-var editor was a complete, styled component with a live write
// endpoint behind it and no route — so skill secrets could be written (from the
// in-chat card) but never reviewed, corrected or removed. The page supplies the
// rows + callbacks the presentational editor expects, and gates writes on the
// same role the server enforces.
import SkillEnvPage from './components/SkillEnvPage';
// The process switches (isolation, resume, the debug log, OTLP export, tool
// hooks) are read by the run itself, not by a skill, and several are tri-state —
// so they get a page that can express on/off/unset rather than a NAME=VALUE box.
import ProcessEnvPage from './components/ProcessEnvPage';

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('--');
  const [refreshing, setRefreshing] = useState(false);

  const handleData = useCallback((d: DashboardData) => {
    setData(d);
    setLastUpdated(new Date().toLocaleTimeString());
  }, []);

  const handleConnection = useCallback((c: boolean) => {
    setConnected(c);
  }, []);

  // The top bar's Refresh goes through the SAME call the initial load uses, so
  // the button cannot refresh a different set of things than the page shows.
  // `fetchAll` resolves null on failure (the SSE stream reports health itself),
  // so a failed refresh keeps the last good data rather than blanking the page.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await dashboardAPI.fetchAll();
      if (d) handleData(d);
    } finally {
      setRefreshing(false);
    }
  }, [handleData]);

  useEffect(() => {
    // Fetch initial data
    dashboardAPI.fetchAll().then((d) => {
      if (d) handleData(d);
    });

    // Subscribe to SSE updates
    const unsubData = dashboardAPI.subscribe(handleData);
    const unsubConn = dashboardAPI.onConnectionChange(handleConnection);
    dashboardAPI.connect();

    return () => {
      unsubData();
      unsubConn();
      dashboardAPI.disconnect();
    };
  }, [handleData, handleConnection]);

  return (
    <Layout
      connected={connected}
      lastUpdated={lastUpdated}
      onRefresh={handleRefresh}
      refreshing={refreshing}
    >
      <Routes>
        {/* Phase 5 — Chat is the front door; Overview (and every other room)
            stays reachable as a panel, never required. */}
        <Route path="/" element={<ChatPage />} />
        {/* Overview gets the same refresh handler the top bar uses, so its own
            "Refresh data" control cannot drift from the shell's. */}
        <Route
          path="/overview"
          element={<Overview data={data} onRefresh={handleRefresh} refreshing={refreshing} />}
        />
        <Route path="/chat" element={<Navigate to="/" replace />} />
        <Route path="/dag" element={<DAGView data={data} />} />
        <Route path="/costs" element={<CostDashboard data={data} />} />
        <Route path="/benchmarks" element={<BenchmarkCharts data={data} />} />
        <Route path="/models" element={<ModelsPanel />} />
        <Route path="/models/timeline" element={<ModelTimeline />} />
        <Route path="/routing" element={<RoutingInsightsPanel data={data} />} />
        <Route path="/requests" element={<RequestsPanel data={data} />} />
        <Route path="/traces" element={<TracePanel />} />
        <Route path="/hub" element={<AgentHub />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/evals" element={<EvalsPage data={data} />} />
        <Route path="/platforms" element={<PlatformsPage />} />
        <Route path="/bedrock" element={<BedrockOnboarding canWrite={true} sessionExpired={(msg) => console.error(msg)} />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/gateway" element={<GatewayPage />} />
        <Route path="/env" element={<SkillEnvPage />} />
        <Route path="/process-env" element={<ProcessEnvPage />} />
        <Route path="/memory" element={<MemoryPanel data={data} />} />
        <Route path="/history" element={<HistoryBrowser data={data} />} />
        <Route
          path="/executions"
          element={<ExecutionHistory onFetch={(f) => dashboardAPI.fetchExecutionAudit(f)} />}
        />
        {/* The System tab is the doctor page: it shows the pass/warn/fail checks
            and the REAL SSE state, which is tracked here and passed down — the
            panel used to hardcode "● Connected" and could not be wrong. */}
        <Route
          path="/system"
          element={<HealthPanel data={data} connected={connected} lastUpdated={lastUpdated} />}
        />
        <Route path="/admin" element={<AdminPanel />} />
        {/* Help is a destination, not a modal: it is the page a user reads
            before they know which of the other tabs they want, and it derives
            its contents from the same constants the shell and the cheatsheet
            use, so it cannot describe a shortcut or a page that is gone. */}
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

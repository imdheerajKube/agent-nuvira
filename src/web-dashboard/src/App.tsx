import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { dashboardAPI } from './api';
import type { DashboardData } from './types';
import Layout from './components/Layout';
import Overview from './components/Overview';
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

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('--');

  const handleData = useCallback((d: DashboardData) => {
    setData(d);
    setLastUpdated(new Date().toLocaleTimeString());
  }, []);

  const handleConnection = useCallback((c: boolean) => {
    setConnected(c);
  }, []);

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
    <Layout connected={connected} lastUpdated={lastUpdated}>
      <Routes>
        {/* Phase 5 — Chat is the front door; Overview (and every other room)
            stays reachable as a panel, never required. */}
        <Route path="/" element={<ChatPage />} />
        <Route path="/overview" element={<Overview data={data} />} />
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
        <Route path="/memory" element={<MemoryPanel data={data} />} />
        <Route path="/history" element={<HistoryBrowser data={data} />} />
        <Route
          path="/executions"
          element={<ExecutionHistory onFetch={(f) => dashboardAPI.fetchExecutionAudit(f)} />}
        />
        <Route path="/system" element={<HealthPanel data={data} />} />
        <Route path="/admin" element={<AdminPanel />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

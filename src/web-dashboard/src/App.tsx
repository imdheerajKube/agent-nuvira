import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { dashboardAPI } from './api';
import type { DashboardData } from './types';
import Layout from './components/Layout';
import Overview from './components/Overview';
import DAGView from './components/DAGView';
import HistoryBrowser from './components/HistoryBrowser';
import CostDashboard from './components/CostDashboard';
import BenchmarkCharts from './components/BenchmarkCharts';
import MemoryPanel from './components/MemoryPanel';
import HealthPanel from './components/HealthPanel';
import ModelsPanel from './components/ModelsPanel';

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
        <Route path="/" element={<Overview data={data} />} />
        <Route path="/dag" element={<DAGView data={data} />} />
        <Route path="/history" element={<HistoryBrowser data={data} />} />
        <Route path="/costs" element={<CostDashboard data={data} />} />
        <Route path="/benchmarks" element={<BenchmarkCharts data={data} />} />
        <Route path="/memory" element={<MemoryPanel data={data} />} />
        <Route path="/models" element={<ModelsPanel />} />
        <Route path="/system" element={<HealthPanel data={data} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

interface LayoutProps {
  children: ReactNode;
  connected: boolean;
  lastUpdated: string;
}

const NAV_ITEMS = [
  // Phase 5 — Chat is the front door (the lobby); the other rooms are panels.
  { path: '/', label: 'Chat', icon: '💬' },
  { path: '/overview', label: 'Overview', icon: '📊' },
  { path: '/dag', label: 'Execution', icon: '🔀' },
  { path: '/tasks', label: 'Tasks', icon: '🚀' },
  { path: '/evals', label: 'Evals', icon: '🏆' },
  { path: '/platforms', label: 'Platforms', icon: '🌐' },
  { path: '/gateway', label: 'Gateway', icon: '📡' },
  { path: '/models', label: 'Models', icon: '🧠' },
  { path: '/models/timeline', label: 'Timeline', icon: '📅' },
  { path: '/routing', label: 'Routing', icon: '🤖' },
  { path: '/requests', label: 'Requests', icon: '📨' },
  { path: '/hub', label: 'Agent Hub', icon: '🧰' },
  { path: '/traces', label: 'Traces', icon: '🔍' },
  { path: '/costs', label: 'Costs', icon: '💰' },
  { path: '/history', label: 'History', icon: '📝' },
  { path: '/benchmarks', label: 'Benchmarks', icon: '📈' },
  { path: '/memory', label: 'Memory', icon: '💾' },
  { path: '/system', label: 'System', icon: '⚙️' },
  { path: '/admin', label: 'Admin', icon: '🛠️' },
];

export default function Layout({ children, connected, lastUpdated }: LayoutProps) {
  const statusClass = connected ? 'connected' : 'reconnecting';
  const statusText = connected ? 'Connected' : 'Reconnecting...';

  return (
    <div className="layout">
      <nav className="nav">
        <div className="nav-header">
          <span className="nav-logo">🤖</span>
          <span className="nav-title">Agent-Nuvira</span>
        </div>
        <div className="nav-links">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {item.icon} {item.label}
            </NavLink>
          ))}
        </div>
        <div className="nav-footer">
          <span className={`status-dot ${statusClass}`} />
          <span className="status-text">{statusText}</span>
          <span className="last-updated">{lastUpdated}</span>
        </div>
      </nav>
      <main className="main">
        {children}
      </main>
    </div>
  );
}

import type { DashboardData } from '../types';
import { formatCount } from '../format';
import PageHeader from './PageHeader';
import ContinuitySection from './ContinuitySection';

interface MemoryPanelProps {
  data: DashboardData | null;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return formatCount(n);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || value === null) return '0%';
  return (value * 100).toFixed(1) + '%';
}

/** Human label for the active vector-search backend (BackendType in vector-store.ts). */
const VECTOR_BACKEND_LABEL: Record<string, string> = {
  'faiss-native': 'native FAISS',
  'faiss-ivf': 'FAISS-style IVF-flat ANN',
  json: 'exact flat cosine (JSON)',
};

export default function MemoryPanel({ data }: MemoryPanelProps) {
  if (!data) {
    // Header kept in the loading branch, so the page still says what it is.
    return (
      <>
        <PageHeader icon="💾" title="Memory Store" />
        <div className="loading-state"><p>Loading memory data...</p></div>
      </>
    );
  }

  const { memory, health } = data;
  const entries = Object.entries(memory.byFingerprint || {}).sort(([, a], [, b]) => b - a);
  const factEntries = Object.entries(memory.facts?.byProject || {}).sort(([, a], [, b]) => b - a);
  const namespaces = [...(memory.vectorNamespaces || [])].sort((a, b) => b.entries - a.entries);
  const recall = memory.recall || { total: 0, today: 0, last7d: 0 };

  return (
    <>
      <PageHeader icon="💾" title="Memory Store" />

      <div className="stats-grid mini">
        <div className="stat-card">
          <div className="stat-value">{formatNumber(memory.total)}</div>
          <div className="stat-label">Trajectories</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatPercent(memory.avgScore)}</div>
          <div className="stat-label">Avg Score</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(memory.facts?.total)}</div>
          <div className="stat-label">Facts</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(recall.total)}</div>
          <div className="stat-label">Recall Hits</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(health?.patterns)}</div>
          <div className="stat-label">Coding Patterns</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(health?.feedback)}</div>
          <div className="stat-label">Feedback Ratings</div>
        </div>
      </div>

      <p className="memory-backend">
        Memory tier: <code>{memory.backend || 'local'}</code>
        {' · '}Vector index: <code>{memory.vectorBackend || 'unknown'}</code>
        {memory.vectorBackend && VECTOR_BACKEND_LABEL[memory.vectorBackend] ? ` (${VECTOR_BACKEND_LABEL[memory.vectorBackend]})` : ''}
        {recall.last7d > 0 ? ` · ${formatNumber(recall.last7d)} recall(s) this week, ${formatNumber(recall.today)} today` : ' · no recalls yet'}
      </p>

      {/* Continuity (session snapshots + semantic recall index), with a way to
          see and forget what "on by default" stores on disk. */}
      <ContinuitySection />

      {entries.length > 0 && (
        <>
          <h2 className="section-subtitle">By Project Type</h2>
          <div className="memory-list">
            {entries.map(([project, count]) => (
              <div className="memory-item" key={project}>
                <span className="memory-project">{project}</span>
                <span className="memory-count">{count} trajectory(ies)</span>
              </div>
            ))}
          </div>
        </>
      )}

      {factEntries.length > 0 && (
        <>
          <h2 className="section-subtitle">Facts by Project</h2>
          <div className="memory-list">
            {factEntries.map(([project, count]) => (
              <div className="memory-item" key={project}>
                <span className="memory-project">{project}</span>
                <span className="memory-count">{count} fact(s)</span>
              </div>
            ))}
          </div>
        </>
      )}

      {namespaces.length > 0 && (
        <>
          <h2 className="section-subtitle">Vector Index by Namespace</h2>
          <p className="memory-namespace-note">
            Each namespace is its own index file. <code>default</code> holds only successful
            trajectories and indexed sessions — facts, repo chunks and the model registry have their
            own namespaces — so a small <code>default</code> count is corpus size, not a broken index.
          </p>
          <div className="memory-list">
            {namespaces.map((ns) => (
              <div className="memory-item" key={ns.name}>
                <span className="memory-project">{ns.name}</span>
                <span className="memory-count">{ns.entries} vector(s)</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

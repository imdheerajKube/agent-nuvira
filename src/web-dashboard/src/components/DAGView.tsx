import { useState, useEffect } from 'react';
import { dashboardAPI } from '../api';
import type { DashboardData, AgentNode, AgentEdge, DAGData } from '../types';

interface DAGViewProps {
  data: DashboardData | null;
}

// ─── Agent Visual Constants ─────────────────────────────────────────────────

const AGENT_ICONS: Record<string, string> = {
  planner: '📋',
  'context-gatherer': '📂',
  writer: '✏️',
  reviewer: '👁️',
  tester: '🧪',
  debugger: '🐛',
  runner: '▶️',
  git: '🔀',
  package: '📦',
  'github-release': '🏷️',
  security: '🔒',
  orchestrator: '🎯',
};

const AGENT_COLORS: Record<string, string> = {
  planner: '#58a6ff',
  'context-gatherer': '#39d2c0',
  writer: '#d29922',
  reviewer: '#bc8cff',
  tester: '#3fb950',
  debugger: '#f85149',
  runner: '#58a6ff',
  git: '#f0883e',
  package: '#db6d28',
  'github-release': '#3fb950',
  security: '#f85149',
  orchestrator: '#f0883e',
};

const STATUS_COLORS = {
  pending: { bg: '#1a1f2e', stroke: '#30363d', text: '#6e7681' },
  running: { bg: 'rgba(88, 166, 255, 0.12)', stroke: '#58a6ff', text: '#58a6ff' },
  completed: { bg: 'rgba(63, 185, 80, 0.12)', stroke: '#3fb950', text: '#3fb950' },
  failed: { bg: 'rgba(248, 81, 73, 0.12)', stroke: '#f85149', text: '#f85149' },
};

const STATUS_BADGES = {
  pending: '⏳ Pending',
  running: '▶️ Running',
  completed: '✅ Done',
  failed: '❌ Failed',
};

const AGENT_LABELS: Record<string, string> = {
  planner: 'Planner',
  'context-gatherer': 'Context',
  writer: 'Writer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  debugger: 'Debugger',
  runner: 'Runner',
  git: 'Git',
  package: 'Package',
  'github-release': 'Release',
  security: 'Security',
  orchestrator: 'Orchestrator',
};

// ─── Layout Engine ──────────────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  step: number;
  totalInStep: number;
  indexInStep: number;
}

function computeLayout(
  nodes: AgentNode[],
  edges: AgentEdge[],
  nodeW = 160,
  nodeH = 68,
  gapX = 40,
  gapY = 24,
  padding = 40,
): { layoutNodes: LayoutNode[]; svgW: number; svgH: number } {
  if (nodes.length === 0) {
    return { layoutNodes: [], svgW: 400, svgH: 200 };
  }

  // Assign steps based on topological order
  const steps = new Map<string, number>();
  const visited = new Set<string>();

  function assignStep(id: string): number {
    if (steps.has(id)) return steps.get(id)!;
    if (visited.has(id)) return 0; // cycle protection
    visited.add(id);

    const incoming = edges.filter((e) => e.to === id);
    if (incoming.length === 0) {
      steps.set(id, 0);
      return 0;
    }

    const maxDepStep = Math.max(...incoming.map((e) => assignStep(e.from)));
    const step = maxDepStep + 1;
    steps.set(id, step);
    return step;
  }

  for (const node of nodes) assignStep(node.id);

  // Group nodes by step
  const stepGroups = new Map<number, typeof nodes>();
  for (const node of nodes) {
    const s = steps.get(node.id) ?? 0;
    if (!stepGroups.has(s)) stepGroups.set(s, []);
    stepGroups.get(s)!.push(node);
  }

  const maxStep = Math.max(...stepGroups.keys());
  const maxNodesInStep = Math.max(...Array.from(stepGroups.values()).map((g) => g.length));

  const svgW = (maxStep + 1) * (nodeW + gapX) + padding * 2 - gapX;
  const svgH = Math.max(maxNodesInStep, 1) * (nodeH + gapY) + padding * 2 - gapY;

  const layoutNodes: LayoutNode[] = [];
  for (const node of nodes) {
    const step = steps.get(node.id) ?? 0;
    const group = stepGroups.get(step)!;
    const indexInStep = group.indexOf(node);
    const totalInStep = group.length;

    // Center the group vertically
    const groupHeight = totalInStep * (nodeH + gapY) - gapY;
    const startY = svgH / 2 - groupHeight / 2;

    layoutNodes.push({
      ...node,
      x: padding + step * (nodeW + gapX),
      y: startY + indexInStep * (nodeH + gapY),
      w: nodeW,
      h: nodeH,
      step,
      totalInStep,
      indexInStep,
    });
  }

  return { layoutNodes, svgW, svgH };
}

// ─── Time Formatting ────────────────────────────────────────────────────────

function formatDuration(start?: number, end?: number): string {
  if (!start) return '--';
  const ms = (end || Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function formatTime(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-US', { minute: '2-digit', second: '2-digit' });
}

// ─── DAG Empty State ───────────────────────────────────────────────────────

function EmptyDAGState({ memoryTotal }: { memoryTotal?: number }) {
  return (
    <>
      <h2 className="section-title">🔀 Agent Execution DAG</h2>
      <p className="section-description">
        Live visualization of the agent execution pipeline. When an agent task runs, you'll see each step
        appear here in real time as it moves through planning → context gathering → writing → review → testing.
      </p>
      <div className="dag-empty">
        <div className="dag-empty-icon">🔀</div>
        <h3>No Active Pipeline</h3>
        <p>Run an agent task to see the execution pipeline appear here in real time.</p>
        {memoryTotal !== undefined && memoryTotal > 0 && (
          <p className="dag-empty-hint">
            <code>{memoryTotal}</code> past executions are stored in memory.
          </p>
        )}
      </div>
    </>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function DAGView({ data }: DAGViewProps) {
  const dag: DAGData | undefined = data?.dag as DAGData | undefined;
  const memoryTotal = data?.memory?.total;
  const [liveDAG, setLiveDAG] = useState<DAGData | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // Subscribe to DAG events via the existing dashboard API connection
  useEffect(() => {
    const unsub = dashboardAPI.onDAGEvent((dagData) => {
      setLiveDAG(dagData);
    });
    return unsub;
  }, []);

  // Use data.dag from dashboard updates (init/refresh events include dag field)
  const displayDAG = dag || liveDAG;

  if (!displayDAG || (displayDAG.nodes.length === 0 && !displayDAG.active)) {
    return <EmptyDAGState memoryTotal={memoryTotal} />;
  }

  const { nodes, edges, pipeline, active } = displayDAG;
  const { layoutNodes, svgW, svgH } = computeLayout(nodes, edges);

  const runningCount = nodes.filter((n) => n.status === 'running').length;
  const completedCount = nodes.filter((n) => n.status === 'completed').length;
  const failedCount = nodes.filter((n) => n.status === 'failed').length;
  const pendingCount = nodes.filter((n) => n.status === 'pending').length;
  const totalCount = nodes.length;

  return (
    <>
      <h2 className="section-title">🔀 Agent Execution DAG</h2>

      {/* Pipeline Header */}
      <div className={`dag-status-bar ${active ? 'active' : ''}`}>
        <div className="dag-pipeline-name">
          {active && <span className="dag-live-dot" />}
          {pipeline || 'Execution Pipeline'}
        </div>
        <div className="dag-pipeline-meta">
          {active && <span className="dag-live-badge">LIVE</span>}
          <span className="dag-step-count">{totalCount} steps</span>
          {runningCount > 0 && <span className="dag-running-badge">▶ {runningCount} running</span>}
          {pendingCount > 0 && <span className="dag-pending-badge">⏳ {pendingCount} pending</span>}
          <span className="dag-completed-badge">✅ {completedCount} done</span>
          {failedCount > 0 && <span className="dag-failed-badge">❌ {failedCount} failed</span>}
        </div>
      </div>

      {/* SVG DAG Visualization */}
      <div className="dag-container">
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
          {/* Edge definitions */}
          <defs>
            {edges.map((edge) => (
              <marker
                key={`arrow-${edge.from}-${edge.to}`}
                id={`arrow-${edge.from}-${edge.to}`}
                markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#58a6ff" />
              </marker>
            ))}
            {/* Glow filter for running nodes */}
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Draw edges */}
          {edges.map((edge) => {
            const fromNode = layoutNodes.find((n) => n.id === edge.from);
            const toNode = layoutNodes.find((n) => n.id === edge.to);
            if (!fromNode || !toNode) return null;

            const startX = fromNode.x + fromNode.w;
            const startY = fromNode.y + fromNode.h / 2;
            const endX = toNode.x;
            const endY = toNode.y + toNode.h / 2;
            const midX = (startX + endX) / 2;

            const toStatus = toNode.status;
            const edgeColor = toStatus === 'failed' ? '#f85149'
              : toStatus === 'running' ? '#58a6ff'
              : toStatus === 'completed' ? '#3fb950'
              : '#30363d';

            return (
              <g key={`edge-${edge.from}-${edge.to}`}>
                <path
                  d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
                  fill="none"
                  stroke={edgeColor}
                  strokeWidth={toStatus === 'pending' ? 1.5 : 2.5}
                  strokeOpacity={toStatus === 'pending' ? 0.3 : 0.8}
                  markerEnd={`url(#arrow-${edge.from}-${edge.to})`}
                  className="dag-edge"
                />
              </g>
            );
          })}

          {/* Draw nodes */}
          {layoutNodes.map((node) => {
            const colors = STATUS_COLORS[node.status];
            const color = AGENT_COLORS[node.agentType] || '#58a6ff';
            const icon = AGENT_ICONS[node.agentType] || '⚙️';
            const label = AGENT_LABELS[node.agentType] || node.agentType;
            const isSelected = selectedNode === node.id;
            const isRunning = node.status === 'running';

            return (
              <g
                key={`node-${node.id}`}
                onClick={() => setSelectedNode(isSelected ? null : node.id)}
                style={{ cursor: 'pointer' }}
                className="dag-node-group"
              >
                {/* Selection highlight */}
                {isSelected && (
                  <rect
                    x={node.x - 4}
                    y={node.y - 4}
                    width={node.w + 8}
                    height={node.h + 8}
                    rx={10}
                    ry={10}
                    fill="none"
                    stroke="#58a6ff"
                    strokeWidth={2}
                    strokeOpacity={0.5}
                  />
                )}

                {/* Node background */}
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.w}
                  height={node.h}
                  rx={8}
                  ry={8}
                  fill={colors.bg}
                  stroke={colors.stroke}
                  strokeWidth={isRunning ? 2.5 : 1.5}
                  strokeOpacity={0.9}
                  className={isRunning ? 'dag-node-running' : ''}
                  filter={isRunning ? 'url(#glow)' : undefined}
                />

                {/* Icon + Agent Type */}
                <text
                  x={node.x + 10}
                  y={node.y + 22}
                  fill="#e6edf3"
                  fontSize={10}
                  fontWeight={600}
                >
                  {icon} {label}
                </text>

                {/* Status text */}
                <text
                  x={node.x + node.w - 10}
                  y={node.y + 22}
                  textAnchor="end"
                  fill={colors.text}
                  fontSize={9}
                  fontWeight={500}
                >
                  {STATUS_BADGES[node.status]}
                </text>

                {/* Description */}
                <text
                  x={node.x + 10}
                  y={node.y + 40}
                  fill="#8b949e"
                  fontSize={9}
                >
                  {node.description.length > 28
                    ? node.description.slice(0, 26) + '..'
                    : node.description}
                </text>

                {/* Duration */}
                <text
                  x={node.x + 10}
                  y={node.y + 56}
                  fill="#6e7681"
                  fontSize={8}
                >
                  {formatDuration(node.startedAt, node.completedAt)}
                </text>

                {/* Time */}
                <text
                  x={node.x + node.w - 10}
                  y={node.y + 56}
                  textAnchor="end"
                  fill="#6e7681"
                  fontSize={8}
                >
                  {formatTime(node.startedAt || node.completedAt)}
                </text>

                {/* Summary on completed nodes (if selected or always for failed) */}
                {(node.status === 'failed' || isSelected) && node.summary && (
                  <foreignObject
                    x={Math.max(10, node.x - 80)}
                    y={node.y + node.h + 6}
                    width={node.w + 160}
                    height={36}
                  >
                    <div className="dag-node-summary" style={{
                      color: node.status === 'failed' ? '#f85149' : '#8b949e',
                      fontSize: '10px',
                      lineHeight: 1.4,
                      background: 'rgba(13,17,23,0.9)',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: `1px solid ${node.status === 'failed' ? 'rgba(248,81,73,0.3)' : 'rgba(48,54,61,0.5)'}`,
                      maxHeight: '32px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {node.summary}
                    </div>
                  </foreignObject>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Node Status Table */}
      <h3 className="section-subtitle">Step Details</h3>
      <div className="dag-table-wrapper">
        <table className="dag-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Time</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {layoutNodes.map((node) => (
              <tr key={node.id} className={`dag-row dag-row-${node.status}`}>
                <td className="dag-cell-step">{node.step}</td>
                <td className="dag-cell-agent">
                  <span className="dag-agent-dot" style={{ background: AGENT_COLORS[node.agentType] || '#58a6ff' }} />
                  {AGENT_LABELS[node.agentType] || node.agentType}
                </td>
                <td className={`dag-cell-status dag-status-${node.status}`}>
                  {STATUS_BADGES[node.status]}
                </td>
                <td className="dag-cell-duration">{formatDuration(node.startedAt, node.completedAt)}</td>
                <td className="dag-cell-time">{formatTime(node.startedAt || node.completedAt)}</td>
                <td className="dag-cell-summary">{node.summary || node.description || '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <h3 className="section-subtitle">Agent Types</h3>
      <div className="dag-legend">
        {Object.entries(AGENT_ICONS).map(([type, icon]) => (
          <div className="legend-item" key={type}>
            <span className="legend-dot" style={{ background: AGENT_COLORS[type] || '#58a6ff' }} />
            <span className="legend-icon">{icon}</span>
            <span className="legend-label">{AGENT_LABELS[type] || type}</span>
          </div>
        ))}
        <div className="legend-item">
          <span className="legend-dot" style={{ background: 'transparent', border: '2px dashed #58a6ff' }} />
          <span className="legend-icon">⚡</span>
          <span className="legend-label">Live node</span>
        </div>
      </div>
    </>
  );
}

/**
 * DAG Renderer — SVG DAG visualization for the agent execution pipeline.
 *
 * Renders a directed acyclic graph (DAG) of the multi-agent pipeline inline
 * in the chat panel. Supports real-time updates with animated transitions
 * for running, completed, and failed agent nodes.
 *
 * Ported from the web dashboard's React DAGView component (src/web-dashboard/src/components/DAGView.tsx)
 * to vanilla JS for use in the VS Code webview.
 */

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
  'issue-triage': '🏷️',
  'pr-review': '🔍',
  'gitlab-agent': '🦊',
  'skill-runner': '⚡',
  mcp: '🔌',
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
  'issue-triage': '#f0883e',
  'pr-review': '#bc8cff',
  'gitlab-agent': '#fc6d26',
  'skill-runner': '#58a6ff',
  mcp: '#39d2c0',
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
  'issue-triage': 'Triage',
  'pr-review': 'PR Review',
  'gitlab-agent': 'GitLab',
  'skill-runner': 'Skill',
  mcp: 'MCP',
};

const STATUS_STYLES: Record<string, { bg: string; stroke: string; text: string }> = {
  pending: { bg: '#1a1f2e', stroke: '#30363d', text: '#6e7681' },
  running: { bg: 'rgba(88, 166, 255, 0.12)', stroke: '#58a6ff', text: '#58a6ff' },
  completed: { bg: 'rgba(63, 185, 80, 0.12)', stroke: '#3fb950', text: '#3fb950' },
  failed: { bg: 'rgba(248, 81, 73, 0.12)', stroke: '#f85149', text: '#f85149' },
};

const STATUS_BADGES: Record<string, string> = {
  pending: '⏳ Pending',
  running: '▶️ Running',
  completed: '✅ Done',
  failed: '❌ Failed',
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PipelineNode {
  id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PipelineEdge {
  from: string;
  to: string;
}

export interface PipelineState {
  pipeline: string;
  active: boolean;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

// ─── Layout Engine ──────────────────────────────────────────────────────────

interface LayoutNode extends PipelineNode {
  x: number;
  y: number;
  w: number;
  h: number;
  step: number;
  totalInStep: number;
  indexInStep: number;
}

function computeLayout(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  nodeW = 150,
  nodeH = 64,
  gapX = 32,
  gapY = 20,
  padding = 24,
): { layoutNodes: LayoutNode[]; svgW: number; svgH: number } {
  if (nodes.length === 0) {
    return { layoutNodes: [], svgW: 400, svgH: 160 };
  }

  // Assign steps based on topological order
  const steps = new Map<string, number>();
  const visited = new Set<string>();

  function assignStep(id: string): number {
    if (steps.has(id)) return steps.get(id)!;
    if (visited.has(id)) return 0;
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
  const stepGroups = new Map<number, PipelineNode[]>();
  for (const node of nodes) {
    const s = steps.get(node.id) ?? 0;
    if (!stepGroups.has(s)) stepGroups.set(s, []);
    stepGroups.get(s)!.push(node);
  }

  const maxStep = Math.max(...stepGroups.keys());
  const maxNodesInStep = Math.max(...Array.from(stepGroups.values()).map((g) => g.length));

  const svgW = Math.max(400, (maxStep + 1) * (nodeW + gapX) + padding * 2 - gapX);
  const svgH = Math.max(160, Math.max(maxNodesInStep, 1) * (nodeH + gapY) + padding * 2 - gapY);

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

// ─── SVG Renderer ───────────────────────────────────────────────────────────

/**
 * Render a pipeline state as an SVG HTML string.
 *
 * @param state - The current pipeline state (nodes, edges, metadata)
 * @returns An SVG HTML string ready to inject into the chat panel
 */
export function renderDAG(state: PipelineState): string {
  const { nodes, edges, pipeline, active } = state;
  const { layoutNodes, svgW, svgH } = computeLayout(nodes, edges);

  const runningCount = nodes.filter((n) => n.status === 'running').length;
  const completedCount = nodes.filter((n) => n.status === 'completed').length;
  const failedCount = nodes.filter((n) => n.status === 'failed').length;
  const pendingCount = nodes.filter((n) => n.status === 'pending').length;
  const totalCount = nodes.length;

  // ── Header ──────────────────────────────────────────────────────────
  const headerBg = active ? 'linear-gradient(135deg, #1a2332, #1e1e2e)' : '#1e1e2e';
  const headerBorder = active ? '#58a6ff' : '#3c3c3c';

  let html = `<div class="dag-pipeline" style="background:${headerBg};border:1px solid ${headerBorder};border-radius:8px;overflow:hidden;margin:8px 0;">`;
  html += `<div class="dag-header" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid ${active ? '#58a6ff33' : '#3c3c3c'};background:rgba(0,0,0,0.2);">`;
  html += `<div style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;color:#e6edf3;">`;
  if (active) {
    html += `<span class="dag-live-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fb950;animation:dag-pulse 1.5s infinite;"></span>`;
  }
  html += `<span>🔀 ${pipeline || 'Execution Pipeline'}</span>`;
  html += `</div>`;
  html += `<div style="display:flex;align-items:center;gap:8px;margin-left:auto;font-size:10px;">`;
  if (active) {
    html += `<span style="background:#3fb95022;color:#3fb950;padding:2px 6px;border-radius:3px;font-weight:600;font-size:9px;">LIVE</span>`;
  }
  html += `<span style="color:#6e7681;">${totalCount} steps</span>`;
  if (runningCount > 0) {
    html += `<span style="color:#58a6ff;">▶ ${runningCount} running</span>`;
  }
  if (pendingCount > 0) {
    html += `<span style="color:#6e7681;">⏳ ${pendingCount} pending</span>`;
  }
  html += `<span style="color:#3fb950;">✅ ${completedCount} done</span>`;
  if (failedCount > 0) {
    html += `<span style="color:#f85149;">❌ ${failedCount} failed</span>`;
  }
  html += `</div></div>`;

  // ── SVG Canvas ──────────────────────────────────────────────────────
  html += `<div class="dag-svg-container" style="padding:8px 0;overflow-x:auto;">`;
  html += `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="display:block;margin:0 auto;">`;

  // Defs: markers + glow
  html += `<defs>`;
  // Arrow markers
  const arrowIds = new Set<string>();
  for (const edge of edges) {
    const aid = `arrow-${edge.from}-${edge.to}`;
    if (!arrowIds.has(aid)) {
      arrowIds.add(aid);
      html += `<marker id="${aid}" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="#58a6ff" />
      </marker>`;
    }
  }
  // Glow filter for running nodes
  html += `<filter id="dag-glow">
    <feGaussianBlur stdDeviation="3" result="coloredBlur" />
    <feMerge>
      <feMergeNode in="coloredBlur" />
      <feMergeNode in="SourceGraphic" />
    </feMerge>
  </filter>`;
  html += `</defs>`;

  // ── Edges ───────────────────────────────────────────────────────────
  for (const edge of edges) {
    const fromNode = layoutNodes.find((n) => n.id === edge.from);
    const toNode = layoutNodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;

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

    html += `<path
      d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}"
      fill="none"
      stroke="${edgeColor}"
      stroke-width="${toStatus === 'pending' ? 1.5 : 2.5}"
      stroke-opacity="${toStatus === 'pending' ? 0.3 : 0.8}"
      marker-end="url(#arrow-${edge.from}-${edge.to})"
    />`;
  }

  // ── Nodes ───────────────────────────────────────────────────────────
  for (const node of layoutNodes) {
    const colors = STATUS_STYLES[node.status] || STATUS_STYLES.pending;
    const color = AGENT_COLORS[node.agentType] || '#58a6ff';
    const icon = AGENT_ICONS[node.agentType] || '⚙️';
    const label = AGENT_LABELS[node.agentType] || node.agentType;
    const isRunning = node.status === 'running';

    // Selection highlight for failed nodes
    if (node.status === 'failed') {
      html += `<rect
        x="${node.x - 3}" y="${node.y - 3}"
        width="${node.w + 6}" height="${node.h + 6}"
        rx="10" ry="10" fill="none" stroke="#f85149"
        stroke-width="1.5" stroke-opacity="0.4"
      />`;
    }

    // Node background
    html += `<rect
      x="${node.x}" y="${node.y}"
      width="${node.w}" height="${node.h}"
      rx="8" ry="8"
      fill="${colors.bg}"
      stroke="${colors.stroke}"
      stroke-width="${isRunning ? 2.5 : 1.5}"
      stroke-opacity="0.9"
      filter="${isRunning ? 'url(#dag-glow)' : ''}"
    />`;

    // Icon + Agent Type
    html += `<text
      x="${node.x + 8}" y="${node.y + 20}"
      fill="#e6edf3" font-size="10" font-weight="600"
    >${icon} ${label}</text>`;

    // Status badge
    html += `<text
      x="${node.x + node.w - 8}" y="${node.y + 20}"
      text-anchor="end" fill="${colors.text}"
      font-size="9" font-weight="500"
    >${STATUS_BADGES[node.status] || '⏳'}</text>`;

    // Description (truncated)
    const desc = node.description.length > 26
      ? node.description.slice(0, 24) + '..'
      : node.description;
    html += `<text
      x="${node.x + 8}" y="${node.y + 38}"
      fill="#8b949e" font-size="9"
    >${escXml(desc)}</text>`;

    // Duration
    html += `<text
      x="${node.x + 8}" y="${node.y + 54}"
      fill="#6e7681" font-size="8"
    >${formatDuration(node.startedAt, node.completedAt)}</text>`;

    // Time
    html += `<text
      x="${node.x + node.w - 8}" y="${node.y + 54}"
      text-anchor="end" fill="#6e7681" font-size="8"
    >${formatTime(node.startedAt || node.completedAt)}</text>`;

    // Summary tooltip for failed/selected nodes
    if (node.summary && (node.status === 'failed')) {
      html += `<foreignObject
        x="${Math.max(4, node.x - 60)}"
        y="${node.y + node.h + 4}"
        width="${node.w + 120}"
        height="28"
      >
        <div xmlns="http://www.w3.org/1999/xhtml" style="
          color:#f85149;font-size:10px;line-height:1.4;
          background:rgba(13,17,23,0.95);padding:4px 8px;
          border-radius:4px;border:1px solid rgba(248,81,73,0.3);
          max-height:24px;overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap;
        ">${escXml(node.summary)}</div>
      </foreignObject>`;
    }
  }

  html += `</svg></div>`;

  // ── Step Details Table ─────────────────────────────────────────────
  html += `<div style="border-top:1px solid #3c3c3c;">`;
  html += `<div style="padding:8px 14px;font-size:11px;font-weight:600;color:#969696;text-transform:uppercase;letter-spacing:0.04em;">Step Details</div>`;
  html += `<table style="width:100%;border-collapse:collapse;font-size:11px;">`;
  html += `<thead><tr style="background:rgba(0,0,0,0.15);">`;
  html += `<th style="padding:6px 10px;text-align:left;color:#6e7681;border-bottom:1px solid #3c3c3c;">Step</th>`;
  html += `<th style="padding:6px 10px;text-align:left;color:#6e7681;border-bottom:1px solid #3c3c3c;">Agent</th>`;
  html += `<th style="padding:6px 10px;text-align:left;color:#6e7681;border-bottom:1px solid #3c3c3c;">Status</th>`;
  html += `<th style="padding:6px 10px;text-align:left;color:#6e7681;border-bottom:1px solid #3c3c3c;">Time</th>`;
  html += `<th style="padding:6px 10px;text-align:left;color:#6e7681;border-bottom:1px solid #3c3c3c;">Summary</th>`;
  html += `</tr></thead><tbody>`;
  for (const node of layoutNodes) {
    const rowBg = node.status === 'running' ? 'rgba(88,166,255,0.05)' : 'transparent';
    const statusColor = STATUS_STYLES[node.status]?.text || '#6e7681';
    html += `<tr style="background:${rowBg};">`;
    html += `<td style="padding:5px 10px;border-bottom:1px solid #2d2d2d;color:#6e7681;">${node.step}</td>`;
    html += `<td style="padding:5px 10px;border-bottom:1px solid #2d2d2d;color:#e6edf3;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${AGENT_COLORS[node.agentType] || '#58a6ff'};margin-right:6px;vertical-align:middle;"></span>
      ${AGENT_LABELS[node.agentType] || node.agentType}
    </td>`;
    html += `<td style="padding:5px 10px;border-bottom:1px solid #2d2d2d;color:${statusColor};">${STATUS_BADGES[node.status] || '⏳'}</td>`;
    html += `<td style="padding:5px 10px;border-bottom:1px solid #2d2d2d;color:#6e7681;">${formatDuration(node.startedAt, node.completedAt)}</td>`;
    html += `<td style="padding:5px 10px;border-bottom:1px solid #2d2d2d;color:#8b949e;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${node.summary || node.description || '--'}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;

  // ── Agent Legend ────────────────────────────────────────────────────
  const usedTypes = new Set(nodes.map((n) => n.agentType));
  html += `<div style="border-top:1px solid #3c3c3c;padding:8px 14px;">`;
  html += `<div style="font-size:11px;font-weight:600;color:#969696;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Agent Types</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:6px;">`;
  for (const [type, icon] of Object.entries(AGENT_ICONS)) {
    if (!usedTypes.has(type)) continue;
    html += `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:10px;background:#252526;border:1px solid #3c3c3c;color:#8b949e;">
      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${AGENT_COLORS[type] || '#58a6ff'};"></span>
      ${icon} <span style="color:#e6edf3;">${AGENT_LABELS[type] || type}</span>
    </span>`;
  }
  html += `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:10px;background:#252526;border:1px dashed #58a6ff;color:#8b949e;">
    ⚡ Live
  </span>`;
  html += `</div></div>`;

  html += `</div>`;

  // ── Animations ──────────────────────────────────────────────────────
  html += `<style>
    @keyframes dag-pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
    @keyframes dag-fade-in { from{opacity:0;transform:translateY(6px);} to{opacity:1;transform:translateY(0);} }
    .dag-pipeline { animation: dag-fade-in 0.3s ease; }
    .dag-svg-container::-webkit-scrollbar { height:4px; }
    .dag-svg-container::-webkit-scrollbar-track { background:transparent; }
    .dag-svg-container::-webkit-scrollbar-thumb { background:#3c3c3c;border-radius:2px; }
    .dag-svg-container::-webkit-scrollbar-thumb:hover { background:#6e7681; }
  </style>`;

  return html;
}

/**
 * Render an empty pipeline state (no active pipeline).
 */
export function renderEmptyDAG(): string {
  return `<div class="dag-pipeline" style="background:#1e1e2e;border:1px dashed #3c3c3c;border-radius:8px;padding:24px;text-align:center;margin:8px 0;">
    <div style="font-size:28px;margin-bottom:8px;">🔀</div>
    <div style="font-size:13px;font-weight:600;color:#969696;margin-bottom:4px;">No Active Pipeline</div>
    <div style="font-size:11px;color:#6e7681;max-width:300px;margin:0 auto;line-height:1.5;">
      Run a slash command like <code style="background:#2d2d2d;padding:1px 5px;border-radius:3px;color:#569cd6;">/fix</code>,
      <code style="background:#2d2d2d;padding:1px 5px;border-radius:3px;color:#569cd6;">/review</code>, or
      <code style="background:#2d2d2d;padding:1px 5px;border-radius:3px;color:#569cd6;">/workflow</code>
      to see the multi-agent pipeline visualization.
    </div>
  </div>`;
}

/**
 * Build a PipelineState from a list of completed agent results.
 * Useful for rendering the final DAG after a pipeline completes.
 */
export function buildPipelineState(
  pipelineName: string,
  agents: Array<{
    agentType: string;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    summary?: string;
    startedAt?: number;
    completedAt?: number;
  }>,
): PipelineState {
  const nodes: PipelineNode[] = agents.map((agent, i) => ({
    id: `agent-${i}`,
    agentType: agent.agentType,
    status: agent.status,
    description: agent.description,
    summary: agent.summary,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
  }));

  // Build edges: sequential from planner → last
  const edges: PipelineEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
  }

  const hasActive = agents.some((a) => a.status === 'running');

  return {
    pipeline: pipelineName,
    active: hasActive,
    nodes,
    edges,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

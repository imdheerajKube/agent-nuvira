/**
 * Web Dashboard Server — Serves the Agent-Nuvira dashboard UI and data APIs.
 *
 * Uses only Node.js built-in modules (no Express, no WebSocket libraries):
 * - Static files: HTML, CSS, JS from public/
 * - REST API: cost, history, benchmark, memory, health data
 * - SSE (Server-Sent Events): real-time updates
 *
 * Start with: agent-nuvira dashboard
 * Opens at: http://localhost:3030
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// ─── Constants ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.BUFF_DASHBOARD_PORT || '3030', 10);
const HOST = process.env.BUFF_DASHBOARD_HOST || '127.0.0.1';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Public files location: try the source directory first (dev via tsx),
// then the compiled output directory (production via node dist/)
const POSSIBLE_PUBLIC_DIRS = [
  join(__dirname, 'public'),                                   // tsx: src/web-dashboard/public/
  join(__dirname, '..', '..', 'src', 'web-dashboard', 'public'), // node: dist/web-dashboard/server.js
];
const PUBLIC_DIR = POSSIBLE_PUBLIC_DIRS.find((p) => existsSync(p)) || POSSIBLE_PUBLIC_DIRS[0];
const MEMORY_DIR = join(homedir(), '.buff', 'memory');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── SSE Client Management ──────────────────────────────────────────────────

interface SSEClient {
  id: number;
  res: ServerResponse;
}

let sseClients: SSEClient[] = [];
let nextClientId = 1;

// ─── In-Memory DAG Store ────────────────────────────────────────────────────

/**
 * A real-time DAG state that the orchestrator can push updates to.
 * Reset before each new execution. Served via /api/dag and SSE events.
 */
interface DAGNode {
  id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
}

interface DAGEdge {
  from: string;
  to: string;
}

let activePipeline: string | null = null; // goal/description of current pipeline
let activeNodes: DAGNode[] = [];
let activeEdges: DAGEdge[] = [];

/**
 * Called by the orchestrator to push a DAG update in real time.
 * Clears the pipeline when a new execution starts.
 */
export function pushDAGUpdate(update: {
  pipelineId?: string;
  pipelineDescription?: string;
  nodes: Array<Omit<DAGNode, 'startedAt' | 'completedAt'>>;
  edges: DAGEdge[];
}): void {
  if (update.pipelineId) {
    activePipeline = update.pipelineDescription || update.pipelineId;
    // If this is a new pipeline, reset nodes/edges
    if (update.nodes.length > 0) {
      activeNodes = update.nodes.map((n) => ({
        ...n,
        startedAt: n.status === 'running' || n.status === 'completed' || n.status === 'failed' ? Date.now() : undefined,
        completedAt: n.status === 'completed' || n.status === 'failed' ? Date.now() : undefined,
      }));
      activeEdges = update.edges;
    }
  }
  broadcastDAG();
}

/** Update a single node's status (called by orchestrator as each agent finishes) */
export function updateDAGNode(nodeId: string, update: { status: DAGNode['status']; summary?: string }): void {
  const node = activeNodes.find((n) => n.id === nodeId);
  if (!node) return;
  node.status = update.status;
  if (update.summary) node.summary = update.summary;
  if (update.status === 'running' && !node.startedAt) node.startedAt = Date.now();
  if (update.status === 'completed' || update.status === 'failed') {
    if (!node.completedAt) node.completedAt = Date.now();
  }
  broadcastDAG();
}

/** Reset the DAG state for a fresh execution */
export function resetDAG(): void {
  activePipeline = null;
  activeNodes = [];
  activeEdges = [];
  broadcastDAG();
}

/** Broadcast current DAG state to all SSE clients */
function broadcastDAG(): void {
  const dagData = {
    pipeline: activePipeline,
    nodes: activeNodes,
    edges: activeEdges,
    timestamp: Date.now(),
  };
  const payload = `event: dag\ndata: ${JSON.stringify(dagData)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(payload); } catch { /* client disconnected */ }
  }
}

/** Read DAG data: in-memory first, fall back to recent trajectories */
export function readDAGData(): Record<string, unknown> {
  // If there's an active in-memory pipeline, return it
  if (activeNodes.length > 0) {
    return {
      pipeline: activePipeline,
      nodes: activeNodes,
      edges: activeEdges,
      timestamp: Date.now(),
      active: true,
    };
  }

  // Otherwise, reconstruct from recent trajectory data
  const trajectoriesFile = readJSON<{ trajectories: Record<string, unknown> }>(
    join(MEMORY_DIR, 'trajectories.json'),
  );
  if (trajectoriesFile?.trajectories) {
    const trajs = Object.values(trajectoriesFile.trajectories) as any[];
    const recent = trajs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 1);
    if (recent.length > 0 && recent[0].plan) {
      const plan = recent[0].plan as Array<{ agentType: string; description: string }>;
      return {
        pipeline: recent[0].goal || 'Recent execution',
        nodes: plan.map((step, i) => ({
          id: `step-${i}`,
          agentType: step.agentType,
          status: 'completed' as const,
          description: step.description,
        })),
        edges: plan.slice(0, -1).map((_, i) => ({ from: `step-${i}`, to: `step-${i + 1}` })),
        timestamp: recent[0].timestamp,
        active: false,
      };
    }
  }

  // Fallback: return empty
  return { pipeline: null, nodes: [], edges: [], timestamp: Date.now(), active: false };
}

// ─── Data Readers ───────────────────────────────────────────────────────────

function readJSON<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readCostData(): Record<string, unknown> {
  const data = readJSON<{ entries: Array<Record<string, unknown>> }>(
    join(MEMORY_DIR, 'cost-tracker.json'),
  );
  if (!data?.entries) {
    return { totalRequests: 0, totalCost: 0, byProvider: {}, byModel: {} };
  }

  const entries = data.entries;
  const totalCost = entries.reduce((s, e) => s + (typeof e.costUsd === 'number' ? e.costUsd : 0), 0);
  const totalTokens = entries.reduce((s, e) => s + (typeof e.totalTokens === 'number' ? e.totalTokens : 0), 0);

  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  for (const e of entries) {
    const cost = typeof e.costUsd === 'number' ? e.costUsd : 0;
    if (e.provider) byProvider[e.provider as string] = (byProvider[e.provider as string] || 0) + cost;
    if (e.model) byModel[e.model as string] = (byModel[e.model as string] || 0) + cost;
  }

  const recent = entries.slice(-50).reverse().map((e) => ({
    provider: e.provider,
    model: e.model,
    costUsd: e.costUsd,
    totalTokens: e.totalTokens,
    timestamp: e.timestamp,
  }));

  return {
    totalRequests: entries.length,
    totalCost: Math.round(totalCost * 100000) / 100000,
    totalTokens,
    byProvider,
    byModel,
    recent,
  };
}

function readHistoryData(): Record<string, unknown> {
  const data = readJSON<{ sessions: Record<string, unknown> }>(
    join(MEMORY_DIR, 'history.json'),
  );
  if (!data?.sessions) {
    return { total: 0, recent: [] };
  }

  const sessions = Object.values(data.sessions);
  const recent = (sessions as any[])
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, 20)
    .map((s: any) => ({
      id: s.id,
      summary: s.summary?.slice(0, 80) || '',
      provider: s.provider,
      model: s.model,
      messageCount: s.messages?.length || 0,
      tags: s.tags || [],
      startedAt: s.startedAt,
    }));

  return { total: sessions.length, recent };
}

function readBenchmarkData(): Record<string, unknown> {
  const data = readJSON<{ runs: Array<Record<string, unknown>> }>(
    join(MEMORY_DIR, 'benchmarks.json'),
  );
  if (!data?.runs) {
    return { totalRuns: 0, latest: null, runs: [] };
  }

  const runs = data.runs.slice(-10).reverse();
  const latest = runs[0] || null;

  return {
    totalRuns: data.runs.length,
    latest: latest ? {
      provider: latest.provider,
      model: latest.model,
      summary: latest.summary,
      startedAt: latest.startedAt,
    } : null,
    runs: runs.map((r: any) => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      startedAt: r.startedAt,
      summary: r.summary,
    })),
  };
}

function readMemoryData(): Record<string, unknown> {
  const data = readJSON<{ trajectories: Record<string, unknown> }>(
    join(MEMORY_DIR, 'trajectories.json'),
  );
  if (!data?.trajectories) {
    return { total: 0 };
  }

  const trajectories = Object.values(data.trajectories) as any[];
  const avgScore = trajectories.length > 0
    ? trajectories.reduce((s, t) => s + (t.score || 0), 0) / trajectories.length
    : 0;

  const byFingerprint: Record<string, number> = {};
  for (const t of trajectories) {
    const fp = t.projectFingerprint || 'unknown';
    byFingerprint[fp] = (byFingerprint[fp] || 0) + 1;
  }

  return {
    total: trajectories.length,
    avgScore: Math.round(avgScore * 100) / 100,
    byFingerprint,
  };
}

function readHealthData(): Record<string, unknown> {
  const patterns = readJSON<{ patterns: Array<unknown> }>(join(MEMORY_DIR, 'patterns.json'));
  const feedback = readJSON<{ entries: Array<unknown> }>(join(MEMORY_DIR, 'feedback.json'));
  const vectors = readJSON<{ entries: Record<string, unknown> }>(join(MEMORY_DIR, 'vectors.json'));
  const agentStats = readJSON<{ agents: Record<string, unknown>; totalRuns: number; overallSuccessRate: number }>(
    join(MEMORY_DIR, 'agent-stats.json'),
  );

  return {
    patterns: patterns?.patterns?.length || 0,
    feedback: feedback?.entries?.length || 0,
    vectors: vectors?.entries ? Object.keys(vectors.entries).length : 0,
    agentStats: agentStats ? {
      totalRuns: agentStats.totalRuns,
      overallSuccessRate: agentStats.overallSuccessRate,
      agents: agentStats.agents,
    } : null,
    memoryDir: MEMORY_DIR,
  };
}

// ─── Request Handler ────────────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── API Routes ─────────────────────────────────────────────────
  if (pathname === '/api/cost') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readCostData()));
    return;
  }

  if (pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readHistoryData()));
    return;
  }

  if (pathname === '/api/benchmarks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readBenchmarkData()));
    return;
  }

  if (pathname === '/api/memory') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readMemoryData()));
    return;
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readHealthData()));
    return;
  }

  if (pathname === '/api/dag') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readDAGData()));
    return;
  }

  if (pathname === '/api/all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cost: readCostData(),
      history: readHistoryData(),
      benchmarks: readBenchmarkData(),
      memory: readMemoryData(),
      health: readHealthData(),
      dag: readDAGData(),
      serverTime: Date.now(),
    }));
    return;
  }

  // ── SSE Endpoint ───────────────────────────────────────────────
  if (pathname === '/api/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const allData = {
      cost: readCostData(),
      history: readHistoryData(),
      benchmarks: readBenchmarkData(),
      memory: readMemoryData(),
      health: readHealthData(),
      dag: readDAGData(),
      serverTime: Date.now(),
    };
    res.write(`event: init\ndata: ${JSON.stringify(allData)}\n\n`);

    const clientId = nextClientId++;
    const client: SSEClient = { id: clientId, res };
    sseClients.push(client);

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);

    const refreshInterval = setInterval(() => {
      try {
        const data = {
          cost: readCostData(),
          history: readHistoryData(),
          benchmarks: readBenchmarkData(),
          memory: readMemoryData(),
          health: readHealthData(),
          dag: readDAGData(),
          serverTime: Date.now(),
        };
        res.write(`event: refresh\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { clearInterval(refreshInterval); }
    }, 10000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(refreshInterval);
      sseClients = sseClients.filter((c) => c.id !== clientId);
    });

    return;
  }

  // ── Static Files / SPA Fallback ─────────────────────────────────
  const filePath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = join(PUBLIC_DIR, filePath);

  // Prevent directory traversal
  if (!normalizedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    if (existsSync(normalizedPath) && !statSync(normalizedPath).isDirectory()) {
      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      createReadStream(normalizedPath).pipe(res);
      return;
    }

    // SPA fallback: serve index.html for any unmatched path (React Router handles routing)
    const indexPath = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(indexPath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    createReadStream(indexPath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function createDashboardServer(): { server: ReturnType<typeof createServer>; port: number; host: string } {
  const server = createServer(handleRequest);

  server.listen(PORT, HOST, () => {
    console.log(`\n  🌐 Agent-Nuvira Dashboard`);
    console.log(`  ─────────────────────────`);
    console.log(`  Local:   http://${HOST}:${PORT}`);
    console.log(`  Network: http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to stop\n`);
  });

  return { server, port: PORT, host: HOST };
}

export const DASHBOARD_DEFAULTS = { PORT, HOST };

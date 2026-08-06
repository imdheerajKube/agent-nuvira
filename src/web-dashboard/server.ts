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
import { createReadStream, readFileSync, existsSync, statSync, watch, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { loadEnv } from '../utils/env.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { getRouterPromotion } from '../learning/router-promotion.js';
import { ACTION_LOG_FILENAME, aggregateActionTelemetry, readActionTelemetryFile } from '../learning/model-registry.js';
import type { ActionTelemetryInsights } from '../learning/model-registry.js';

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
// Honor BUFF_MEMORY_DIR (same as the CLI and the learning router) so the bandit
// card and the promotion-gate card always read from the SAME memory directory.
const MEMORY_DIR = process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');

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

// ─── Quota File Watcher (real-time Failover Timeline) ───────────────────────

/**
 * Watch the memory dir for quota ledger/timeline writes and push a `quota`
 * SSE event to connected dashboards IMMEDIATELY — so the Failover Timeline
 * updates in real time instead of waiting for the next 10s `refresh` tick.
 *
 * The ledger and chat run in OTHER processes (CLI / extension) writing to
 * quota-events.jsonl / quota-ledger.json on disk; a directory fs.watch catches
 * those writes. Debounced because fs.watch may fire multiple events per write.
 * Armed while at least one SSE client is connected, disarmed when the last one
 * disconnects (no dangling watcher when nobody is viewing).
 */
let quotaWatcher: ReturnType<typeof watch> | null = null;
let quotaWatchTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * When true (config `routing.alwaysWatchQuota`), the quota watcher stays armed
 * from server start and is NEVER disarmed by client count — so the Failover
 * Timeline is always current the moment a dashboard connects, even if the
 * server sat idle between viewing sessions.
 */
let alwaysWatchQuota = false;

/**
 * Read `routing.alwaysWatchQuota` from ~/.buff/buffconfig.json (same source
 * loadApiKeysFromConfig uses). Best-effort — a missing/corrupt config just
 * keeps the default (false = arm-on-connect only).
 */
function loadAlwaysWatchQuotaFlag(): void {
  try {
    const configPath = join(homedir(), '.buff', 'buffconfig.json');
    if (!existsSync(configPath)) return;
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { routing?: { alwaysWatchQuota?: boolean } };
    if (config?.routing?.alwaysWatchQuota === true) {
      alwaysWatchQuota = true;
    }
  } catch {
    // Best-effort — keep the default.
  }
}

function broadcastQuotaEvent(): void {
  const payload = `event: quota\ndata: ${JSON.stringify({
    quota: readQuotaData(),
    serverTime: Date.now(),
  })}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(payload); } catch { /* client disconnected */ }
  }
}

function armQuotaWatcher(): void {
  if (quotaWatcher) return;
  try {
    // The memory dir may not exist yet (dashboard started before any ledger /
    // CLI write) — create it first so watch() doesn't throw ENOENT and silently
    // disable real-time pushes for the whole session.
    if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
    // Watch the DIRECTORY so we catch file creation too (quota-events.jsonl
    // may not exist until the first failover).
    quotaWatcher = watch(MEMORY_DIR, (_eventType, filename) => {
      // Some platforms report a null filename on directory watches — treat
      // that as a trigger too (worst case: a harmless extra quota push, since
      // broadcastQuotaEvent re-reads fresh data). macOS FSEvents can also
      // report FULL PATHS, so normalize with basename() before comparing.
      const name = basename(String(filename || ''));
      if (name && name !== 'quota-events.jsonl' && name !== 'quota-ledger.json') return;
      if (quotaWatchTimer) clearTimeout(quotaWatchTimer);
      quotaWatchTimer = setTimeout(() => {
        quotaWatchTimer = null;
        broadcastQuotaEvent();
      }, 150);
    });
  } catch {
    // Best-effort — a failed watcher must never break the dashboard.
    quotaWatcher = null;
  }
}

function disarmQuotaWatcher(): void {
  if (quotaWatchTimer) { clearTimeout(quotaWatchTimer); quotaWatchTimer = null; }
  if (quotaWatcher) {
    try { quotaWatcher.close(); } catch { /* ignore */ }
    quotaWatcher = null;
  }
}

/** Test hook: is the quota file watcher currently armed? */
export function isQuotaWatcherArmed(): boolean {
  return quotaWatcher !== null;
}

/** Test hook: override the always-on quota watcher flag (config re-read on next create). */
export function setAlwaysWatchQuota(value: boolean): void {
  alwaysWatchQuota = value;
  // Turning the flag OFF must also disarm an already-armed watcher —
  // otherwise a test that armed it would leak the fs.watch handle into
  // later tests in the same process (the only other disarm path is an SSE
  // connect→disconnect cycle, which may never happen).
  if (!value) disarmQuotaWatcher();
}

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
  /** Per-subtask complexity label (trivial/simple/moderate/complex/critical). */
  complexity?: string;
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
    // If this is a new pipeline, reset nodes/edges AND start a run draft for
    // the persisted phase timeline (the event-bus DAG timeline: the orchestrator
    // emits plan → gather → write → review → test via DAGConsumer, which lands
    // here as pushDAGUpdate / updateDAGNode).
    if (update.nodes.length > 0) {
      activeRunId = update.pipelineId;
      activeRunGoal = update.pipelineDescription || update.pipelineId;
      activeRunStartedAt = Date.now();
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
  // When every step of the active run has reached a terminal state, persist
  // the run to pipeline-runs.json so the scrubbable phase timeline can show it
  // after the in-memory DAG is reset.
  maybeFinalizeRun();
  broadcastDAG();
}

/** Reset the DAG state for a fresh execution */
export function resetDAG(): void {
  activePipeline = null;
  activeNodes = [];
  activeEdges = [];
  activeRunId = null;
  activeRunGoal = '';
  activeRunStartedAt = 0;
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

// ─── Persisted Pipeline Runs (scrubbable phase timeline) ─────────────────────

/**
 * A phase in a pipeline run — mirrors the DAG node shape with a computed
 * duration so the frontend can size timeline blocks proportionally.
 */
interface PipelinePhase {
  id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  /** Per-subtask complexity label (trivial/simple/moderate/complex/critical). */
  complexity?: string;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
  /** Computed duration (ms) when both timestamps are known. */
  durationMs?: number;
}

/** One persisted pipeline execution, rebuilt from the event-bus DAG timeline. */
interface PipelineRun {
  id: string;
  goal: string;
  startedAt: number;
  endedAt?: number;
  success?: boolean;
  totalDurationMs: number;
  phases: PipelinePhase[];
}

/** File in the memory dir that backs the dashboard's Run Timeline. */
const PIPELINE_RUNS_FILENAME = 'pipeline-runs.json';
/** Keep the most recent 25 runs (enough for a scrubber without unbounded disk). */
const MAX_PIPELINE_RUNS = 25;

let activeRunId: string | null = null;
let activeRunGoal = '';
let activeRunStartedAt = 0;

function pipelineRunsPath(): string {
  return join(MEMORY_DIR, PIPELINE_RUNS_FILENAME);
}

/**
 * Read the persisted pipeline runs, most recent first.
 */
export function readPipelineRuns(): { total: number; runs: PipelineRun[] } {
  const data = readJSON<{ runs: PipelineRun[] }>(pipelineRunsPath());
  if (!data?.runs || !Array.isArray(data.runs)) {
    return { total: 0, runs: [] };
  }
  return { total: data.runs.length, runs: data.runs };
}

/**
 * Best-effort append of a finalized run to pipeline-runs.json. Never throws —
 * a failed write must not break the dashboard or the DAG broadcast path.
 */
function appendPipelineRun(run: PipelineRun): void {
  try {
    if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
    const current = readPipelineRuns();
    const runs = [run, ...current.runs.filter((r) => r.id !== run.id)].slice(0, MAX_PIPELINE_RUNS);
    writeFileSync(pipelineRunsPath(), JSON.stringify({ runs }, null, 2), 'utf-8');
  } catch {
    // Best-effort — a failed write must never break the dashboard.
  }
}

/**
 * When every node of the active run is terminal (completed/failed), persist it.
 * Called from updateDAGNode after each status transition; idempotent via the
 * activeRunId latch (cleared once the run is persisted).
 */
function maybeFinalizeRun(): void {
  if (!activeRunId || activeNodes.length === 0) return;
  const allTerminal = activeNodes.every((n) => n.status === 'completed' || n.status === 'failed');
  if (!allTerminal) return;

  const phases: PipelinePhase[] = activeNodes.map((n) => ({
    id: n.id,
    agentType: n.agentType,
    status: n.status,
    description: n.description,
    complexity: n.complexity,
    summary: n.summary,
    startedAt: n.startedAt,
    completedAt: n.completedAt,
    durationMs: n.startedAt && n.completedAt ? n.completedAt - n.startedAt : undefined,
  }));
  const starts = phases.map((p) => p.startedAt || 0);
  const ends = phases.map((p) => p.completedAt || 0);
  const started = activeRunStartedAt || (starts.length > 0 ? Math.min(...starts) : Date.now());
  const ended = ends.length > 0 ? Math.max(...ends) : Date.now();

  appendPipelineRun({
    id: activeRunId,
    goal: activeRunGoal || 'Execution pipeline',
    startedAt: started,
    endedAt: ended,
    success: phases.length > 0 && phases.every((p) => p.status === 'completed'),
    totalDurationMs: Math.max(0, ended - started),
    phases,
  });
  activeRunId = null;
  activeRunGoal = '';
  activeRunStartedAt = 0;
}

// ─── Model Health Check ────────────────────────────────────────────────────

/** Log which env vars were (or weren't) found for debugging */
function logEnvVarStatus(label: string, varName: string, value: string | undefined): void {
  if (value) {
    console.log(`  ✓ ${label}: ${varName} found (${value.slice(0, 8)}...)`);
  } else {
    console.log(`  ✗ ${label}: ${varName} not set`);
  }
}


interface ModelCheckResult {
  provider: string;
  providerLabel: string;
  icon: string;
  apiConfigured: boolean;
  apiAccessible: boolean;
  canGenerate: boolean;
  overallStatus: 'available' | 'limited' | 'unavailable';
  models: Array<{
    id: string;
    name: string;
    status: 'available' | 'limited' | 'unavailable';
    statusReason: string;
    rateLimitRemaining?: number;
    rateLimitTotal?: number;
  }>;
  notes: string;
  freeTierInfo?: string;
  rateLimitRemaining?: number;
  rateLimitTotal?: number;
}

/**
 * Fetch with timeout. Returns status, ok flag, headers, and parsed JSON body.
 * Headers are extracted for rate-limit parsing.
 */
async function fetchWithTimeout<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; statusText: string; data?: T; headers: Record<string, string> }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);

    // Extract headers for rate-limit parsing
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (res.ok) {
      try {
        const data = await res.json() as T;
        return { ok: true, status: res.status, statusText: res.statusText, data, headers };
      } catch {
        return { ok: true, status: res.status, statusText: res.statusText, headers };
      }
    }
    return { ok: false, status: res.status, statusText: res.statusText, headers };
  } catch {
    return { ok: false, status: 0, statusText: 'Connection failed', headers: {} };
  }
}

/**
 * Parse common rate-limit headers and return remaining/total if found.
 * Supports multiple header naming conventions across providers.
 */
function parseRateLimitHeaders(headers: Record<string, string>): { remaining?: number; total?: number } {
  const result: { remaining?: number; total?: number } = {};

  // Try various rate-limit header names
  const remainingHeaders = [
    'x-ratelimit-remaining-requests',  // Groq
    'x-ratelimit-remaining',            // NIM, OpenRouter, generic
    'x-ratelimit-remaining-quota',      // Gemini
    'x-ratelimit-remaining-tokens',     // Groq token limit
    'ratelimit-remaining',              // Generic
  ];

  const totalHeaders = [
    'x-ratelimit-limit',          // NIM
    'x-ratelimit-request-limit',  // Groq
    'x-ratelimit-limit-quota',    // Gemini
    'ratelimit-limit',            // Generic
  ];

  for (const h of remainingHeaders) {
    const val = headers[h];
    if (val !== undefined) {
      const num = parseInt(val, 10);
      if (!isNaN(num)) {
        result.remaining = num;
        break;
      }
    }
  }

  for (const h of totalHeaders) {
    const val = headers[h];
    if (val !== undefined) {
      const num = parseInt(val, 10);
      if (!isNaN(num)) {
        result.total = num;
        break;
      }
    }
  }

  return result;
}

/**
 * Determine status based on rate limit remaining vs total.
 * Green: plenty of quota (>20% remaining or no headers available)
 * Amber: low quota (<=20% remaining or < 10 requests)
 */
function rateLimitStatus(remaining?: number, total?: number): { status: 'available' | 'limited'; reason: string } {
  if (remaining === undefined) {
    // No rate-limit info — assume available
    return { status: 'available', reason: 'API connected' };
  }

  if (remaining <= 0) {
    return { status: 'limited', reason: 'Rate limit exhausted — wait or upgrade' };
  }

  if (total !== undefined && total > 0) {
    const pct = (remaining / total) * 100;
    if (pct <= 20) {
      return { status: 'limited', reason: `${remaining}/${total} quota remaining (${Math.round(pct)}%)` };
    }
    if (remaining < 10) {
      return { status: 'limited', reason: `Only ${remaining} requests remaining` };
    }
    return { status: 'available', reason: `${remaining}/${total} quota remaining` };
  }

  // Total unknown, but remaining known
  if (remaining < 10) {
    return { status: 'limited', reason: `Only ${remaining} requests remaining` };
  }

  return { status: 'available', reason: `${remaining} requests remaining` };
}

/**
 * Check all configured providers and return their health status.
 *
 * Covers 16 providers: Local, OpenAI, Anthropic, Mistral, Cohere, Together,
 * DeepInfra, Fireworks, Perplexity, Groq, NIM, Gemini, OpenRouter, Azure,
 * LM Studio, and vLLM/TGI.
 */
async function readModelsHealth(): Promise<{
  providers: ModelCheckResult[];
  lastChecked: number;
  totalModels: number;
  available: number;
  limited: number;
  unavailable: number;
}> {
  const results = await Promise.all([
    checkLocalProvider(),
    checkOpenAIProvider(),
    checkAnthropicProvider(),
    checkMistralProvider(),
    checkCohereProvider(),
    checkTogetherProvider(),
    checkDeepInfraProvider(),
    checkFireworksProvider(),
    checkPerplexityProvider(),
    checkGroqProvider(),
    checkNIMProvider(),
    checkGeminiProvider(),
    checkOpenRouterProvider(),
    checkAzureOpenAIProvider(),
    checkLMStudioProvider(),
    checkAnyscaleProvider(),
    checkVLLMProvider(),
  ]);

  const providers = results.filter(Boolean) as ModelCheckResult[];
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);
  const available = providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === 'available').length, 0);
  const limited = providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === 'limited').length, 0);
  const unavailable = providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === 'unavailable').length, 0);

  return { providers, lastChecked: Date.now(), totalModels, available, limited, unavailable };
}

/** Check local Ollama provider — no rate limits to parse */
async function checkLocalProvider(): Promise<ModelCheckResult | null> {
  const result: ModelCheckResult = {
    provider: 'local', providerLabel: 'Ollama (Local)', icon: '💻',
    apiConfigured: true, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Local models via Ollama at http://localhost:11434',
    freeTierInfo: 'Fully free — runs on your machine',
  };

  const check = await fetchWithTimeout<{ models?: Array<{ name: string }> }>('http://localhost:11434/api/tags');
  if (check.ok && check.data?.models) {
    result.apiAccessible = true;
    result.canGenerate = true;
    const models = check.data.models;
    if (models.length > 0) {
      result.models = models.map((m) => ({
        id: m.name, name: m.name,
        status: 'available' as const,
        statusReason: 'Running locally — no rate limits',
      }));
      result.overallStatus = 'available';
    } else {
      result.models = [{ id: '(no models)', name: 'No models pulled', status: 'limited' as const, statusReason: 'Run: ollama pull <model>' }];
      result.overallStatus = 'limited';
      result.notes = 'Ollama running but no models pulled yet';
    }
  } else if (check.ok) {
    result.apiAccessible = true;
    result.models = [{ id: '(empty)', name: 'No model data', status: 'limited' as const, statusReason: 'Could not parse model list' }];
    result.overallStatus = 'limited';
  } else {
    result.models = [{ id: '(offline)', name: 'Ollama not running', status: 'unavailable' as const, statusReason: 'Install Ollama: brew install ollama' }];
    result.overallStatus = 'unavailable';
  }
  return result;
}

/** Check Groq provider — parses x-ratelimit-remaining-requests headers */
async function checkGroqProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.GROQ_API_KEY;
  const result: ModelCheckResult = {
    provider: 'groq', providerLabel: 'Groq', icon: '🟢',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'LPU cloud inference — fastest response times',
    freeTierInfo: 'Free tier: ~30 req/min, 14400 req/day. Set GROQ_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'GROQ_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at console.groq.com' }];
    return result;
  }

  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.groq.com/openai/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (check.ok && check.data?.data) {
    result.apiAccessible = true;
    result.canGenerate = true;

    // Parse Groq's rate-limit headers (x-ratelimit-remaining-requests)
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining;
    result.rateLimitTotal = rl.total;
    const statusInfo = rateLimitStatus(rl.remaining, rl.total);

    result.models = check.data.data.map((m) => ({
      id: m.id, name: m.id,
      status: statusInfo.status,
      statusReason: statusInfo.reason,
      rateLimitRemaining: rl.remaining,
      rateLimitTotal: rl.total,
    }));

    // If rate limit is low, set overall to limited
    result.overallStatus = statusInfo.status;
    if (statusInfo.status === 'limited') {
      result.notes = `Rate limit: ${statusInfo.reason}`;
    }
  } else if (check.status === 401 || check.status === 403) {
    result.models = [{ id: '(auth error)', name: 'Invalid API key', status: 'unavailable' as const, statusReason: 'Check GROQ_API_KEY at console.groq.com' }];
  } else if (check.status === 429) {
    result.apiAccessible = true;
    result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited' as const, statusReason: 'Free tier rate limit hit — wait or upgrade' }];
    result.overallStatus = 'limited';
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}: ${check.statusText}` }];
  }
  return result;
}

/** Check NVIDIA NIM provider — parses x-ratelimit-remaining headers */
async function checkNIMProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  const baseUrl = process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const result: ModelCheckResult = {
    provider: 'nim', providerLabel: 'NVIDIA NIM', icon: '🔶',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'NVIDIA NIM cloud or self-hosted inference',
    freeTierInfo: 'Free tier: 1000 req/day. Set NVIDIA_NIM_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'NVIDIA_NIM_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at build.nvidia.com' }];
    return result;
  }

  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    `${baseUrl}/models`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (check.ok && check.data?.data) {
    result.apiAccessible = true;
    result.canGenerate = true;

    // Parse NIM's rate-limit headers (x-ratelimit-remaining, x-ratelimit-limit)
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining;
    result.rateLimitTotal = rl.total;
    const statusInfo = rateLimitStatus(rl.remaining, rl.total);

    result.models = check.data.data.map((m) => ({
      id: m.id, name: m.id.split('/').pop() || m.id,
      status: statusInfo.status,
      statusReason: statusInfo.reason,
      rateLimitRemaining: rl.remaining,
      rateLimitTotal: rl.total,
    }));
    result.overallStatus = statusInfo.status;
    if (statusInfo.status === 'limited') {
      result.notes = `Rate limit: ${statusInfo.reason}`;
    }
  } else if (check.status === 401 || check.status === 403) {
    result.models = [{ id: '(auth error)', name: 'Invalid API key', status: 'unavailable' as const, statusReason: 'Check NVIDIA_NIM_API_KEY at build.nvidia.com' }];
  } else if (check.status === 429) {
    result.apiAccessible = true;
    result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited' as const, statusReason: 'Free tier limit hit — wait or upgrade' }];
    result.overallStatus = 'limited';
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}: ${check.statusText}` }];
  }
  return result;
}

/** Check Google Gemini provider — parses rate-limit headers */
async function checkGeminiProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  const result: ModelCheckResult = {
    provider: 'gemini', providerLabel: 'Google Gemini', icon: '🔷',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Google Gemini API — strong reasoning, large context',
    freeTierInfo: 'Free tier: 60 req/min, 1500 req/day. Set GEMINI_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'GEMINI_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at aistudio.google.com/apikey' }];
    return result;
  }

  const check = await fetchWithTimeout<{ models?: Array<{ name: string; displayName?: string }> }>(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );

  if (check.ok && check.data?.models) {
    result.apiAccessible = true;
    result.canGenerate = true;

    // Parse Gemini's rate-limit headers
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining;
    result.rateLimitTotal = rl.total;
    const statusInfo = rateLimitStatus(rl.remaining, rl.total);

    result.models = check.data.models.map((m) => {
      const id = m.name.replace('models/', '');
      return {
        id, name: m.displayName || id,
        status: statusInfo.status,
        statusReason: statusInfo.reason,
        rateLimitRemaining: rl.remaining,
        rateLimitTotal: rl.total,
      };
    });
    result.overallStatus = statusInfo.status;
    if (statusInfo.status === 'limited') {
      result.notes = `Rate limit: ${statusInfo.reason}`;
    }
  } else if (check.status === 403) {
    result.models = [{ id: '(auth error)', name: 'Invalid or expired API key', status: 'unavailable' as const, statusReason: 'Check GEMINI_API_KEY at aistudio.google.com' }];
  } else if (check.status === 429) {
    result.apiAccessible = true;
    result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited' as const, statusReason: 'Free tier limit hit — wait or upgrade to paid' }];
    result.overallStatus = 'limited';
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}: ${check.statusText}` }];
  }
  return result;
}

/** Check OpenRouter provider — parses x-ratelimit-remaining headers */
async function checkOpenRouterProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const result: ModelCheckResult = {
    provider: 'openrouter', providerLabel: 'OpenRouter', icon: '🟣',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Unified API — access 200+ models',
    freeTierInfo: 'Free credits: $1 free trial. Set OPENROUTER_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'OPENROUTER_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at openrouter.ai/keys' }];
    return result;
  }

  const check = await fetchWithTimeout<{ data: Array<{ id: string; name?: string }> }>(
    'https://openrouter.ai/api/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (check.ok && check.data?.data) {
    result.apiAccessible = true;
    result.canGenerate = true;

    // Parse OpenRouter's rate-limit headers (x-ratelimit-remaining for credits)
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining;
    result.rateLimitTotal = rl.total;
    const statusInfo = rateLimitStatus(rl.remaining, rl.total);

    result.models = check.data.data.map((m) => ({
      id: m.id, name: m.name || m.id,
      status: statusInfo.status,
      statusReason: statusInfo.reason,
      rateLimitRemaining: rl.remaining,
      rateLimitTotal: rl.total,
    }));
    result.overallStatus = statusInfo.status;
    if (statusInfo.status === 'limited') {
      result.notes = `Credits: ${statusInfo.reason}`;
    }
  } else if (check.status === 401 || check.status === 403) {
    result.models = [{ id: '(auth error)', name: 'Invalid API key', status: 'unavailable' as const, statusReason: 'Check OPENROUTER_API_KEY at openrouter.ai/keys' }];
  } else if (check.status === 429) {
    result.apiAccessible = true;
    result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited' as const, statusReason: 'Rate limit hit — check credits at openrouter.ai' }];
    result.overallStatus = 'limited';
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}: ${check.statusText}` }];
  }
  return result;
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
  const byProviderMeasured: Record<string, number> = {};
  let measuredCalls = 0;
  let estimatedCalls = 0;
  let measuredCost = 0;
  let estimatedCost = 0;
  for (const e of entries) {
    const cost = typeof e.costUsd === 'number' ? e.costUsd : 0;
    if (e.provider) byProvider[e.provider as string] = (byProvider[e.provider as string] || 0) + cost;
    if (e.model) byModel[e.model as string] = (byModel[e.model as string] || 0) + cost;
    // M2.2 wire-token metering split: measured (exact provider-reported
    // usage) vs estimated (length-based) spend.
    if (e.measured === true) {
      measuredCalls += 1;
      measuredCost += cost;
      if (e.provider) byProviderMeasured[e.provider as string] = (byProviderMeasured[e.provider as string] || 0) + cost;
    } else {
      estimatedCalls += 1;
      estimatedCost += cost;
    }
  }

  const recent = entries.slice(-50).reverse().map((e) => ({
    provider: e.provider,
    model: e.model,
    costUsd: e.costUsd,
    totalTokens: e.totalTokens,
    timestamp: e.timestamp,
    measured: e.measured === true,
  }));

  return {
    totalRequests: entries.length,
    totalCost: Math.round(totalCost * 100000) / 100000,
    totalTokens,
    byProvider,
    byModel,
    byProviderMeasured,
    measuredCalls,
    estimatedCalls,
    measuredCost: Math.round(measuredCost * 100000) / 100000,
    estimatedCost: Math.round(estimatedCost * 100000) / 100000,
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

function readEvalData(): Record<string, unknown> {
  const data = readJSON<{ runs: Array<Record<string, unknown>> }>(
    join(MEMORY_DIR, 'evals.json'),
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

// Free/local-first cost optics: providers whose default pricing is $0 (local
// Ollama, Gemini free tier). NOTE: a user-configured `pricing.gemini` override
// would make Gemini paid — this classification follows the DEFAULT pricing
// table and is a simplification (the ledger itself doesn't store pricing).
const FREE_PROVIDERS = new Set(['local', 'gemini']);
// Conservative blended rate (USD per 1K tokens) for the "would have cost"
// estimate — mirrors the auto router's default pricing for a mid-tier model.
const AVG_PAID_RATE_PER_1K = 0.0005;

// ─── Auto Routing Insights ──────────────────────────────────────────────────

/**
 * Aggregate routing insights for the dashboard:
 * - Per-provider benchmark quality (avg quality, pass rate, cost, runs)
 * - Best-performing model per agent type (from agent stats)
 * - What the Auto router would pick for sample tasks across complexity levels
 */
/**
 * Read the central quota-ledger status (tokens/requests per provider × model,
 * reset windows, parked state). Backs the dashboard's Quota card.
 */
/**
 * Read the Model Availability Registry mirror (model-registry.json) — the
 * UNIFIED enterprise read store: per provider × model it carries availability
 * (verified / unverified / unavailable), quota telemetry mirrored from the
 * ledger (tokens consumed, requests, resetsInMs, remainingTokens), latency,
 * and error rate. Backs the dashboard's Model Registry card so users see the
 * exact sub-ms snapshot the Auto router consults on every pick.
 */
function readModelRegistryData(): Record<string, unknown> {
  const data = readJSON<{ entries: Record<string, {
    provider: string;
    model: string;
    status: string;
    latencyMs?: number;
    errorRate?: number;
    quotaParkedUntil?: number;
    lastVerifiedAt?: number;
    lastError?: string;
    source?: string;
    tokensConsumed?: number;
    requests?: number;
    resetsInMs?: number;
    remainingTokens?: number;
    measuredInputTokens?: number;
    measuredOutputTokens?: number;
    measuredSamples?: number;
    /** P4 M4.4: mid-stream flakiness EMA (0-1) — the router deprioritizes flaky models. */
    partialRate?: number;
    /** P4 M4.4: flakiness trajectory [{ t, rate }] — the panel's healing sparkline. */
    partialHistory?: Array<{ t: number; rate: number }>;
  }> }>(join(MEMORY_DIR, 'model-registry.json'));
  if (!data?.entries) {
    return { enabled: false, total: 0, flaky: 0, providers: [], actionTelemetry: readRegistryTelemetry(), updatedAt: Date.now() };
  }

  const now = Date.now();
  const byProvider = new Map<string, Array<Record<string, unknown>>>();
  for (const e of Object.values(data.entries)) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider)!.push({
      model: e.model,
      status: e.status,
      latencyMs: e.latencyMs,
      errorRate: e.errorRate ?? 0,
      parked: (e.quotaParkedUntil ?? 0) > now,
      quotaParkedUntil: e.quotaParkedUntil ?? 0,
      remainingTokens: e.remainingTokens ?? -1,
      tokensConsumed: e.tokensConsumed ?? 0,
      requests: e.requests ?? 0,
      resetsInMs: e.resetsInMs ?? 0,
      lastVerifiedAt: e.lastVerifiedAt ?? 0,
      lastError: e.lastError,
      source: e.source,
      // M2.2: measured wire-token EMAs — the panel flags which provider ×
      // model drive their cost score from REAL usage data.
      measuredInputTokens: e.measuredInputTokens,
      measuredOutputTokens: e.measuredOutputTokens,
      measuredSamples: e.measuredSamples,
      // P4 M4.4: mid-stream flakiness EMA — the Models panel flags which
      // provider × model the router treats as flaky (started streaming, died
      // before finish) and deprioritizes by up to 40% in scoring — plus the
      // trajectory so the row can sparkline healing (decay via clean calls).
      partialRate: e.partialRate,
      partialHistory: e.partialHistory,
    });
  }

  const providers = [...byProvider.entries()].map(([provider, models]) => {
    models.sort((a, b) => String(a.model).localeCompare(String(b.model)));
    return {
      provider,
      total: models.length,
      verified: models.filter((m) => m.status === 'verified' && !m.parked).length,
      unverified: models.filter((m) => m.status === 'unverified').length,
      unavailable: models.filter((m) => m.status === 'unavailable').length,
      parked: models.filter((m) => m.parked).length,
      flaky: models.filter((m) => Number(m.partialRate) > 0).length,
      models,
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider));

  const allModels = providers.flatMap((p) => p.models as Array<Record<string, unknown>>);
  return {
    enabled: providers.length > 0,
    total: allModels.length,
    verified: allModels.filter((m) => m.status === 'verified' && !m.parked).length,
    unverified: allModels.filter((m) => m.status === 'unverified').length,
    unavailable: allModels.filter((m) => m.status === 'unavailable').length,
    parked: allModels.filter((m) => m.parked).length,
    flaky: allModels.filter((m) => Number(m.partialRate) > 0).length,
    providers,
    // Per-action "learned from real usage" telemetry — which provider × model
    // each action (chat / execute / plan / edit / ...) killed or verified, so
    // the predictive skips routing makes are VISIBLE in the dashboard.
    actionTelemetry: readRegistryTelemetry(),
    updatedAt: now,
  };
}

/**
 * Read the per-action "learned from real usage" telemetry log
 * (model-registry-actions.jsonl) — which provider × model each action killed
 * or verified. Aggregated by the same pure function the registry uses, so the
 * dashboard and the CLI always agree on the shape.
 */
function readRegistryTelemetry(): ActionTelemetryInsights {
  // Same file + parse the registry itself uses — one source of truth for both
  // the dashboard and the CLI, so they always agree on the shape.
  return aggregateActionTelemetry(readActionTelemetryFile(join(MEMORY_DIR, ACTION_LOG_FILENAME)));
}

/**
 * P3-M3.2 — Requests panel aggregate. Per provider × model × action: request
 * count, error rate, p50/p95/p99 latency (from logged latencyMs samples),
 * measured cost, and recent correlation ids. Fed by the SAME action-telemetry
 * JSONL the Models panel uses (readActionTelemetryFile) — one source of truth
 * for both panels. Percentile columns are omitted when fewer than 3 latency
 * samples exist (the roadmap's "p95 with <10 samples shows —" contract).
 */
function readRequestsData(): Record<string, unknown> {
  const entries = readActionTelemetryFile(join(MEMORY_DIR, ACTION_LOG_FILENAME));

  // Measured spend per provider × model from the cost ledger (cost-tracker.json)
  // — the same file readCostData reads. Cost is attributed at provider×model
  // level (the adapters record it without an action tag), so every action row
  // for a provider×model shows that pair's ledger spend, and the panel sums
  // UNIQUE pairs for the total.
  const costData = readJSON<{ entries: Array<Record<string, unknown>> }>(join(MEMORY_DIR, 'cost-tracker.json'));
  const costByPm = new Map<string, { measured: number; estimated: number; measuredCalls: number }>();
  for (const e of costData?.entries ?? []) {
    const provider = typeof e.provider === 'string' ? e.provider : '';
    const model = typeof e.model === 'string' ? e.model : '';
    const cost = typeof e.costUsd === 'number' ? e.costUsd : 0;
    if (!provider || !model || cost <= 0) continue;
    const key = `${provider}|${model}`;
    const c = costByPm.get(key) ?? { measured: 0, estimated: 0, measuredCalls: 0 };
    if (e.measured === true) {
      c.measured += cost;
      c.measuredCalls++;
    } else {
      c.estimated += cost;
    }
    costByPm.set(key, c);
  }

  type Group = {
    provider: string;
    model: string;
    action: string;
    requests: number;
    failures: number;
    /** P4 M4.4: mid-stream partial-interruption events in this group. */
    partials: number;
    latencies: number[];
    callIds: string[];
    lastAt: number;
  };
  const groups = new Map<string, Group>();
  for (const e of entries) {
    const key = `${e.provider}|${e.model}|${e.action}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        provider: e.provider,
        model: e.model,
        action: e.action,
        requests: 0,
        failures: 0,
        partials: 0,
        latencies: [],
        callIds: [],
        lastAt: 0,
      };
      groups.set(key, g);
    }
    g.requests++;
    // A mid-stream partial is NOT a request failure (the provider answered)
    // — exclude it from the failure count entirely; it's the flakiness signal,
    // surfaced separately so the panel can flag providers that start streams
    // but can't finish them.
    if (e.outcome !== 'verified' && e.outcome !== 'partial') g.failures++;
    if (e.outcome === 'partial') g.partials++;
    if (e.latencyMs !== undefined) g.latencies.push(e.latencyMs);
    if (e.callId) g.callIds.push(e.callId);
    g.lastAt = Math.max(g.lastAt, e.timestamp);
  }

  // Percentile gate: the roadmap contract is "p95 with <10 samples shows —".
  // A p99 from 3 samples is noise — percentiles appear only at >= 10 samples;
  // the avg still renders whenever any sample exists.
  const pct = (sorted: number[], p: number): number | undefined =>
    sorted.length >= 10
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
      : undefined;

  const rows = [...groups.values()]
    .map((g) => {
      const sorted = [...g.latencies].sort((a, b) => a - b);
      const avg = sorted.length > 0
        ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
        : undefined;
      const ledger = costByPm.get(`${g.provider}|${g.model}`);
      const costUsd = ledger && ledger.measured > 0
        ? Math.round(ledger.measured * 1e6) / 1e6
        : ledger && ledger.estimated > 0
          ? Math.round(ledger.estimated * 1e6) / 1e6
          : undefined;
      return {
        provider: g.provider,
        model: g.model,
        action: g.action,
        requests: g.requests,
        failures: g.failures,
        partials: g.partials,
        errorRate: Math.round((g.failures / g.requests) * 1000) / 1000,
        latency: sorted.length >= 10
          ? { avg, samples: sorted.length, p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99) }
          : sorted.length > 0
            ? { avg, samples: sorted.length }
            : undefined,
        costUsd,
        costBasis: ledger && ledger.measured > 0 ? 'measured' : ledger && ledger.estimated > 0 ? 'estimated' : undefined,
        costCalls: ledger?.measuredCalls ?? 0,
        callIds: g.callIds.slice(-5),
        lastAt: g.lastAt,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);

  return {
    enabled: entries.length > 0,
    total: entries.length,
    rows: rows.slice(0, 300),
    updatedAt: Date.now(),
  };
}

function readQuotaData(): Record<string, unknown> {
  const data = readJSON<{ entries: Record<string, {
    provider: string;
    model: string;
    tokensConsumed: number;
    requests: number;
    windowStart: number;
    windowLengthMs: number;
    cooldownUntil: number;
  }> }>(join(MEMORY_DIR, 'quota-ledger.json'));
  if (!data?.entries) {
    // Failover timeline can exist even when the ledger has no usage entries
    // (chat records failover events on auth/rate-limit failures without a
    // prior successful call) — always include events. Also always ship
    // parkedAccounts as an empty array so the panel can iterate safely
    // against an older ledger that predates multi-account rotation.
    return { enabled: false, entries: [], events: readQuotaEvents(), parkedAccounts: [], updatedAt: Date.now() };
  }

  const now = Date.now();
  const entries = Object.values(data.entries)
    .map((e) => {
      const windowEnd = e.windowStart + e.windowLengthMs;
      const resetsInMs = Math.max(0, windowEnd - now);
      const cooldownRemaining = Math.max(0, e.cooldownUntil - now);
      return {
        provider: e.provider,
        model: e.model,
        tokensConsumed: e.tokensConsumed,
        requests: e.requests,
        windowLengthMs: e.windowLengthMs,
        resetsInMs,
        parked: cooldownRemaining > 0,
        cooldownRemaining,
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  // Free/local-first cost optics (assessment #7 transparency): split tracked
  // usage into FREE providers (local, gemini free tier — $0) vs PAID providers,
  // and estimate what the free-tier tokens would have cost on a typical paid
  // provider. This is the "tokens saved / paid usage triggered" transparency
  // metric: free usage = savings, paid usage = actual spend.
  let freeTokens = 0;
  let freeRequests = 0;
  let paidTokens = 0;
  let paidRequests = 0;
  for (const e of entries) {
    if (FREE_PROVIDERS.has(e.provider)) {
      freeTokens += e.tokensConsumed;
      freeRequests += e.requests;
    } else {
      paidTokens += e.tokensConsumed;
      paidRequests += e.requests;
    }
  }
  const estimatedSavedUsd = Math.round((freeTokens / 1000) * AVG_PAID_RATE_PER_1K * 100000) / 100000;

  // Failover timeline (assessment #7): events appended by the ledger's
  // park/release/window-roll paths + chat's mid-session failover bookkeeping.
  const events = readQuotaEvents();

  // M2.3/M2.4: parked multi-account keys (fingerprints only — the ledger never
  // stores raw keys). Surfacing them makes key rotation visible: which account
  // of a provider is skipped predictively and why. The ledger persists
  // `accounts: { provider: { accountId: { parkedUntil, reason } } }`.
  const rawAccounts = (data as { accounts?: Record<string, Record<string, { parkedUntil?: number; reason?: string }>> }).accounts;
  const parkedAccounts: Array<{
    provider: string;
    accountId: string;
    reason?: string;
    parkedUntil: number;
    remainingMs: number;
  }> = [];
  if (rawAccounts) {
    for (const [provider, accounts] of Object.entries(rawAccounts)) {
      for (const [accountId, state] of Object.entries(accounts || {})) {
        const parkedUntil = state?.parkedUntil || 0;
        if (parkedUntil > now) {
          parkedAccounts.push({
            provider,
            accountId,
            reason: state?.reason,
            parkedUntil,
            remainingMs: parkedUntil - now,
          });
        }
      }
    }
    parkedAccounts.sort((a, b) => a.provider.localeCompare(b.provider) || b.remainingMs - a.remainingMs);
  }

  return {
    enabled: entries.length > 0,
    entries,
    freeTokens,
    freeRequests,
    paidTokens,
    paidRequests,
    estimatedSavedUsd,
    events,
    parkedAccounts,
    updatedAt: now,
  };
}

/**
 * Read the quota failover timeline (quota-events.jsonl) — parked / re-enabled /
 * released / failover events, newest first. Backs the dashboard's Failover
 * Timeline card in the Quota section.
 */
function readQuotaEvents(): Array<Record<string, unknown>> {
  try {
    const path = join(MEMORY_DIR, 'quota-events.jsonl');
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    const events: Array<Record<string, unknown>> = [];
    for (const line of raw.split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e && typeof e === 'object' && e.type && e.provider) events.push(e);
      } catch {
        // Skip corrupt lines.
      }
      if (events.length >= 50) break;
    }
    return events;
  } catch {
    return [];
  }
}

function readRoutingInsights(): Record<string, unknown> {
  // 1. Per-provider benchmark quality from benchmarks.json
  const benchData = readJSON<{ runs: Array<Record<string, unknown>> }>(join(MEMORY_DIR, 'benchmarks.json'));
  const perProvider: Record<string, {
    runs: number;
    avgQuality: number;
    passRate: number;
    totalCostUsd: number;
    bestModel?: string;
  }> = {};

  if (benchData?.runs) {
    for (const run of benchData.runs) {
      const provider = String(run.provider || 'unknown');
      const summary = (run.summary || {}) as Record<string, unknown>;
      const entry = perProvider[provider] || (perProvider[provider] = {
        runs: 0, avgQuality: 0, passRate: 0, totalCostUsd: 0,
      });
      entry.runs++;
      entry.avgQuality += Number(summary.avgQualityScore || 0);
      const total = Number(summary.totalTasks || 0);
      const passed = Number(summary.tasksPassed || 0);
      entry.passRate += total > 0 ? passed / total : 0;
      entry.totalCostUsd += Number(summary.totalCostUsd || 0);
      if (run.model) entry.bestModel = String(run.model);
    }
    for (const p of Object.values(perProvider)) {
      p.avgQuality = Math.round((p.avgQuality / p.runs) * 1000) / 1000;
      p.passRate = Math.round((p.passRate / p.runs) * 1000) / 1000;
    }
  }

  // 2. Best model per agent type from agent-stats.json
  const statsData = readJSON<{ agents: Record<string, unknown> }>(join(MEMORY_DIR, 'agent-stats.json'));
  const bestModels: Array<{ agentType: string; model: string; successRate: number; runs: number }> = [];
  if (statsData?.agents) {
    for (const [agentType, agentRaw] of Object.entries(statsData.agents)) {
      const agent = agentRaw as { modelPerformance?: Record<string, { runs: number; successes: number }> };
      const mp = agent?.modelPerformance || {};
      let best: { model: string; rate: number; runs: number } | null = null;
      for (const [model, perf] of Object.entries(mp)) {
        const rate = perf.runs > 0 ? perf.successes / perf.runs : 0;
        if (!best || rate > best.rate || (rate === best.rate && perf.runs > best.runs)) {
          best = { model, rate, runs: perf.runs };
        }
      }
      if (best) {
        bestModels.push({
          agentType,
          model: best.model,
          successRate: Math.round(best.rate * 100) / 100,
          runs: best.runs,
        });
      }
    }
  }

  // 3. Auto-router preference across complexity levels (static profiles + real pricing)
  const samples: Array<{ label: string; task: string }> = [
    { label: 'trivial', task: 'format this code' },
    { label: 'simple', task: 'add a simple utility function' },
    { label: 'moderate', task: 'implement a feature' },
    { label: 'complex', task: 'design a distributed microservices architecture' },
    { label: 'critical', task: 'deploy to production with zero downtime' },
  ];
  const preference = samples.map((s) => {
    const d = getAutoRouter().resolve('chat', s.task, {});
    return {
      complexity: s.label,
      winner: `${d.provider}/${d.model}`,
      score: Math.round(d.score * 1000) / 1000,
      providers: d.ranked.map((r) => ({
        provider: r.provider,
        score: Math.round(r.score * 1000) / 1000,
        reason: r.reason,
        // v1.58.0 M2.x chips — mirror the CLI `model explain` guarantees so the
        // dashboard shows WHY each provider ranks where it does.
        capabilityFit: r.capabilityFit !== undefined ? Math.round(r.capabilityFit * 100) : undefined,
        costSource: r.costSource || 'estimated',
        costBasis: r.costBasis ? {
          inputTokens: r.costBasis.inputTokens,
          outputTokens: r.costBasis.outputTokens,
        } : undefined,
        contextUtilization: r.contextUtilization !== undefined ? Math.round(r.contextUtilization * 100) : undefined,
        contextWindowTokens: r.contextWindowTokens,
      })),
    };
  });

  return {
    providers: Object.entries(perProvider).map(([provider, v]) => ({ provider, ...v })),
    bestModels,
    preference,
    usage: readRoutingUsage(),
    history: readRoutingHistory(),
    bandit: readBanditData(),
    promotion: readPromotionData(),
    quota: readQuotaData(),
    retrieval: readRetrievalData(),
    updatedAt: Date.now(),
  };
}

/**
 * Read the vector-retrieval token-savings transparency (retrieval-stats.json
 * from the memory dir) plus the repo chunk index size. Backs the dashboard's
 * Retrieval card: how many tokens were saved by vectorizing large contexts
 * (complements the quota ledger — one saves tokens, the other manages quotas).
 */
function readRetrievalData(): Record<string, unknown> {
  const data = readJSON<{
    totalCalls?: number;
    totalRetrievals?: number;
    totalFailovers?: number;
    totalOriginalTokens?: number;
    totalReducedTokens?: number;
    totalSavedTokens?: number;
    avgPctReduced?: number;
    lastCall?: Record<string, unknown>;
    recent?: Array<Record<string, unknown>>;
  }>(join(MEMORY_DIR, 'retrieval-stats.json'));

  let repoChunks = 0;
  let dimensions = 0;
  try {
    const idx = readJSON<{ entries?: Record<string, { vector?: number[] }> }>(
      join(MEMORY_DIR, 'vectors-repo.json'),
    );
    if (idx?.entries) {
      repoChunks = Object.keys(idx.entries).length;
      const first = Object.values(idx.entries)[0];
      dimensions = first?.vector?.length || 0;
    }
  } catch {
    // Best-effort — the index may not exist yet.
  }

  if (!data) {
    return {
      enabled: false,
      totalCalls: 0,
      totalRetrievals: 0,
      totalFailovers: 0,
      totalOriginalTokens: 0,
      totalReducedTokens: 0,
      totalSavedTokens: 0,
      avgPctReduced: 0,
      repoChunks,
      dimensions,
      recent: [],
      updatedAt: Date.now(),
    };
  }

  return {
    enabled: (data.totalCalls || 0) > 0 || repoChunks > 0,
    totalCalls: data.totalCalls ?? 0,
    totalRetrievals: data.totalRetrievals ?? 0,
    totalFailovers: data.totalFailovers ?? 0,
    totalOriginalTokens: data.totalOriginalTokens ?? 0,
    totalReducedTokens: data.totalReducedTokens ?? 0,
    totalSavedTokens: data.totalSavedTokens ?? 0,
    avgPctReduced: data.avgPctReduced ?? 0,
    lastCall: data.lastCall ?? null,
    recent: (data.recent || []).slice(-10),
    repoChunks,
    dimensions,
    updatedAt: Date.now(),
  };
}

/**
 * Read the promotion-gate verdict — bandit-vs-heuristic A/B status from
 * router-promotion.jsonl (ruflo ADR-150 mirror). Evaluated live via the
 * RouterPromotion singleton so the dashboard always shows the current gate.
 * Returns a fully-shaped snapshot even with zero decisions so the frontend
 * can render "collecting data" instead of a blank card.
 */
function readPromotionData(): Record<string, unknown> {
  const status = getRouterPromotion().evaluate();
  return {
    decisionCount: status.decisionCount,
    divergedCount: status.divergedCount,
    minDecisions: status.minDecisions,
    qualityDelta: Math.round(status.qualityDelta * 10000) / 10000,
    costDelta: Math.round(status.costDelta * 10000) / 10000,
    latencyDelta: Math.round(status.latencyDelta * 10000) / 10000,
    latencyMeasured: status.latencyMeasured,
    criteria: status.criteria,
    sufficient: status.sufficient,
    promoted: status.promoted,
  };
}

/**
 * Read the learning-router bandit state — Beta(α, β) priors per provider ×
 * complexity bucket plus recent learning history (from router-bandit.json).
 * The dashboard renders this as a Thompson-sampling heatmap + history timeline.
 */
function readBanditData(): Record<string, unknown> {
  const data = readJSON<{
    version?: number;
    priors?: Record<string, Record<string, { alpha: number; beta: number }>>;
    learningHistory?: Array<{
      provider: string;
      complexity: string;
      outcome: string;
      reward: number;
      timestamp: string;
    }>;
  }>(join(MEMORY_DIR, 'router-bandit.json'));
  if (!data || typeof data !== 'object') {
    return { enabled: false, version: 1, priors: {}, learningHistory: [], updatedAt: Date.now() };
  }

  // Collapse priors into a provider → bucket → {alpha,beta,expectedWinRate} shape
  const providers = new Set<string>();
  for (const bucket of Object.keys(data.priors || {})) {
    for (const provider of Object.keys(data.priors?.[bucket] || {})) {
      providers.add(provider);
    }
  }
  const priors: Record<string, Record<string, { alpha: number; beta: number; expectedWinRate: number }>> = {};
  for (const provider of providers) {
    priors[provider] = {};
    for (const bucket of ['trivial', 'simple', 'moderate', 'complex', 'critical']) {
      const prior = data.priors?.[bucket]?.[provider];
      priors[provider][bucket] = prior
        ? {
            alpha: Math.round(prior.alpha * 1000) / 1000,
            beta: Math.round(prior.beta * 1000) / 1000,
            expectedWinRate: Math.round((prior.alpha / (prior.alpha + prior.beta)) * 1000) / 1000,
          }
        : { alpha: 0, beta: 0, expectedWinRate: 0 };
    }
  }

  return {
    enabled: Object.keys(priors).length > 0 || (data.learningHistory?.length || 0) > 0,
    version: data.version ?? 1,
    priors,
    learningHistory: (data.learningHistory || []).slice(-50),
    updatedAt: Date.now(),
  };
}

// ─── Routing Usage Stats & Audit Trail ─────────────────────────────────────

/**
 * Aggregate routing usage over time from routing-history.json — which
 * providers/models were actually picked, by source (chat/orchestrator/explain/
 * benchmark/eval) and by complexity, plus the last-24h count.
 */
function readRoutingUsage(): Record<string, unknown> {
  const data = readJSON<{ entries: Array<Record<string, unknown>> }>(
    join(MEMORY_DIR, 'routing-history.json'),
  );
  if (!data?.entries || !Array.isArray(data.entries)) {
    return { total: 0, last24h: 0, byProvider: {}, byModel: {}, bySource: {}, byComplexity: {}, updatedAt: Date.now() };
  }

  const entries = data.entries as Array<Record<string, unknown>>;
  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byComplexity: Record<string, number> = {};
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let last24h = 0;

  for (const e of entries) {
    const provider = String(e.provider || 'unknown');
    const model = String(e.model || 'unknown');
    const source = String(e.source || 'unknown');
    const complexity = String(e.complexity || 'unknown');
    byProvider[provider] = (byProvider[provider] || 0) + 1;
    byModel[model] = (byModel[model] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
    byComplexity[complexity] = (byComplexity[complexity] || 0) + 1;
    if (typeof e.timestamp === 'number' && e.timestamp >= dayAgo) last24h++;
  }

  return {
    total: entries.length,
    last24h,
    byProvider,
    byModel,
    bySource,
    byComplexity,
    updatedAt: Date.now(),
  };
}

/**
 * Read the recent routing-decision timeline (audit trail) — most recent first.
 */
function readRoutingHistory(): Array<Record<string, unknown>> {
  const data = readJSON<{ entries: Array<Record<string, unknown>> }>(
    join(MEMORY_DIR, 'routing-history.json'),
  );
  if (!data?.entries || !Array.isArray(data.entries)) return [];

  const entries = data.entries as Array<Record<string, unknown>>;
  return [...entries]
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 30)
    .map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      source: e.source,
      agentType: e.agentType,
      task: typeof e.task === 'string' ? e.task.slice(0, 80) : '',
      complexity: e.complexity,
      provider: e.provider,
      model: e.model,
      score: typeof e.score === 'number' ? Math.round(e.score * 1000) / 1000 : 0,
    }));
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

  if (pathname === '/api/evals') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readEvalData()));
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

  if (pathname === '/api/models') {
    readModelsHealth().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check model health' }));
    });
    return;
  }

  if (pathname === '/api/model-registry') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readModelRegistryData()));
    return;
  }

  if (pathname === '/api/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readRequestsData()));
    return;
  }

  if (pathname === '/api/dag') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readDAGData()));
    return;
  }

  if (pathname === '/api/pipeline-runs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readPipelineRuns()));
    return;
  }

  if (pathname === '/api/routing') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readRoutingInsights()));
    return;
  }

  if (pathname === '/api/all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cost: readCostData(),
      history: readHistoryData(),
      benchmarks: readBenchmarkData(),
      evals: readEvalData(),
      memory: readMemoryData(),
      health: readHealthData(),
      routing: readRoutingInsights(),
      modelRegistry: readModelRegistryData(),
      requests: readRequestsData(),
      dag: readDAGData(),
      pipelineRuns: readPipelineRuns(),
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
      evals: readEvalData(),
      memory: readMemoryData(),
      health: readHealthData(),
      requests: readRequestsData(),
      routing: readRoutingInsights(),
      modelRegistry: readModelRegistryData(),
      dag: readDAGData(),
      pipelineRuns: readPipelineRuns(),
      serverTime: Date.now(),
    };
    res.write(`event: init\ndata: ${JSON.stringify(allData)}\n\n`);

    const clientId = nextClientId++;
    const client: SSEClient = { id: clientId, res };
    sseClients.push(client);
    // Real-time quota pushes only matter while someone is viewing — arm the
    // file watcher (idempotent) and disarm when the last client disconnects.
    // NOTE: arm unconditionally — the length===1 guard raced with a previous
    // client's async close (arm skipped when the stale client was still listed,
    // then disarm skipped too, leaving the watcher never armed).
    armQuotaWatcher();

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);

    const refreshInterval = setInterval(() => {
      try {
        const data = {
          cost: readCostData(),
          history: readHistoryData(),
          benchmarks: readBenchmarkData(),
          evals: readEvalData(),
          memory: readMemoryData(),
          health: readHealthData(),
          routing: readRoutingInsights(),
          modelRegistry: readModelRegistryData(),
          requests: readRequestsData(),
          dag: readDAGData(),
          pipelineRuns: readPipelineRuns(),
          serverTime: Date.now(),
        };
        res.write(`event: refresh\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { clearInterval(refreshInterval); }
    }, 10000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(refreshInterval);
      sseClients = sseClients.filter((c) => c.id !== clientId);
      // Only disarm when nobody is viewing AND always-on is not configured —
      // otherwise the watcher persists to keep quota state warm between sessions.
      if (sseClients.length === 0 && !alwaysWatchQuota) disarmQuotaWatcher();
    });

    return;
  }

  // ── API: unknown /api/* paths must NEVER return the SPA HTML ────
  // A frontend fetching a newer endpoint from an older server (or a typo'd
  // path) previously fell through to the SPA fallback below and got
  // index.html with HTTP 200 — then `res.json()` threw "Unexpected token '<'"
  // and took down the whole panel. API consumers get a parseable JSON 404.
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: pathname }));
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

/**
 * Load API keys from ~/.buff/buffconfig.json into process.env.
 * This covers the case where keys were saved to the config file
 * (e.g., via `buff config set` or the model picker) rather than
 * as environment variables or in a .env file.
 *
 * Does NOT override env vars that are already set.
 */
function loadApiKeysFromConfig(): void {
  const configPath = join(homedir(), '.buff', 'buffconfig.json');
  if (!existsSync(configPath)) return;

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    if (!config.providers) return;

    // Map provider config keys to their expected env var names
    const envVarMap: Record<string, string> = {
      groq: 'GROQ_API_KEY',
      nim: 'NVIDIA_NIM_API_KEY',
      gemini: 'GEMINI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      mistral: 'MISTRAL_API_KEY',
      cohere: 'COHERE_API_KEY',
      together: 'TOGETHER_API_KEY',
      anyscale: 'ANYSCALE_API_KEY',
      deepinfra: 'DEEPINFRA_TOKEN',
      fireworks: 'FIREWORKS_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
      azure: 'AZURE_OPENAI_API_KEY',
    };

    for (const [providerKey, envVar] of Object.entries(envVarMap)) {
      const apiKey = config.providers[providerKey]?.apiKey;
      if (apiKey && !process.env[envVar]) {
        process.env[envVar] = apiKey;
      }
    }
  } catch {
    // Best-effort — config file might be corrupted or unreadable
  }
}

export interface DashboardServerHandle {
  server: ReturnType<typeof createServer>;
  port: number;
  host: string;
  /**
   * IPv6-loopback twin sharing the SAME request handler — the permanent fix
   * for the "Dashboard server unreachable / Failed to fetch" issue. macOS
   * resolves `localhost` → `::1` (IPv6) BEFORE `127.0.0.1` (IPv4), so an
   * IPv4-only bind makes the browser hit `[::1]:port` → ECONNREFUSED → the
   * Models page error banner. Binding BOTH loopback families means `localhost`
   * works regardless of resolution order. Undefined when IPv6 loopback is
   * unavailable or the primary host is non-loopback.
   */
  ipv6Twin?: ReturnType<typeof createServer>;
}

export function createDashboardServer(
  opts?: { port?: number; host?: string },
): DashboardServerHandle {
  // Bind values are resolved at CALL time: explicit override → env var →
  // import-time default. (PORT/HOST above are module constants, so the CLI's
  // `dashboard --port X` can NOT rely on setting BUFF_DASHBOARD_PORT after
  // import — it must pass the override explicitly, or the server silently
  // binds the default 3030.)
  const bindPort = opts?.port ?? PORT;
  const bindHost = opts?.host ?? HOST;

  // Step 1: Load .env file values into process.env
  loadEnv();

  // Step 2: Load API keys from ~/.buff/buffconfig.json into process.env
  // This is the primary source if the user configured providers via
  // the CLI model picker or `buff config set` commands.
  loadApiKeysFromConfig();

  // Step 3: If routing.alwaysWatchQuota is set, arm the quota watcher NOW and
  // never disarm on client disconnect (always-on real-time quota updates).
  loadAlwaysWatchQuotaFlag();
  if (alwaysWatchQuota) armQuotaWatcher();

  // Log env var status once at startup for debugging
  console.log('  Provider configuration:');
  logEnvVarStatus('OpenAI', 'OPENAI_API_KEY', process.env.OPENAI_API_KEY);
  logEnvVarStatus('Anthropic', 'ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);
  logEnvVarStatus('Mistral AI', 'MISTRAL_API_KEY', process.env.MISTRAL_API_KEY);
  logEnvVarStatus('Cohere', 'COHERE_API_KEY', process.env.COHERE_API_KEY);
  logEnvVarStatus('Together AI', 'TOGETHER_API_KEY', process.env.TOGETHER_API_KEY);
  logEnvVarStatus('DeepInfra', 'DEEPINFRA_TOKEN', process.env.DEEPINFRA_TOKEN);
  logEnvVarStatus('Fireworks AI', 'FIREWORKS_API_KEY', process.env.FIREWORKS_API_KEY);
  logEnvVarStatus('Perplexity', 'PERPLEXITY_API_KEY', process.env.PERPLEXITY_API_KEY);
  logEnvVarStatus('Groq', 'GROQ_API_KEY', process.env.GROQ_API_KEY);
  logEnvVarStatus('NVIDIA NIM', 'NVIDIA_NIM_API_KEY', process.env.NVIDIA_NIM_API_KEY);
  logEnvVarStatus('Google Gemini', 'GEMINI_API_KEY', process.env.GEMINI_API_KEY);
  logEnvVarStatus('OpenRouter', 'OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY);
  logEnvVarStatus('Azure OpenAI', 'AZURE_OPENAI_API_KEY', process.env.AZURE_OPENAI_API_KEY);
  logEnvVarStatus('Anyscale', 'ANYSCALE_API_KEY', process.env.ANYSCALE_API_KEY);
  logEnvVarStatus('LM Studio', 'LM_STUDIO_URL', process.env.LM_STUDIO_URL || 'http://localhost:1234');
  logEnvVarStatus('vLLM / TGI', 'VLLM_URL', process.env.VLLM_URL || 'http://localhost:8000');
  console.log('  (AWS Bedrock & Vertex AI use IAM auth — not checked via simple API call)\n');
  console.log('');

  const server = createServer(handleRequest);

  // ── Loopback-family twin (permanent "server unreachable" fix) ──────────
  // macOS resolves `localhost` → ::1 (IPv6) BEFORE 127.0.0.1 (IPv4) — see
  // /etc/hosts + dns.lookup ordering. An IPv4-only bind made the browser hit
  // [::1]:port → ECONNREFUSED → "Failed to fetch" / "Dashboard server
  // unreachable" intermittently (happy-eyeballs timing). Bind BOTH loopback
  // families to the same handler so `localhost` and `127.0.0.1` both always
  // work. Best-effort: if the twin family is unavailable (EAFNOSUPPORT) or
  // already taken, the primary bind still serves — never fail the dashboard
  // over the twin.
  //
  // EADDRINUSE retry: when bindHost is `localhost`, Node resolves it via
  // getaddrinfo and binds the FIRST family (::1 on macOS) — so the "other"
  // family guess must adapt. If the twin hits EADDRINUSE, the primary took
  // that family; retry on the remaining loopback family instead of giving up.
  const handle: DashboardServerHandle = { server, port: bindPort, host: bindHost };
  const OTHER_LOOPBACK: Record<string, string> = { '127.0.0.1': '::1', '::1': '127.0.0.1' };
  const isLoopbackHost =
    bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
  const fmtUrl = (host: string, port: number): string =>
    host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;

  const tryTwin = (host: string): void => {
    const twin = createServer(handleRequest);
    handle.ipv6Twin = twin; // keep the live handle in sync (retry swaps it)
    twin.on('error', (err: NodeJS.ErrnoException) => {
      const other = OTHER_LOOPBACK[host];
      if (err.code === 'EADDRINUSE' && other && other !== bindHost) {
        // Primary already bound this family (e.g. --host localhost → ::1) —
        // flip to the other loopback family.
        try { twin.close(); } catch { /* ignore */ }
        tryTwin(other);
        return;
      }
      console.log(`  ⚠️ Loopback (${host}) bind skipped: ${err.code || err.message}`);
      try { twin.close(); } catch { /* ignore */ }
      if (handle.ipv6Twin === twin) handle.ipv6Twin = undefined;
    });
    twin.listen(bindPort, host, () => {
      console.log(`  Loopback twin: ${fmtUrl(host, bindPort)} (localhost race-proof)`);
    });
  };

  if (isLoopbackHost) {
    try {
      tryTwin(bindHost === '::1' ? '127.0.0.1' : '::1');
    } catch {
      handle.ipv6Twin = undefined;
    }
  }

  server.listen(bindPort, bindHost, () => {
    console.log(`\n  🌐 Agent-Nuvira Dashboard`);
    console.log(`  ─────────────────────────`);
    console.log(`  Local:   ${fmtUrl(bindHost, bindPort)}`);
    console.log(`  Network: http://localhost:${bindPort}`);
    if (handle.ipv6Twin) console.log(`  IPv6:    ${fmtUrl('::1', bindPort)} (localhost race-proof)`);
    console.log(`  Press Ctrl+C to stop\n`);
  });

  return handle;
}

// ═══════════════════════════════════════════════════════════════════════════
//  New Provider Health Checks
// ═══════════════════════════════════════════════════════════════════════════

/** Check OpenAI provider */
async function checkOpenAIProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  const result: ModelCheckResult = {
    provider: 'openai', providerLabel: 'OpenAI', icon: '🤖',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'GPT-4o, GPT-4, GPT-3.5 — industry-standard API',
    freeTierInfo: 'Pay-as-you-go. Set OPENAI_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'OPENAI_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at platform.openai.com/api-keys' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.openai.com/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check Anthropic provider */
async function checkAnthropicProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const result: ModelCheckResult = {
    provider: 'anthropic', providerLabel: 'Anthropic', icon: '🔮',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Claude 3.5 Sonnet, Claude 3 Opus — strong reasoning',
    freeTierInfo: 'Free tier: limited trial credits. Set ANTHROPIC_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'ANTHROPIC_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at console.anthropic.com' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.anthropic.com/v1/models',
    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check Mistral AI provider */
async function checkMistralProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  const result: ModelCheckResult = {
    provider: 'mistral', providerLabel: 'Mistral AI', icon: '🌀',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Mistral Large, Mistral Small, Codestral — efficient models',
    freeTierInfo: 'Free tier: limited API credits. Set MISTRAL_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'MISTRAL_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at console.mistral.ai' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.mistral.ai/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check Cohere provider */
async function checkCohereProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.COHERE_API_KEY;
  const result: ModelCheckResult = {
    provider: 'cohere', providerLabel: 'Cohere', icon: '🧠',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Command R+, Command R — enterprise-grade RAG & generation',
    freeTierInfo: 'Free tier: limited API calls. Set COHERE_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'COHERE_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at dashboard.cohere.com' }];
    return result;
  }
  const check = await fetchWithTimeout<{ models?: Array<{ id: string; name?: string }> }>(
    'https://api.cohere.com/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.models) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.models.map((m) => ({ id: m.id, name: m.name || m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check Together AI provider */
async function checkTogetherProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.TOGETHER_API_KEY;
  const result: ModelCheckResult = {
    provider: 'together', providerLabel: 'Together AI', icon: '🟢',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Open-source model hosting — Llama, Mistral, Mixtral & more',
    freeTierInfo: 'Free tier: $25 trial credits. Set TOGETHER_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'TOGETHER_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at api.together.xyz' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.together.ai/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check DeepInfra provider */
async function checkDeepInfraProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.DEEPINFRA_TOKEN;
  const result: ModelCheckResult = {
    provider: 'deepinfra', providerLabel: 'DeepInfra', icon: '🌐',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Serverless GPU inference — Llama, Mixtral, SDXL & more',
    freeTierInfo: 'Pay-as-you-go. Set DEEPINFRA_TOKEN',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'DEEPINFRA_TOKEN not set', status: 'unavailable' as const, statusReason: 'Get key at deepinfra.com' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.deepinfra.com/v1/openai/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check Fireworks AI provider */
async function checkFireworksProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  const result: ModelCheckResult = {
    provider: 'fireworks', providerLabel: 'Fireworks AI', icon: '🎆',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Fast inference — Llama, Mixtral, DeepSeek & community models',
    freeTierInfo: 'Free tier: limited API calls. Set FIREWORKS_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'FIREWORKS_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at fireworks.ai' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.fireworks.ai/inference/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check Perplexity provider */
async function checkPerplexityProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  const result: ModelCheckResult = {
    provider: 'perplexity', providerLabel: 'Perplexity', icon: '❓',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Sonar models — real-time web search & reasoning',
    freeTierInfo: 'Free tier: $5 trial credits. Set PERPLEXITY_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'PERPLEXITY_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at perplexity.ai/settings/api' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.perplexity.ai/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check Azure OpenAI provider */
async function checkAzureOpenAIProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://your-resource.openai.azure.com';
  const result: ModelCheckResult = {
    provider: 'azure', providerLabel: 'Azure OpenAI', icon: '🔵',
    apiConfigured: !!apiKey && process.env.AZURE_OPENAI_ENDPOINT !== undefined,
    apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'GPT-4o, GPT-4 via Azure — enterprise deployment',
    freeTierInfo: 'Azure subscription required. Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT',
  };
  if (!apiKey || !process.env.AZURE_OPENAI_ENDPOINT) {
    result.models = [{ id: '(no config)', name: 'AZURE_OPENAI not configured', status: 'unavailable' as const, statusReason: 'Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    `${endpoint.replace(/\/+$/, '')}/openai/models?api-version=2024-10-21`,
    { headers: { 'api-key': apiKey } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'Endpoint unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check LM Studio (local) */
async function checkLMStudioProvider(): Promise<ModelCheckResult | null> {
  const baseUrl = process.env.LM_STUDIO_URL || 'http://localhost:1234';
  const result: ModelCheckResult = {
    provider: 'lmstudio', providerLabel: 'LM Studio', icon: '🎨',
    apiConfigured: true, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Local model runner — GUI for GGUF models',
    freeTierInfo: 'Fully free — runs on your machine',
  };
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    `${baseUrl.replace(/\/+$/, '')}/api/v0/models`,
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    result.models = check.data.data.map((m) => ({
      id: m.id, name: m.id,
      status: 'available' as const,
      statusReason: 'Running locally — no rate limits',
    }));
    result.overallStatus = 'available';
  } else {
    result.models = [{ id: '(offline)', name: 'LM Studio not running', status: 'unavailable' as const, statusReason: `Start LM Studio at ${baseUrl}` }];
  }
  return result;
}

/** Check Anyscale provider */
async function checkAnyscaleProvider(): Promise<ModelCheckResult | null> {
  const apiKey = process.env.ANYSCALE_API_KEY;
  const result: ModelCheckResult = {
    provider: 'anyscale', providerLabel: 'Anyscale', icon: '🔷',
    apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Serverless Ray-based inference — Llama, Mistral & more',
    freeTierInfo: 'Pay-as-you-go. Set ANYSCALE_API_KEY',
  };
  if (!apiKey) {
    result.models = [{ id: '(no key)', name: 'ANYSCALE_API_KEY not set', status: 'unavailable' as const, statusReason: 'Get key at console.anyscale.com' }];
    return result;
  }
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    'https://api.endpoints.anyscale.com/v1/models',
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    const rl = parseRateLimitHeaders(check.headers);
    result.rateLimitRemaining = rl.remaining; result.rateLimitTotal = rl.total;
    const si = rateLimitStatus(rl.remaining, rl.total);
    result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
    result.overallStatus = si.status;
  } else {
    result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable' as const, statusReason: `HTTP ${check.status}` }];
  }
  return result;
}

/** Check vLLM / TGI (local) */
async function checkVLLMProvider(): Promise<ModelCheckResult | null> {
  const baseUrl = process.env.VLLM_URL || 'http://localhost:8000';
  const result: ModelCheckResult = {
    provider: 'vllm', providerLabel: 'vLLM / TGI', icon: '⚡',
    apiConfigured: true, apiAccessible: false, canGenerate: false,
    overallStatus: 'unavailable', models: [],
    notes: 'Self-hosted inference server — vLLM or HuggingFace TGI',
    freeTierInfo: 'Fully free — runs on your own hardware',
  };
  const check = await fetchWithTimeout<{ data: Array<{ id: string }> }>(
    `${baseUrl.replace(/\/+$/, '')}/v1/models`,
  );
  if (check.ok && check.data?.data) {
    result.apiAccessible = true; result.canGenerate = true;
    result.models = check.data.data.map((m) => ({
      id: m.id, name: m.id,
      status: 'available' as const,
      statusReason: 'Running locally — no rate limits',
    }));
    result.overallStatus = 'available';
  } else {
    result.models = [{ id: '(offline)', name: 'vLLM/TGI not running', status: 'unavailable' as const, statusReason: `Start server at ${baseUrl}` }];
  }
  return result;
}

export const DASHBOARD_DEFAULTS = { PORT, HOST };

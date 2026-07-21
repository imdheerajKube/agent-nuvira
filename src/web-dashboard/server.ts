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

import { loadEnv } from '../utils/env.js';

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
    checkGroqProvider(),
    checkNIMProvider(),
    checkGeminiProvider(),
    checkOpenRouterProvider(),
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

export function createDashboardServer(): { server: ReturnType<typeof createServer>; port: number; host: string } {
  // Step 1: Load .env file values into process.env
  loadEnv();

  // Step 2: Load API keys from ~/.buff/buffconfig.json into process.env
  // This is the primary source if the user configured providers via
  // the CLI model picker or `buff config set` commands.
  loadApiKeysFromConfig();

  // Log env var status once at startup for debugging
  console.log('  Provider configuration:');
  logEnvVarStatus('Groq', 'GROQ_API_KEY', process.env.GROQ_API_KEY);
  logEnvVarStatus('NVIDIA NIM', 'NVIDIA_NIM_API_KEY', process.env.NVIDIA_NIM_API_KEY);
  logEnvVarStatus('Google Gemini', 'GEMINI_API_KEY', process.env.GEMINI_API_KEY);
  logEnvVarStatus('OpenRouter', 'OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY);
  console.log('');

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

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
import { createServer } from 'node:http';
import { createReadStream, readFileSync, existsSync, statSync, watch, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseRbacUsers } from '../enterprise/rbac.js';
import { resolveBuffConfigDir, resolveBuffConfigPath } from '../config/paths.js';
import { loadEnv } from '../utils/env.js';
import { ConfigManager } from '../config/manager.js';
import { runAllChecks } from '../cli/doctor.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { readRecallHits } from '../context/session-recall.js';
import { getRouterPromotion } from '../learning/router-promotion.js';
import { AUTH_CLEAR_THRESHOLD } from '../learning/key-hygiene.js';
import { ACTION_LOG_FILENAME, aggregateActionTelemetry, readActionTelemetryFile } from '../learning/model-registry.js';
import { AdminSessions, countAdminRoleUsers, isAdminConfigured, listAdminUsers, removeAdminUser, roleForUser, verifyAdmin, writeAdminUser, MIN_ADMIN_PASSWORD_LENGTH, } from './src/admin-auth.js';
import { TaskRunner } from './task-runner.js';
import { WhatsAppPairingManager } from './whatsapp-pairing.js';
import { ChatConsole, newChatSessionId } from './chat-console.js';
import { buildProjectContext, formatProjectText } from './project-context.js';
import { isVaultRef } from '../enterprise/vault.js';
import { ROLES, roleCan } from '../enterprise/rbac.js';
import { clearModelListCache } from '../inference/model-validator.js';
import { probeProviderList } from '../inference/model-probe.js';
import { CATALOG_PROVIDER_IDS, getCatalogProvider } from '../inference/provider-catalog.js';
import { readHubData } from './hub-data.js';
import { setToolsetEnabled } from '../tools/toolsets.js';
import { setSkillEnabled } from '../learning/hub-skill-catalog.js';
// I11 — dashboard channel send-test: the same registry/adapters `buff gateway
// send` uses, so a Channels-tab test message behaves identically to the CLI.
// GatewayRegistry is intentionally a LAZY import inside the handler: it pulls
// the whole pipeline (pipeline-tool → cli/router, which reads package.json at
// module top level) — loading it at server-import time breaks test files that
// mock node:fs before importing the server (router's package.json read would
// hit the mocked readFileSync).
import { createConfiguredAdapters } from '../gateway/adapters.js';
import { ChannelDirectory, PLATFORM_ENV_VARS } from '../gateway/channel-directory.js';
import { applyEnvToProcess, configurablePlatforms, platformConfigStatus, platformEnvVarMeta, redactValue, writeEnvFile, } from '../gateway/platform-config.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.BUFF_DASHBOARD_PORT || '3030', 10);
const HOST = process.env.BUFF_DASHBOARD_HOST || '127.0.0.1';
const __dirname = dirname(fileURLToPath(import.meta.url));
// Public files location: try the source directory first (dev via tsx),
// then the compiled output directory (production via node dist/)
const POSSIBLE_PUBLIC_DIRS = [
    join(__dirname, 'public'), // tsx: src/web-dashboard/public/
    join(__dirname, '..', '..', 'src', 'web-dashboard', 'public'), // node: dist/web-dashboard/server.js
];
const PUBLIC_DIR = POSSIBLE_PUBLIC_DIRS.find((p) => existsSync(p)) || POSSIBLE_PUBLIC_DIRS[0];
// Honor BUFF_MEMORY_DIR (same as the CLI and the learning router) so the bandit
// card and the promotion-gate card always read from the SAME memory directory.
const MEMORY_DIR = process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};
let sseClients = [];
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
let quotaWatcher = null;
let quotaWatchTimer = null;
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
function loadAlwaysWatchQuotaFlag() {
    try {
        const configPath = resolveBuffConfigPath();
        if (!existsSync(configPath))
            return;
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        if (config?.routing?.alwaysWatchQuota === true) {
            alwaysWatchQuota = true;
        }
    }
    catch {
        // Best-effort — keep the default.
    }
}
function broadcastQuotaEvent() {
    const payload = `event: quota\ndata: ${JSON.stringify({
        quota: readQuotaData(),
        serverTime: Date.now(),
    })}\n\n`;
    for (const client of sseClients) {
        try {
            client.res.write(payload);
        }
        catch { /* client disconnected */ }
    }
}
function armQuotaWatcher() {
    if (quotaWatcher)
        return;
    try {
        // The memory dir may not exist yet (dashboard started before any ledger /
        // CLI write) — create it first so watch() doesn't throw ENOENT and silently
        // disable real-time pushes for the whole session.
        if (!existsSync(MEMORY_DIR))
            mkdirSync(MEMORY_DIR, { recursive: true });
        // Watch the DIRECTORY so we catch file creation too (quota-events.jsonl
        // may not exist until the first failover).
        quotaWatcher = watch(MEMORY_DIR, (_eventType, filename) => {
            // Some platforms report a null filename on directory watches — treat
            // that as a trigger too (worst case: a harmless extra quota push, since
            // broadcastQuotaEvent re-reads fresh data). macOS FSEvents can also
            // report FULL PATHS, so normalize with basename() before comparing.
            const name = basename(String(filename || ''));
            if (name && name !== 'quota-events.jsonl' && name !== 'quota-ledger.json')
                return;
            if (quotaWatchTimer)
                clearTimeout(quotaWatchTimer);
            quotaWatchTimer = setTimeout(() => {
                quotaWatchTimer = null;
                broadcastQuotaEvent();
            }, 150);
        });
    }
    catch {
        // Best-effort — a failed watcher must never break the dashboard.
        quotaWatcher = null;
    }
}
function disarmQuotaWatcher() {
    if (quotaWatchTimer) {
        clearTimeout(quotaWatchTimer);
        quotaWatchTimer = null;
    }
    if (quotaWatcher) {
        try {
            quotaWatcher.close();
        }
        catch { /* ignore */ }
        quotaWatcher = null;
    }
}
/** Test hook: is the quota file watcher currently armed? */
export function isQuotaWatcherArmed() {
    return quotaWatcher !== null;
}
/** Test hook: override the always-on quota watcher flag (config re-read on next create). */
export function setAlwaysWatchQuota(value) {
    alwaysWatchQuota = value;
    // Turning the flag OFF must also disarm an already-armed watcher —
    // otherwise a test that armed it would leak the fs.watch handle into
    // later tests in the same process (the only other disarm path is an SSE
    // connect→disconnect cycle, which may never happen).
    if (!value)
        disarmQuotaWatcher();
}
let activePipeline = null; // goal/description of current pipeline
let activeNodes = [];
let activeEdges = [];
/**
 * Called by the orchestrator to push a DAG update in real time.
 * Clears the pipeline when a new execution starts.
 */
export function pushDAGUpdate(update) {
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
export function updateDAGNode(nodeId, update) {
    const node = activeNodes.find((n) => n.id === nodeId);
    if (!node)
        return;
    node.status = update.status;
    if (update.summary)
        node.summary = update.summary;
    if (update.status === 'running' && !node.startedAt)
        node.startedAt = Date.now();
    if (update.status === 'completed' || update.status === 'failed') {
        if (!node.completedAt)
            node.completedAt = Date.now();
    }
    // When every step of the active run has reached a terminal state, persist
    // the run to pipeline-runs.json so the scrubbable phase timeline can show it
    // after the in-memory DAG is reset.
    maybeFinalizeRun();
    broadcastDAG();
}
/** Reset the DAG state for a fresh execution */
export function resetDAG() {
    activePipeline = null;
    activeNodes = [];
    activeEdges = [];
    activeRunId = null;
    activeRunGoal = '';
    activeRunStartedAt = 0;
    broadcastDAG();
}
/** Broadcast current DAG state to all SSE clients */
function broadcastDAG() {
    const dagData = {
        pipeline: activePipeline,
        nodes: activeNodes,
        edges: activeEdges,
        timestamp: Date.now(),
    };
    const payload = `event: dag\ndata: ${JSON.stringify(dagData)}\n\n`;
    for (const client of sseClients) {
        try {
            client.res.write(payload);
        }
        catch { /* client disconnected */ }
    }
}
/** Read DAG data: in-memory first, fall back to recent trajectories */
export function readDAGData() {
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
    const trajectoriesFile = readJSON(join(MEMORY_DIR, 'trajectories.json'));
    if (trajectoriesFile?.trajectories) {
        const trajs = Object.values(trajectoriesFile.trajectories);
        const recent = trajs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 1);
        if (recent.length > 0 && recent[0].plan) {
            const plan = recent[0].plan;
            return {
                pipeline: recent[0].goal || 'Recent execution',
                nodes: plan.map((step, i) => ({
                    id: `step-${i}`,
                    agentType: step.agentType,
                    status: 'completed',
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
/** File in the memory dir that backs the dashboard's Run Timeline. */
const PIPELINE_RUNS_FILENAME = 'pipeline-runs.json';
/** Keep the most recent 25 runs (enough for a scrubber without unbounded disk). */
const MAX_PIPELINE_RUNS = 25;
let activeRunId = null;
let activeRunGoal = '';
let activeRunStartedAt = 0;
function pipelineRunsPath() {
    return join(MEMORY_DIR, PIPELINE_RUNS_FILENAME);
}
/**
 * Read the persisted pipeline runs, most recent first.
 */
export function readPipelineRuns() {
    const data = readJSON(pipelineRunsPath());
    if (!data?.runs || !Array.isArray(data.runs)) {
        return { total: 0, runs: [] };
    }
    return { total: data.runs.length, runs: data.runs };
}
/**
 * Best-effort append of a finalized run to pipeline-runs.json. Never throws —
 * a failed write must not break the dashboard or the DAG broadcast path.
 */
function appendPipelineRun(run) {
    try {
        if (!existsSync(MEMORY_DIR))
            mkdirSync(MEMORY_DIR, { recursive: true });
        const current = readPipelineRuns();
        const runs = [run, ...current.runs.filter((r) => r.id !== run.id)].slice(0, MAX_PIPELINE_RUNS);
        writeFileSync(pipelineRunsPath(), JSON.stringify({ runs }, null, 2), 'utf-8');
    }
    catch {
        // Best-effort — a failed write must never break the dashboard.
    }
}
/**
 * When every node of the active run is terminal (completed/failed), persist it.
 * Called from updateDAGNode after each status transition; idempotent via the
 * activeRunId latch (cleared once the run is persisted).
 */
function maybeFinalizeRun() {
    if (!activeRunId || activeNodes.length === 0)
        return;
    const allTerminal = activeNodes.every((n) => n.status === 'completed' || n.status === 'failed');
    if (!allTerminal)
        return;
    const phases = activeNodes.map((n) => ({
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
function tracesPath() {
    return join(MEMORY_DIR, 'reasoning-traces.json');
}
function readTracesFile() {
    const data = readJSON(tracesPath());
    if (!data || !Array.isArray(data.traces))
        return { traces: [] };
    return data;
}
/**
 * List traces, most recent first, WITHOUT prompt/response previews (the index
 * view stays small). Includes per-trace aggregate counts so the panel can
 * render summary cards without the full steps.
 */
export function readTracesData() {
    const file = readTracesFile();
    // Newest first — sort by startedAt (defensive: file order may not be
    // append order if a trace was re-written).
    const traces = [...file.traces]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((t) => {
        const { steps, ...rest } = t;
        const stepCount = steps.length;
        const failedSteps = steps.filter((s) => !s.success).length;
        const totalTokens = steps.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
        return { ...rest, stepCount, failedSteps, totalTokens };
    });
    return { total: file.traces.length, traces };
}
/** Full trace detail (steps included) for the replay view. */
export function readTraceDetail(id) {
    const file = readTracesFile();
    return file.traces.find((t) => t.id === id) || null;
}
// ─── Model Health Check ────────────────────────────────────────────────────
/** Log which env vars were (or weren't) found for debugging */
function logEnvVarStatus(label, varName, value) {
    if (value) {
        console.log(`  ✓ ${label}: ${varName} found (${value.slice(0, 8)}...)`);
    }
    else {
        console.log(`  ✗ ${label}: ${varName} not set`);
    }
}
/**
 * Fetch with timeout. Returns status, ok flag, headers, and parsed JSON body.
 * Headers are extracted for rate-limit parsing.
 */
async function fetchWithTimeout(url, init) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timeout);
        // Extract headers for rate-limit parsing
        const headers = {};
        res.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });
        if (res.ok) {
            try {
                const data = await res.json();
                return { ok: true, status: res.status, statusText: res.statusText, data, headers };
            }
            catch {
                return { ok: true, status: res.status, statusText: res.statusText, headers };
            }
        }
        return { ok: false, status: res.status, statusText: res.statusText, headers };
    }
    catch {
        return { ok: false, status: 0, statusText: 'Connection failed', headers: {} };
    }
}
/**
 * Parse common rate-limit headers and return remaining/total if found.
 * Supports multiple header naming conventions across providers.
 */
function parseRateLimitHeaders(headers) {
    const result = {};
    // Try various rate-limit header names
    const remainingHeaders = [
        'x-ratelimit-remaining-requests', // Groq
        'x-ratelimit-remaining', // NIM, OpenRouter, generic
        'x-ratelimit-remaining-quota', // Gemini
        'x-ratelimit-remaining-tokens', // Groq token limit
        'ratelimit-remaining', // Generic
    ];
    const totalHeaders = [
        'x-ratelimit-limit', // NIM
        'x-ratelimit-request-limit', // Groq
        'x-ratelimit-limit-quota', // Gemini
        'ratelimit-limit', // Generic
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
function rateLimitStatus(remaining, total) {
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
async function readModelsHealth() {
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
    const providers = results.filter(Boolean);
    const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);
    const available = providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === 'available').length, 0);
    const limited = providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === 'limited').length, 0);
    const unavailable = providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === 'unavailable').length, 0);
    return { providers, lastChecked: Date.now(), totalModels, available, limited, unavailable };
}
/** Check local Ollama provider — no rate limits to parse */
async function checkLocalProvider() {
    const result = {
        provider: 'local', providerLabel: 'Ollama (Local)', icon: '💻',
        apiConfigured: true, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Local models via Ollama at http://localhost:11434',
        freeTierInfo: 'Fully free — runs on your machine',
    };
    const check = await fetchWithTimeout('http://localhost:11434/api/tags');
    if (check.ok && check.data?.models) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const models = check.data.models;
        if (models.length > 0) {
            result.models = models.map((m) => ({
                id: m.name, name: m.name,
                status: 'available',
                statusReason: 'Running locally — no rate limits',
            }));
            result.overallStatus = 'available';
        }
        else {
            result.models = [{ id: '(no models)', name: 'No models pulled', status: 'limited', statusReason: 'Run: ollama pull <model>' }];
            result.overallStatus = 'limited';
            result.notes = 'Ollama running but no models pulled yet';
        }
    }
    else if (check.ok) {
        result.apiAccessible = true;
        result.models = [{ id: '(empty)', name: 'No model data', status: 'limited', statusReason: 'Could not parse model list' }];
        result.overallStatus = 'limited';
    }
    else {
        result.models = [{ id: '(offline)', name: 'Ollama not running', status: 'unavailable', statusReason: 'Install Ollama: brew install ollama' }];
        result.overallStatus = 'unavailable';
    }
    return result;
}
/** Check Groq provider — parses x-ratelimit-remaining-requests headers */
async function checkGroqProvider() {
    const apiKey = process.env.GROQ_API_KEY;
    const result = {
        provider: 'groq', providerLabel: 'Groq', icon: '🟢',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'LPU cloud inference — fastest response times',
        freeTierInfo: 'Free tier: ~30 req/min, 14400 req/day. Set GROQ_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'GROQ_API_KEY not set', status: 'unavailable', statusReason: 'Get key at console.groq.com' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
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
    }
    else if (check.status === 401 || check.status === 403) {
        result.models = [{ id: '(auth error)', name: 'Invalid API key', status: 'unavailable', statusReason: 'Check GROQ_API_KEY at console.groq.com' }];
    }
    else if (check.status === 429) {
        result.apiAccessible = true;
        result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited', statusReason: 'Free tier rate limit hit — wait or upgrade' }];
        result.overallStatus = 'limited';
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}: ${check.statusText}` }];
    }
    return result;
}
/** Check NVIDIA NIM provider — parses x-ratelimit-remaining headers */
async function checkNIMProvider() {
    const apiKey = process.env.NVIDIA_NIM_API_KEY;
    const baseUrl = process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
    const result = {
        provider: 'nim', providerLabel: 'NVIDIA NIM', icon: '🔶',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'NVIDIA NIM cloud or self-hosted inference',
        freeTierInfo: 'Free tier: 1000 req/day. Set NVIDIA_NIM_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'NVIDIA_NIM_API_KEY not set', status: 'unavailable', statusReason: 'Get key at build.nvidia.com' }];
        return result;
    }
    const check = await fetchWithTimeout(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
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
    }
    else if (check.status === 401 || check.status === 403) {
        result.models = [{ id: '(auth error)', name: 'Invalid API key', status: 'unavailable', statusReason: 'Check NVIDIA_NIM_API_KEY at build.nvidia.com' }];
    }
    else if (check.status === 429) {
        result.apiAccessible = true;
        result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited', statusReason: 'Free tier limit hit — wait or upgrade' }];
        result.overallStatus = 'limited';
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}: ${check.statusText}` }];
    }
    return result;
}
/** Check Google Gemini provider — parses rate-limit headers */
async function checkGeminiProvider() {
    const apiKey = process.env.GEMINI_API_KEY;
    const result = {
        provider: 'gemini', providerLabel: 'Google Gemini', icon: '🔷',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Google Gemini API — strong reasoning, large context',
        freeTierInfo: 'Free tier: 60 req/min, 1500 req/day. Set GEMINI_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'GEMINI_API_KEY not set', status: 'unavailable', statusReason: 'Get key at aistudio.google.com/apikey' }];
        return result;
    }
    const check = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
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
    }
    else if (check.status === 403) {
        result.models = [{ id: '(auth error)', name: 'Invalid or expired API key', status: 'unavailable', statusReason: 'Check GEMINI_API_KEY at aistudio.google.com' }];
    }
    else if (check.status === 429) {
        result.apiAccessible = true;
        result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited', statusReason: 'Free tier limit hit — wait or upgrade to paid' }];
        result.overallStatus = 'limited';
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}: ${check.statusText}` }];
    }
    return result;
}
/** Check OpenRouter provider — parses x-ratelimit-remaining headers */
async function checkOpenRouterProvider() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const result = {
        provider: 'openrouter', providerLabel: 'OpenRouter', icon: '🟣',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Unified API — access 200+ models',
        freeTierInfo: 'Free credits: $1 free trial. Set OPENROUTER_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'OPENROUTER_API_KEY not set', status: 'unavailable', statusReason: 'Get key at openrouter.ai/keys' }];
        return result;
    }
    const check = await fetchWithTimeout('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
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
    }
    else if (check.status === 401 || check.status === 403) {
        result.models = [{ id: '(auth error)', name: 'Invalid API key', status: 'unavailable', statusReason: 'Check OPENROUTER_API_KEY at openrouter.ai/keys' }];
    }
    else if (check.status === 429) {
        result.apiAccessible = true;
        result.models = [{ id: '(rate limited)', name: 'Rate limited', status: 'limited', statusReason: 'Rate limit hit — check credits at openrouter.ai' }];
        result.overallStatus = 'limited';
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}: ${check.statusText}` }];
    }
    return result;
}
// ─── Data Readers ───────────────────────────────────────────────────────────
function readJSON(filePath) {
    try {
        if (!existsSync(filePath))
            return null;
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function readCostData() {
    const data = readJSON(join(MEMORY_DIR, 'cost-tracker.json'));
    if (!data?.entries) {
        return { totalRequests: 0, totalCost: 0, byProvider: {}, byModel: {} };
    }
    const entries = data.entries;
    const totalCost = entries.reduce((s, e) => s + (typeof e.costUsd === 'number' ? e.costUsd : 0), 0);
    const totalTokens = entries.reduce((s, e) => s + (typeof e.totalTokens === 'number' ? e.totalTokens : 0), 0);
    const byProvider = {};
    const byModel = {};
    const byProviderMeasured = {};
    let measuredCalls = 0;
    let estimatedCalls = 0;
    let measuredCost = 0;
    let estimatedCost = 0;
    for (const e of entries) {
        const cost = typeof e.costUsd === 'number' ? e.costUsd : 0;
        if (e.provider)
            byProvider[e.provider] = (byProvider[e.provider] || 0) + cost;
        if (e.model)
            byModel[e.model] = (byModel[e.model] || 0) + cost;
        // M2.2 wire-token metering split: measured (exact provider-reported
        // usage) vs estimated (length-based) spend.
        if (e.measured === true) {
            measuredCalls += 1;
            measuredCost += cost;
            if (e.provider)
                byProviderMeasured[e.provider] = (byProviderMeasured[e.provider] || 0) + cost;
        }
        else {
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
function readHistoryData() {
    const data = readJSON(join(MEMORY_DIR, 'history.json'));
    if (!data?.sessions) {
        return { total: 0, recent: [] };
    }
    const sessions = Object.values(data.sessions);
    const recent = sessions
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 20)
        .map((s) => ({
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
function readEvalData() {
    const data = readJSON(join(MEMORY_DIR, 'evals.json'));
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
        runs: runs.map((r) => ({
            id: r.id,
            provider: r.provider,
            model: r.model,
            startedAt: r.startedAt,
            summary: r.summary,
        })),
    };
}
function readBenchmarkData() {
    const data = readJSON(join(MEMORY_DIR, 'benchmarks.json'));
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
        runs: runs.map((r) => ({
            id: r.id,
            provider: r.provider,
            model: r.model,
            startedAt: r.startedAt,
            summary: r.summary,
        })),
    };
}
function readMemoryData() {
    const data = readJSON(join(MEMORY_DIR, 'trajectories.json'));
    const trajectories = data?.trajectories
        ? Object.values(data.trajectories)
        : [];
    const avgScore = trajectories.length > 0
        ? trajectories.reduce((s, t) => s + (t.score || 0), 0) / trajectories.length
        : 0;
    const byFingerprint = {};
    for (const t of trajectories) {
        const fp = t.projectFingerprint || 'unknown';
        byFingerprint[fp] = (byFingerprint[fp] || 0) + 1;
    }
    // G2: facts (B1) + recall hits (D1) + vector backend — read from the same
    // files the CLI reads so the panel and CLI always agree.
    let facts = { total: 0, byProject: {} };
    try {
        // The vector store persists entries as a RECORD keyed by id (same shape
        // as vectors.json) — Object.values, never array iteration.
        const factsData = readJSON(join(MEMORY_DIR, 'vectors-facts.json'));
        const factEntries = factsData?.entries ? Object.values(factsData.entries) : [];
        if (factEntries.length > 0) {
            const byProject = {};
            for (const e of factEntries) {
                const pid = e.metadata?.projectId || 'unknown';
                byProject[pid] = (byProject[pid] || 0) + 1;
            }
            facts = { total: factEntries.length, byProject };
        }
    }
    catch {
        // Best-effort.
    }
    // Shared parser (session-recall.ts) — one source of truth for the counter.
    const recall = readRecallHits();
    return {
        total: trajectories.length,
        avgScore: Math.round(avgScore * 100) / 100,
        byFingerprint,
        facts,
        recall,
        backend: 'local', // memory.backend tier (F1 Mem0 is an optional provider — local is the default)
    };
}
function readHealthData() {
    const patterns = readJSON(join(MEMORY_DIR, 'patterns.json'));
    const feedback = readJSON(join(MEMORY_DIR, 'feedback.json'));
    const vectors = readJSON(join(MEMORY_DIR, 'vectors.json'));
    const agentStats = readJSON(join(MEMORY_DIR, 'agent-stats.json'));
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
 * ISSUE-004: read the key-hygiene store (key-hygiene.json) — the consecutive
 * 401/403 auth-failure counters per provider that drive the auto-clear at
 * AUTH_CLEAR_THRESHOLD. Surfaces how close each provider is to having its
 * dead key cleared, so the Models panel can warn BEFORE the threshold.
 */
function readKeyHygieneData() {
    const data = readJSON(join(MEMORY_DIR, 'key-hygiene.json'));
    return {
        threshold: AUTH_CLEAR_THRESHOLD,
        consecutive: data?.consecutiveAuthFailures ?? {},
    };
}
/**
 * Read the Model Availability Registry mirror (model-registry.json) — the
 * UNIFIED enterprise read store: per provider × model it carries availability
 * (verified / unverified / unavailable), quota telemetry mirrored from the
 * ledger (tokens consumed, requests, resetsInMs, remainingTokens), latency,
 * and error rate. Backs the dashboard's Model Registry card so users see the
 * exact sub-ms snapshot the Auto router consults on every pick.
 */
function readModelRegistryData() {
    const data = readJSON(join(MEMORY_DIR, 'model-registry.json'));
    if (!data?.entries) {
        return {
            enabled: false, total: 0, flaky: 0, providers: [],
            actionTelemetry: readRegistryTelemetry(),
            keyHygiene: readKeyHygieneData(),
            deletedLocal: 0,
            updatedAt: Date.now(),
        };
    }
    const now = Date.now();
    const byProvider = new Map();
    for (const e of Object.values(data.entries)) {
        if (!byProvider.has(e.provider))
            byProvider.set(e.provider, []);
        byProvider.get(e.provider).push({
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
            // v1.60.1/1.60.2: the live provider-advertised context window the probe
            // recorded into the registry — the real spec the router's context
            // preflight prefers over static provider-level estimates.
            contextWindowTokens: e.contextWindowTokens,
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
    const allModels = providers.flatMap((p) => p.models);
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
        // ISSUE-004: how close each provider is to having its dead key auto-
        // cleared (3 consecutive 401/403s) + how many verified local models were
        // demoted because they were deleted from the machine (ollama rm).
        keyHygiene: readKeyHygieneData(),
        deletedLocal: allModels.filter((m) => m.lastError === 'model deleted from local system').length,
        updatedAt: now,
    };
}
/**
 * Read the per-action "learned from real usage" telemetry log
 * (model-registry-actions.jsonl) — which provider × model each action killed
 * or verified. Aggregated by the same pure function the registry uses, so the
 * dashboard and the CLI always agree on the shape.
 */
function readRegistryTelemetry() {
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
function readRequestsData() {
    const entries = readActionTelemetryFile(join(MEMORY_DIR, ACTION_LOG_FILENAME));
    // Measured spend per provider × model from the cost ledger (cost-tracker.json)
    // — the same file readCostData reads. Cost is attributed at provider×model
    // level (the adapters record it without an action tag), so every action row
    // for a provider×model shows that pair's ledger spend, and the panel sums
    // UNIQUE pairs for the total.
    const costData = readJSON(join(MEMORY_DIR, 'cost-tracker.json'));
    const costByPm = new Map();
    for (const e of costData?.entries ?? []) {
        const provider = typeof e.provider === 'string' ? e.provider : '';
        const model = typeof e.model === 'string' ? e.model : '';
        const cost = typeof e.costUsd === 'number' ? e.costUsd : 0;
        if (!provider || !model || cost <= 0)
            continue;
        const key = `${provider}|${model}`;
        const c = costByPm.get(key) ?? { measured: 0, estimated: 0, measuredCalls: 0 };
        if (e.measured === true) {
            c.measured += cost;
            c.measuredCalls++;
        }
        else {
            c.estimated += cost;
        }
        costByPm.set(key, c);
    }
    const groups = new Map();
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
        if (e.outcome !== 'verified' && e.outcome !== 'partial')
            g.failures++;
        if (e.outcome === 'partial')
            g.partials++;
        if (e.latencyMs !== undefined)
            g.latencies.push(e.latencyMs);
        if (e.callId)
            g.callIds.push(e.callId);
        g.lastAt = Math.max(g.lastAt, e.timestamp);
    }
    // Percentile gate: the roadmap contract is "p95 with <10 samples shows —".
    // A p99 from 3 samples is noise — percentiles appear only at >= 10 samples;
    // the avg still renders whenever any sample exists.
    const pct = (sorted, p) => sorted.length >= 10
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
function readQuotaData() {
    const data = readJSON(join(MEMORY_DIR, 'quota-ledger.json'));
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
        }
        else {
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
    const rawAccounts = data.accounts;
    const parkedAccounts = [];
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
function readQuotaEvents() {
    try {
        const path = join(MEMORY_DIR, 'quota-events.jsonl');
        if (!existsSync(path))
            return [];
        const raw = readFileSync(path, 'utf-8');
        const events = [];
        for (const line of raw.split('\n').reverse()) {
            if (!line.trim())
                continue;
            try {
                const e = JSON.parse(line);
                if (e && typeof e === 'object' && e.type && e.provider)
                    events.push(e);
            }
            catch {
                // Skip corrupt lines.
            }
            if (events.length >= 50)
                break;
        }
        return events;
    }
    catch {
        return [];
    }
}
function readRoutingInsights() {
    // 1. Per-provider benchmark quality from benchmarks.json
    const benchData = readJSON(join(MEMORY_DIR, 'benchmarks.json'));
    const perProvider = {};
    if (benchData?.runs) {
        for (const run of benchData.runs) {
            const provider = String(run.provider || 'unknown');
            const summary = (run.summary || {});
            const entry = perProvider[provider] || (perProvider[provider] = {
                runs: 0, avgQuality: 0, passRate: 0, totalCostUsd: 0,
            });
            entry.runs++;
            entry.avgQuality += Number(summary.avgQualityScore || 0);
            const total = Number(summary.totalTasks || 0);
            const passed = Number(summary.tasksPassed || 0);
            entry.passRate += total > 0 ? passed / total : 0;
            entry.totalCostUsd += Number(summary.totalCostUsd || 0);
            if (run.model)
                entry.bestModel = String(run.model);
        }
        for (const p of Object.values(perProvider)) {
            p.avgQuality = Math.round((p.avgQuality / p.runs) * 1000) / 1000;
            p.passRate = Math.round((p.passRate / p.runs) * 1000) / 1000;
        }
    }
    // 2. Best model per agent type from agent-stats.json
    const statsData = readJSON(join(MEMORY_DIR, 'agent-stats.json'));
    const bestModels = [];
    if (statsData?.agents) {
        for (const [agentType, agentRaw] of Object.entries(statsData.agents)) {
            const agent = agentRaw;
            const mp = agent?.modelPerformance || {};
            let best = null;
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
    const samples = [
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
        // v1.71.0 ML task-similarity router state (ruflo neural-router analog).
        ml: readMlData(),
        quota: readQuotaData(),
        retrieval: readRetrievalData(),
        // P6 M6.5: the admin governance policy the router enforces as hard
        // constraints — surfaced so the dashboard shows policy where routing
        // decisions are made (mirrors `buff admin policy`).
        governance: readGovernanceData(),
        // P6 M6.1: RBAC identity + role assignments (mirrors `buff admin whoami` /
        // `buff admin role list`) so the dashboard shows WHO may write policy
        // alongside WHAT the policy is.
        rbac: readRbacData(),
        updatedAt: Date.now(),
    };
}
/**
 * Read the vector-retrieval token-savings transparency (retrieval-stats.json
 * from the memory dir) plus the repo chunk index size. Backs the dashboard's
 * Retrieval card: how many tokens were saved by vectorizing large contexts
 * (complements the quota ledger — one saves tokens, the other manages quotas).
 */
function readRetrievalData() {
    const data = readJSON(join(MEMORY_DIR, 'retrieval-stats.json'));
    let repoChunks = 0;
    let dimensions = 0;
    try {
        const idx = readJSON(join(MEMORY_DIR, 'vectors-repo.json'));
        if (idx?.entries) {
            repoChunks = Object.keys(idx.entries).length;
            const first = Object.values(idx.entries)[0];
            dimensions = first?.vector?.length || 0;
        }
    }
    catch {
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
 * Read the admin governance policy (routing.governance from buffconfig.json)
 * — the exact policy `buff admin` writes and the auto-router enforces as hard
 * constraints. Always returns a shaped payload: `enabled: false` when empty
 * (fully permissive) so the dashboard can render the policy card either way.
 */
function readGovernanceData() {
    try {
        const configPath = resolveBuffConfigPath();
        if (!existsSync(configPath))
            return { enabled: false, updatedAt: Date.now() };
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        const gov = config?.routing?.governance || {};
        return {
            enabled: Object.keys(gov).length > 0,
            ...gov,
            updatedAt: Date.now(),
        };
    }
    catch {
        return { enabled: false, updatedAt: Date.now() };
    }
}
/**
 * Read the RBAC role file (~/.buff/rbac.json — the same file `buff admin
 * role add` writes) into a shaped payload: the acting identity, their role
 * (null when unassigned), the full user→role map, and whether the system is
 * in legacy single-user mode (no roles assigned → fully permissive). Uses the
 * same BUFF_CONFIG_DIR-aware path convention as the other readers.
 */
function readRbacData() {
    try {
        const configPath = join(resolveBuffConfigDir(), 'rbac.json');
        const identity = process.env.BUFF_ACT_AS || process.env.USER || 'local';
        if (!existsSync(configPath)) {
            return { legacy: true, identity, role: null, users: [], updatedAt: Date.now() };
        }
        const users = parseRbacUsers(readFileSync(configPath, 'utf-8'));
        return {
            legacy: Object.keys(users).length === 0,
            identity,
            role: users[identity]?.role || null,
            users: Object.entries(users)
                .map(([user, u]) => ({ user, role: u.role, via: u.via }))
                .sort((a, b) => a.user.localeCompare(b.user)),
            updatedAt: Date.now(),
        };
    }
    catch {
        return { legacy: true, identity: 'local', role: null, users: [], updatedAt: Date.now() };
    }
}
/**
 * Read the promotion-gate verdict — bandit-vs-heuristic A/B status from
 * router-promotion.jsonl (ruflo ADR-150 mirror). Evaluated live via the
 * RouterPromotion singleton so the dashboard always shows the current gate.
 * Returns a fully-shaped snapshot even with zero decisions so the frontend
 * can render "collecting data" instead of a blank card.
 */
function readPromotionData() {
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
function readBanditData() {
    const data = readJSON(join(MEMORY_DIR, 'router-bandit.json'));
    if (!data || typeof data !== 'object') {
        return { enabled: false, version: 1, priors: {}, learningHistory: [], updatedAt: Date.now() };
    }
    // Collapse priors into a provider → bucket → {alpha,beta,expectedWinRate} shape
    const providers = new Set();
    for (const bucket of Object.keys(data.priors || {})) {
        for (const provider of Object.keys(data.priors?.[bucket] || {})) {
            providers.add(provider);
        }
    }
    const priors = {};
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
/**
 * Read the ML task-similarity router state (from ml-router.jsonl) — the
 * ruflo neural-router analog: every recorded outcome is a feature vector, and
 * at resolve time the k most similar past tasks yield a per-provider learned
 * win rate / factor. The dashboard renders this as a learned-state card:
 * record count, per-provider samples, win rate, and the clamped factor
 * (1 + strength × (winRate − 0.5), default strength 0.5, minSamples 5).
 */
function readMlData() {
    const records = [];
    try {
        const p = join(MEMORY_DIR, 'ml-router.jsonl');
        if (!existsSync(p))
            return { enabled: false, recordCount: 0, providers: [], updatedAt: Date.now() };
        for (const line of readFileSync(p, 'utf-8').split('\n')) {
            const t = line.trim();
            if (!t)
                continue;
            try {
                records.push(JSON.parse(t));
            }
            catch {
                // Skip malformed lines — the trajectory must never break the dashboard.
            }
        }
    }
    catch {
        return { enabled: false, recordCount: 0, providers: [], updatedAt: Date.now() };
    }
    // Aggregate per provider: samples, wins (escalated = half-win), win rate,
    // and the clamped learned factor with the same defaults as ml-router.ts.
    const byProvider = new Map();
    let lastTs = 0;
    for (const r of records) {
        const provider = r.provider || 'unknown';
        const entry = byProvider.get(provider) || { samples: 0, winSum: 0 };
        entry.samples++;
        const w = r.outcome === 'success' ? 1 : r.outcome === 'escalated' ? 0.5 : 0;
        entry.winSum += w;
        if (r.model)
            entry.model = r.model;
        if (r.ts && r.ts > lastTs)
            lastTs = r.ts;
        byProvider.set(provider, entry);
    }
    const MIN_SAMPLES = 5;
    const STRENGTH = 0.5;
    const providers = [...byProvider.entries()]
        .map(([provider, e]) => {
        const winRate = e.samples > 0 ? e.winSum / e.samples : 0.5;
        const factor = 1 + STRENGTH * (winRate - 0.5);
        return {
            provider,
            samples: e.samples,
            winRate: Math.round(winRate * 1000) / 1000,
            factor: Math.round(factor * 1000) / 1000,
            trusted: e.samples >= MIN_SAMPLES,
            model: e.model,
        };
    })
        .sort((a, b) => b.samples - a.samples);
    return {
        enabled: records.length > 0,
        recordCount: records.length,
        providers,
        updatedAt: lastTs || Date.now(),
    };
}
// ─── Routing Usage Stats & Audit Trail ─────────────────────────────────────
/**
 * Aggregate routing usage over time from routing-history.json — which
 * providers/models were actually picked, by source (chat/orchestrator/explain/
 * benchmark/eval) and by complexity, plus the last-24h count.
 */
function readRoutingUsage() {
    const data = readJSON(join(MEMORY_DIR, 'routing-history.json'));
    if (!data?.entries || !Array.isArray(data.entries)) {
        return { total: 0, last24h: 0, byProvider: {}, byModel: {}, bySource: {}, byComplexity: {}, updatedAt: Date.now() };
    }
    const entries = data.entries;
    const byProvider = {};
    const byModel = {};
    const bySource = {};
    const byComplexity = {};
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
        if (typeof e.timestamp === 'number' && e.timestamp >= dayAgo)
            last24h++;
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
function readRoutingHistory() {
    const data = readJSON(join(MEMORY_DIR, 'routing-history.json'));
    if (!data?.entries || !Array.isArray(data.entries))
        return [];
    const entries = data.entries;
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
/** Mask a secret so the dashboard never exposes a raw key. */
function maskKey(key) {
    if (!key)
        return null;
    if (key.length <= 8)
        return '••••';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
/**
 * The per-provider env var used for key detection (mirrors doctor.ts).
 * The dashboard reports where a key lives WITHOUT ever printing it.
 */
const PROVIDER_ENV_VARS = {
    groq: 'GROQ_API_KEY',
    gemini: 'GEMINI_API_KEY',
    nim: 'NVIDIA_NIM_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
};
/**
 * One provider's summary row (read path, keys ALWAYS masked). Shared by
 * buildAdminProviderSummary AND the write routes' response, so the frontend
 * always receives the same shape after a save/remove. The key SOURCE is
 * detected the same way the CLI sees it: env override > vault ref > config
 * plaintext > none (local providers are keyless by design).
 */
function summarizeProvider(type, configManager) {
    const c = (configManager.getAll().providers || {})[type];
    const envVar = PROVIDER_ENV_VARS[type];
    const viaEnv = envVar ? !!process.env[envVar] : false;
    const key = c?.apiKey;
    const rotationKeys = Array.isArray(c?.apiKeys) ? c.apiKeys : [];
    const vaultKey = typeof key === 'string' && isVaultRef(key);
    const keySource = type === 'local'
        ? 'local'
        : viaEnv
            ? 'env'
            : vaultKey
                ? 'vault'
                : (key || rotationKeys.length > 0)
                    ? 'config'
                    : 'none';
    return {
        type,
        configured: (keySource !== 'none' && keySource !== 'local') || !!c?.baseUrl || type === 'local',
        keySource,
        keyMasked: rotationKeys.length > 0
            ? `${rotationKeys.length} rotation key(s): ${maskKey(key || rotationKeys[0])}`
            : maskKey(key),
        model: c?.model,
        baseUrl: c?.baseUrl,
    };
}
/**
 * The provider configuration summary (read path, keys masked). This is the
 * foundation of the admin surface: the same rows become editable (API-key /
 * provider configuration) via the authed PUT/DELETE routes — CLI and dashboard
 * stay parallel, never deprecating either.
 */
function buildAdminProviderSummary(configManager) {
    const providers = configManager.getAll().providers || {};
    return Object.keys(providers).map((type) => summarizeProvider(type, configManager));
}
/** Run ALL state checks — the dashboard command-runner payload. */
async function runAdminChecks() {
    const configManager = new ConfigManager();
    const { system, enterprise } = await runAllChecks(configManager);
    return {
        system,
        enterprise,
        providers: buildAdminProviderSummary(configManager),
        serverTime: Date.now(),
    };
}
// ─── Admin Write Surface Helpers (Session 18) ───────────────────────────────
/** One session store per server process (in-memory Bearer tokens, 8h expiry). */
const adminSessions = new AdminSessions();
/**
 * P1 — Task runner: the dashboard's command console executes the CLI
 * (`dist/index.js`) as an isolated child process — the GUI is literally
 * running the CLI, so command/UX parity is guaranteed by construction.
 * BUFF_DASHBOARD_TASK_CLI_ENTRY overrides the entry (tests / custom builds).
 */
const taskRunner = new TaskRunner({
    cliEntry: process.env.BUFF_DASHBOARD_TASK_CLI_ENTRY || undefined,
});
/**
 * P2 — In-page WhatsApp pairing: the dashboard twin of `buff whatsapp pair`.
 * QR payloads stream to the browser as scannable PNG data URLs (the panel's
 * `<img>`), the 8-char phone-pairing code streams the same way, and status
 * events drive the panel's state. One manager per server process.
 */
let whatsappPairing = new WhatsAppPairingManager();
/**
 * P3 — Dashboard chat console: in-process agent chat (GUI parity with
 * `buff chat "<prompt>"`). The engine (ChatCommand) is loaded lazily on the
 * first message, so server import stays light. One console per process.
 */
// P4 — chat sessions persist through ~/.buff/memory/chat-sessions.json so the
// sidebar can resume any past conversation after a dashboard restart.
let chatConsole = new ChatConsole({ persistPath: join(MEMORY_DIR, 'chat-sessions.json') });
// P3 — project attach. The bundle is cached per path and rebuilt only when the
// directory mtime changes, so repeat turns don't re-walk the tree. The
// recent-projects list (the dashboard's own cwd + every attached path) feeds
// the picker; both are in-memory (the workspace store records repo ids, not
// local paths — this is the dashboard's own recency).
const projectBundleCache = new Map();
const recentProjects = new Set([process.cwd()]);
/** Get (or build) the cached bundle for a project path; null when invalid. */
function getProjectBundle(path) {
    try {
        const mtimeMs = statSync(path).mtimeMs;
        const cached = projectBundleCache.get(path);
        if (cached && cached.mtimeMs === mtimeMs)
            return cached.bundle;
        const bundle = buildProjectContext(path);
        if (!bundle)
            return null;
        projectBundleCache.set(path, { mtimeMs, bundle });
        return bundle;
    }
    catch {
        return null;
    }
}
/** Test hook: swap the chat console (e.g. a fake engine) — routes read the
 * module variable at request time, so this works anytime. */
export function setChatConsoleForTest(console) {
    chatConsole = console;
}
/**
 * The LIVE server handle, kept module-level so the Shutdown route can close
 * the listeners (primary + IPv6 twin) before exiting — a dashboard stopped
 * from its own UI must free the port immediately, not wait for the OS.
 * Set by createDashboardServer on bind; cleared on shutdown.
 */
let activeServerHandle = null;
/**
 * Default shutdown action for POST /api/admin/shutdown { target: 'dashboard' }:
 * close both listeners, then exit after a short tick so the HTTP 200 response
 * flushes to the browser first (the page shows the result, then disconnects).
 */
let dashboardShutdownAction = () => {
    setTimeout(() => {
        try {
            activeServerHandle?.server.close();
        }
        catch { /* best-effort */ }
        if (activeServerHandle?.ipv6Twin) {
            try {
                activeServerHandle.ipv6Twin.close();
            }
            catch { /* best-effort */ }
        }
        process.exit(0);
    }, 150);
};
/**
 * Run the dashboard shutdown action (test hook: swap to a no-op so API tests
 * exercising /api/admin/shutdown never exit the test runner).
 */
export function setDashboardShutdownForTest(action) {
    dashboardShutdownAction = action ?? (() => { });
}
/** Invoke the current dashboard shutdown action (used by the shutdown route). */
function runDashboardShutdown() {
    dashboardShutdownAction();
}
/**
 * Test hook: swap the pairing manager (e.g. for a fake-bridge manager) so
 * /api/whatsapp integration tests never open a real WhatsApp connection.
 * Routes read the module variable at request time, so this works anytime.
 */
export function setWhatsappPairingForTest(manager) {
    whatsappPairing = manager;
}
/**
 * Login brute-force throttle (the control layer's first hardening): per-IP
 * failed-attempt counter with a 1-minute window. After 10 failures the IP is
 * refused with 429 until the window rolls. A successful login clears the IP's
 * counter. In-memory — a restart resets it (acceptable for local-first).
 */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 60_000;
const loginFailures = new Map();
function loginFailureCount(ip) {
    const now = Date.now();
    const e = loginFailures.get(ip);
    if (!e || e.resetAt < now)
        return 0;
    return e.count;
}
function recordLoginFailure(ip) {
    const now = Date.now();
    const e = loginFailures.get(ip);
    if (!e || e.resetAt < now)
        loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    else
        e.count += 1;
}
function clearLoginFailures(ip) {
    loginFailures.delete(ip);
}
/** Providers the admin editor can configure: the full catalog + local/nuvira. */
const VALID_ADMIN_PROVIDERS = new Set([...CATALOG_PROVIDER_IDS, 'local', 'nuvira']);
/** Extract the Bearer token from the Authorization header, or null. */
function bearerToken(req) {
    const h = req.headers.authorization;
    if (!h)
        return null;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : null;
}
/**
 * Read a JSON request body (cap 256KB). Returns null on parse failure, empty
 * body, or size overflow — callers respond 400. Never throws.
 */
function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 262144) {
                resolve(null);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
                resolve(typeof parsed === 'object' && parsed !== null ? parsed : null);
            }
            catch {
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
    });
}
/** Send a JSON response (the admin routes' single writer). */
function writeJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
// ─── Request Handler ────────────────────────────────────────────────────────
function handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
    const pathname = url.pathname;
    // CORS headers (Session 18: admin write surface adds POST/PUT/DELETE +
    // the Bearer Authorization header the admin panel sends).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    // ── Agent Hub (I4) — aggregated read for the Skills/Tools/Channels/Artifacts
    // tabs. One endpoint the AgentHub panel polls; every sub-read degrades to
    // empty data, never a crash. Write toggles live under /api/admin/hub/*.
    // Defensive try/catch — readHubData is best-effort by design, but a broken
    // config/disk must surface as a 500 JSON, never a hanging request.
    if (pathname === '/api/hub') {
        try {
            writeJson(res, 200, readHubData());
        }
        catch (err) {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
    }
    // ── Admin command-runner: run ALL state commands on demand ───────────
    // The dashboard executes doctor/system/enterprise checks (one source with
    // `buff doctor` — runAllChecks) so the user never types a command. Read
    // path only: keys are NEVER exposed — the provider summary masks them.
    if (pathname === '/api/admin/checks') {
        runAdminChecks().then((payload) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        }).catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err), system: [], enterprise: [], providers: [], serverTime: Date.now() }));
        });
        return;
    }
    // ── Admin auth + write surface (Session 18 — the user's control layer) ──
    // The READ paths (checks/catalog) stay open; every WRITE (provider config,
    // API keys) is gated behind a user-id + password login. Keys NEVER leave the
    // server unmasked, and provider writes go through the SAME ConfigManager
    // save() the CLI uses — GUI and CLI stay parallel, never deprecating the CLI.
    if (pathname === '/api/admin/auth-status') {
        const configured = isAdminConfigured();
        const session = adminSessions.validate(bearerToken(req));
        writeJson(res, 200, {
            configured,
            authenticated: session !== null,
            user: session?.user ?? null,
            role: session?.role ?? null,
        });
        return;
    }
    if (pathname === '/api/admin/catalog') {
        const providers = CATALOG_PROVIDER_IDS.map((id) => {
            const entry = getCatalogProvider(id);
            return {
                id,
                label: entry?.label || id,
                icon: entry?.icon,
                envVar: entry?.envVar || null,
                keyless: entry?.keyless === true,
            };
        });
        writeJson(res, 200, { providers });
        return;
    }
    if (pathname === '/api/admin/setup' && req.method === 'POST') {
        void (async () => {
            try {
                if (isAdminConfigured()) {
                    writeJson(res, 400, { ok: false, error: 'Admin is already configured. Log in instead.' });
                    return;
                }
                const body = await readJsonBody(req);
                const user = typeof body?.user === 'string' ? body.user.trim() : '';
                const password = typeof body?.password === 'string' ? body.password : '';
                if (!user || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
                    writeJson(res, 400, { ok: false, error: `A username and a password of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters are required.` });
                    return;
                }
                // The FIRST user is always an admin (bootstrap). Later users are created
                // by an admin through POST /api/admin/users with an explicit role.
                const cred = writeAdminUser(user, password, 'admin');
                writeJson(res, 200, { ok: true, user: cred.user, role: roleForUser(cred.user), token: adminSessions.issue(cred.user, roleForUser(cred.user)) });
            }
            catch (err) {
                writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
        return;
    }
    if (pathname === '/api/admin/login' && req.method === 'POST') {
        void (async () => {
            const ip = req.socket.remoteAddress || 'local';
            if (loginFailureCount(ip) >= LOGIN_MAX_FAILURES) {
                writeJson(res, 429, { ok: false, error: 'Too many failed attempts — try again in a minute.' });
                return;
            }
            const body = await readJsonBody(req);
            const user = typeof body?.user === 'string' ? body.user.trim() : '';
            const password = typeof body?.password === 'string' ? body.password : '';
            if (verifyAdmin(user, password)) {
                clearLoginFailures(ip);
                const role = roleForUser(user);
                writeJson(res, 200, { ok: true, user, role, token: adminSessions.issue(user, role) });
            }
            else {
                recordLoginFailure(ip);
                writeJson(res, 401, { ok: false, error: 'Invalid username or password.' });
            }
        })();
        return;
    }
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
        adminSessions.revoke(bearerToken(req));
        writeJson(res, 200, { ok: true });
        return;
    }
    // ── Shutdown (dashboard / gateway) — the GUI twin of `buff dashboard stop`
    // and `buff gateway stop`. POST /api/admin/shutdown with { target }:
    //   target 'dashboard' → respond 200, then close the listeners + exit the
    //       server process (the browser sees the page disconnect — expected).
    //   target 'gateway'   → SIGTERM the running `gateway start` process (found
    //       by port 8787 or by command-line match), respond with whether it was
    //       found/stopped.
    // RBAC: dashboard → system.manage (admin); gateway → gateway.manage
    // (admin + operator — same as `buff gateway alias` / `buff gateway stop`).
    // A test hook (setDashboardShutdownForTest) swaps the exit so API tests
    // never kill the test runner.
    if (pathname === '/api/admin/shutdown' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            const body = await readJsonBody(req);
            const target = body?.target;
            if (target !== 'dashboard' && target !== 'gateway') {
                writeJson(res, 400, { ok: false, error: 'Invalid target — expected "dashboard" or "gateway".' });
                return;
            }
            const required = target === 'dashboard' ? 'system.manage' : 'gateway.manage';
            if (!roleCan(session.role, required)) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot shut down the ${target} (requires ${required === 'system.manage' ? 'admin' : 'admin or operator'}).`,
                });
                return;
            }
            if (target === 'gateway') {
                const { stopGateway } = await import('../cli/process-control.js');
                const result = await stopGateway();
                if (result.stopped) {
                    writeJson(res, 200, { ok: true, target, stopped: true, pid: result.pid });
                }
                else {
                    writeJson(res, 200, { ok: true, target, stopped: false, reason: result.reason ?? 'no running gateway found' });
                }
                return;
            }
            // Dashboard target: confirm, then stop this very server.
            writeJson(res, 200, { ok: true, target });
            runDashboardShutdown();
        })();
        return;
    }
    // ── Agent Hub toggles (I5) — admin-gated writes honored by the I1 runtime
    // gate (tool-loop schema + execution gating), so the dashboard toggle is
    // NEVER cosmetic. Same config the CLI writes (`buff tools toolsets`);
    // capability control rides on routing.operate (admin or operator).
    if (pathname.startsWith('/api/admin/hub/toolsets/') && req.method === 'PUT') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot change tool capabilities (requires admin or operator).`,
                });
                return;
            }
            // Validate the toolset name on the RAW segment — toolset ids are
            // lowercase alphanumeric + hyphen and never need URL-decoding, so the
            // allowlist here is both throw-free (no decodeURIComponent → no URIError
            // crash on '%zz' inputs) and authoritative.
            const name = pathname.slice('/api/admin/hub/toolsets/'.length);
            if (!/^[a-z0-9-]+$/.test(name)) {
                writeJson(res, 400, { ok: false, error: 'Invalid toolset name.' });
                return;
            }
            const body = await readJsonBody(req);
            if (!body || typeof body.enabled !== 'boolean') {
                writeJson(res, 400, { ok: false, error: 'Invalid JSON body — expected { enabled: boolean }.' });
                return;
            }
            try {
                setToolsetEnabled(name, body.enabled, new ConfigManager());
                writeJson(res, 200, { ok: true, toolset: name, enabled: body.enabled });
            }
            catch (err) {
                writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
        return;
    }
    // ── Agent Hub skill toggles (P3) — admin-gated writes honored by the I7
    // match gate (compiled findMatch + hub catalog), so the toggle is NEVER
    // cosmetic. Same `skills.disabled[]` config the CLI writes; capability
    // control rides on routing.operate (admin or operator).
    if (pathname.startsWith('/api/admin/hub/skills/') && req.method === 'PUT') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot change skill capabilities (requires admin or operator).`,
                });
                return;
            }
            // Validate the skill id on the RAW segment — skill ids are lowercase
            // alphanumeric + hyphen (the sandbox rule shared by installs and the
            // catalog) and never need URL-decoding, so the allowlist here is both
            // throw-free (no decodeURIComponent → no URIError crash on '%zz') and
            // authoritative. Unknown-but-well-formed ids fall through to
            // setSkillEnabled's typo-safety check (400).
            const name = pathname.slice('/api/admin/hub/skills/'.length);
            if (!/^[a-z0-9-]+$/.test(name)) {
                writeJson(res, 400, { ok: false, error: 'Invalid skill name.' });
                return;
            }
            const body = await readJsonBody(req);
            if (!body || typeof body.enabled !== 'boolean') {
                writeJson(res, 400, { ok: false, error: 'Invalid JSON body — expected { enabled: boolean }.' });
                return;
            }
            try {
                setSkillEnabled(name, body.enabled, new ConfigManager());
                writeJson(res, 200, { ok: true, skill: name, enabled: body.enabled });
            }
            catch (err) {
                writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
        return;
    }
    // ── Agent Hub channel send-test (I11) — admin-gated gateway send ────────
    // Mirrors `buff gateway send <target> <text>`: resolve the target (alias or
    // platform:channelId) through the SAME ChannelDirectory, then send through
    // the SAME GatewayRegistry + configured adapters. Rides on routing.operate
    // (admin or operator) like the toolset/skill toggles. The dashboard process
    // must have the platform env tokens set (e.g. BUFF_SMTP_HOST) — the error
    // message says so when the adapter is unconfigured.
    if (pathname === '/api/admin/hub/channels/send' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot send channel messages (requires admin or operator).`,
                });
                return;
            }
            const body = await readJsonBody(req);
            const target = typeof body?.target === 'string' ? body.target.trim() : '';
            const text = typeof body?.text === 'string' ? body.text : '';
            if (!target || target.length > 128) {
                writeJson(res, 400, { ok: false, error: 'Invalid target — expected an alias or platform:channelId (max 128 chars).' });
                return;
            }
            if (!text || text.length > 4000) {
                writeJson(res, 400, { ok: false, error: 'Invalid text — expected a non-empty message (max 4000 chars).' });
                return;
            }
            const ref = new ChannelDirectory().resolve(target);
            if (!ref) {
                writeJson(res, 400, { ok: false, error: `Unknown channel target '${target}' — use an alias or platform:channelId.` });
                return;
            }
            const { GatewayRegistry } = await import('../gateway/registry.js');
            const registry = new GatewayRegistry({ streamEvents: false });
            for (const adapter of createConfiguredAdapters())
                registry.register(adapter);
            // Bound the send — the webhook adapters use bare fetch with no internal
            // timeout, so a hung endpoint must not wedge the dashboard request.
            // The underlying fetch continues in the background (harmless; the
            // ledger/CLI paths do the same), but the route always answers.
            const ok = await Promise.race([
                registry.sendToRef(ref, text),
                new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
            ]);
            if (!ok) {
                const envVars = PLATFORM_ENV_VARS[ref.platform].join(', ');
                writeJson(res, 400, {
                    ok: false,
                    error: `Send failed — the '${ref.platform}' adapter is not configured in the dashboard process (set ${envVars} and restart) or the endpoint timed out.`,
                });
                return;
            }
            writeJson(res, 200, { ok: true, target, platform: ref.platform, channelId: ref.channelId });
        })();
        return;
    }
    // ── Gateway Permissions (validated senders) — admin-gated ────────────────
    // GET  /api/admin/gateway/policies — effective per-platform policies
    //       (env merged under config, mirroring the running gateway's gate)
    //       plus the saved verified contacts (name + contact no).
    // PUT  /api/admin/gateway/policies — replace per-platform policies (the
    //       dashboard passes the FULL map it read; the running gateway re-reads
    //       config per inbound, so changes apply without a restart). Named
    //       WhatsApp contacts are also synced into the bridge contacts file
    //       (send-by-name parity with `buff whatsapp contact add`).
    // Rides on gateway.manage (admin + operator) like the alias CLI.
    if (pathname === '/api/admin/gateway/policies') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'gateway.manage')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot manage gateway permissions (requires admin or operator).`,
                });
                return;
            }
            if (req.method === 'GET') {
                // Effective policies the running gateway would apply (env < config).
                const { envPolicies } = await import('../gateway/registry.js');
                const { readGatewayContacts } = await import('../gateway/contacts.js');
                const configManager = new ConfigManager();
                const all = configManager.getAll();
                const fromConfig = all.gateway?.policies ?? {};
                const policies = {};
                for (const p of Object.keys(PLATFORM_ENV_VARS)) {
                    policies[p] = { ...(envPolicies()[p] ?? {}), ...(fromConfig[p] ?? {}) };
                }
                writeJson(res, 200, { ok: true, policies, statusRecipients: all.gateway?.statusRecipients ?? [], contacts: readGatewayContacts() });
                return;
            }
            if (req.method === 'PUT') {
                const body = await readJsonBody(req);
                const incoming = (body?.policies ?? {});
                const configManager = new ConfigManager();
                const current = configManager.getAll().gateway?.policies ?? {};
                // Keep platforms not in the payload untouched, and merge each incoming
                // policy PER-KEY over the saved one — a draft that only touches
                // `silentDrop` must never wipe the platform's saved allowedUsers (the
                // dashboard sends its draft, which is a partial diff). Whole keys in
                // the draft (e.g. an edited allowedUsers list) still replace theirs.
                const merged = { ...current };
                for (const [platform, pol] of Object.entries(incoming)) {
                    if (!(platform in PLATFORM_ENV_VARS))
                        continue;
                    merged[platform] = { ...(merged[platform] ?? {}), ...(pol ?? {}) };
                }
                // Status recipients ride along on the same PUT (whole-array semantics).
                const gatewayPatch = { policies: merged };
                if (Array.isArray(body?.statusRecipients))
                    gatewayPatch.statusRecipients = body.statusRecipients;
                configManager.save({ gateway: gatewayPatch });
                // Verified contacts ride along too (whole-array). Names are metadata
                // for the Permissions page — the GATE still only reads allowedUsers,
                // so a bad/missing contact write can never widen access. Named
                // WhatsApp contacts are synced into the bridge contacts file for
                // send-by-name parity with `buff whatsapp contact add <Name> <no>`.
                let savedContacts;
                if (Array.isArray(body?.contacts)) {
                    const { writeGatewayContacts, syncWhatsAppContactName } = await import('../gateway/contacts.js');
                    const valid = body.contacts
                        .filter((c) => !!c && typeof c === 'object' &&
                        typeof c.name === 'string' &&
                        typeof c.platform === 'string' &&
                        typeof c.id === 'string')
                        .map((c) => ({
                        name: (c.name ?? '').trim(),
                        platform: c.platform,
                        id: (c.id ?? '').trim(),
                        addedAt: typeof c.addedAt === 'number' ? c.addedAt : Date.now(),
                    }))
                        .filter((c) => c.name && c.id && c.platform in PLATFORM_ENV_VARS);
                    savedContacts = valid;
                    writeGatewayContacts(savedContacts);
                    // Send-by-name parity: named whatsapp contacts land in the bridge
                    // contacts file (same file `buff whatsapp contact add` writes).
                    for (const c of savedContacts) {
                        if (c.platform === 'whatsapp')
                            syncWhatsAppContactName(c.name, c.id);
                    }
                }
                writeJson(res, 200, { ok: true, policies: merged, statusRecipients: gatewayPatch.statusRecipients ?? [], contacts: savedContacts });
                return;
            }
            writeJson(res, 405, { ok: false, error: 'Method not allowed — use GET or PUT.' });
        })();
        return;
    }
    // ── User management (Session 19 — RBAC on the dashboard control layer) ──
    // role.manage (admin) gates who may add/remove dashboard admin users.
    // rbac.json assignments override a credential's stored role (CLI parity),
    // so an operator/viewer logged in here can never escalate via a role
    // stored in the dashboard file.
    if (pathname === '/api/admin/users' && req.method === 'GET') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'role.manage')) {
            writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot manage users (requires admin).` });
            return;
        }
        writeJson(res, 200, { ok: true, users: listAdminUsers() });
        return;
    }
    if (pathname === '/api/admin/users' && req.method === 'POST') {
        void (async () => {
            try {
                const session = adminSessions.validate(bearerToken(req));
                if (!session) {
                    writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                    return;
                }
                if (!roleCan(session.role, 'role.manage')) {
                    writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot manage users (requires admin).` });
                    return;
                }
                const body = await readJsonBody(req);
                const name = typeof body?.user === 'string' ? body.user.trim() : '';
                const password = typeof body?.password === 'string' ? body.password : '';
                const role = typeof body?.role === 'string' && ROLES.includes(body.role) ? body.role : null;
                if (!name || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
                    writeJson(res, 400, { ok: false, error: `A username and a password of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters are required.` });
                    return;
                }
                if (!role) {
                    writeJson(res, 400, { ok: false, error: `Invalid role. Valid: ${ROLES.join(', ')}.` });
                    return;
                }
                writeAdminUser(name, password, role);
                writeJson(res, 200, { ok: true });
            }
            catch (err) {
                writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
        return;
    }
    const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
    if (userMatch && req.method === 'DELETE') {
        try {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'role.manage')) {
                writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot manage users (requires admin).` });
                return;
            }
            const target = decodeURIComponent(userMatch[1]);
            if (target === session.user) {
                writeJson(res, 400, { ok: false, error: 'You cannot remove your own user.' });
                return;
            }
            if (roleForUser(target) === 'admin' && countAdminRoleUsers() <= 1) {
                writeJson(res, 400, { ok: false, error: 'Cannot remove the last admin user.' });
                return;
            }
            const removed = removeAdminUser(target);
            writeJson(res, 200, { ok: true, removed });
        }
        catch (err) {
            writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
    }
    // ── Authed provider write routes: PUT upsert / DELETE remove / POST test ──
    const providerMatch = /^\/api\/admin\/providers\/([a-z0-9-]+)(\/test)?$/.exec(pathname);
    if (providerMatch && (req.method === 'PUT' || req.method === 'DELETE' || req.method === 'POST')) {
        void (async () => {
            const type = providerMatch[1];
            if (!VALID_ADMIN_PROVIDERS.has(type)) {
                writeJson(res, 400, { ok: false, error: `Unknown provider '${type}'.` });
                return;
            }
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            // Session 19: provider WRITES are gated by the RBAC matrix —
            // credential.write requires admin (operator/viewer are read-only here).
            if (!roleCan(session.role, 'credential.write')) {
                writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot modify provider configuration (requires admin).` });
                return;
            }
            // POST /test — reachability probe: list the provider's models with the
            // CURRENT (possibly edited-but-unsaved is NOT applied — we test what is
            // configured) credentials. Mirrors the CLI's probe path (one source).
            if (providerMatch[2] === '/test' && req.method === 'POST') {
                try {
                    const configManager = new ConfigManager();
                    const models = await probeProviderList(type, configManager);
                    writeJson(res, 200, { ok: true, models });
                }
                catch (err) {
                    writeJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
                }
                return;
            }
            const configManager = new ConfigManager();
            if (req.method === 'PUT') {
                const body = await readJsonBody(req);
                if (!body) {
                    writeJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
                    return;
                }
                const updates = {};
                if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0)
                    updates.apiKey = body.apiKey.trim();
                // Empty string EXPLICITLY CLEARS baseUrl/model (the editor lets users
                // blank a field; a save must take effect, not silently keep the old
                // value). JSON.stringify drops undefined, so the field leaves the file.
                if (typeof body.baseUrl === 'string') {
                    updates.baseUrl = body.baseUrl.trim() ? body.baseUrl.trim().replace(/\/+$/, '') : undefined;
                }
                if (typeof body.model === 'string') {
                    updates.model = body.model.trim() ? body.model.trim() : undefined;
                }
                if (typeof body.runner === 'string' && body.runner.trim().length > 0)
                    updates.runner = body.runner.trim();
                // Raw config (vault refs INTACT) — never save a resolved key back to
                // plaintext (the documented resolveVaultRefs footgun).
                const raw = configManager.getAll().providers[type] || {};
                configManager.save({ providers: { [type]: { ...raw, ...updates } } });
                // A key/model/baseURL change can invalidate the cached live model list
                // — the CLI does the same after `buff config set providers.*`.
                clearModelListCache();
                writeJson(res, 200, { ok: true, provider: summarizeProvider(type, configManager) });
                return;
            }
            // DELETE — remove the key (vault-purged by clearProviderApiKey) + the
            // credential-ish fields (apiKey/baseUrl/model). JSON.stringify drops
            // explicit undefineds, so the fields vanish from the file.
            if (req.method === 'DELETE') {
                const cleared = configManager.clearProviderApiKey(type);
                configManager.save({ providers: { [type]: { apiKey: undefined, baseUrl: undefined, model: undefined, runner: undefined } } });
                clearModelListCache();
                // An ENV-sourced key cannot be removed from the file (env re-injects on
                // every load) — surface that so the UI warns instead of hiding the row.
                writeJson(res, 200, {
                    ok: true,
                    cleared: cleared.cleared,
                    envSourced: cleared.envSourced === true,
                    envVar: cleared.envSourced ? cleared.envVar : undefined,
                    provider: summarizeProvider(type, configManager),
                });
                return;
            }
        })();
        return;
    }
    // ── Session 36: user-declared daily budget (routing.quota + cost cap) ──
    // Same config the CLI writes (`buff model quota set`) — dashboard is a
    // parallel GUI, never a fork. Reads are open (like checks/catalog); writes
    // are authed: budget fields need routing.operate, the cost cap needs
    // policy.write. Legacy single-user mode stays fully permissive (role admin).
    if (pathname === '/api/admin/quota' && req.method === 'GET') {
        const configManager = new ConfigManager();
        const all = configManager.getAll();
        writeJson(res, 200, {
            ok: true,
            quota: all.routing?.quota || {},
            costUsd: all.routing?.governance?.maxCostUsd ?? null,
            providers: [...CATALOG_PROVIDER_IDS, 'local', 'nuvira'],
        });
        return;
    }
    if (pathname === '/api/admin/quota' && req.method === 'PUT') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            const body = await readJsonBody(req);
            if (!body) {
                writeJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
                return;
            }
            if (body.quota !== undefined || body.clearProvider !== undefined) {
                if (!roleCan(session.role, 'routing.operate')) {
                    writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot modify budget limits (requires admin or operator).` });
                    return;
                }
            }
            if (body.costUsd !== undefined) {
                if (!roleCan(session.role, 'policy.write')) {
                    writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot modify the cost cap (requires admin).` });
                    return;
                }
            }
            const configManager = new ConfigManager();
            const all = configManager.getAll();
            const quota = { ...(all.routing?.quota || {}) };
            // clearProvider — remove the provider's budget entry entirely.
            if (typeof body.clearProvider === 'string' && body.clearProvider) {
                delete quota[body.clearProvider];
            }
            // quota — merge per-provider field updates; explicit null clears a field.
            if (body.quota && typeof body.quota === 'object') {
                for (const [provider, fields] of Object.entries(body.quota)) {
                    if (!fields || typeof fields !== 'object')
                        continue;
                    const cur = { ...quota[provider] };
                    for (const field of ['tokensPerWindow', 'requestsPerWindow', 'windowMs']) {
                        const v = fields[field];
                        if (v === null)
                            delete cur[field];
                        else if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
                            cur[field] = v;
                    }
                    if (Object.keys(cur).length === 0)
                        delete quota[provider];
                    else
                        quota[provider] = cur;
                }
            }
            const patch = { routing: { quota } };
            if (body.costUsd !== undefined) {
                const governance = { ...(all.routing?.governance || {}) };
                if (body.costUsd === null || body.costUsd === 0)
                    delete governance.maxCostUsd;
                else
                    governance.maxCostUsd = body.costUsd;
                patch.routing.governance = governance;
            }
            configManager.save(patch);
            writeJson(res, 200, { ok: true, quota, costUsd: configManager.getAll().routing?.governance?.maxCostUsd ?? null });
        })();
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
    // P0 reasoning traces: list (summarized) + single-trace detail. The list
    // omits prompt/response previews so the dashboard index stays small; the
    // detail endpoint returns the full steps for the replay view.
    if (pathname === '/api/traces') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readTracesData()));
        return;
    }
    if (pathname.startsWith('/api/traces/')) {
        const traceId = decodeURIComponent(pathname.slice('/api/traces/'.length));
        const trace = readTraceDetail(traceId);
        if (!trace) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Trace not found: ${traceId}` }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(trace));
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
            traces: readTracesData(),
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
        const client = { id: clientId, res };
        sseClients.push(client);
        // Real-time quota pushes only matter while someone is viewing — arm the
        // file watcher (idempotent) and disarm when the last client disconnects.
        // NOTE: arm unconditionally — the length===1 guard raced with a previous
        // client's async close (arm skipped when the stale client was still listed,
        // then disarm skipped too, leaving the watcher never armed).
        armQuotaWatcher();
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            }
            catch {
                clearInterval(heartbeat);
            }
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
            }
            catch {
                clearInterval(refreshInterval);
            }
        }, 10000);
        req.on('close', () => {
            clearInterval(heartbeat);
            clearInterval(refreshInterval);
            sseClients = sseClients.filter((c) => c.id !== clientId);
            // Only disarm when nobody is viewing AND always-on is not configured —
            // otherwise the watcher persists to keep quota state warm between sessions.
            if (sseClients.length === 0 && !alwaysWatchQuota)
                disarmQuotaWatcher();
        });
        return;
    }
    // ── P1 Task Runner API ───────────────────────────────────────────
    // The dashboard's command console: run the CLI as an isolated child process,
    // stream logs via SSE, cancel/timeout. Running commands is a write action,
    // so every endpoint requires an admin session (like the other admin routes).
    // GET /api/tasks — recent task history (newest first).
    if (pathname === '/api/tasks' && req.method === 'GET') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        writeJson(res, 200, { ok: true, tasks: taskRunner.list() });
        return;
    }
    // POST /api/tasks — start a CLI task { args: string[], timeoutMs?, cwd? }.
    if (pathname === '/api/tasks' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot run tasks (requires admin or operator).`,
                });
                return;
            }
            const body = await readJsonBody(req);
            const rawArgs = Array.isArray(body?.args) ? body.args : null;
            if (!rawArgs) {
                writeJson(res, 400, { ok: false, error: 'Missing args — expected an array of CLI args (e.g. ["eval","run","--task","smoke"]).' });
                return;
            }
            const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined;
            const cwd = typeof body?.cwd === 'string' ? body.cwd : undefined;
            const result = taskRunner.start(rawArgs.map((a) => String(a)), { timeoutMs, cwd });
            if (!result.ok || !result.task) {
                writeJson(res, 400, { ok: false, error: result.error || 'Invalid task.' });
                return;
            }
            writeJson(res, 200, { ok: true, task: result.task });
        })();
        return;
    }
    // POST /api/tasks/:id/cancel — SIGTERM a running task.
    const taskCancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(pathname);
    if (taskCancelMatch && req.method === 'POST') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'routing.operate')) {
            writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot cancel tasks.` });
            return;
        }
        const id = decodeURIComponent(taskCancelMatch[1]);
        const cancelled = taskRunner.cancel(id);
        writeJson(res, 200, { ok: cancelled, task: taskRunner.get(id) ?? null });
        return;
    }
    // GET /api/tasks/:id — full detail (logs included).
    const taskDetailMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (taskDetailMatch && req.method === 'GET') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        const id = decodeURIComponent(taskDetailMatch[1]);
        const task = taskRunner.get(id);
        if (!task) {
            writeJson(res, 404, { ok: false, error: `Task not found: ${id}` });
            return;
        }
        writeJson(res, 200, { ok: true, task });
        return;
    }
    // GET /api/tasks/:id/events — SSE stream of log + status events. EventSource
    // can't set Authorization headers, so the token is accepted via ?token= too.
    const taskEventsMatch = /^\/api\/tasks\/([^/]+)\/events$/.exec(pathname);
    if (taskEventsMatch && req.method === 'GET') {
        const token = bearerToken(req) ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
        const session = adminSessions.validate(token);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Not authenticated — log in first.' }));
            return;
        }
        const id = decodeURIComponent(taskEventsMatch[1]);
        const task = taskRunner.get(id);
        if (!task) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Task not found: ${id}` }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: init\ndata: ${JSON.stringify(task)}\n\n`);
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            }
            catch {
                clearInterval(heartbeat);
            }
        }, 30000);
        const off = taskRunner.onEvent((eventId, payload) => {
            if (eventId !== id)
                return;
            try {
                if (payload.kind === 'log' && payload.line) {
                    res.write(`event: log\ndata: ${JSON.stringify(payload.line)}\n\n`);
                }
                else if (payload.kind === 'status' && payload.status) {
                    res.write(`event: status\ndata: ${JSON.stringify(payload.status)}\n\n`);
                }
            }
            catch { /* client gone */ }
        });
        req.on('close', () => {
            clearInterval(heartbeat);
            off();
        });
        return;
    }
    // ── P2 In-page WhatsApp pairing (GUI parity with `buff whatsapp pair`) ──
    // Reads (status/events) need an admin session; writes (pair/cancel/unpair)
    // additionally need routing.operate (admin or operator) — the same gate as
    // the channel send-test and the CLI's own pairing RBAC guard. The manager
    // runs the real BaileysBridge in this process; QRs and the 8-char code
    // stream over SSE so the panel never polls.
    // GET /api/whatsapp — pairing status (state, QR data URL, code, session dir)
    // + the send-by-name contact mappings (bridge contacts file).
    if (pathname === '/api/whatsapp' && req.method === 'GET') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            const { readContactsFile } = await import('../gateway/whatsapp/contacts.js');
            const { whatsappSessionDir } = await import('../gateway/whatsapp/session.js');
            writeJson(res, 200, {
                ok: true,
                status: whatsappPairing.statusSnapshot(),
                contacts: readContactsFile(whatsappSessionDir()),
            });
        })();
        return;
    }
    // POST /api/whatsapp/pair — start pairing { phone?: string } (QR or code mode).
    if (pathname === '/api/whatsapp/pair' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot pair WhatsApp (requires admin or operator).`,
                });
                return;
            }
            const body = await readJsonBody(req);
            const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
            const result = whatsappPairing.start({ phone: phone || undefined });
            if (!result.ok) {
                writeJson(res, 400, { ok: false, error: result.error || 'Could not start pairing.' });
                return;
            }
            writeJson(res, 200, { ok: true, status: whatsappPairing.statusSnapshot() });
        })();
        return;
    }
    // POST /api/whatsapp/cancel — abort the active pairing.
    if (pathname === '/api/whatsapp/cancel' && req.method === 'POST') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'routing.operate')) {
            writeJson(res, 403, {
                ok: false,
                error: `Access denied — role '${session.role}' cannot cancel WhatsApp pairing (requires admin or operator).`,
            });
            return;
        }
        const result = whatsappPairing.cancel();
        if (!result.ok) {
            writeJson(res, 400, { ok: false, error: result.error || 'Nothing to cancel.' });
            return;
        }
        writeJson(res, 200, { ok: true, status: whatsappPairing.statusSnapshot() });
        return;
    }
    // POST /api/whatsapp/unpair — remove the paired session from disk.
    if (pathname === '/api/whatsapp/unpair' && req.method === 'POST') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'routing.operate')) {
            writeJson(res, 403, {
                ok: false,
                error: `Access denied — role '${session.role}' cannot unpair WhatsApp (requires admin or operator).`,
            });
            return;
        }
        const result = whatsappPairing.unpair();
        if (!result.ok) {
            writeJson(res, 400, { ok: false, error: result.error || 'Unpair failed.' });
            return;
        }
        writeJson(res, 200, { ok: true, status: whatsappPairing.statusSnapshot() });
        return;
    }
    // GET /api/whatsapp/events — SSE stream: qr (PNG data URL) / code / status.
    // EventSource can't set Authorization headers, so the token rides ?token=.
    if (pathname === '/api/whatsapp/events' && req.method === 'GET') {
        const token = bearerToken(req) ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
        const session = adminSessions.validate(token);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Not authenticated — log in first.' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: init\ndata: ${JSON.stringify({ status: whatsappPairing.statusSnapshot() })}\n\n`);
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            }
            catch {
                clearInterval(heartbeat);
            }
        }, 30000);
        const off = whatsappPairing.onEvent((event) => {
            try {
                if (event.kind === 'qr') {
                    res.write(`event: qr\ndata: ${JSON.stringify({ qr: event.qr, raw: event.raw })}\n\n`);
                }
                else if (event.kind === 'code') {
                    res.write(`event: code\ndata: ${JSON.stringify({ code: event.code })}\n\n`);
                }
                else if (event.kind === 'status') {
                    res.write(`event: status\ndata: ${JSON.stringify(event.status)}\n\n`);
                }
            }
            catch { /* client gone */ }
        });
        req.on('close', () => {
            clearInterval(heartbeat);
            off();
        });
        return;
    }
    // ── Platform transport config (GUI parity with `buff config gateway`) ──
    // GET/POST/DELETE /api/config/platforms — read/write/remove a platform's
    // env tokens in ~/.buff/.env (loaded by loadEnv() at startup + applied to
    // this process on write, so the send-test picks it up immediately).
    // GET /api/config/platforms — list every configurable platform with per-var
    // status; full values only for admin/operator (viewers get redacted).
    if (pathname === '/api/config/platforms' && req.method === 'GET') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        const canWrite = roleCan(session.role, 'routing.operate');
        const platforms = configurablePlatforms().map((p) => {
            const st = platformConfigStatus(p);
            const meta = platformEnvVarMeta(p);
            return {
                platform: p,
                label: st.label,
                configured: st.configured,
                envVars: st.envVars.map((v) => {
                    const m = meta.find((x) => x.varName === v.varName);
                    return {
                        varName: v.varName,
                        set: v.set,
                        value: canWrite ? v.value : v.set ? redactValue(v.value) : '',
                        prompt: m?.prompt ?? v.varName,
                        secret: m?.secret ?? false,
                    };
                }),
            };
        });
        writeJson(res, 200, { ok: true, platforms });
        return;
    }
    const platformConfigMatch = /^\/api\/config\/platforms\/([^/]+)$/.exec(pathname);
    // POST /api/config/platforms/:platform — write the platform's env values.
    if (platformConfigMatch && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot configure platforms (requires admin or operator).`,
                });
                return;
            }
            const platform = platformConfigMatch[1];
            if (!(platform in PLATFORM_ENV_VARS) || platform === 'whatsapp' || platform === 'mock') {
                writeJson(res, 400, { ok: false, error: `Platform '${platform}' is not env-configurable.` });
                return;
            }
            const body = await readJsonBody(req);
            const values = (body?.values ?? {});
            const allowed = new Set(PLATFORM_ENV_VARS[platform]);
            const clean = {};
            for (const [key, value] of Object.entries(values)) {
                if (!allowed.has(key)) {
                    writeJson(res, 400, { ok: false, error: `Unknown env var '${key}' for ${platform}.` });
                    return;
                }
                if (typeof value === 'string')
                    clean[key] = value.trim();
            }
            if (Object.keys(clean).length === 0) {
                writeJson(res, 400, { ok: false, error: 'Provide at least one value.' });
                return;
            }
            const { wrote } = writeEnvFile(clean);
            applyEnvToProcess(clean);
            writeJson(res, 200, { ok: true, wrote, status: platformConfigStatus(platform) });
        })();
        return;
    }
    // DELETE /api/config/platforms/:platform — remove the platform's env values.
    if (platformConfigMatch && req.method === 'DELETE') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'routing.operate')) {
            writeJson(res, 403, {
                ok: false,
                error: `Access denied — role '${session.role}' cannot configure platforms (requires admin or operator).`,
            });
            return;
        }
        const platform = platformConfigMatch[1];
        if (!(platform in PLATFORM_ENV_VARS) || platform === 'whatsapp' || platform === 'mock') {
            writeJson(res, 400, { ok: false, error: `Platform '${platform}' is not env-configurable.` });
            return;
        }
        const keys = PLATFORM_ENV_VARS[platform];
        writeEnvFile({}, keys);
        applyEnvToProcess({}, keys);
        writeJson(res, 200, { ok: true, removed: keys, status: platformConfigStatus(platform) });
        return;
    }
    // ── P3 Chat console (GUI parity with `buff chat "<prompt>"`) ──────────
    // One tool-loop turn per message, history threaded per session. Running the
    // agent executes tools, so it rides the same admin + routing.operate gate
    // as the task runner. The engine runs in-process (ChatCommand), so provider
    // API keys must be configured in the dashboard process — the 400 tells the
    // user exactly that when the turn fails.
    // GET /api/projects — P3 project picker: the dashboard's own cwd + every
    // path attached this session, validated to still exist. Same auth as chat.
    if (pathname === '/api/projects' && req.method === 'GET') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'routing.operate')) {
            writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot view projects.` });
            return;
        }
        const projects = [...recentProjects]
            .map((p) => ({ path: p, name: basename(p) || p, kind: p === process.cwd() ? 'cwd' : 'recent' }))
            .filter((p) => existsSync(p.path) && statSync(p.path).isDirectory());
        writeJson(res, 200, { ok: true, projects });
        return;
    }
    // POST /api/projects/attach — validate a directory and build (or reuse) its
    // bounded context bundle. The bundle itself stays server-side; it is
    // injected into chat turns that carry this projectPath.
    if (pathname === '/api/projects/attach' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot attach projects.` });
                return;
            }
            const body = await readJsonBody(req);
            const path = typeof body?.path === 'string' ? body.path.trim() : '';
            if (!path) {
                writeJson(res, 400, { ok: false, error: 'Missing path — expected { path: string }.' });
                return;
            }
            const bundle = getProjectBundle(path);
            if (!bundle) {
                writeJson(res, 400, { ok: false, error: `Not a readable directory: ${path}` });
                return;
            }
            recentProjects.add(bundle.path);
            writeJson(res, 200, {
                ok: true,
                project: {
                    path: bundle.path,
                    name: bundle.name,
                    fileCount: bundle.fileCount,
                    symbolCount: bundle.symbolCount,
                    truncated: bundle.truncated,
                    builtAt: bundle.builtAt,
                },
            });
        })();
        return;
    }
    // GET /api/sessions — P4 session sidebar: past conversations (most recent
    // first) with title/preview/turnCount. Same auth as /api/chat (the sidebar
    // is part of the chat surface).
    if (pathname === '/api/sessions' && req.method === 'GET') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'routing.operate')) {
            writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot view chat sessions.` });
            return;
        }
        writeJson(res, 200, { ok: true, sessions: chatConsole.list() });
        return;
    }
    // GET /api/sessions/:id — P4 full transcript for resume (loads the thread).
    const sessionDetailMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (sessionDetailMatch && req.method === 'GET') {
        const session = adminSessions.validate(bearerToken(req));
        if (!session) {
            writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
            return;
        }
        if (!roleCan(session.role, 'routing.operate')) {
            writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot view chat sessions.` });
            return;
        }
        const id = decodeURIComponent(sessionDetailMatch[1]);
        const rec = chatConsole.get(id);
        if (!rec) {
            writeJson(res, 404, { ok: false, error: 'No such session.' });
            return;
        }
        writeJson(res, 200, { ok: true, session: { id, ...rec } });
        return;
    }
    // POST /api/chat/resolve — resolve a plain-English ask into the CLI
    // command(s) the intent router would run (the dashboard twin of
    // `buff intent resolve`). The Chat UI calls this BEFORE sending to the
    // agent: a confident, executable match short-circuits to a confirm card
    // (no 20s model round-trip for "stop the dashboard"), an ambiguous ask
    // shows its options as choices, and everything else falls through to the
    // normal agent chat.
    if (pathname === '/api/chat/resolve' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            const body = await readJsonBody(req);
            const message = typeof body?.message === 'string' ? body.message.trim() : '';
            if (!message) {
                writeJson(res, 400, { ok: false, error: 'Missing message — expected { message: string }.' });
                return;
            }
            const { resolveAsk } = await import('../commands/intent-router.js');
            const matches = resolveAsk(message);
            writeJson(res, 200, { ok: true, matches });
        })();
        return;
    }
    // POST /api/chat — send one message { sessionId?, message, provider?, model? }.
    if (pathname === '/api/chat' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, {
                    ok: false,
                    error: `Access denied — role '${session.role}' cannot chat with the agent (requires admin or operator).`,
                });
                return;
            }
            const body = await readJsonBody(req);
            const message = typeof body?.message === 'string' ? body.message.trim() : '';
            if (!message) {
                writeJson(res, 400, { ok: false, error: 'Missing message — expected { message: string }.' });
                return;
            }
            const sessionId = typeof body?.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 64
                ? body.sessionId
                : newChatSessionId();
            const provider = typeof body?.provider === 'string' ? body.provider : undefined;
            const model = typeof body?.model === 'string' ? body.model : undefined;
            // P3 — an attached project's bounded snapshot rides into the turn as
            // `[Project context]`, so "assess THIS project" works without the user
            // describing the codebase. Cache misses rebuild automatically.
            let projectContext;
            let projectPath;
            if (typeof body?.projectPath === 'string' && body.projectPath.trim()) {
                projectPath = body.projectPath.trim();
                const bundle = getProjectBundle(projectPath);
                if (bundle)
                    projectContext = formatProjectText(bundle);
            }
            const result = await chatConsole.answer(sessionId, message, { provider, model, projectContext, projectPath });
            if (!result.ok) {
                writeJson(res, 400, {
                    ok: false,
                    error: result.error || 'The agent could not answer — check that a provider API key is configured in the dashboard process.',
                });
                return;
            }
            writeJson(res, 200, {
                ok: true,
                sessionId,
                content: result.content ?? '',
                followups: result.followups ?? [],
                provider: result.provider ?? null,
                model: result.model ?? null,
                generationFailed: result.generationFailed === true,
            });
        })();
        return;
    }
    // POST /api/chat/reset — forget a session's history { sessionId }.
    if (pathname === '/api/chat/reset' && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            if (!roleCan(session.role, 'routing.operate')) {
                writeJson(res, 403, { ok: false, error: `Access denied — role '${session.role}' cannot reset chat sessions.` });
                return;
            }
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
            if (sessionId)
                chatConsole.reset(sessionId);
            writeJson(res, 200, { ok: true });
        })();
        return;
    }
    // POST /api/chat/:sessionId/respond — answer a pending ask_user question
    // from the GUI (P0.1). The tool loop paused on the question; the answer
    // feeds back and the turn resumes. index -1 / [] / skip = proceed on best
    // judgment (the pre-P0.1 behavior).
    const chatRespondMatch = /^\/api\/chat\/([^/]+)\/respond$/.exec(pathname);
    if (chatRespondMatch && req.method === 'POST') {
        void (async () => {
            const session = adminSessions.validate(bearerToken(req));
            if (!session) {
                writeJson(res, 401, { ok: false, error: 'Not authenticated — log in first.' });
                return;
            }
            const sessionId = decodeURIComponent(chatRespondMatch[1]);
            const body = await readJsonBody(req);
            const questionId = typeof body?.questionId === 'string' ? body.questionId : '';
            if (!questionId) {
                writeJson(res, 400, { ok: false, error: 'Missing questionId.' });
                return;
            }
            const index = body?.index;
            const custom = typeof body?.custom === 'string' ? body.custom : undefined;
            const ok = chatConsole.respond(sessionId, questionId, {
                index: typeof index === 'number' ? index : Array.isArray(index) ? index.map(Number) : undefined,
                custom,
            });
            if (!ok) {
                writeJson(res, 404, { ok: false, error: 'No pending question with that id (it may have been answered or the session reset).' });
                return;
            }
            writeJson(res, 200, { ok: true });
        })();
        return;
    }
    // GET /api/chat/:sessionId/events — SSE stream of the session's LIVE
    // progress (agent working steps) + status while a turn is in flight. The
    // client subscribes FIRST, then POSTs the message; tool-call lines stream
    // in during the turn and the POST resolves with the final answer. EventSource
    // can't set Authorization headers, so the token rides ?token=.
    const chatEventsMatch = /^\/api\/chat\/([^/]+)\/events$/.exec(pathname);
    if (chatEventsMatch && req.method === 'GET') {
        const token = bearerToken(req) ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
        const session = adminSessions.validate(token);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Not authenticated — log in first.' }));
            return;
        }
        const sessionId = decodeURIComponent(chatEventsMatch[1]);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: init\ndata: ${JSON.stringify({ sessionId })}\n\n`);
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            }
            catch {
                clearInterval(heartbeat);
            }
        }, 30000);
        const off = chatConsole.onEvent((sid, event) => {
            if (sid !== sessionId)
                return;
            try {
                if (event.kind === 'progress') {
                    res.write(`event: progress\ndata: ${JSON.stringify({ line: event.line })}\n\n`);
                }
                else if (event.kind === 'tool') {
                    // P0.6 — structured step card: tool name + lifecycle (started →
                    // called with ok/duration/result). The GUI renders it as a card.
                    res.write(`event: tool\ndata: ${JSON.stringify({
                        id: event.id,
                        tool: event.tool,
                        phase: event.phase,
                        args: event.args,
                        ok: event.ok,
                        result: event.result,
                        error: event.error,
                        durationMs: event.durationMs,
                    })}\n\n`);
                }
                else if (event.kind === 'plan') {
                    // P0.7 — live checklist: goal + steps + revision (updates in place).
                    res.write(`event: plan\ndata: ${JSON.stringify({
                        goal: event.goal,
                        steps: event.steps,
                        revision: event.revision,
                    })}\n\n`);
                }
                else if (event.kind === 'diff') {
                    // P3b — git diff card: per-file bodies + summary.
                    res.write(`event: diff\ndata: ${JSON.stringify({
                        files: event.files,
                        summary: event.summary,
                    })}\n\n`);
                }
                else if (event.kind === 'status') {
                    res.write(`event: status\ndata: ${JSON.stringify({ status: event.status })}\n\n`);
                }
                else if (event.kind === 'token') {
                    // P4 — one content token of the answer as it streams (the GUI's
                    // typewriter bubble). The POST response stays authoritative: the
                    // client renders the stream live and replaces it with the final
                    // content when the turn resolves.
                    res.write(`event: token\ndata: ${JSON.stringify({ text: event.text })}\n\n`);
                }
                else if (event.kind === 'question') {
                    res.write(`event: question\ndata: ${JSON.stringify({
                        questionId: event.questionId,
                        question: event.question,
                        choices: event.choices,
                        multiSelect: event.multiSelect,
                    })}\n\n`);
                }
            }
            catch { /* client gone */ }
        });
        req.on('close', () => {
            clearInterval(heartbeat);
            off();
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
    }
    catch {
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
function loadApiKeysFromConfig() {
    const configPath = resolveBuffConfigPath();
    if (!existsSync(configPath))
        return;
    try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        if (!config.providers)
            return;
        // Map provider config keys to their expected env var names
        const envVarMap = {
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
    }
    catch {
        // Best-effort — config file might be corrupted or unreadable
    }
}
export function createDashboardServer(opts) {
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
    if (alwaysWatchQuota)
        armQuotaWatcher();
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
    const handle = { server, port: bindPort, host: bindHost };
    activeServerHandle = handle;
    const OTHER_LOOPBACK = { '127.0.0.1': '::1', '::1': '127.0.0.1' };
    const isLoopbackHost = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
    const fmtUrl = (host, port) => host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
    const tryTwin = (host) => {
        const twin = createServer(handleRequest);
        handle.ipv6Twin = twin; // keep the live handle in sync (retry swaps it)
        twin.on('error', (err) => {
            const other = OTHER_LOOPBACK[host];
            if (err.code === 'EADDRINUSE' && other && other !== bindHost) {
                // Primary already bound this family (e.g. --host localhost → ::1) —
                // flip to the other loopback family.
                try {
                    twin.close();
                }
                catch { /* ignore */ }
                tryTwin(other);
                return;
            }
            console.log(`  ⚠️ Loopback (${host}) bind skipped: ${err.code || err.message}`);
            try {
                twin.close();
            }
            catch { /* ignore */ }
            if (handle.ipv6Twin === twin)
                handle.ipv6Twin = undefined;
        });
        twin.listen(bindPort, host, () => {
            console.log(`  Loopback twin: ${fmtUrl(host, bindPort)} (localhost race-proof)`);
        });
    };
    if (isLoopbackHost) {
        try {
            tryTwin(bindHost === '::1' ? '127.0.0.1' : '::1');
        }
        catch {
            handle.ipv6Twin = undefined;
        }
    }
    server.listen(bindPort, bindHost, () => {
        console.log(`\n  🌐 Agent-Nuvira Dashboard`);
        console.log(`  ─────────────────────────`);
        console.log(`  Local:   ${fmtUrl(bindHost, bindPort)}`);
        console.log(`  Network: http://localhost:${bindPort}`);
        if (handle.ipv6Twin)
            console.log(`  IPv6:    ${fmtUrl('::1', bindPort)} (localhost race-proof)`);
        console.log(`  Press Ctrl+C to stop\n`);
    });
    return handle;
}
// ═══════════════════════════════════════════════════════════════════════════
//  New Provider Health Checks
// ═══════════════════════════════════════════════════════════════════════════
/** Check OpenAI provider */
async function checkOpenAIProvider() {
    const apiKey = process.env.OPENAI_API_KEY;
    const result = {
        provider: 'openai', providerLabel: 'OpenAI', icon: '🤖',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'GPT-4o, GPT-4, GPT-3.5 — industry-standard API',
        freeTierInfo: 'Pay-as-you-go. Set OPENAI_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'OPENAI_API_KEY not set', status: 'unavailable', statusReason: 'Get key at platform.openai.com/api-keys' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check Anthropic provider */
async function checkAnthropicProvider() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const result = {
        provider: 'anthropic', providerLabel: 'Anthropic', icon: '🔮',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Claude 3.5 Sonnet, Claude 3 Opus — strong reasoning',
        freeTierInfo: 'Free tier: limited trial credits. Set ANTHROPIC_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'ANTHROPIC_API_KEY not set', status: 'unavailable', statusReason: 'Get key at console.anthropic.com' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check Mistral AI provider */
async function checkMistralProvider() {
    const apiKey = process.env.MISTRAL_API_KEY;
    const result = {
        provider: 'mistral', providerLabel: 'Mistral AI', icon: '🌀',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Mistral Large, Mistral Small, Codestral — efficient models',
        freeTierInfo: 'Free tier: limited API credits. Set MISTRAL_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'MISTRAL_API_KEY not set', status: 'unavailable', statusReason: 'Get key at console.mistral.ai' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.mistral.ai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check Cohere provider */
async function checkCohereProvider() {
    const apiKey = process.env.COHERE_API_KEY;
    const result = {
        provider: 'cohere', providerLabel: 'Cohere', icon: '🧠',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Command R+, Command R — enterprise-grade RAG & generation',
        freeTierInfo: 'Free tier: limited API calls. Set COHERE_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'COHERE_API_KEY not set', status: 'unavailable', statusReason: 'Get key at dashboard.cohere.com' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.cohere.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.models) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.models.map((m) => ({ id: m.id, name: m.name || m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check Together AI provider */
async function checkTogetherProvider() {
    const apiKey = process.env.TOGETHER_API_KEY;
    const result = {
        provider: 'together', providerLabel: 'Together AI', icon: '🟢',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Open-source model hosting — Llama, Mistral, Mixtral & more',
        freeTierInfo: 'Free tier: $25 trial credits. Set TOGETHER_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'TOGETHER_API_KEY not set', status: 'unavailable', statusReason: 'Get key at api.together.xyz' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.together.ai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check DeepInfra provider */
async function checkDeepInfraProvider() {
    const apiKey = process.env.DEEPINFRA_TOKEN;
    const result = {
        provider: 'deepinfra', providerLabel: 'DeepInfra', icon: '🌐',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Serverless GPU inference — Llama, Mixtral, SDXL & more',
        freeTierInfo: 'Pay-as-you-go. Set DEEPINFRA_TOKEN',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'DEEPINFRA_TOKEN not set', status: 'unavailable', statusReason: 'Get key at deepinfra.com' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.deepinfra.com/v1/openai/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check Fireworks AI provider */
async function checkFireworksProvider() {
    const apiKey = process.env.FIREWORKS_API_KEY;
    const result = {
        provider: 'fireworks', providerLabel: 'Fireworks AI', icon: '🎆',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Fast inference — Llama, Mixtral, DeepSeek & community models',
        freeTierInfo: 'Free tier: limited API calls. Set FIREWORKS_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'FIREWORKS_API_KEY not set', status: 'unavailable', statusReason: 'Get key at fireworks.ai' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.fireworks.ai/inference/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check Perplexity provider */
async function checkPerplexityProvider() {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    const result = {
        provider: 'perplexity', providerLabel: 'Perplexity', icon: '❓',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Sonar models — real-time web search & reasoning',
        freeTierInfo: 'Free tier: $5 trial credits. Set PERPLEXITY_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'PERPLEXITY_API_KEY not set', status: 'unavailable', statusReason: 'Get key at perplexity.ai/settings/api' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.perplexity.ai/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check Azure OpenAI provider */
async function checkAzureOpenAIProvider() {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://your-resource.openai.azure.com';
    const result = {
        provider: 'azure', providerLabel: 'Azure OpenAI', icon: '🔵',
        apiConfigured: !!apiKey && process.env.AZURE_OPENAI_ENDPOINT !== undefined,
        apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'GPT-4o, GPT-4 via Azure — enterprise deployment',
        freeTierInfo: 'Azure subscription required. Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT',
    };
    if (!apiKey || !process.env.AZURE_OPENAI_ENDPOINT) {
        result.models = [{ id: '(no config)', name: 'AZURE_OPENAI not configured', status: 'unavailable', statusReason: 'Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT' }];
        return result;
    }
    const check = await fetchWithTimeout(`${endpoint.replace(/\/+$/, '')}/openai/models?api-version=2024-10-21`, { headers: { 'api-key': apiKey } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'Endpoint unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check LM Studio (local) */
async function checkLMStudioProvider() {
    const baseUrl = process.env.LM_STUDIO_URL || 'http://localhost:1234';
    const result = {
        provider: 'lmstudio', providerLabel: 'LM Studio', icon: '🎨',
        apiConfigured: true, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Local model runner — GUI for GGUF models',
        freeTierInfo: 'Fully free — runs on your machine',
    };
    const check = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, '')}/api/v0/models`);
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        result.models = check.data.data.map((m) => ({
            id: m.id, name: m.id,
            status: 'available',
            statusReason: 'Running locally — no rate limits',
        }));
        result.overallStatus = 'available';
    }
    else {
        result.models = [{ id: '(offline)', name: 'LM Studio not running', status: 'unavailable', statusReason: `Start LM Studio at ${baseUrl}` }];
    }
    return result;
}
/** Check Anyscale provider */
async function checkAnyscaleProvider() {
    const apiKey = process.env.ANYSCALE_API_KEY;
    const result = {
        provider: 'anyscale', providerLabel: 'Anyscale', icon: '🔷',
        apiConfigured: !!apiKey, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Serverless Ray-based inference — Llama, Mistral & more',
        freeTierInfo: 'Pay-as-you-go. Set ANYSCALE_API_KEY',
    };
    if (!apiKey) {
        result.models = [{ id: '(no key)', name: 'ANYSCALE_API_KEY not set', status: 'unavailable', statusReason: 'Get key at console.anyscale.com' }];
        return result;
    }
    const check = await fetchWithTimeout('https://api.endpoints.anyscale.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        const rl = parseRateLimitHeaders(check.headers);
        result.rateLimitRemaining = rl.remaining;
        result.rateLimitTotal = rl.total;
        const si = rateLimitStatus(rl.remaining, rl.total);
        result.models = check.data.data.map((m) => ({ id: m.id, name: m.id, status: si.status, statusReason: si.reason }));
        result.overallStatus = si.status;
    }
    else {
        result.models = [{ id: '(unreachable)', name: 'API unreachable', status: 'unavailable', statusReason: `HTTP ${check.status}` }];
    }
    return result;
}
/** Check vLLM / TGI (local) */
async function checkVLLMProvider() {
    const baseUrl = process.env.VLLM_URL || 'http://localhost:8000';
    const result = {
        provider: 'vllm', providerLabel: 'vLLM / TGI', icon: '⚡',
        apiConfigured: true, apiAccessible: false, canGenerate: false,
        overallStatus: 'unavailable', models: [],
        notes: 'Self-hosted inference server — vLLM or HuggingFace TGI',
        freeTierInfo: 'Fully free — runs on your own hardware',
    };
    const check = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, '')}/v1/models`);
    if (check.ok && check.data?.data) {
        result.apiAccessible = true;
        result.canGenerate = true;
        result.models = check.data.data.map((m) => ({
            id: m.id, name: m.id,
            status: 'available',
            statusReason: 'Running locally — no rate limits',
        }));
        result.overallStatus = 'available';
    }
    else {
        result.models = [{ id: '(offline)', name: 'vLLM/TGI not running', status: 'unavailable', statusReason: `Start server at ${baseUrl}` }];
    }
    return result;
}
export const DASHBOARD_DEFAULTS = { PORT, HOST };
//# sourceMappingURL=server.js.map
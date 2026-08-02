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
import { createReadStream, readFileSync, existsSync, statSync, watch, mkdirSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadEnv } from '../utils/env.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { getRouterPromotion } from '../learning/router-promotion.js';
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
    broadcastDAG();
}
/** Reset the DAG state for a fresh execution */
export function resetDAG() {
    activePipeline = null;
    activeNodes = [];
    activeEdges = [];
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
    for (const e of entries) {
        const cost = typeof e.costUsd === 'number' ? e.costUsd : 0;
        if (e.provider)
            byProvider[e.provider] = (byProvider[e.provider] || 0) + cost;
        if (e.model)
            byModel[e.model] = (byModel[e.model] || 0) + cost;
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
    if (!data?.trajectories) {
        return { total: 0 };
    }
    const trajectories = Object.values(data.trajectories);
    const avgScore = trajectories.length > 0
        ? trajectories.reduce((s, t) => s + (t.score || 0), 0) / trajectories.length
        : 0;
    const byFingerprint = {};
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
function readQuotaData() {
    const data = readJSON(join(MEMORY_DIR, 'quota-ledger.json'));
    if (!data?.entries) {
        // Failover timeline can exist even when the ledger has no usage entries
        // (chat records failover events on auth/rate-limit failures without a
        // prior successful call) — always include events.
        return { enabled: false, entries: [], events: readQuotaEvents(), updatedAt: Date.now() };
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
    return {
        enabled: entries.length > 0,
        entries,
        freeTokens,
        freeRequests,
        paidTokens,
        paidRequests,
        estimatedSavedUsd,
        events,
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
// ─── Request Handler ────────────────────────────────────────────────────────
function handleRequest(req, res) {
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
    if (pathname === '/api/dag') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readDAGData()));
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
            evals: readEvalData(),
            memory: readMemoryData(),
            health: readHealthData(),
            routing: readRoutingInsights(),
            dag: readDAGData(),
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
                    dag: readDAGData(),
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
            if (sseClients.length === 0)
                disarmQuotaWatcher();
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
    const configPath = join(homedir(), '.buff', 'buffconfig.json');
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
export function createDashboardServer() {
    // Step 1: Load .env file values into process.env
    loadEnv();
    // Step 2: Load API keys from ~/.buff/buffconfig.json into process.env
    // This is the primary source if the user configured providers via
    // the CLI model picker or `buff config set` commands.
    loadApiKeysFromConfig();
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
    server.listen(PORT, HOST, () => {
        console.log(`\n  🌐 Agent-Nuvira Dashboard`);
        console.log(`  ─────────────────────────`);
        console.log(`  Local:   http://${HOST}:${PORT}`);
        console.log(`  Network: http://localhost:${PORT}`);
        console.log(`  Press Ctrl+C to stop\n`);
    });
    return { server, port: PORT, host: HOST };
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
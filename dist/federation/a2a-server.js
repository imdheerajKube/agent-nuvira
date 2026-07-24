/**
 * A2A Server — HTTP server implementing A2A-compatible endpoints for
 * agent discovery and task delegation.
 *
 * Runs alongside the existing federation server (separate port by default).
 * Provides:
 *   GET  /.well-known/agent-card  — AgentCard discovery
 *   GET  /a2a/agent-card          — Alternative discovery endpoint
 *   POST /a2a/task                — Task delegation
 *   GET  /a2a/task/:id            — Task status polling
 *   GET  /a2a/health              — Health check
 *
 * Uses only Node.js built-in modules (http, crypto) — no external dependencies.
 */
import { createServer } from 'node:http';
import { logger } from '../utils/logger.js';
import { ConfigManager } from '../config/manager.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { A2A_PROTOCOL_VERSION, A2A_DEFAULT_PORT, A2A_DEFAULT_HOST, A2A_TASK_TIMEOUT_MS, createDefaultAgentCard, } from './a2a-types.js';
// ─── In-Memory Task Store ───────────────────────────────────────────────────
const tasks = new Map();
const taskResults = new Map();
let taskCounter = 0;
let completedTaskCount = 0;
let failedTaskCount = 0;
const serverStartTime = Date.now();
// ─── Helpers ────────────────────────────────────────────────────────────────
function generateTaskId() {
    return `a2a-task-${Date.now()}-${++taskCounter}`;
}
function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
}
function sendError(res, statusCode, message) {
    sendJSON(res, statusCode, { error: true, message });
}
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf-8');
                resolve(body ? JSON.parse(body) : {});
            }
            catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}
function extractTaskId(path) {
    // Match /a2a/task/<id> or /a2a/task/<id>/
    const match = path.match(/^\/a2a\/task\/([^/]+)/);
    return match ? match[1] : null;
}
// ─── Route Handlers ─────────────────────────────────────────────────────────
function handleAgentCard(_req, res, agentCard) {
    sendJSON(res, 200, agentCard);
}
async function handleTaskDelegation(req, res, agentCard) {
    let body;
    try {
        body = (await parseBody(req));
    }
    catch {
        sendError(res, 400, 'Invalid JSON body');
        return;
    }
    if (!body.goal) {
        sendError(res, 400, 'Missing required field: goal');
        return;
    }
    if (!body.skillId && !body.agentType) {
        sendError(res, 400, 'Missing required field: skillId or agentType');
        return;
    }
    // Validate skillId if provided
    if (body.skillId) {
        const skill = agentCard.skills.find((s) => s.id === body.skillId);
        if (!skill) {
            sendError(res, 400, `Unknown skill: ${body.skillId}`);
            return;
        }
    }
    const taskId = generateTaskId();
    const task = {
        id: taskId,
        status: 'pending',
        goal: body.goal,
        skillId: body.skillId,
        agentType: body.agentType,
        parameters: body.parameters,
        provider: body.provider,
        model: body.model,
        createdAt: Date.now(),
    };
    tasks.set(taskId, task);
    // Return immediately with task ID
    const response = {
        taskId,
        status: 'running',
        message: `Task accepted. Poll ${agentCard.endpoints.taskStatus}/${taskId} for status.`,
        statusEndpoint: `${agentCard.endpoints.taskStatus || '/a2a/task'}/${taskId}`,
    };
    sendJSON(res, 202, response);
    // Execute task asynchronously
    executeTask(task, agentCard).catch((err) => {
        logger.error(`A2A task ${taskId} execution error: ${err}`);
    });
}
async function executeTask(task, _agentCard) {
    task.status = 'running';
    task.startedAt = Date.now();
    logger.info(`A2A: Executing task ${task.id} (${task.skillId || task.agentType}: ${task.goal.slice(0, 80)})`);
    try {
        const configManager = new ConfigManager();
        const orchestrator = new Orchestrator(configManager);
        // Enforce timeout on task execution
        const timeoutMs = A2A_TASK_TIMEOUT_MS;
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`A2A task timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        const result = await Promise.race([
            orchestrator.execute(task.goal, {
                provider: task.provider,
                model: task.model,
                verbose: false,
            }),
            timeoutPromise,
        ]);
        const durationMs = Date.now() - (task.startedAt || task.createdAt);
        task.status = result.success ? 'completed' : 'failed';
        task.completedAt = Date.now();
        task.progress = 100;
        const taskResult = {
            taskId: task.id,
            success: result.success,
            summary: result.summary,
            details: result.fileChanges,
            error: result.error,
            durationMs,
        };
        taskResults.set(task.id, taskResult);
        if (result.success) {
            completedTaskCount++;
            logger.success(`A2A: Task ${task.id} completed successfully (${(durationMs / 1000).toFixed(1)}s)`);
        }
        else {
            failedTaskCount++;
            logger.info(`A2A: Task ${task.id} failed — ${result.summary}`);
        }
    }
    catch (err) {
        const durationMs = Date.now() - (task.startedAt || task.createdAt);
        const msg = err instanceof Error ? err.message : String(err);
        task.status = 'failed';
        task.completedAt = Date.now();
        failedTaskCount++;
        const taskResult = {
            taskId: task.id,
            success: false,
            summary: 'Task execution failed',
            error: msg,
            durationMs,
        };
        taskResults.set(task.id, taskResult);
        logger.error(`A2A: Task ${task.id} failed with error: ${msg}`);
    }
}
function handleTaskStatus(req, res) {
    const taskId = extractTaskId(req.url || '');
    if (!taskId) {
        sendError(res, 400, 'Missing task ID in URL');
        return;
    }
    const task = tasks.get(taskId);
    if (!task) {
        sendError(res, 404, `Task not found: ${taskId}`);
        return;
    }
    const result = taskResults.get(taskId);
    sendJSON(res, 200, {
        taskId: task.id,
        status: task.status,
        goal: task.goal,
        progress: task.progress,
        message: task.message,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        result: result || undefined,
    });
}
function handleHealth(_req, res) {
    const health = {
        status: 'ok',
        version: A2A_PROTOCOL_VERSION,
        uptime: Date.now() - serverStartTime,
        activeTasks: Array.from(tasks.values()).filter((t) => t.status === 'running' || t.status === 'pending').length,
        completedTasks: completedTaskCount,
        failedTasks: failedTaskCount,
    };
    sendJSON(res, 200, health);
}
// ─── Request Router ─────────────────────────────────────────────────────────
function routeRequest(req, res, agentCard) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }
    const url = req.url || '/';
    const method = req.method || 'GET';
    try {
        // Discovery endpoints
        if (method === 'GET' && (url === '/.well-known/agent-card' || url === '/a2a/agent-card')) {
            handleAgentCard(req, res, agentCard);
        }
        // Task delegation
        else if (method === 'POST' && url === '/a2a/task') {
            handleTaskDelegation(req, res, agentCard);
        }
        // Task status polling
        else if (method === 'GET' && url.startsWith('/a2a/task/')) {
            handleTaskStatus(req, res);
        }
        // Health check
        else if (method === 'GET' && url === '/a2a/health') {
            handleHealth(req, res);
        }
        else {
            sendError(res, 404, `Not found: ${method} ${url}`);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 500, msg);
        logger.error(`A2A server error: ${msg}`);
    }
}
/**
 * Create and start an A2A-compatible HTTP server.
 *
 * @param options — Server configuration
 * @returns The started HTTP server instance
 */
export function createA2AServer(options = {}) {
    const port = options.port || A2A_DEFAULT_PORT;
    const host = options.host || A2A_DEFAULT_HOST;
    const baseUrl = `http://${host}:${port}`;
    const nodeName = options.nodeName || process.env.HOSTNAME || 'agent-nuvira';
    const agentCard = options.agentCard || createDefaultAgentCard(baseUrl, nodeName);
    const server = createServer((req, res) => routeRequest(req, res, agentCard));
    return server;
}
/**
 * Start the A2A server on the configured port.
 */
export function startA2AServer(options = {}) {
    const port = options.port || A2A_DEFAULT_PORT;
    const host = options.host || A2A_DEFAULT_HOST;
    const server = createA2AServer(options);
    return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
            logger.success(`A2A server listening on ${host}:${port}`);
            logger.info(`  AgentCard: http://${host}:${port}/.well-known/agent-card`);
            logger.info(`  Task API:  http://${host}:${port}/a2a/task`);
            logger.info(`  Health:    http://${host}:${port}/a2a/health`);
            resolve(server);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${port} is already in use`));
            }
            else {
                reject(err);
            }
        });
    });
}
//# sourceMappingURL=a2a-server.js.map
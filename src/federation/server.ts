/**
 * FederationServer — HTTP server that accepts remote agent task delegations.
 *
 * Runs on a configurable port and listens for:
 * - POST /federation/handshake — Authentication and session creation
 * - POST /federation/task — Task delegation (with SSE for progress)
 * - POST /federation/cancel — Cancel a running task
 * - GET  /federation/health — Health check endpoint
 *
 * Uses only Node.js built-in modules (http, crypto) — no external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { logger } from '../utils/logger.js';
import { ConfigManager } from '../config/manager.js';
import { Orchestrator } from '../agents/orchestrator.js';
import {
  type FederationConfig,
  type FederationEnvelope,
  type HandshakeRequest,
  type HandshakeResponse,
  type TaskDelegationRequest,
  type TaskDelegationResponse,
  type TaskResult,
  type TaskProgressEvent,
  type FederationHealth,
  FEDERATION_PROTOCOL_VERSION,
  DEFAULT_FEDERATION_CONFIG,
} from './protocol.js';

// ─── Active Sessions & Tasks ────────────────────────────────────────────────

interface Session {
  token: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
}

interface RunningTask {
  taskId: string;
  sessionToken: string;
  goal: string;
  startedAt: number;
  abortController: AbortController;
}

const sessions = new Map<string, Session>();
const runningTasks = new Map<string, RunningTask>();
const sseClients = new Map<string, Set<ServerResponse>>(); // taskId → SSE clients

let taskCounter = 0;
let completedTaskCount = 0;
let failedTaskCount = 0;
const serverStartTime = Date.now();

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function generateTaskId(): string {
  return `fed-task-${Date.now()}-${++taskCounter}`;
}

function createEnvelope(type: FederationEnvelope['type'], payload: unknown): FederationEnvelope {
  return {
    version: FEDERATION_PROTOCOL_VERSION,
    type,
    payload,
    timestamp: Date.now(),
  };
}

function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJSON(res, statusCode, createEnvelope('error', { message }));
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  return parts[0].toLowerCase() === 'bearer' ? parts.slice(1).join(' ') : null;
}

function authenticateSession(token: string): Session | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function constantTimeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// ─── SSE Helpers ────────────────────────────────────────────────────────────

function sendSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function setupSSEConnection(res: ServerResponse, taskId: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Add to SSE clients for this task
  if (!sseClients.has(taskId)) {
    sseClients.set(taskId, new Set());
  }
  sseClients.get(taskId)!.add(res);

  // Send initial connected event
  sendSSE(res, 'connected', { taskId });

  // Start heartbeat
  const heartbeat = setInterval(() => {
    try {
      sendSSE(res, 'heartbeat', { timestamp: Date.now() });
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);

  // Clean up on close
  res.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(taskId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(taskId);
    }
  });
}

function broadcastTaskProgress(taskId: string, event: TaskProgressEvent): void {
  const clients = sseClients.get(taskId);
  if (!clients) return;

  for (const client of clients) {
    try {
      sendSSE(client, 'progress', event);
    } catch {
      clients.delete(client);
    }
  }
}

// ─── Task Executor ──────────────────────────────────────────────────────────

async function executeDelegatedTask(
  task: TaskDelegationRequest,
  taskId: string,
  abortController: AbortController,
): Promise<TaskResult> {
  const startTime = Date.now();
  broadcastTaskProgress(taskId, { taskId, status: 'running', progress: 0, message: 'Starting task...' });

  try {
    const configManager = new ConfigManager();
    const orchestrator = new Orchestrator(configManager);

    // Execute the task
    const result = await orchestrator.execute(task.goal, {
      provider: task.provider,
      model: task.model,
      verbose: false,
      dryRun: false,
    });

    const durationMs = Date.now() - startTime;
    broadcastTaskProgress(taskId, {
      taskId,
      status: result.success ? 'completed' : 'failed',
      progress: 100,
      message: result.summary,
    });

    return {
      taskId,
      success: result.success,
      summary: result.summary,
      details: result.fileChanges,
      error: result.error,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);

    broadcastTaskProgress(taskId, {
      taskId,
      status: 'failed',
      progress: 100,
      message: msg,
    });

    return {
      taskId,
      success: false,
      summary: 'Task execution failed',
      error: msg,
      durationMs,
    };
  }
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

async function handleHandshake(req: IncomingMessage, res: ServerResponse, config: FederationConfig): Promise<void> {
  const body = await parseBody(req) as HandshakeRequest;

  if (!body.secret || !body.clientId) {
    sendError(res, 400, 'Missing secret or clientId');
    return;
  }

  // Validate pre-shared key using constant-time comparison
  if (!constantTimeCompare(body.secret, config.secret)) {
    sendError(res, 401, 'Invalid secret key');
    return;
  }

  // Create session
  const token = generateToken();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  const session: Session = {
    token,
    clientId: body.clientId,
    createdAt: Date.now(),
    expiresAt,
  };

  sessions.set(token, session);

  logger.success(`Federation: Client '${body.clientId}' connected (capabilities: ${(body.capabilities || []).join(', ')})`);

  const response: HandshakeResponse = {
    sessionToken: token,
    serverId: config.nodeId,
    expiresAt,
    capabilities: config.capabilities,
  };

  sendJSON(res, 200, createEnvelope('response', response));
}

async function handleTaskDelegation(
  req: IncomingMessage,
  res: ServerResponse,
  _config: FederationConfig,
): Promise<void> {
  const token = getBearerToken(req);
  if (!token || !authenticateSession(token)) {
    sendError(res, 401, 'Invalid or expired session token');
    return;
  }

  const body = await parseBody(req) as TaskDelegationRequest;

  if (!body.goal || !body.agentType) {
    sendError(res, 400, 'Missing goal or agentType');
    return;
  }

  const taskId = generateTaskId();

  // Check if streaming requested
  if (body.streamProgress !== false) {
    setupSSEConnection(res, taskId);
  } else {
    // Non-streaming: return immediately with accepted status
    const response: TaskDelegationResponse = {
      taskId,
      status: 'accepted',
    };
    sendJSON(res, 202, createEnvelope('response', response));
  }

  // Execute task asynchronously
  const abortController = new AbortController();
  const runningTask: RunningTask = {
    taskId,
    sessionToken: token,
    goal: body.goal,
    startedAt: Date.now(),
    abortController,
  };
  runningTasks.set(taskId, runningTask);

  logger.info(`Federation: Executing task ${taskId} (${body.agentType}: ${body.goal.slice(0, 80)})`);

  const result = await executeDelegatedTask(body, taskId, abortController);

  runningTasks.delete(taskId);
  if (result.success) {
    completedTaskCount++;
  } else {
    failedTaskCount++;
  }

  // For non-streaming requests, send the result back via SSE if connected
  if (body.streamProgress !== false) {
    broadcastTaskProgress(taskId, {
      taskId,
      status: result.success ? 'completed' : 'failed',
      progress: 100,
      message: result.summary,
      result,
    });
  }

  logger.success(`Federation: Task ${taskId} completed (${result.success ? '✅' : '❌'})`);
}

async function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = getBearerToken(req);
  if (!token || !authenticateSession(token)) {
    sendError(res, 401, 'Invalid or expired session token');
    return;
  }

  const body = await parseBody(req) as { taskId?: string };

  if (!body.taskId) {
    sendError(res, 400, 'Missing taskId');
    return;
  }

  const runningTask = runningTasks.get(body.taskId);
  if (!runningTask) {
    sendError(res, 404, 'Task not found or already completed');
    return;
  }

  runningTask.abortController.abort();
  runningTasks.delete(body.taskId);

  broadcastTaskProgress(body.taskId, {
    taskId: body.taskId,
    status: 'failed',
    progress: 100,
    message: 'Cancelled by user',
  });

  sendJSON(res, 200, createEnvelope('response', { taskId: body.taskId, status: 'cancelled' }));
  logger.info(`Federation: Task ${body.taskId} cancelled`);
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const health: FederationHealth = {
    status: 'ok',
    uptime: Date.now() - serverStartTime,
    activeTasks: runningTasks.size,
    completedTasks: completedTaskCount,
    failedTasks: failedTaskCount,
    version: FEDERATION_PROTOCOL_VERSION,
  };

  sendJSON(res, 200, createEnvelope('response', health));
}

// ─── Request Router ─────────────────────────────────────────────────────────

function routeRequest(req: IncomingMessage, res: ServerResponse, config: FederationConfig): void {
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
    if (method === 'POST' && url === '/federation/handshake') {
      handleHandshake(req, res, config);
    } else if (method === 'POST' && url === '/federation/task') {
      handleTaskDelegation(req, res, config);
    } else if (method === 'POST' && url === '/federation/cancel') {
      handleCancel(req, res);
    } else if (method === 'GET' && url === '/federation/health') {
      handleHealth(req, res);
    } else {
      sendError(res, 404, `Not found: ${method} ${url}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, msg);
    logger.error(`Federation server error: ${msg}`);
  }
}

// ─── Server Creation ────────────────────────────────────────────────────────

/**
 * Create and start a federation server.
 *
 * @param config — Federation configuration (defaults to reading from env/config)
 * @returns The started HTTP server instance
 */
export function createFederationServer(config?: Partial<FederationConfig>): ReturnType<typeof createServer> {
  const resolvedConfig: FederationConfig = {
    ...DEFAULT_FEDERATION_CONFIG,
    ...config,
  };

  if (!resolvedConfig.secret) {
    // Try to read from env or config
    resolvedConfig.secret = process.env.FEDERATION_SECRET || '';
  }

  if (!resolvedConfig.secret) {
    throw new Error(
      'Federation secret not configured. Set FEDERATION_SECRET env var ' +
      'or pass it via FederationConfig.secret.',
    );
  }

  const server = createServer((req, res) => routeRequest(req, res, resolvedConfig));

  return server;
}

/**
 * Start the federation server on the configured port.
 */
export function startFederationServer(config?: Partial<FederationConfig>): Promise<ReturnType<typeof createServer>> {
  const resolvedConfig = { ...DEFAULT_FEDERATION_CONFIG, ...config };
  const server = createFederationServer(resolvedConfig);

  return new Promise((resolve, reject) => {
    server.listen(resolvedConfig.port, resolvedConfig.host, () => {
      logger.success(`Federation server listening on ${resolvedConfig.host}:${resolvedConfig.port}`);
      logger.info(`  Node ID: ${resolvedConfig.nodeId}`);
      logger.info(`  Capabilities: ${resolvedConfig.capabilities.join(', ')}`);
      resolve(server);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${resolvedConfig.port} is already in use`));
      } else {
        reject(err);
      }
    });
  });
}

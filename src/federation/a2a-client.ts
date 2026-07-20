/**
 * A2A Client — Discovers remote A2A-compliant agents and delegates tasks to them.
 *
 * Provides:
 * - fetchAgentCard(url) — Discover an agent's capabilities via AgentCard
 * - discoverAgent(url) — Wrapper that fetches and validates AgentCard
 * - delegateTask(url, request) — Delegate a task to a remote A2A agent
 * - pollTaskStatus(url, taskId) — Poll for task completion
 * - checkHealth(url) — Remote A2A health check
 *
 * Uses only Node.js built-in modules (http) — no external dependencies.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { logger } from '../utils/logger.js';
import {
  type AgentCard,
  type A2ATaskRequest,
  type A2ATaskResponse,
  type A2ATaskResult,
  type A2AHealth,
  type A2ADiscoveryResult,
  A2A_TASK_TIMEOUT_MS,
} from './a2a-types.js';

// ─── HTTP Helper ────────────────────────────────────────────────────────────

/**
 * Make an HTTP/HTTPS request and parse the JSON response.
 */
function makeRequest(
  url: string,
  method: string,
  body?: unknown,
  timeoutMs: number = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Parse URL
    const isHttps = url.startsWith('https://');
    const urlObj = new URL(url);
    const mod = isHttps ? httpsRequest : httpRequest;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const bodyStr = body ? JSON.stringify(body) : undefined;
    if (bodyStr) {
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const req = mod(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(reqTimer);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON response from ${url}`));
            }
          } else {
            reject(new Error(`Request failed (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
        res.on('error', (err) => { clearTimeout(reqTimer); reject(err); });
      },
    );

    const reqTimer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', (err: Error) => {
      clearTimeout(reqTimer);
      reject(err);
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── AgentCard Discovery ────────────────────────────────────────────────────

/**
 * Fetch an AgentCard from a remote A2A-compliant server.
 * Tries /.well-known/agent-card first, then /a2a/agent-card as fallback.
 */
export async function fetchAgentCard(baseUrl: string): Promise<A2ADiscoveryResult> {
  const startTime = Date.now();

  // Strip trailing slash
  const url = baseUrl.replace(/\/+$/, '');

  // Try standard discovery endpoint first
  for (const path of ['/.well-known/agent-card', '/a2a/agent-card']) {
    try {
      const response = (await makeRequest(`${url}${path}`, 'GET')) as Record<string, unknown>;

      // Validate that it looks like an AgentCard
      if (response && typeof response === 'object' && response.name && response.capabilities) {
        const card = response as unknown as AgentCard;
        return {
          success: true,
          card,
          responseTimeMs: Date.now() - startTime,
        };
      }
    } catch {
      // Try next path
    }
  }

  return {
    success: false,
    error: `Could not fetch AgentCard from ${url}. Tried /.well-known/agent-card and /a2a/agent-card.`,
    responseTimeMs: Date.now() - startTime,
  };
}

/**
 * Discover an A2A agent by fetching and validating its AgentCard.
 */
export async function discoverAgent(baseUrl: string): Promise<A2ADiscoveryResult> {
  const result = await fetchAgentCard(baseUrl);

  if (result.success && result.card) {
    logger.success(`A2A: Discovered agent '${result.card.name}' at ${baseUrl}`);
    logger.info(`   ${result.card.capabilities.length} capabilities, ${result.card.skills.length} skills`);
  }

  return result;
}

// ─── Task Delegation ────────────────────────────────────────────────────────

/**
 * Delegate a task to a remote A2A-compliant agent.
 *
 * Returns the initial task response with taskId and status endpoint.
 * Use pollTaskStatus() to wait for completion.
 */
export async function delegateTask(
  baseUrl: string,
  request: A2ATaskRequest,
  timeoutMs: number = A2A_TASK_TIMEOUT_MS,
): Promise<A2ATaskResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/a2a/task`;
  const response = (await makeRequest(url, 'POST', request, timeoutMs)) as Record<string, unknown>;

  if (!response.taskId) {
    throw new Error(`Invalid A2A response from ${url}: missing taskId`);
  }

  return response as unknown as A2ATaskResponse;
}

/**
 * Poll for task status/result until completion or timeout.
 */
export async function pollTaskStatus(
  baseUrl: string,
  taskId: string,
  pollIntervalMs: number = 2_000,
  timeoutMs: number = A2A_TASK_TIMEOUT_MS,
): Promise<A2ATaskResult> {
  const baseUrlClean = baseUrl.replace(/\/+$/, '');
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const url = `${baseUrlClean}/a2a/task/${taskId}`;
      const response = (await makeRequest(url, 'GET')) as Record<string, unknown>;

      // Detect 404 (task not found) — no point polling further
      if (response && (response as Record<string, unknown>).error === true) {
        const msg = (response as Record<string, unknown>).message as string || `Task ${taskId} not found`;
        throw new Error(`A2A task error: ${msg}`);
      }

      const status = response.status as string;

      if (status === 'completed' || status === 'failed') {
        const result = response.result as Record<string, unknown> | undefined;
        return {
          taskId,
          success: status === 'completed',
          summary: (result?.summary as string) || (response.message as string) || '',
          details: result?.details as string | undefined,
          error: result?.error as string | undefined,
          durationMs: (result?.durationMs as number) || (Date.now() - startTime),
        };
      }

      // Show progress if available
      if (response.progress !== undefined) {
        logger.debug(`A2A: Task ${taskId} progress: ${response.progress}%`);
      }
    } catch (err) {
      // Re-throw known errors (like 404) immediately instead of retrying
      if (
        err instanceof Error &&
        (err.message.startsWith('A2A task error:') || err.message.includes('(404)'))
      ) {
        throw err;
      }
      // Network error — retry
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`A2A task ${taskId} timed out after ${timeoutMs}ms`);
}

/**
 * Delegate a task to an A2A agent and wait for the result.
 * Combines delegateTask + pollTaskStatus into a single call.
 */
export async function delegateAndWait(
  baseUrl: string,
  request: A2ATaskRequest,
  options?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (progress: number, message: string) => void;
  },
): Promise<A2ATaskResult> {
  const response = await delegateTask(baseUrl, request, options?.timeoutMs);

  if (options?.onProgress) {
    options.onProgress(0, 'Task delegated, waiting for result...');
  }

  const result = await pollTaskStatus(
    baseUrl,
    response.taskId,
    options?.pollIntervalMs || 2_000,
    options?.timeoutMs || A2A_TASK_TIMEOUT_MS,
  );

  if (options?.onProgress) {
    options.onProgress(100, result.success ? 'Task completed' : 'Task failed');
  }

  return result;
}

// ─── Health Check ───────────────────────────────────────────────────────────

/**
 * Check the health of a remote A2A server.
 */
export async function checkA2AHealth(baseUrl: string): Promise<A2AHealth> {
  const url = `${baseUrl.replace(/\/+$/, '')}/a2a/health`;
  const response = (await makeRequest(url, 'GET')) as Record<string, unknown>;

  return response as unknown as A2AHealth;
}

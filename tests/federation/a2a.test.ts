/**
 * Tests for the A2A (Agent-to-Agent) Protocol implementation.
 *
 * Covers:
 *   - Types and constants (A2A_DEFAULT_PORT, A2A_PROTOCOL_VERSION, etc.)
 *   - createDefaultAgentCard()
 *   - A2A server endpoints (via actual HTTP on random port)
 *   - A2A client functions (fetchAgentCard, delegateTask, pollTaskStatus, checkA2AHealth)
 *   - CLI A2A subcommand registration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';


import {
  A2A_PROTOCOL_VERSION,
  A2A_DEFAULT_PORT,
  A2A_DEFAULT_HOST,
  A2A_HEARTBEAT_MS,
  A2A_TASK_TIMEOUT_MS,
  createDefaultAgentCard,
  type A2ATaskRequest,
} from '../../src/federation/a2a-types.js';

import { createA2AServer } from '../../src/federation/a2a-server.js';

import {
  fetchAgentCard,
  discoverAgent,
  delegateTask,
  pollTaskStatus,
  delegateAndWait,
  checkA2AHealth,
} from '../../src/federation/a2a-client.js';

// ─── Tests: Types & Constants ───────────────────────────────────────────────

describe('A2A types and constants', () => {
  it('exports expected constants', () => {
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
    expect(A2A_DEFAULT_PORT).toBe(8375);
    expect(A2A_DEFAULT_HOST).toBe('0.0.0.0');
    expect(A2A_HEARTBEAT_MS).toBe(15_000);
    expect(A2A_TASK_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});

// ─── Tests: createDefaultAgentCard ──────────────────────────────────────────

describe('createDefaultAgentCard', () => {
  const card = createDefaultAgentCard('http://localhost:8375', 'test-node');

  it('returns a valid AgentCard with required fields', () => {
    expect(card).toBeDefined();
    expect(card.name).toBe('test-node');
    expect(card.url).toBe('http://localhost:8375');
    expect(card.version).toBe(A2A_PROTOCOL_VERSION);
    expect(card.description).toContain('Agent-Nuvira');
  });

  it('has 6 capabilities', () => {
    expect(card.capabilities).toHaveLength(6);
    expect(card.capabilities.map((c) => c.id)).toEqual([
      'code-generation',
      'code-review',
      'testing',
      'debugging',
      'refactoring',
      'planning',
    ]);
  });

  it('has 4 skills', () => {
    expect(card.skills).toHaveLength(4);
    const skillIds = card.skills.map((s) => s.id);
    expect(skillIds).toContain('execute-goal');
    expect(skillIds).toContain('quick-fix');
    expect(skillIds).toContain('review-code');
    expect(skillIds).toContain('generate-test');
  });

  it('has all endpoints defined', () => {
    expect(card.endpoints.agentCard).toBe('/.well-known/agent-card');
    expect(card.endpoints.task).toBe('/a2a/task');
    expect(card.endpoints.taskStatus).toBe('/a2a/task');
    expect(card.endpoints.health).toBe('/a2a/health');
  });

  it('has authentication schemes with none', () => {
    expect(card.authentication?.schemes).toContain('none');
  });

  it('has identity with organization', () => {
    expect(card.identity?.organization).toBe('Agent-Nuvira');
    expect(card.identity?.documentationUrl).toBeDefined();
  });
});

// ─── Tests: A2A Server (real HTTP server on random port) ───────────────────

describe('A2A server HTTP endpoints', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    // Find a free port by binding to port 0
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    server = createA2AServer({
      port,
      host: '127.0.0.1',
      nodeName: 'test-a2a-node',
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves AgentCard at /.well-known/agent-card', async () => {
    const res = await fetchJSON(`${baseUrl}/.well-known/agent-card`);
    expect(res).toBeDefined();
    expect(res.name).toBe('test-a2a-node');
    expect(res.version).toBe('1.0');
    expect(res.capabilities).toHaveLength(6);
    expect(res.skills).toHaveLength(4);
  });

  it('serves AgentCard at /a2a/agent-card', async () => {
    const res = await fetchJSON(`${baseUrl}/a2a/agent-card`);
    expect(res).toBeDefined();
    expect(res.name).toBe('test-a2a-node');
  });

  it('returns health at /a2a/health', async () => {
    const res = await fetchJSON(`${baseUrl}/a2a/health`);
    expect(res).toBeDefined();
    expect(res.status).toBe('ok');
    expect(res.version).toBe('1.0');
    expect(typeof res.uptime).toBe('number');
    expect(typeof res.activeTasks).toBe('number');
  });

  it('returns 404 for unknown endpoints', async () => {
    const statusCode = await fetchStatusCode(`${baseUrl}/a2a/nonexistent`);
    expect(statusCode).toBe(404);
  });

  it('accepts a task delegation and returns 202 with taskId', async () => {
    const body: A2ATaskRequest = {
      goal: 'Say hello to the user',
      agentType: 'writer',
    };

    const res = await fetchJSON(`${baseUrl}/a2a/task`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res).toBeDefined();
    expect(res.taskId).toBeDefined();
    expect(typeof res.taskId).toBe('string');
    expect(res.taskId).toMatch(/^a2a-task-/);
    expect(res.status).toBe('running');
    expect(res.statusEndpoint).toContain(res.taskId);
  });

  it('rejects task delegation without goal', async () => {
    const statusCode = await fetchStatusCode(`${baseUrl}/a2a/task`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(statusCode).toBe(400);
  });

  it('rejects task delegation without skillId or agentType', async () => {
    const statusCode = await fetchStatusCode(`${baseUrl}/a2a/task`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(statusCode).toBe(400);
  });

  it('rejects task delegation with unknown skillId', async () => {
    const statusCode = await fetchStatusCode(`${baseUrl}/a2a/task`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'test', skillId: 'nonexistent-skill' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(statusCode).toBe(400);
  });

  it('returns 404 for unknown task ID', async () => {
    const statusCode = await fetchStatusCode(`${baseUrl}/a2a/task/nonexistent-task`);
    expect(statusCode).toBe(404);
  });

  it('handles CORS preflight (OPTIONS)', async () => {
    const statusCode = await fetchStatusCode(`${baseUrl}/a2a/health`, {
      method: 'OPTIONS',
    });
    expect(statusCode).toBe(204);
  });
});

// ─── Tests: A2A Client ──────────────────────────────────────────────────────

describe('A2A client functions', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    server = createA2AServer({
      port,
      host: '127.0.0.1',
      nodeName: 'client-test-node',
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fetchAgentCard discovers agent capabilities', async () => {
    const result = await fetchAgentCard(baseUrl);
    expect(result.success).toBe(true);
    expect(result.responseTimeMs).toBeGreaterThan(0);
    expect(result.card).toBeDefined();
    expect(result.card!.name).toBe('client-test-node');
    expect(result.card!.capabilities).toHaveLength(6);
  });

  it('fetchAgentCard returns error for unreachable URL', async () => {
    const result = await fetchAgentCard('http://127.0.0.1:18799');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('discoverAgent wraps fetchAgentCard and logs success', async () => {
    const result = await discoverAgent(baseUrl);
    expect(result.success).toBe(true);
    expect(result.card).toBeDefined();
  });

  it('delegateTask sends a task and returns response', async () => {
    const response = await delegateTask(baseUrl, {
      goal: 'Write a unit test',
      agentType: 'writer',
    });
    expect(response.taskId).toBeDefined();
    expect(response.taskId).toMatch(/^a2a-task-/);
    expect(response.status).toBe('running');
  });


  it('pollTaskStatus returns result for completed/failed tasks', async () => {
    // First delegate a task
    const resp = await delegateTask(baseUrl, {
      goal: 'Say hello',
      agentType: 'writer',
    });

    // Poll for its status
    const result = await pollTaskStatus(baseUrl, resp.taskId, 500, 30_000);
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.summary).toBe('string');
    expect(typeof result.durationMs).toBe('number');
    expect(result.taskId).toBe(resp.taskId);
  });

  it('pollTaskStatus throws for nonexistent task', async () => {
    await expect(
      pollTaskStatus(baseUrl, 'nonexistent-task', 500, 5_000),
    ).rejects.toThrow(/not found|error/i);
  });

  it('checkA2AHealth returns server health', async () => {
    const health = await checkA2AHealth(baseUrl);
    expect(health).toBeDefined();
    expect(health.status).toBe('ok');
    expect(health.version).toBe('1.0');
    expect(typeof health.uptime).toBe('number');
    expect(typeof health.activeTasks).toBe('number');
  });

  it('delegateAndWait delegates and polls in one call', async () => {
    const result = await delegateAndWait(baseUrl, {
      goal: 'Say hello world',
      agentType: 'writer',
    });
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.durationMs).toBe('number');
    expect(result.taskId).toBeDefined();
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function fetchJSON(
  url: string,
  options?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = httpRequest(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: options?.method || 'GET',
        headers: options?.headers || {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as Record<string, unknown>);
            } catch {
              reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

function fetchStatusCode(
  url: string,
  options?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = httpRequest(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: options?.method || 'GET',
        headers: options?.headers || {},
      },
      (res) => {
        // Consume the response body to avoid hanging
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode || 500));
        res.on('error', () => resolve(res.statusCode || 500));
      },
    );
    req.on('error', reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

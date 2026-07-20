/**
 * Federation Tests — Protocol, Client, and Server.
 *
 * Tests are organized into three groups:
 *   1. Protocol — types, constants, defaults
 *   2. Client — construction, connection state, HTTP mocking, error handling
 *   3. Server — create server, handshake, task delegation, cancellation, health
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


import {
  // Constants
  DEFAULT_FEDERATION_PORT,
  DEFAULT_FEDERATION_HOST,
  FEDERATION_PROTOCOL_VERSION,
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  // Types (used structurally in tests)
  type FederationConfig,
  type HandshakeRequest,
  type HandshakeResponse,
  type TaskDelegationRequest,
  type TaskDelegationResponse,
  type TaskResult,
  type TaskProgressEvent,
  type FederationHealth,
  DEFAULT_FEDERATION_CONFIG,
} from '../../src/federation/protocol.js';

import { FederationClient } from '../../src/federation/client.js';
import { createFederationServer } from '../../src/federation/server.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Part 1: Protocol Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Federation Protocol', () => {
  describe('constants', () => {
    it('DEFAULT_FEDERATION_PORT is 8374', () => {
      expect(DEFAULT_FEDERATION_PORT).toBe(8374);
    });

    it('DEFAULT_FEDERATION_HOST is 0.0.0.0', () => {
      expect(DEFAULT_FEDERATION_HOST).toBe('0.0.0.0');
    });

    it('FEDERATION_PROTOCOL_VERSION is 1.0', () => {
      expect(FEDERATION_PROTOCOL_VERSION).toBe('1.0');
    });

    it('DEFAULT_TASK_TIMEOUT_MS is 30 minutes', () => {
      expect(DEFAULT_TASK_TIMEOUT_MS).toBe(30 * 60 * 1000);
    });

    it('DEFAULT_REQUEST_TIMEOUT_MS is 10 seconds', () => {
      expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(10_000);
    });

    it('DEFAULT_HEARTBEAT_INTERVAL_MS is 15 seconds', () => {
      expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    });
  });

  describe('DEFAULT_FEDERATION_CONFIG', () => {
    it('is disabled by default', () => {
      expect(DEFAULT_FEDERATION_CONFIG.enabled).toBe(false);
    });

    it('has empty secret', () => {
      expect(DEFAULT_FEDERATION_CONFIG.secret).toBe('');
    });

    it('binds to all interfaces on port 8374', () => {
      expect(DEFAULT_FEDERATION_CONFIG.host).toBe('0.0.0.0');
      expect(DEFAULT_FEDERATION_CONFIG.port).toBe(8374);
    });

    it('allows 4 concurrent tasks', () => {
      expect(DEFAULT_FEDERATION_CONFIG.maxConcurrentTasks).toBe(4);
    });

    it('has 30 minute task timeout', () => {
      expect(DEFAULT_FEDERATION_CONFIG.taskTimeoutMs).toBe(30 * 60 * 1000);
    });

    it('has 7 default capabilities', () => {
      expect(DEFAULT_FEDERATION_CONFIG.capabilities).toContain('planner');
      expect(DEFAULT_FEDERATION_CONFIG.capabilities).toContain('writer');
      expect(DEFAULT_FEDERATION_CONFIG.capabilities).toContain('reviewer');
      expect(DEFAULT_FEDERATION_CONFIG.capabilities).toContain('tester');
      expect(DEFAULT_FEDERATION_CONFIG.capabilities).toContain('debugger');
      expect(DEFAULT_FEDERATION_CONFIG.capabilities).toContain('runner');
      expect(DEFAULT_FEDERATION_CONFIG.capabilities).toContain('context-gatherer');
      expect(DEFAULT_FEDERATION_CONFIG.capabilities.length).toBe(7);
    });

    it('has unknown nodeId', () => {
      expect(DEFAULT_FEDERATION_CONFIG.nodeId).toBe('unknown');
    });
  });

  describe('type shapes', () => {
    it('HandshakeRequest has correct shape', () => {
      const req: HandshakeRequest = { secret: 'key', clientId: 'client1', capabilities: ['writer'] };
      expect(req.secret).toBe('key');
      expect(req.clientId).toBe('client1');
      expect(req.capabilities).toEqual(['writer']);
    });

    it('HandshakeResponse has correct shape', () => {
      const res: HandshakeResponse = {
        sessionToken: 'abc123',
        serverId: 'server1',
        expiresAt: Date.now() + 86400000,
        capabilities: ['planner'],
      };
      expect(res.sessionToken).toBe('abc123');
      expect(res.serverId).toBe('server1');
      expect(res.expiresAt).toBeGreaterThan(Date.now());
      expect(res.capabilities).toEqual(['planner']);
    });

    it('TaskDelegationRequest has correct shape', () => {
      const req: TaskDelegationRequest = {
        goal: 'Write tests',
        agentType: 'writer',
        provider: 'groq',
        model: 'llama-3.3-70b',
        timeoutMs: 30000,
        contextFiles: ['src/test.ts'],
        streamProgress: false,
      };
      expect(req.goal).toBe('Write tests');
      expect(req.agentType).toBe('writer');
      expect(req.streamProgress).toBe(false);
    });

    it('TaskResult supports both success and failure', () => {
      const success: TaskResult = {
        taskId: 'task-1',
        success: true,
        summary: 'Done',
        durationMs: 1500,
        outputFiles: [{ path: 'out.ts', content: 'code' }],
        costUsd: 0.001,
      };
      expect(success.success).toBe(true);
      expect(success.costUsd).toBe(0.001);

      const failure: TaskResult = {
        taskId: 'task-2',
        success: false,
        summary: 'Failed',
        error: 'Connection error',
        durationMs: 200,
      };
      expect(failure.success).toBe(false);
      expect(failure.error).toBe('Connection error');
    });

    it('TaskProgressEvent has all statuses', () => {
      const running: TaskProgressEvent = { taskId: 't1', status: 'running', progress: 50, message: 'Processing' };
      const completed: TaskProgressEvent = { taskId: 't1', status: 'completed', progress: 100 };
      const failed: TaskProgressEvent = { taskId: 't1', status: 'failed' };
      expect(running.status).toBe('running');
      expect(completed.status).toBe('completed');
      expect(failed.status).toBe('failed');
    });

    it('FederationHealth has correct shape', () => {
      const health: FederationHealth = {
        status: 'ok',
        uptime: 3600000,
        activeTasks: 2,
        completedTasks: 10,
        failedTasks: 1,
        version: '1.0',
        loadAverage: [0.5, 0.3, 0.1],
      };
      expect(health.status).toBe('ok');
      expect(health.uptime).toBe(3600000);
      expect(health.loadAverage).toHaveLength(3);
    });

    it('FederationConfig can merge with defaults', () => {
      const partial: Partial<FederationConfig> = { secret: 'my-secret', port: 9090 };
      const merged: FederationConfig = { ...DEFAULT_FEDERATION_CONFIG, ...partial };
      expect(merged.secret).toBe('my-secret');
      expect(merged.port).toBe(9090);
      expect(merged.host).toBe(DEFAULT_FEDERATION_HOST); // from defaults
      expect(merged.nodeId).toBe('unknown'); // from defaults
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Part 2: Client Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('FederationClient', () => {
  let client: FederationClient;

  beforeEach(() => {
    client = new FederationClient({ secret: 'test-secret', host: '127.0.0.1', port: 19199 });
  });

  afterEach(() => {
    client.removeAllListeners();
    client.disconnect();
  });

  describe('construction', () => {
    it('starts in disconnected state', () => {
      expect(client.isConnected()).toBe(false);
      expect(client.getStatus()).toBe('disconnected');
    });

    it('has no serverId before connection', () => {
      expect(client.getServerId()).toBeNull();
    });

    it('merges provided config with defaults', () => {
      const custom = new FederationClient({ secret: 'custom', port: 8375 });
      expect((custom as any).config.secret).toBe('custom');
      expect((custom as any).config.port).toBe(8375);
      expect((custom as any).config.host).toBe('0.0.0.0'); // from defaults
      custom.disconnect();
    });

    it('accepts empty config', () => {
      const defaultClient = new FederationClient();
      expect(defaultClient.isConnected()).toBe(false);
      defaultClient.disconnect();
    });
  });

  describe('disconnect', () => {
    it('resets session token and status', () => {
      // Simulate connected state by setting internals
      (client as any).sessionToken = 'test-token';
      (client as any).serverId = 'server-1';
      (client as any).status = 'connected';

      client.disconnect();
      expect(client.isConnected()).toBe(false);
      expect(client.getStatus()).toBe('disconnected');
      expect(client.getServerId()).toBeNull();
    });

    it('is safe to call when already disconnected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });

    it('emits disconnected event', () => {
      const spy = vi.fn();
      client.on('disconnected', spy);
      (client as any).sessionToken = 'token';
      client.disconnect();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('connect', () => {
    it('returns cached session if already connected', async () => {
      const fakeToken = 'existing-token';
      const fakeServerId = 'server-1';
      (client as any).sessionToken = fakeToken;
      (client as any).serverId = fakeServerId;
      (client as any).status = 'connected';

      const result = await client.connect();
      expect(result.sessionToken).toBe(fakeToken);
      expect(result.serverId).toBe(fakeServerId);
    });

    it('rejects with error when connection is refused', async () => {
      // Attempt connecting to localhost:9999 which should fail
      const connectingClient = new FederationClient({
        secret: 'fail-key',
        host: '127.0.0.1',
        port: 1, // privileged port — connection will be refused
      });

      await expect(connectingClient.connect()).rejects.toThrow();
      expect(connectingClient.getStatus()).toBe('error');
      connectingClient.disconnect();
    });
  });

  describe('isConnected', () => {
    it('returns true only when status is connected and token exists', () => {
      expect(client.isConnected()).toBe(false);
      (client as any).status = 'connected';
      expect(client.isConnected()).toBe(false); // no token
      (client as any).sessionToken = 'token';
      expect(client.isConnected()).toBe(true);
    });
  });

  describe('delegateTask', () => {
    it('throws when not connected', async () => {
      await expect(
        client.delegateTask('Fix bug', 'debugger'),
      ).rejects.toThrow('Not connected to federation server');
    });
  });

  describe('cancelTask', () => {
    it('throws when not connected', async () => {
      await expect(client.cancelTask('task-1')).rejects.toThrow();
    });
  });

  describe('getHealth (unauthenticated)', () => {
    it('throws when server is not running', async () => {
      const noServerClient = new FederationClient({
        host: '127.0.0.1',
        port: 1,
      });
      await expect(noServerClient.getHealth()).rejects.toThrow();
      noServerClient.disconnect();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Part 3: Server Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Federation Server', () => {
  describe('createFederationServer', () => {
    it('throws when no secret is configured', () => {
      expect(() => createFederationServer({ secret: '' })).toThrow(
        /Federation secret not configured/,
      );
    });

    it('creates server when secret is provided', () => {
      const server = createFederationServer({ secret: 'test-secret' });
      expect(server).toBeDefined();
      expect(typeof server.listen).toBe('function');
      server.close();
    });

    it('creates server with custom config', () => {
      const server = createFederationServer({
        secret: 'custom-secret',
        port: 9998,
        host: '127.0.0.1',
        nodeId: 'test-node',
      });
      expect(server).toBeDefined();
      server.close();
    });

    it('reads secret from env when not provided', () => {
      const originalEnv = process.env.FEDERATION_SECRET;
      process.env.FEDERATION_SECRET = 'env-secret';

      const server = createFederationServer();
      expect(server).toBeDefined();
      server.close();

      process.env.FEDERATION_SECRET = originalEnv;
    });
  });

  describe('handshake', () => {
    it('accepts valid credentials', async () => {
      const secret = 'valid-secret-key';
      const server = createFederationServer({ secret, port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, clientId: 'test-client', capabilities: ['writer'] }),
        });

        expect(response.status).toBe(200);
        const data = await response.json() as { type: string; payload: HandshakeResponse };
        // Envelope format
        expect(data.type).toBe('response');
        expect(data.payload.sessionToken).toBeDefined();
        expect(typeof data.payload.sessionToken).toBe('string');
        expect(data.payload.sessionToken.length).toBeGreaterThan(0);
        expect(data.payload.serverId).toBe('unknown');
        expect(data.payload.expiresAt).toBeGreaterThan(Date.now());
        expect(data.payload.capabilities).toContain('planner');
      } finally {
        server.close();
      }
    });

    it('rejects invalid secret with 401', async () => {
      const server = createFederationServer({ secret: 'real-secret', port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: 'wrong-secret', clientId: 'test-client', capabilities: [] }),
        });

        expect(response.status).toBe(401);
      } finally {
        server.close();
      }
    });

    it('rejects missing secret or clientId with 400', async () => {
      const server = createFederationServer({ secret: 's', port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const noSecret = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: 'test-client' }),
        });
        expect(noSecret.status).toBe(400);

        const noClientId = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: 's' }),
        });
        expect(noClientId.status).toBe(400);
      } finally {
        server.close();
      }
    });
  });

  describe('health endpoint', () => {
    it('returns health status without authentication', async () => {
      const server = createFederationServer({ secret: 'health-test', port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/federation/health`);
        expect(response.status).toBe(200);
        const data = await response.json() as { type: string; payload: FederationHealth };
        expect(data.type).toBe('response');
        expect(data.payload.status).toBe('ok');
        expect(data.payload.version).toBe('1.0');
        expect(typeof data.payload.uptime).toBe('number');
        expect(typeof data.payload.activeTasks).toBe('number');
        expect(typeof data.payload.completedTasks).toBe('number');
      } finally {
        server.close();
      }
    });
  });

  describe('task delegation', () => {
    it('rejects unauthenticated task with 401', async () => {
      const server = createFederationServer({ secret: 'task-test', port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/federation/task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: 'Fix bug', agentType: 'debugger' }),
        });
        expect(response.status).toBe(401);
      } finally {
        server.close();
      }
    });

    it('rejects task without goal or agentType with 400', async () => {
      const secret = 'task-secret';
      const server = createFederationServer({ secret, port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        // First authenticate
        const authRes = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, clientId: 'test-client', capabilities: ['writer'] }),
        });
        const authData = await authRes.json() as { payload: { sessionToken: string } };
        const token = authData.payload.sessionToken;

        // Then try invalid task
        const noGoal = await fetch(`http://127.0.0.1:${port}/federation/task`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ agentType: 'writer' }),
        });
        expect(noGoal.status).toBe(400);
      } finally {
        server.close();
      }
    });
  });

  describe('cancellation', () => {
    it('rejects cancellation for non-existent task', async () => {
      const secret = 'cancel-secret';
      const server = createFederationServer({ secret, port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        // Authenticate
        const authRes = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, clientId: 'test-client', capabilities: [] }),
        });
        const authData = await authRes.json() as { payload: { sessionToken: string } };
        const token = authData.payload.sessionToken;

        // Try cancelling non-existent task
        const cancelRes = await fetch(`http://127.0.0.1:${port}/federation/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ taskId: 'nonexistent-task' }),
        });
        expect(cancelRes.status).toBe(404);
      } finally {
        server.close();
      }
    });

    it('rejects cancellation without authentication', async () => {
      const server = createFederationServer({ secret: 'c', port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/federation/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: 'task-1' }),
        });
        expect(response.status).toBe(401);
      } finally {
        server.close();
      }
    });
  });

  describe('route not found', () => {
    it('returns 404 for unknown routes', async () => {
      const server = createFederationServer({ secret: 'r', port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/federation/unknown`);
        expect(response.status).toBe(404);
      } finally {
        server.close();
      }
    });
  });

  describe('CORS preflight', () => {
    it('responds to OPTIONS requests', async () => {
      const server = createFederationServer({ secret: 'cors', port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/federation/health`, {
          method: 'OPTIONS',
        });
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
      } finally {
        server.close();
      }
    });
  });

  describe('non-streaming task', () => {
    it('returns 202 accepted for non-streaming tasks', async () => {
      const secret = 'nonstream-secret';
      const server = createFederationServer({ secret, port: 0, host: '127.0.0.1' });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        // Authenticate
        const authRes = await fetch(`http://127.0.0.1:${port}/federation/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, clientId: 'test-client', capabilities: [] }),
        });
        const authData = await authRes.json() as { payload: { sessionToken: string } };
        const token = authData.payload.sessionToken;

        // Delegate task with streamProgress: false
        const taskRes = await fetch(`http://127.0.0.1:${port}/federation/task`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            goal: 'Write a test',
            agentType: 'writer',
            streamProgress: false,
            timeoutMs: 5000,
          }),
        });

        // The server returns 202 for non-streaming tasks
        expect(taskRes.status).toBe(202);
      } finally {
        server.close();
      }
    }, 10000); // 10s timeout for this test
  });
});

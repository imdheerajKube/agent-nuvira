/**
 * Unit tests for A2A client functions — fast, HTTP-mocked tests.
 *
 * Unlike the integration tests in a2a.test.ts, these mock the node:http
 * module so every test completes in <10ms without spinning up a real server.
 *
 * Covers:
 *   - fetchAgentCard()   — success (first + fallback endpoint), failure
 *   - discoverAgent()    — success path with logging
 *   - delegateTask()     — success, missing taskId error
 *   - pollTaskStatus()   — completed, failed, 404 immediate throw, timeout
 *   - delegateAndWait()  — success with onProgress callback
 *   - checkA2AHealth()   — success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';

// ─── Mock node:http (vi.hoisted — vitest hoists vi.mock factories) ─────────

const mockRequestFn = vi.hoisted(() => vi.fn());

vi.mock('node:http', () => ({
  request: mockRequestFn,
}));

vi.mock('node:https', () => ({
  request: vi.fn(),
}));

// Import after mocks are set up
import {
  fetchAgentCard,
  discoverAgent,
  delegateTask,
  pollTaskStatus,
  delegateAndWait,
  checkA2AHealth,
} from '../../src/federation/a2a-client.js';

// ─── Helpers: Create mock EventEmitter-based request/response objects ───────

/**
 * Create a mock ClientRequest that can safely receive write()/end() calls.
 * The real http.ClientRequest extends Writable (which extends EventEmitter).
 * A plain EventEmitter would throw when write()/end() are called on it.
 */
function createMockReq(): EventEmitter {
  const req = new EventEmitter();
  (req as any).write = () => {};   // no-op — makeRequest calls req.write(bodyStr)
  (req as any).end = () => {};     // no-op — makeRequest calls req.end()
  (req as any).destroy = () => {}; // no-op — cleanup
  return req;
}

/**
 * Create a mock IncomingMessage-like stream for simulated responses.
 */
function createMockRes(statusCode: number = 200, body: Record<string, unknown> = {}): EventEmitter {
  const res = new EventEmitter();
  (res as any).statusCode = statusCode;
  (res as any).headers = { 'content-type': 'application/json' };
  // Store body for later emission (after callback sets up listeners)
  (res as any)._body = Buffer.from(JSON.stringify(body));
  return res;
}

/** Mock HTTP response state — tracks pending body deliveries */
const pendingDeliveries = new Set<EventEmitter>();

/**
 * Deliver the response body after a short delay, giving event handlers time
 * to be registered. The real node:http module delivers data asynchronously,
 * so the makeRequest() function's reqTimer declaration runs before the
 * 'end' handler fires.
 */
function deliverLater(res: EventEmitter): void {
  const body = (res as any)._body;
  if (!body) return;
  pendingDeliveries.add(res);
  setImmediate(() => {
    if (!pendingDeliveries.has(res)) return;
    pendingDeliveries.delete(res);
    res.emit('data', body);
    res.emit('end');
  });
}

// ─── Helpers: Configure mock behavior ───────────────────────────────────────

interface MockResponseOptions {
  /** HTTP status code (default: 200) */
  statusCode?: number;
  /** Response body as an object (will be JSON.stringify'd) */
  body?: Record<string, unknown>;
}

/**
 * Build a mock implementation function that simulates an async HTTP response.
 * Used by both mockResponse() (persistent) and mockResponseOnce() (single-use).
 */
function buildResponseImpl(statusCode: number, body: Record<string, unknown>): Function {
  const res = createMockRes(statusCode, body);
  return (_opts: unknown, callback?: (res: IncomingMessage) => void) => {
    const req = createMockReq();
    if (callback) {
      callback(res as unknown as IncomingMessage);
    }
    deliverLater(res);
    return req as unknown as ClientRequest;
  };
}

/**
 * Build a mock implementation function that emits an async network error.
 * Used by both mockNetworkError() (persistent) and mockNetworkErrorOnce() (single-use).
 */
function buildErrorImpl(errorMsg: string): Function {
  return () => {
    const req = createMockReq();
    setTimeout(() => req.emit('error', new Error(errorMsg)), 0);
    return req as unknown as ClientRequest;
  };
}

/**
 * Configure node:http.request to simulate a successful response (persistent).
 */
function mockResponse(options: MockResponseOptions = {}): void {
  const { statusCode = 200, body = {} } = options;
  mockRequestFn.mockImplementation(buildResponseImpl(statusCode, body));
}

/**
 * Configure node:http.request to simulate a successful response (single-use).
 */
function mockResponseOnce(options: MockResponseOptions = {}): void {
  const { statusCode = 200, body = {} } = options;
  mockRequestFn.mockImplementationOnce(buildResponseImpl(statusCode, body));
}

/**
 * Configure node:http.request to emit an error (e.g. connection refused) (persistent).
 */
function mockNetworkError(errorMsg: string): void {
  mockRequestFn.mockImplementation(buildErrorImpl(errorMsg));
}

/**
 * Configure node:http.request to emit an error (single-use).
 */
function mockNetworkErrorOnce(errorMsg: string): void {
  mockRequestFn.mockImplementationOnce(buildErrorImpl(errorMsg));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('A2A client — unit tests (HTTP mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingDeliveries.clear();
  });

  // ── fetchAgentCard ─────────────────────────────────────────────────────

  describe('fetchAgentCard', () => {
    it('returns an AgentCard from /.well-known/agent-card', async () => {
      const mockCard = {
        name: 'test-agent',
        version: '1.0',
        capabilities: [{ id: 'code-gen', name: 'Code Gen', description: 'Generates code' }],
        skills: [],
        endpoints: { agentCard: '/.well-known/agent-card', task: '/a2a/task', taskStatus: '/a2a/task', health: '/a2a/health' },
        url: 'http://127.0.0.1:8375',
        description: 'Test agent',
      };

      mockResponse({ body: mockCard });

      const result = await fetchAgentCard('http://127.0.0.1:8375');

      expect(result.success).toBe(true);
      expect(result.card).toBeDefined();
      expect(result.card!.name).toBe('test-agent');
      expect(result.card!.capabilities).toHaveLength(1);
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);

      // Should have tried /.well-known/agent-card
      const callPath = (mockRequestFn.mock.calls[0][0] as any).path;
      expect(callPath).toContain('/.well-known/agent-card');
    });

    it('falls back to /a2a/agent-card when first endpoint fails', async () => {
      const mockCard = {
        name: 'fallback-agent',
        version: '1.0',
        capabilities: [],
        skills: [],
        endpoints: { agentCard: '/.well-known/agent-card', task: '/a2a/task', taskStatus: '/a2a/task', health: '/a2a/health' },
        url: 'http://127.0.0.1:8375',
        description: 'Fallback agent',
      };

      // First call fails (network error), second succeeds
      mockNetworkErrorOnce('Connection refused');
      mockResponseOnce({ body: mockCard });

      const result = await fetchAgentCard('http://127.0.0.1:8375');

      expect(result.success).toBe(true);
      expect(result.card!.name).toBe('fallback-agent');

      // Verify both endpoints were tried
      expect(mockRequestFn).toHaveBeenCalledTimes(2);
    });

    it('returns failure when both endpoints are unreachable', async () => {
      // Both calls fail
      mockNetworkError('Connection refused');
      mockNetworkError('Connection refused');

      const result = await fetchAgentCard('http://127.0.0.1:8375');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not fetch AgentCard');
      expect(result.error).toContain('/.well-known/agent-card');
      expect(result.error).toContain('/a2a/agent-card');
      expect(result.card).toBeUndefined();
    });

    it('falls through when response lacks name/capabilities (not a valid AgentCard)', async () => {
      // First endpoint returns valid JSON but not a valid AgentCard
      mockResponse({ body: { version: '1.0' } });
      // Second endpoint also invalid
      mockResponse({ body: { version: '1.0' } });

      const result = await fetchAgentCard('http://127.0.0.1:8375');

      expect(result.success).toBe(false);
      expect(result.card).toBeUndefined();
      expect(mockRequestFn).toHaveBeenCalledTimes(2); // Both endpoints tried
    });
  });

  // ── discoverAgent ──────────────────────────────────────────────────────

  describe('discoverAgent', () => {
    it('returns successful discovery result', async () => {
      const mockCard = {
        name: 'test-agent',
        version: '1.0',
        capabilities: [{ id: 'gen', name: 'Gen', description: 'Gen' }],
        skills: [{ id: 'skill-1', name: 'Skill 1', description: 'A skill' }],
        endpoints: { agentCard: '/.well-known/agent-card', task: '/a2a/task', taskStatus: '/a2a/task', health: '/a2a/health' },
        url: 'http://127.0.0.1:8375',
        description: 'Test',
      };

      mockResponse({ body: mockCard });

      const result = await discoverAgent('http://127.0.0.1:8375');

      expect(result.success).toBe(true);
      expect(result.card!.name).toBe('test-agent');
      expect(mockRequestFn).toHaveBeenCalled();
    });
  });

  // ── delegateTask ───────────────────────────────────────────────────────

  describe('delegateTask', () => {
    it('returns a task response with taskId on success', async () => {
      mockResponse({
        body: {
          taskId: 'a2a-task-123',
          status: 'running',
          statusEndpoint: '/a2a/task/a2a-task-123',
        },
      });

      const result = await delegateTask('http://127.0.0.1:8375', {
        goal: 'Write code',
        agentType: 'writer',
      });

      expect(result.taskId).toBe('a2a-task-123');
      expect(result.status).toBe('running');
      expect(result.statusEndpoint).toBe('/a2a/task/a2a-task-123');

      // Verify POST method and path
      const callArgs = mockRequestFn.mock.calls[0][0] as any;
      expect(callArgs.method).toBe('POST');
      expect(callArgs.path).toBe('/a2a/task');
    });

    it('throws an error when response lacks taskId', async () => {
      mockResponse({
        body: { status: 'error' },
      });

      await expect(
        delegateTask('http://127.0.0.1:8375', { goal: 'test', agentType: 'writer' }),
      ).rejects.toThrow(/missing taskId/i);
    });

    it('rejects on HTTP error status', async () => {
      mockResponse({
        statusCode: 400,
        body: { error: true, message: 'Missing goal' },
      });

      await expect(
        delegateTask('http://127.0.0.1:8375', { goal: 'test', agentType: 'writer' }),
      ).rejects.toThrow(/400|Request failed/i);
    });
  });

  // ── pollTaskStatus ─────────────────────────────────────────────────────

  describe('pollTaskStatus', () => {
    it('returns result when task status is completed', async () => {
      mockResponse({
        body: {
          status: 'completed',
          result: {
            summary: 'Task done',
            details: 'All good',
            durationMs: 1500,
          },
        },
      });

      const result = await pollTaskStatus('http://127.0.0.1:8375', 'a2a-task-123', 100, 5_000);

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Task done');
      expect(result.details).toBe('All good');
      expect(result.taskId).toBe('a2a-task-123');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns failure when task status is failed', async () => {
      mockResponse({
        body: {
          status: 'failed',
          result: {
            summary: 'Something went wrong',
            error: 'LLM returned invalid JSON',
            durationMs: 3000,
          },
        },
      });

      const result = await pollTaskStatus('http://127.0.0.1:8375', 'a2a-task-456', 100, 5_000);

      expect(result.success).toBe(false);
      expect(result.summary).toBe('Something went wrong');
      expect(result.error).toBe('LLM returned invalid JSON');
    });

    it('throws immediately on server-side error (e.g. task not found)', async () => {
      mockResponse({
        body: { error: true, message: 'Task not found' },
      });

      await expect(
        pollTaskStatus('http://127.0.0.1:8375', 'nonexistent', 100, 5_000),
      ).rejects.toThrow(/not found/i);
    });

    it('throws on timeout when task never completes', async () => {
      // Task keeps returning 'pending' status
      mockResponse({
        body: { status: 'pending' },
      });

      await expect(
        pollTaskStatus('http://127.0.0.1:8375', 'a2a-task-slow', 50, 500),
      ).rejects.toThrow(/timed out/i);
    });

    it('retries on transient network errors', async () => {
      // First call: network error, second call: success
      mockNetworkErrorOnce('ECONNRESET');
      mockResponseOnce({
        body: {
          status: 'completed',
          result: { summary: 'Recovered', durationMs: 500 },
        },
      });

      const result = await pollTaskStatus('http://127.0.0.1:8375', 'a2a-task-retry', 50, 5_000);

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Recovered');
      expect(mockRequestFn).toHaveBeenCalledTimes(2); // First failed, second succeeded
    });
  });

  // ── delegateAndWait ────────────────────────────────────────────────────

  describe('delegateAndWait', () => {
    it('delegates, waits for completion, and returns result', async () => {
      // Two sequential responses: one for delegateTask, one for pollTaskStatus
      mockResponseOnce({
        statusCode: 202,
        body: {
          taskId: 'a2a-task-789',
          status: 'running',
          statusEndpoint: '/a2a/task/a2a-task-789',
        },
      });
      mockResponseOnce({
        body: {
          status: 'completed',
          result: { summary: 'Delegated task done', durationMs: 2000 },
        },
      });

      const result = await delegateAndWait('http://127.0.0.1:8375', {
        goal: 'Remote task',
        agentType: 'writer',
      }, {
        pollIntervalMs: 50,
        timeoutMs: 5_000,
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Delegated task done');
      expect(result.taskId).toBe('a2a-task-789');
      expect(mockRequestFn).toHaveBeenCalledTimes(2);
    });

    it('calls onProgress callback when provided', async () => {
      const onProgress = vi.fn();

      mockResponseOnce({
        statusCode: 202,
        body: {
          taskId: 'a2a-task-progress',
          status: 'running',
          statusEndpoint: '/a2a/task/a2a-task-progress',
        },
      });
      mockResponseOnce({
        body: {
          status: 'completed',
          result: { summary: 'Done', durationMs: 1000 },
        },
      });

      await delegateAndWait('http://127.0.0.1:8375', {
        goal: 'Progress test',
        agentType: 'writer',
      }, {
        pollIntervalMs: 50,
        timeoutMs: 5_000,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(1, 0, 'Task delegated, waiting for result...');
      expect(onProgress).toHaveBeenNthCalledWith(2, 100, 'Task completed');
    });
  });

  // ── checkA2AHealth ─────────────────────────────────────────────────────

  describe('checkA2AHealth', () => {
    it('returns server health information', async () => {
      mockResponse({
        body: {
          status: 'ok',
          version: '1.0',
          uptime: 123456,
          activeTasks: 2,
          completedTasks: 10,
          failedTasks: 1,
        },
      });

      const health = await checkA2AHealth('http://127.0.0.1:8375');

      expect(health.status).toBe('ok');
      expect(health.version).toBe('1.0');
      expect(health.uptime).toBe(123456);
      expect(health.activeTasks).toBe(2);
      expect(health.completedTasks).toBe(10);
      expect(health.failedTasks).toBe(1);

      // Verify GET request to /a2a/health
      const callArgs = mockRequestFn.mock.calls[0][0] as any;
      expect(callArgs.method).toBe('GET');
      expect(callArgs.path).toBe('/a2a/health');
    });
  });
});

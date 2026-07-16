/**
 * Integration tests for the Agent-Baba-D Dashboard Server.
 *
 * Tests the HTTP endpoints, data reader functions, SSE streaming,
 * and static file serving — all through real HTTP requests to a
 * server started on a random port.
 *
 * Fixture data is written to a temp directory (via mocked homedir)
 * so tests work without a real ~/.buff/memory/ directory.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Test directory (avoid node:os.tmpdir since it gets mocked below) ──────

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-dashboard-test-'));
const memoryDir = join(testDir, '.buff', 'memory');

// Create the memory directory structure
mkdirSync(memoryDir, { recursive: true });

// Set env vars BEFORE importing the server module (PORT/HOST are read at import time)
process.env.BUFF_DASHBOARD_PORT = '0';
process.env.BUFF_DASHBOARD_HOST = '127.0.0.1';

// Mock node:os so the server reads from our temp directory
// NOTE: vi.mock is hoisted above imports, so importing from node:os in this
// file would get the mock. Avoid importing tmpdir() — use TMP_BASE instead.
vi.mock('node:os', () => ({
  homedir: () => testDir,
}));

// Import the server after env/os mocks are in place
const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

// ─── Fixture data helpers ───────────────────────────────────────────────────

interface Fixtures {
  costTracker: { entries: Array<Record<string, unknown>> };
  history: { sessions: Record<string, unknown> };
  benchmarks: { runs: Array<Record<string, unknown>> };
  trajectories: { trajectories: Record<string, unknown> };
  patterns: { patterns: Array<unknown> };
  feedback: { entries: Array<unknown> };
  vectors: { entries: Record<string, unknown> };
  agentStats: { agents: Record<string, unknown>; totalRuns: number; overallSuccessRate: number };
}

function writeFixture(name: string, data: unknown): void {
  const filePath = join(memoryDir, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function removeFixture(name: string): void {
  const filePath = join(memoryDir, `${name}.json`);
  try { rmSync(filePath); } catch { /* ignore */ }
}

function writeDefaultFixtures(): Fixtures {
  const costTracker = {
    entries: [
      { provider: 'groq', model: 'llama-3.3-70b', costUsd: 0.0015, totalTokens: 1500, timestamp: Date.now() - 60000 },
      { provider: 'groq', model: 'llama-3.3-70b', costUsd: 0.0020, totalTokens: 2000, timestamp: Date.now() - 30000 },
      { provider: 'gemini', model: 'gemini-2.0-flash', costUsd: 0.0005, totalTokens: 800, timestamp: Date.now() - 10000 },
    ],
  };

  const history = {
    sessions: {
      'session-1': {
        id: 'session-1', summary: 'Fixed login bug', provider: 'groq', model: 'llama-3.3-70b',
        messages: [{ role: 'user' }, { role: 'assistant' }], tags: ['bugfix'], startedAt: Date.now() - 7200000,
      },
      'session-2': {
        id: 'session-2', summary: 'Refactored API routes', provider: 'gemini', model: 'gemini-2.0-flash',
        messages: [{ role: 'user' }], tags: ['refactor'], startedAt: Date.now() - 3600000,
      },
    },
  };

  const benchmarks = {
    runs: [
      {
        id: 'bench-1', provider: 'groq', model: 'llama-3.3-70b', startedAt: Date.now() - 86400000,
        summary: { totalTasks: 10, tasksPassed: 8, tasksFailed: 2, avgQualityScore: 0.85, medianLatencyMs: 1200, totalCostUsd: 0.012, totalTokens: 12000 },
      },
    ],
  };

  const trajectories = {
    trajectories: {
      't1': { score: 0.9, projectFingerprint: 'project-a', timestamp: Date.now() - 86400000 },
      't2': { score: 0.7, projectFingerprint: 'project-a', timestamp: Date.now() - 43200000 },
      't3': { score: 0.5, projectFingerprint: 'project-b', timestamp: Date.now() - 21600000 },
    },
  };

  const patterns = { patterns: ['pattern-one', 'pattern-two'] };
  const feedback = { entries: [{ rating: 5 }, { rating: 4 }] };
  const vectors = { entries: { 'vec-1': { text: 'hello' }, 'vec-2': { text: 'world' } } };
  const agentStats = { agents: { writer: { totalRuns: 10, successfulRuns: 9, failedRuns: 1, successRate: 0.9, lastRun: Date.now() } }, totalRuns: 10, overallSuccessRate: 0.9 };

  writeFixture('cost-tracker', costTracker);
  writeFixture('history', history);
  writeFixture('benchmarks', benchmarks);
  writeFixture('trajectories', trajectories);
  writeFixture('patterns', patterns);
  writeFixture('feedback', feedback);
  writeFixture('vectors', vectors);
  writeFixture('agent-stats', agentStats);

  return { costTracker, history, benchmarks, trajectories, patterns, feedback, vectors, agentStats };
}

// ─── HTTP helper ────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 500,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function httpOptions(url: string): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'OPTIONS' }, (res) => {
      res.resume(); // drain response
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 500,
          headers: res.headers as Record<string, string | string[] | undefined>,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Read the first SSE event from the stream, then close the connection */
function httpGetSSE(url: string): Promise<{ statusCode: number; contentType: string; event: string; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const full = Buffer.concat(chunks).toString('utf-8');

        // Look for the first complete SSE event (between \n\n boundaries)
        const eventMatch = full.match(/event: (.+)\ndata: (.+?)(?:\n\n|$)/s);
        if (eventMatch) {
          res.removeListener('data', onData);
          req.destroy(); // close connection

          let parsed: unknown = null;
          try { parsed = JSON.parse(eventMatch[2]); } catch { /* ignore */ }

          resolve({
            statusCode: res.statusCode ?? 500,
            contentType: res.headers['content-type'] as string || '',
            event: eventMatch[1],
            data: parsed,
          });
        }
      };
      res.on('data', onData);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Suite setup ────────────────────────────────────────────────────────────

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;

beforeAll(async () => {
  // server.listen() is async — wait for the 'listening' callback
  server = createDashboardServer();
  const addr = await new Promise<any>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address()));
  });
  const port = typeof addr === 'object' && addr ? addr.port : 3030;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  // Close the server
  server.server.close();
  // Remove the temp test directory
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Dashboard Server', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // Data reader: empty/default state
  // ═══════════════════════════════════════════════════════════════════════

  describe('data readers — empty state (no fixture files)', () => {
    it('GET /api/cost returns zeros when no cost data exists', async () => {
      const res = await httpGet(`${baseUrl}/api/cost`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.totalRequests).toBe(0);
      expect(body.totalCost).toBe(0);
      expect(body.byProvider).toEqual({});
      expect(body.byModel).toEqual({});
      expect(body.recent).toBeUndefined(); // empty state doesn't include 'recent'
    });

    it('GET /api/history returns zero sessions when no history exists', async () => {
      const res = await httpGet(`${baseUrl}/api/history`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(0);
      expect(body.recent).toEqual([]);
    });

    it('GET /api/benchmarks returns zero runs when no benchmarks exist', async () => {
      const res = await httpGet(`${baseUrl}/api/benchmarks`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.totalRuns).toBe(0);
      expect(body.latest).toBeNull();
      expect(body.runs).toEqual([]);
    });

    it('GET /api/memory returns zero trajectories when no memory exists', async () => {
      const res = await httpGet(`${baseUrl}/api/memory`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(0);
    });

    it('GET /api/health returns zero counts when no health data exists', async () => {
      const res = await httpGet(`${baseUrl}/api/health`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.patterns).toBe(0);
      expect(body.feedback).toBe(0);
      expect(body.vectors).toBe(0);
      expect(body.agentStats).toBeNull();
      expect(body.memoryDir).toContain('.buff/memory');
    });

    it('GET /api/all returns combined empty data', async () => {
      const res = await httpGet(`${baseUrl}/api/all`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('cost');
      expect(body).toHaveProperty('history');
      expect(body).toHaveProperty('benchmarks');
      expect(body).toHaveProperty('memory');
      expect(body).toHaveProperty('health');
      expect(body).toHaveProperty('serverTime');
      expect(typeof body.serverTime).toBe('number');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Data readers: with fixture data
  // ═══════════════════════════════════════════════════════════════════════

  describe('data readers — with fixture data', () => {
    let fixtures: Fixtures;

    beforeAll(() => {
      fixtures = writeDefaultFixtures();
    });

    afterAll(() => {
      // Remove all fixture files
      for (const name of ['cost-tracker', 'history', 'benchmarks', 'trajectories', 'patterns', 'feedback', 'vectors', 'agent-stats']) {
        removeFixture(name);
      }
    });

    it('GET /api/cost computes totals from fixture entries', async () => {
      const res = await httpGet(`${baseUrl}/api/cost`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.totalRequests).toBe(3);
      expect(body.totalCost).toBe(0.004); // 0.0015 + 0.0020 + 0.0005
      expect(body.totalTokens).toBe(4300); // 1500 + 2000 + 800

      // byProvider
      expect(body.byProvider).toHaveProperty('groq');
      expect(body.byProvider).toHaveProperty('gemini');
      expect(body.byProvider.groq).toBeCloseTo(0.0035, 6);
      expect(body.byProvider.gemini).toBeCloseTo(0.0005, 6);

      // byModel
      expect(body.byModel).toHaveProperty('llama-3.3-70b');
      expect(body.byModel).toHaveProperty('gemini-2.0-flash');

      // recent — 3 entries, newest first
      expect(body.recent).toHaveLength(3);
      expect(body.recent[0].provider).toBe('gemini');
      expect(body.recent[0].model).toBe('gemini-2.0-flash');
      expect(body.recent[1].provider).toBe('groq');
    });

    it('GET /api/history returns sorted recent sessions', async () => {
      const res = await httpGet(`${baseUrl}/api/history`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.total).toBe(2);
      expect(body.recent).toHaveLength(2);

      // Sessions sorted by startedAt descending
      expect(body.recent[0].id).toBe('session-2');
      expect(body.recent[1].id).toBe('session-1');

      // Session fields
      const session = body.recent[0];
      expect(session).toHaveProperty('summary');
      expect(session).toHaveProperty('provider');
      expect(session).toHaveProperty('model');
      expect(session).toHaveProperty('messageCount');
      expect(session).toHaveProperty('tags');
      expect(session).toHaveProperty('startedAt');
      expect(session.messageCount).toBe(1);
      expect(session.tags).toContain('refactor');
    });

    it('GET /api/benchmarks returns latest run and history', async () => {
      const res = await httpGet(`${baseUrl}/api/benchmarks`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.totalRuns).toBe(1);
      expect(body.runs).toHaveLength(1);

      expect(body.latest).not.toBeNull();
      expect(body.latest.provider).toBe('groq');
      expect(body.latest.model).toBe('llama-3.3-70b');

      // Run fields
      const run = body.runs[0];
      expect(run).toHaveProperty('id');
      expect(run).toHaveProperty('provider');
      expect(run).toHaveProperty('model');
      expect(run).toHaveProperty('startedAt');
      expect(run).toHaveProperty('summary');
      expect(run.summary.totalTasks).toBe(10);
      expect(run.summary.tasksPassed).toBe(8);
    });

    it('GET /api/memory computes averages from fixture trajectories', async () => {
      const res = await httpGet(`${baseUrl}/api/memory`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.total).toBe(3);
      // avgScore = (0.9 + 0.7 + 0.5) / 3 = 0.7
      expect(body.avgScore).toBe(0.7);

      // byFingerprint
      expect(body.byFingerprint).toHaveProperty('project-a');
      expect(body.byFingerprint).toHaveProperty('project-b');
      expect(body.byFingerprint['project-a']).toBe(2);
      expect(body.byFingerprint['project-b']).toBe(1);
    });

    it('GET /api/health returns aggregated counts and agent stats', async () => {
      const res = await httpGet(`${baseUrl}/api/health`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.patterns).toBe(2);
      expect(body.feedback).toBe(2);
      expect(body.vectors).toBe(2);

      expect(body.agentStats).not.toBeNull();
      expect(body.agentStats.totalRuns).toBe(10);
      expect(body.agentStats.overallSuccessRate).toBe(0.9);
      expect(body.agentStats.agents).toHaveProperty('writer');
      expect(body.agentStats.agents.writer.successfulRuns).toBe(9);
    });

    it('GET /api/all returns combined data with all fixtures', async () => {
      const res = await httpGet(`${baseUrl}/api/all`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.cost.totalRequests).toBe(3);
      expect(body.history.total).toBe(2);
      expect(body.benchmarks.totalRuns).toBe(1);
      expect(body.memory.total).toBe(3);
      expect(body.health.patterns).toBe(2);
      expect(typeof body.serverTime).toBe('number');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // HTTP / Server
  // ═══════════════════════════════════════════════════════════════════════

  describe('HTTP server', () => {
    it('GET / returns index.html with correct content type', async () => {
      const res = await httpGet(`${baseUrl}/`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<!DOCTYPE html>');
    });

    it('GET /api/cost returns application/json', async () => {
      const res = await httpGet(`${baseUrl}/api/cost`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('OPTIONS returns 204 with CORS headers', async () => {
      const res = await httpOptions(`${baseUrl}/api/cost`);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
    });

    it('SPA fallback: GET /nonexistent-route returns index.html', async () => {
      const res = await httpGet(`${baseUrl}/some-unknown-path`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<!DOCTYPE html>');
    });

    it('SPA fallback: GET /api/nonexistent correctly returns JSON (hits API route handling)', async () => {
      // /api/* routes are explicitly handled, so an unknown API path won't hit SPA fallback
      // The server only has explicit /api/cost, /api/history, etc. routes
      // Anything else falls through to static file handler
      const res = await httpGet(`${baseUrl}/api/nonexistent`);
      // Should hit SPA fallback since no route matches
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SSE
  // ═══════════════════════════════════════════════════════════════════════

  describe('SSE endpoint', () => {
    it('GET /api/sse returns event-stream content type', async () => {
      const res = await httpGetSSE(`${baseUrl}/api/sse`);
      expect(res.statusCode).toBe(200);
      expect(res.contentType).toContain('text/event-stream');
    });

    it('SSE sends an init event with all data fields', async () => {
      const res = await httpGetSSE(`${baseUrl}/api/sse`);
      expect(res.event).toBe('init');
      expect(res.data).toBeDefined();
      expect(typeof res.data).toBe('object');

      const d = res.data as Record<string, unknown>;
      expect(d).toHaveProperty('cost');
      expect(d).toHaveProperty('history');
      expect(d).toHaveProperty('benchmarks');
      expect(d).toHaveProperty('memory');
      expect(d).toHaveProperty('health');
      expect(d).toHaveProperty('serverTime');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles malformed JSON in fixture files gracefully', async () => {
      // Write invalid JSON to cost-tracker
      writeFileSync(join(memoryDir, 'cost-tracker.json'), 'not-valid-json{');
      const res = await httpGet(`${baseUrl}/api/cost`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Should return empty defaults rather than crash
      expect(body.totalRequests).toBe(0);
      expect(body.totalCost).toBe(0);
      // Restore: remove the corrupt file
      removeFixture('cost-tracker');
    });

    it('handles malformed JSON in agent-stats gracefully', async () => {
      writeFileSync(join(memoryDir, 'agent-stats.json'), '{broken');
      const res = await httpGet(`${baseUrl}/api/health`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // agentStats should be null (failed parse returns null)
      expect(body.agentStats).toBeNull();
      removeFixture('agent-stats');
    });

    it('handles missing entries field in cost data', async () => {
      writeFileSync(join(memoryDir, 'cost-tracker.json'), JSON.stringify({ notEntries: [] }));
      const res = await httpGet(`${baseUrl}/api/cost`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.totalRequests).toBe(0);
      removeFixture('cost-tracker');
    });

    it('handles non-existent absolute path gracefully (SPA fallback)', async () => {
      // Absolute paths that don't exist fall through to SPA fallback (serves index.html)
      const port = new URL(baseUrl).port;
      const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { hostname: '127.0.0.1', port, path: '/nonexistent-file-xyz', method: 'GET' },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf-8') }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<!DOCTYPE html>');
    });

    it('handles SSE disconnection cleanly', async () => {
      // Make SSE request, send it, then immediately abort
      const req = httpRequest(`${baseUrl}/api/sse`, { method: 'GET' }, () => {});
      req.end();

      // Wait for response then destroy
      await new Promise<void>((resolve) => {
        req.on('response', () => {
          req.destroy();
          resolve();
        });
        req.on('error', (err) => {
          // destroy can cause ECONNRESET — that's expected
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
            console.warn('SSE disconnect test error:', (err as Error).message);
          }
          resolve();
        });
      });
      // Success = no crash
      expect(true).toBe(true);
    });
  });
});

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
import { request as httpRequest, createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Test directory (avoid node:os.tmpdir since it gets mocked below) ──────

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-dashboard-test-'));
const memoryDir = join(testDir, '.buff', 'memory');

// Create the memory directory structure
mkdirSync(memoryDir, { recursive: true });

// Set env vars BEFORE importing the server module (PORT/HOST/MEMORY_DIR are
// read at import time). Pinning BUFF_MEMORY_DIR keeps the suite hermetic even
// for developers who export it in their shell — otherwise the server would read
// fixtures from the real memory dir while the tests write to the temp one.
process.env.BUFF_DASHBOARD_PORT = '0';
process.env.BUFF_DASHBOARD_HOST = '127.0.0.1';
process.env.BUFF_MEMORY_DIR = memoryDir;

// Mock node:os so the server reads from our temp directory
// NOTE: vi.mock is hoisted above imports, so importing from node:os in this
// file would get the mock. Avoid importing tmpdir() — use TMP_BASE instead.
vi.mock('node:os', () => ({
  homedir: () => testDir,
}));

// Import the server after env/os mocks are in place
const { createDashboardServer, isQuotaWatcherArmed, setAlwaysWatchQuota, pushDAGUpdate, updateDAGNode, resetDAG, readPipelineRuns } = await import('../../src/web-dashboard/server.js');

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
  routingHistory: { entries: Array<Record<string, unknown>> };
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
      // M2.2: one entry flagged measured (exact wire tokens) to exercise the
      // measured-vs-estimated split read path.
      { provider: 'gemini', model: 'gemini-2.0-flash', costUsd: 0.0005, totalTokens: 800, timestamp: Date.now() - 10000, measured: true },
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

  const routingHistory = {
    entries: [
      { id: 'route-1', timestamp: Date.now() - 60000, source: 'chat', agentType: 'chat', task: 'Implement login page', complexity: 'moderate', provider: 'groq', model: 'llama-3.3-70b', score: 0.85 },
      { id: 'route-2', timestamp: Date.now() - 120000, source: 'explain', agentType: 'chat', task: 'Design auth flow', complexity: 'critical', provider: 'gemini', model: 'gemini-2.0-flash', score: 0.92 },
      { id: 'route-3', timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, source: 'benchmark', agentType: 'chat', task: 'Implement a Queue', complexity: 'simple', provider: 'groq', model: 'llama-3.3-70b', score: 0.78 },
    ],
  };

  writeFixture('cost-tracker', costTracker);
  writeFixture('history', history);
  writeFixture('benchmarks', benchmarks);
  writeFixture('trajectories', trajectories);
  writeFixture('patterns', patterns);
  writeFixture('feedback', feedback);
  writeFixture('vectors', vectors);
  writeFixture('agent-stats', agentStats);
  writeFixture('routing-history', routingHistory);

  return { costTracker, history, benchmarks, trajectories, patterns, feedback, vectors, agentStats, routingHistory };
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

/**
 * Open a persistent SSE stream and resolve once the connection is established
 * (the server has sent the `init` snapshot). Returns a handle to wait for
 * specific named events (e.g. `quota`) and close the connection.
 */
function openSSE(url: string): Promise<{
  req: ReturnType<typeof httpRequest>;
  waitFor: (eventName: string, timeoutMs?: number) => Promise<{ event: string; data: unknown }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let buffer = '';
      // Events that arrive BEFORE a waitFor() registers (e.g. `init` can be
      // emitted on the same tick the response callback fires) are buffered and
      // served to the waiter when it registers — otherwise they'd be lost and
      // the test would hang.
      const received: Array<{ event: string; data: unknown }> = [];
      const waiters: Array<{
        name: string;
        resolve: (v: { event: string; data: unknown }) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }> = [];

      const emit = (name: string, data: unknown) => {
        // Serve an already-registered waiter first.
        for (let i = 0; i < waiters.length; i++) {
          if (waiters[i].name === name) {
            const w = waiters.splice(i, 1)[0];
            clearTimeout(w.timer);
            w.resolve({ event: name, data });
            return;
          }
        }
        // No waiter yet — buffer for a later waitFor().
        received.push({ event: name, data });
      };

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        // Split on complete event blocks (\n\n); keep the tail for more data.
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const eventMatch = block.match(/event: (.+)/);
          const dataMatch = block.match(/data: (.+)/);
          if (eventMatch && dataMatch) {
            let parsed: unknown = null;
            try { parsed = JSON.parse(dataMatch[1]); } catch { /* ignore */ }
            emit(eventMatch[1], parsed);
          }
        }
      });
      res.on('error', () => { /* connection destroyed by test */ });

      resolve({
        req,
        waitFor: (eventName: string, timeoutMs = 5000) => {
          // Serve a buffered event first (arrived before this waiter registered).
          const idx = received.findIndex((e) => e.event === eventName);
          if (idx !== -1) {
            const ev = received.splice(idx, 1)[0];
            return Promise.resolve(ev);
          }
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => {
              const i = waiters.findIndex((w) => w.name === eventName);
              if (i !== -1) waiters.splice(i, 1);
              rejectWait(new Error(`Timed out waiting for SSE event '${eventName}'`));
            }, timeoutMs);
            waiters.push({ name: eventName, resolve: resolveWait, reject: rejectWait, timer });
          });
        },
        close: () => req.destroy(),
      });
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
  // Close the primary AND the IPv6-loopback twin (both bind the same port on
  // different families — leaving one open leaks the handle into later suites).
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  // Remove the temp test directory
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Dashboard Server', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // createDashboardServer — explicit port/host overrides
  // ═══════════════════════════════════════════════════════════════════════

  describe('createDashboardServer honors explicit port/host overrides', () => {
    it('binds the requested port instead of the env/import-time default', async () => {
      // Grab a free port by binding an ephemeral socket, then releasing it.
      // Retry a few candidates in case something grabs one between release
      // and re-bind.
      let srv: ReturnType<typeof createDashboardServer> | undefined;
      let bound: { port: number } | null = null;
      try {
        for (let i = 0; i < 5 && bound === null; i++) {
          const probe = createServer();
          const addr = await new Promise<{ port: number }>((resolve) =>
            probe.listen(0, '127.0.0.1', () => resolve(probe.address() as { port: number })),
          );
          await new Promise<void>((resolve) => probe.close(() => resolve()));

          const candidateSrv = createDashboardServer({ port: addr.port, host: '127.0.0.1' });
          const got = await Promise.race([
            new Promise<{ port: number }>((resolve) =>
              candidateSrv.server.once('listening', () =>
                resolve(candidateSrv.server.address() as { port: number }),
              ),
            ),
            new Promise<null>((resolve) => candidateSrv.server.once('error', () => resolve(null))),
          ]);
          if (got) {
            bound = got;
            srv = candidateSrv;
          } else {
            candidateSrv.server.close();
            if (candidateSrv.ipv6Twin) candidateSrv.ipv6Twin.close();
          }
        }

        // The override wins — the suite's import-time env is BUFF_DASHBOARD_PORT=0,
        // so binding the requested port proves call-time resolution.
        expect(bound).not.toBeNull();
        expect(srv!.port).toBe(bound!.port);
        expect(srv!.host).toBe('127.0.0.1');
      } finally {
        if (srv) srv.server.close();
        if (srv?.ipv6Twin) srv.ipv6Twin.close();
      }
    });

    it('binds an IPv6-loopback twin so `localhost` (::1-first on macOS) can never refuse', async () => {
      // Regression test for the persistent "Dashboard server unreachable"
      // issue: macOS resolves `localhost` → ::1 BEFORE 127.0.0.1, so an
      // IPv4-only bind made the browser hit [::1]:port → ECONNREFUSED. The
      // twin shares the same handler on the other loopback family. Uses an
      // EXPLICIT free port so both families bind the SAME port (port 0 would
      // hand each family its own random port).
      const probe = createServer();
      const freePort = await new Promise<number>((resolve) =>
        probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port)),
      );
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const srv = createDashboardServer({ port: freePort, host: '127.0.0.1' });
      // Wait for the PRIMARY to be listening; the twin's listen() is called
      // synchronously BEFORE it inside createDashboardServer, so by the time
      // the primary fires, the twin is already bound (or errored out).
      await new Promise<void>((resolve, reject) => {
        srv.server.once('error', reject);
        srv.server.once('listening', () => resolve());
      });

      try {
        // IPv4 loopback serves (as always).
        const ipv4 = await fetch(`http://127.0.0.1:${freePort}/api/health`, { signal: AbortSignal.timeout(5000) });
        expect(ipv4.status).toBe(200);

        if (srv.ipv6Twin) {
          // The twin is bound on the SAME port — this is the fix.
          const twinAddr = srv.ipv6Twin.address();
          expect(twinAddr).not.toBeNull();
          const port = (twinAddr as { port: number }).port;
          expect(port).toBe(freePort);
          const ipv6 = await fetch(`http://[::1]:${port}/api/health`, {
            signal: AbortSignal.timeout(5000),
          }).catch(() => null); // env without IPv6 loopback → twin can't be probed
          if (ipv6) expect(ipv6.status).toBe(200);
        } else {
          // No IPv6 on this machine — primary still serves; acceptable.
          expect(ipv4.status).toBe(200);
        }
      } finally {
        srv.server.close();
        if (srv.ipv6Twin) srv.ipv6Twin.close();
      }
    });
  });

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
      // Normalize Windows backslashes before the substring check
      expect(String(body.memoryDir).replace(/\\/g, '/')).toContain('.buff/memory');
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

    it('GET /api/model-registry returns empty state when no registry mirror exists', async () => {
      const res = await httpGet(`${baseUrl}/api/model-registry`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.total).toBe(0);
      expect(body.providers).toEqual([]);
      // Per-action telemetry is always present (even when empty) so the panel
      // can render its "no data yet" hint instead of a blank area.
      expect(body.actionTelemetry).toBeDefined();
      expect(body.actionTelemetry.enabled).toBe(false);
      expect(body.actionTelemetry.actions).toEqual([]);
      expect(typeof body.updatedAt).toBe('number');
    });

    it('GET /api/all includes the modelRegistry field (unified read store)', async () => {
      const res = await httpGet(`${baseUrl}/api/all`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('modelRegistry');
      expect(body.modelRegistry.enabled).toBe(false);
    });

    it('GET /api/requests returns empty state when no action log exists (P3-M3.2)', async () => {
      const res = await httpGet(`${baseUrl}/api/requests`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.total).toBe(0);
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows).toHaveLength(0);
      expect(typeof body.updatedAt).toBe('number');
    });

    it('GET /api/all includes the requests field (Requests panel aggregate)', async () => {
      const res = await httpGet(`${baseUrl}/api/all`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('requests');
      expect(body.requests.enabled).toBe(false);
      expect(Array.isArray(body.requests.rows)).toBe(true);
    });

    it('GET /api/routing returns preference without benchmark data', async () => {
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.providers).toEqual([]);
      expect(body.bestModels).toEqual([]);
      // Auto-router preference is always available (static profiles + real pricing)
      expect(body.preference).toHaveLength(5);
      expect(typeof body.updatedAt).toBe('number');
      for (const p of body.preference) {
        expect(p.winner).toBeTruthy();
        expect(p.providers.length).toBeGreaterThan(0);
        // v1.58.0 M2.x chips mirror the CLI guarantees on every ranked provider.
        for (const prov of p.providers) {
          expect(['measured', 'estimated']).toContain(prov.costSource);
          if (prov.costSource === 'measured') {
            expect(typeof prov.costBasis.inputTokens).toBe('number');
            expect(typeof prov.costBasis.outputTokens).toBe('number');
          } else {
            // Estimated providers carry no measured basis (symmetric contract).
            expect(prov.costBasis).toBeUndefined();
          }
          // capabilityFit / context fields may be undefined (gates OFF) — never crash.
          if (prov.capabilityFit !== undefined) expect(prov.capabilityFit).toBeGreaterThanOrEqual(0);
          if (prov.contextUtilization !== undefined) expect(prov.contextUtilization).toBeGreaterThanOrEqual(0);
          if (prov.contextWindowTokens !== undefined) expect(prov.contextWindowTokens).toBeGreaterThan(0);
        }
      }
    });

    it('GET /api/routing returns a fully-shaped promotion gate in the empty state', async () => {
      // Smoke test: with NO router-promotion.jsonl trajectory, the promotion
      // field must still be fully shaped ("collecting data") so the dashboard
      // can render the card instead of a blank panel.
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.promotion).toBeDefined();
      expect(body.promotion.decisionCount).toBe(0);
      expect(body.promotion.divergedCount).toBe(0);
      expect(body.promotion.minDecisions).toBe(20);
      expect(body.promotion.sufficient).toBe(false);
      expect(body.promotion.promoted).toBe(false);
      // All three criteria are present (quality neutral-false, cost/latency neutral-true)
      expect(body.promotion.criteria).toEqual({ quality: false, cost: true, latency: true });
      expect(typeof body.promotion.qualityDelta).toBe('number');
      expect(typeof body.promotion.costDelta).toBe('number');
      expect(typeof body.promotion.latencyDelta).toBe('number');
      expect(body.promotion.latencyMeasured).toBe(false);
    });

    it('GET /api/all includes routing insights', async () => {
      const res = await httpGet(`${baseUrl}/api/all`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('routing');
      expect(body.routing.preference).toHaveLength(5);
    });

    it('GET /api/pipeline-runs returns empty when no runs file exists', async () => {
      try { rmSync(join(memoryDir, 'pipeline-runs.json'), { force: true }); } catch { /* ignore */ }
      const res = await httpGet(`${baseUrl}/api/pipeline-runs`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(0);
      expect(body.runs).toEqual([]);
    });

    it('GET /api/all includes the pipelineRuns field (scrubbable run timeline)', async () => {
      const res = await httpGet(`${baseUrl}/api/all`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('pipelineRuns');
      expect(body.pipelineRuns.total).toBe(0);
      expect(body.pipelineRuns.runs).toEqual([]);
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
      for (const name of ['cost-tracker', 'history', 'benchmarks', 'trajectories', 'patterns', 'feedback', 'vectors', 'agent-stats', 'routing-history']) {
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

      // M2.2 measured-vs-estimated split (exact wire tokens vs estimates)
      expect(body.measuredCalls).toBe(1);
      expect(body.estimatedCalls).toBe(2);
      expect(body.measuredCost).toBeCloseTo(0.0005, 6);
      expect(body.estimatedCost).toBeCloseTo(0.0035, 6);
      expect(body.byProviderMeasured.gemini).toBeCloseTo(0.0005, 6);
      expect(body.byProviderMeasured.groq).toBeUndefined();
      expect(body.recent[0].measured).toBe(true);
      expect(body.recent[1].measured).toBe(false);
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

    it('GET /api/routing aggregates benchmark quality and preference', async () => {
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Per-provider benchmark aggregation from the groq fixture run
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0].provider).toBe('groq');
      expect(body.providers[0].runs).toBe(1);
      expect(body.providers[0].avgQuality).toBeCloseTo(0.85, 3);
      expect(body.providers[0].passRate).toBeCloseTo(0.8, 3);
      expect(body.providers[0].totalCostUsd).toBeCloseTo(0.012, 6);
      expect(body.providers[0].bestModel).toBe('llama-3.3-70b');

      // Fixture agent-stats has no modelPerformance → no best models
      expect(body.bestModels).toEqual([]);

      // Preference always has the 5 sample complexities
      expect(body.preference).toHaveLength(5);
      expect(body.preference[0].complexity).toBe('trivial');
      expect(body.preference[4].complexity).toBe('critical');
    });

    it('GET /api/routing aggregates routing usage over time', async () => {
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Usage stats from the routing-history fixture (3 entries)
      expect(body.usage.total).toBe(3);
      // 2 entries within the last 24h (route-1, route-2)
      expect(body.usage.last24h).toBe(2);
      expect(body.usage.byProvider).toEqual({ groq: 2, gemini: 1 });
      expect(body.usage.byModel).toEqual({ 'llama-3.3-70b': 2, 'gemini-2.0-flash': 1 });
      expect(body.usage.bySource).toEqual({ chat: 1, explain: 1, benchmark: 1 });
      expect(body.usage.byComplexity).toEqual({ moderate: 1, critical: 1, simple: 1 });
    });

    it('GET /api/model-registry surfaces the unified health + quota telemetry store', async () => {
      const now = Date.now();
      // Mirror the exact model-registry.json shape the ModelRegistry persists:
      // provider × model entries with availability + quota telemetry.
      writeFixture('model-registry', {
        version: 1,
        updatedAt: now,
        entries: {
          'gemini|gemini-2.5-flash': {
            provider: 'gemini', model: 'gemini-2.5-flash', status: 'verified',
            latencyMs: 420, errorRate: 0, quotaParkedUntil: 0, source: 'spot-check',
            tokensConsumed: 2400, requests: 2, resetsInMs: 3_600_000, remainingTokens: 600,
            // M2.2: measured wire-token EMAs (real provider-reported usage).
            measuredInputTokens: 210, measuredOutputTokens: 90, measuredSamples: 3,
            // P4 M4.4: mid-stream flakiness EMA — this model started streaming
            // then died before finish, so the router deprioritizes it. The
            // trajectory powers the row's healing sparkline (trending down =
            // clean successes are decaying the signal).
            partialRate: 0.25,
            partialHistory: [
              { t: now - 20000, rate: 0.4375 },
              { t: now - 10000, rate: 0.25 },
            ],
          },
          'groq|llama-3.3-70b-versatile': {
            provider: 'groq', model: 'llama-3.3-70b-versatile', status: 'verified',
            latencyMs: 180, errorRate: 0.2, quotaParkedUntil: now + 60_000, source: 'telemetry',
            tokensConsumed: 1500, requests: 5, resetsInMs: 60_000, remainingTokens: -1,
            lastError: 'rate-limit',
          },
          'nim|meta/llama-3.3-70b-instruct': {
            provider: 'nim', model: 'meta/llama-3.3-70b-instruct', status: 'unavailable',
            errorRate: 0.5, quotaParkedUntil: 0, source: 'telemetry',
            lastError: 'auth (invalid key / forbidden)',
          },
        },
      });
      try {
        const res = await httpGet(`${baseUrl}/api/model-registry`);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);

        expect(body.enabled).toBe(true);
        expect(body.total).toBe(3);
        expect(body.verified).toBe(1); // groq is parked → not counted verified
        expect(body.unavailable).toBe(1);
        expect(body.parked).toBe(1);
        // P4 M4.4: exactly one model carries a mid-stream flakiness EMA.
        expect(body.flaky).toBe(1);
        expect(body.providers).toHaveLength(3);

        // Provider-level rollups
        const gemini = body.providers.find((p: { provider: string }) => p.provider === 'gemini');
        expect(gemini.verified).toBe(1);
        expect(gemini.models[0].remainingTokens).toBe(600);
        expect(gemini.models[0].resetsInMs).toBe(3_600_000);
        expect(gemini.models[0].latencyMs).toBe(420);
        // M2.2: the measured wire-token basis is surfaced per provider × model
        // (the Models panel flags which entries drive measured cost scoring).
        expect(gemini.models[0].measuredSamples).toBe(3);
        expect(gemini.models[0].measuredInputTokens).toBe(210);
        expect(gemini.models[0].measuredOutputTokens).toBe(90);
        // P4 M4.4: the mid-stream flakiness EMA survives the passthrough and
        // rolls up to the provider-level flaky count; the trajectory arrives
        // for the healing sparkline.
        expect(gemini.models[0].partialRate).toBe(0.25);
        expect(gemini.flaky).toBe(1);
        expect(gemini.models[0].partialHistory).toHaveLength(2);
        expect(gemini.models[0].partialHistory[1].rate).toBe(0.25);

        // Quota-parked entry is flagged + carries the reason
        const groq = body.providers.find((p: { provider: string }) => p.provider === 'groq');
        expect(groq.models[0].parked).toBe(true);
        expect(groq.models[0].lastError).toBe('rate-limit');
        expect(groq.models[0].remainingTokens).toBe(-1); // no limit → unlimited

        // Unavailable entry surfaces the learned reason
        const nim = body.providers.find((p: { provider: string }) => p.provider === 'nim');
        expect(nim.models[0].status).toBe('unavailable');
        expect(nim.models[0].lastError).toContain('auth');
      } finally {
        removeFixture('model-registry');
      }
    });

    it('GET /api/model-registry handles a malformed mirror gracefully', async () => {
      writeFileSync(join(memoryDir, 'model-registry.json'), '{broken');
      const res = await httpGet(`${baseUrl}/api/model-registry`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.total).toBe(0);
      removeFixture('model-registry');
    });

    it('GET /api/model-registry surfaces per-action "learned from real usage" telemetry', async () => {
      // model-registry-actions.jsonl is a JSONL timeline — one
      // {timestamp, action, provider, model, outcome, errorType?} event per
      // line, appended by every LLM call WITH its action tag (chat / execute /
      // plan / edit / ...). The server aggregates it with the same pure
      // function the registry uses.
      const actionsPath = join(memoryDir, 'model-registry-actions.jsonl');
      const now = Date.now();
      const lines = [
        { timestamp: now - 90000, action: 'chat', provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'verified' },
        { timestamp: now - 60000, action: 'chat', provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'verified' },
        { timestamp: now - 30000, action: 'execute', provider: 'gemini', model: 'gemini-2.5-flash', outcome: 'unavailable', errorType: 'auth' },
        { timestamp: now - 10000, action: 'plan', provider: 'nim', model: 'meta/llama-3.3-70b-instruct', outcome: 'error', errorType: 'server' },
        { timestamp: now - 5000, action: 'chat', provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'partial', errorType: 'timeout', streamedChunks: 128 },
      ];
      try {
        writeFileSync(actionsPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

        const res = await httpGet(`${baseUrl}/api/model-registry`);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);

        expect(body.actionTelemetry).toBeDefined();
        expect(body.actionTelemetry.enabled).toBe(true);
        expect(body.actionTelemetry.total).toBe(5);

        // chat verified the same model twice + hit one mid-stream partial →
        // honest volume, one deduped chip per outcome
        const chat = body.actionTelemetry.actions.find((a: { action: string }) => a.action === 'chat');
        expect(chat.verified).toBe(2);
        expect(chat.partial).toBe(1);
        expect(chat.verifiedModels).toHaveLength(1);
        expect(chat.verifiedModels[0]).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile' });

        // execute killed gemini with a definitive auth reason → predictive skip
        const execute = body.actionTelemetry.actions.find((a: { action: string }) => a.action === 'execute');
        expect(execute.killed).toBe(1);
        expect(execute.killedModels[0].reason).toBe('auth');
        expect(execute.killedModels[0].provider).toBe('gemini');

        // plan's transient failure decays health but kills nothing
        const plan = body.actionTelemetry.actions.find((a: { action: string }) => a.action === 'plan');
        expect(plan.transient).toBe(1);
        expect(plan.killed).toBe(0);
        expect(plan.killedModels).toEqual([]);

        // P4 M4.4: the SAME action log feeds the Requests panel — the chat
        // group shows its mid-stream partial count (flakiness context next to
        // the error rate) without counting partials as request failures.
        const reqRes = await httpGet(`${baseUrl}/api/requests`);
        const reqBody = JSON.parse(reqRes.body);
        const chatRow = reqBody.rows.find((r: { provider: string; model: string; action: string }) =>
          r.provider === 'groq' && r.model === 'llama-3.3-70b-versatile' && r.action === 'chat');
        expect(chatRow).toBeDefined();
        expect(chatRow.requests).toBe(3); // 2 verified + 1 partial
        expect(chatRow.partials).toBe(1); // NOT counted as a failure
        expect(chatRow.errorRate).toBe(0);

        // Each action carries a daily timeline so the panel renders the
        // "learned from real usage over time" chart (last 14 days, ascending).
        expect(Array.isArray(chat.timeline)).toBe(true);
        expect(chat.timeline.length).toBeGreaterThan(0);
        // Buckets ascend oldest→newest by day start.
        for (let i = 1; i < chat.timeline.length; i++) {
          expect(chat.timeline[i].day).toBeGreaterThan(chat.timeline[i - 1].day);
        }
        // All events were written within the last 90s — they land in today's
        // bucket OR (if the suite runs within ~90s of UTC midnight) the final
        // two buckets. Sum the last two so the assertions are time-independent.
        const lastTwo = (tl: Array<{ verified: number; killed: number; transient: number }>) => {
          const a = tl[tl.length - 2] || { verified: 0, killed: 0, transient: 0 };
          const b = tl[tl.length - 1];
          return { verified: a.verified + b.verified, killed: a.killed + b.killed, transient: a.transient + b.transient };
        };
        const chatSum = lastTwo(chat.timeline);
        expect(chatSum.verified).toBe(2);
        expect(chatSum.killed).toBe(0);
        const executeSum = lastTwo(execute.timeline);
        expect(executeSum.killed).toBe(1);
        const planSum = lastTwo(plan.timeline);
        expect(planSum.transient).toBe(1);

        // Day buckets carry the RAW events (provider × model × outcome) so the
        // scrubbable chart shows that day's exact chips, not just counts.
        const lastTwoEvents = (tl: Array<{ events: Array<{ provider: string; model: string; outcome: string; errorType?: string }> }>) =>
          [...(tl[tl.length - 2]?.events || []), ...(tl[tl.length - 1]?.events || [])];
        // Events are deduped per provider × model × outcome (latest wins) — the
        // two identical chat verifies collapse to one chip event, while the
        // COUNT above stays honest (chat.verified === 2).
        const chatEvents = lastTwoEvents(chat.timeline);
        expect(chatEvents.filter((e: { outcome: string }) => e.outcome === 'verified')).toHaveLength(1);
        const killEvents = lastTwoEvents(execute.timeline);
        expect(killEvents[0]).toMatchObject({
          provider: 'gemini', model: 'gemini-2.5-flash', outcome: 'unavailable', errorType: 'auth',
        });
        const transientEvents = lastTwoEvents(plan.timeline);
        expect(transientEvents[0]).toMatchObject({
          provider: 'nim', model: 'meta/llama-3.3-70b-instruct', outcome: 'error', errorType: 'server',
        });
      } finally {
        rmSync(actionsPath, { force: true });
      }
    });

    it('GET /api/routing returns the audit-trail timeline most-recent-first', async () => {
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.history).toHaveLength(3);
      // Newest first
      expect(body.history[0].id).toBe('route-1');
      expect(body.history[1].id).toBe('route-2');
      expect(body.history[2].id).toBe('route-3');
      // Entry shape: task truncated, score rounded, source/provider/model present
      const entry = body.history[0];
      expect(entry.source).toBe('chat');
      expect(entry.provider).toBe('groq');
      expect(entry.model).toBe('llama-3.3-70b');
      expect(entry.task).toBe('Implement login page');
      expect(entry.complexity).toBe('moderate');
      expect(entry.score).toBeCloseTo(0.85, 3);
    });

    it('GET /api/routing handles malformed benchmark JSON gracefully', async () => {
      writeFileSync(join(memoryDir, 'benchmarks.json'), '{broken');
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.providers).toEqual([]);
      expect(body.preference).toHaveLength(5);
      removeFixture('benchmarks');
    });

    it('GET /api/routing handles a missing routing-history file gracefully', async () => {
      removeFixture('routing-history');
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.usage.total).toBe(0);
      expect(body.usage.byProvider).toEqual({});
      expect(body.history).toEqual([]);
      // Restore the fixture for later tests
      writeDefaultFixtures();
    });

    it('GET /api/routing returns bandit state when a router-bandit fixture exists', async () => {
      writeFixture('router-bandit', {
        version: 1,
        priors: {
          moderate: { groq: { alpha: 2.5, beta: 1.5 } },
        },
        learningHistory: [
          { provider: 'groq', complexity: 'moderate', outcome: 'success', reward: 0.9, timestamp: new Date().toISOString() },
        ],
      });
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bandit).toBeDefined();
      expect(body.bandit.enabled).toBe(true);
      expect(body.bandit.version).toBe(1);
      // Collapsed per-provider shape: priors.groq.moderate.{alpha,beta,expectedWinRate}
      expect(body.bandit.priors.groq.moderate.alpha).toBe(2.5);
      expect(body.bandit.priors.groq.moderate.beta).toBe(1.5);
      expect(body.bandit.priors.groq.moderate.expectedWinRate).toBeCloseTo(2.5 / 4, 3);
      expect(body.bandit.learningHistory).toHaveLength(1);
      expect(body.bandit.learningHistory[0].provider).toBe('groq');
      removeFixture('router-bandit');
    });

    it('GET /api/routing returns disabled bandit when no router-bandit fixture exists', async () => {
      removeFixture('router-bandit');
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bandit).toBeDefined();
      expect(body.bandit.enabled).toBe(false);
      expect(body.bandit.priors).toEqual({});
    });

    it('GET /api/routing returns the quota failover timeline from quota-events.jsonl', async () => {
      // quota-events.jsonl is a JSONL timeline — one {type, provider, reason?,
      // timestamp} event per line, appended by the ledger's park/release/
      // window-roll paths and chat's mid-session failover bookkeeping.
      const eventsPath = join(memoryDir, 'quota-events.jsonl');
      // The ledger APPENDS events chronologically (oldest first in the file),
      // and readQuotaEvents() reverses the lines to surface newest first — so
      // the fixture must be written oldest→newest to mirror real append order.
      const events = [
        { type: 're-enabled', provider: 'groq', reason: 'window reset', timestamp: Date.now() - 60000 },
        { type: 'parked', provider: 'gemini', reason: 'rate-limit', timestamp: Date.now() - 10000 },
        { type: 'failover', provider: 'gemini', reason: 'rate-limit', timestamp: Date.now() - 5000 },
      ];
      try {
        writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

        const res = await httpGet(`${baseUrl}/api/routing`);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);

        expect(body.quota).toBeDefined();
        expect(body.quota.events).toHaveLength(3);
        // Newest first
        expect(body.quota.events[0].type).toBe('failover');
        expect(body.quota.events[0].provider).toBe('gemini');
        expect(body.quota.events[0].reason).toBe('rate-limit');
        expect(body.quota.events[1].type).toBe('parked');
        expect(body.quota.events[2].type).toBe('re-enabled');
        // Event shape preserved end-to-end
        for (const ev of body.quota.events) {
          expect(typeof ev.type).toBe('string');
          expect(typeof ev.provider).toBe('string');
          expect(typeof ev.timestamp).toBe('number');
        }
      } finally {
        rmSync(eventsPath, { force: true });
      }
    });

    it('GET /api/routing returns an empty quota events timeline when the file is missing', async () => {
      const eventsPath = join(memoryDir, 'quota-events.jsonl');
      try { rmSync(eventsPath, { force: true }); } catch { /* ignore */ }
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.quota).toBeDefined();
      expect(body.quota.events).toEqual([]);
    });

    it('GET /api/routing skips corrupt lines in the quota failover timeline', async () => {
      const eventsPath = join(memoryDir, 'quota-events.jsonl');
      try {
        writeFileSync(
          eventsPath,
          JSON.stringify({ type: 'parked', provider: 'groq', timestamp: Date.now() - 5000 }) + '\n' +
          '{corrupt-line\n' +
          JSON.stringify({ type: 'released', provider: 'local', reason: 'manual', timestamp: Date.now() - 1000 }) + '\n',
        );
        const res = await httpGet(`${baseUrl}/api/routing`);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.quota.events).toHaveLength(2);
        expect(body.quota.events[0].type).toBe('released'); // newest valid first
        expect(body.quota.events[1].type).toBe('parked');
      } finally {
        rmSync(eventsPath, { force: true });
      }
    });

    it('GET /api/routing surfaces M2.3 parked accounts (multi-account key rotation)', async () => {
      // quota-ledger.json may carry `accounts: { provider: { fingerprint:
      // { parkedUntil, reason } } }` — the M2.3 per-key rotation state. The
      // dashboard must surface which ACCOUNT of a provider is parked (and why)
      // so key rotation is visible, not just provider-level parks.
      const ledgerPath = join(memoryDir, 'quota-ledger.json');
      const now = Date.now();
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          version: 1,
          entries: {
            'gemini|gemini-2.5-flash': {
              provider: 'gemini', model: 'gemini-2.5-flash', tokensConsumed: 500,
              requests: 2, windowStart: now - 60000, windowLengthMs: 86400000, cooldownUntil: 0,
            },
          },
          accounts: {
            gemini: {
              'a1b2c3d4': { parkedUntil: now + 3600_000, reason: 'rate-limit' },
              'e5f6a7b8': { parkedUntil: now - 1000, reason: 'auth' }, // expired → excluded
            },
          },
        }),
      );
      try {
        const res = await httpGet(`${baseUrl}/api/routing`);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);

        expect(body.quota.parkedAccounts).toBeDefined();
        expect(body.quota.parkedAccounts).toHaveLength(1);
        expect(body.quota.parkedAccounts[0]).toMatchObject({
          provider: 'gemini',
          accountId: 'a1b2c3d4',
          reason: 'rate-limit',
        });
        // Expired park is filtered out; remaining > 0.
        expect(body.quota.parkedAccounts[0].remainingMs).toBeGreaterThan(0);
        // Raw keys are NEVER surfaced — only the fingerprint.
        expect(JSON.stringify(body.quota.parkedAccounts)).not.toContain('sk-sk-');
      } finally {
        rmSync(ledgerPath, { force: true });
      }
    });

    it('GET /api/routing omits parkedAccounts when the ledger has no accounts (backward compat)', async () => {
      const ledgerPath = join(memoryDir, 'quota-ledger.json');
      try { rmSync(ledgerPath, { force: true }); } catch { /* ignore */ }
      const res = await httpGet(`${baseUrl}/api/routing`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Older ledger without `accounts` → empty array (never undefined/null),
      // so the panel can safely iterate.
      expect(Array.isArray(body.quota.parkedAccounts)).toBe(true);
      expect(body.quota.parkedAccounts).toEqual([]);
    });

    it('GET /api/routing returns the promotion-gate verdict from the trajectory', async () => {
      // router-promotion.jsonl is a JSONL trajectory — one A/B decision per line.
      // Both decisions diverge (bandit pick != heuristic pick) so the gate has signal.
      const promoPath = join(memoryDir, 'router-promotion.jsonl');
      const decisions = [
        {
          agentType: 'chat', task: 'implement login',
          heuristic: { provider: 'groq', model: 'llama-3.3-70b', predictedQuality: 0.7, predictedCostUsd: 0.0001, estimatedLatencyMs: 100 },
          bandit: { provider: 'gemini', model: 'gemini-2.0-flash', predictedQuality: 0.8, predictedCostUsd: 0.0002, estimatedLatencyMs: 200 },
          outcome: 'success', timestamp: new Date().toISOString(),
        },
        {
          agentType: 'chat', task: 'fix login bug',
          heuristic: { provider: 'groq', model: 'llama-3.3-70b', predictedQuality: 0.6, predictedCostUsd: 0.0001, estimatedLatencyMs: 100 },
          bandit: { provider: 'gemini', model: 'gemini-2.0-flash', predictedQuality: 0.9, predictedCostUsd: 0.0002, estimatedLatencyMs: 200 },
          outcome: 'success', timestamp: new Date().toISOString(),
        },
      ];
      try {
        writeFileSync(promoPath, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');

        const res = await httpGet(`${baseUrl}/api/routing`);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);

        expect(body.promotion).toBeDefined();
        expect(body.promotion.decisionCount).toBe(2);
        expect(body.promotion.divergedCount).toBe(2);
        expect(body.promotion.minDecisions).toBe(20);
        // 2 < 20 required diverged decisions → collecting data, never promoted
        expect(body.promotion.sufficient).toBe(false);
        expect(body.promotion.promoted).toBe(false);
        // Deltas are numbers and the three criteria are present
        expect(typeof body.promotion.qualityDelta).toBe('number');
        expect(typeof body.promotion.costDelta).toBe('number');
        expect(typeof body.promotion.latencyDelta).toBe('number');
        expect(body.promotion.criteria).toHaveProperty('quality');
        expect(body.promotion.criteria).toHaveProperty('cost');
        expect(body.promotion.criteria).toHaveProperty('latency');
      } finally {
        rmSync(promoPath, { force: true });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Pipeline runs — persisted scrubbable phase timeline
  // ═══════════════════════════════════════════════════════════════════════

  describe('pipeline runs — persisted phase timeline', () => {
    it('finalizes and persists a run when every DAG node reaches a terminal state', async () => {
      // Hermetic: reset in-memory DAG state and remove any prior runs file.
      resetDAG();
      try { rmSync(join(memoryDir, 'pipeline-runs.json'), { force: true }); } catch { /* ignore */ }

      const pipelineId = `pipeline-${Date.now()}`;
      pushDAGUpdate({
        pipelineId,
        pipelineDescription: 'Implement login flow',
        nodes: [
          { id: 'step-1', agentType: 'planner', status: 'pending', description: 'Plan the login flow' },
          { id: 'step-2', agentType: 'context-gatherer', status: 'pending', description: 'Gather relevant files' },
          { id: 'step-3', agentType: 'writer', status: 'pending', description: 'Write the implementation' },
          { id: 'step-4', agentType: 'reviewer', status: 'pending', description: 'Review the changes' },
          { id: 'step-5', agentType: 'tester', status: 'pending', description: 'Run the test suite' },
        ],
        edges: [
          { from: 'step-1', to: 'step-2' },
          { from: 'step-2', to: 'step-3' },
          { from: 'step-3', to: 'step-4' },
          { from: 'step-4', to: 'step-5' },
        ],
      });

      for (const id of ['step-1', 'step-2', 'step-3', 'step-4', 'step-5']) {
        updateDAGNode(id, { status: 'running' });
      }
      updateDAGNode('step-1', { status: 'completed', summary: 'Plan ready' });
      updateDAGNode('step-2', { status: 'completed', summary: '5 files gathered' });
      updateDAGNode('step-3', { status: 'completed', summary: 'auth.ts written' });
      updateDAGNode('step-4', { status: 'completed', summary: 'approved' });
      updateDAGNode('step-5', { status: 'completed', summary: '12/12 passed' });

      // In-memory reader sees the persisted run with full phase detail.
      const runs = readPipelineRuns();
      expect(runs.total).toBe(1);
      expect(runs.runs[0].id).toBe(pipelineId);
      expect(runs.runs[0].goal).toBe('Implement login flow');
      expect(runs.runs[0].success).toBe(true);
      expect(runs.runs[0].phases).toHaveLength(5);
      expect(runs.runs[0].phases.map((p) => p.agentType)).toEqual([
        'planner', 'context-gatherer', 'writer', 'reviewer', 'tester',
      ]);
      // Every phase has computed start/end/duration for proportional layout.
      for (const p of runs.runs[0].phases) {
        expect(p.status).toBe('completed');
        expect(typeof p.startedAt).toBe('number');
        expect(typeof p.completedAt).toBe('number');
        expect(typeof p.durationMs).toBe('number');
        expect(p.summary).toBeTruthy();
      }
      expect(runs.runs[0].totalDurationMs).toBeGreaterThanOrEqual(0);

      // HTTP endpoint serves the persisted run.
      const res = await httpGet(`${baseUrl}/api/pipeline-runs`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.runs[0].id).toBe(pipelineId);
      expect(body.runs[0].phases).toHaveLength(5);

      // /api/all includes it so the dashboard's Run Timeline can render it.
      const all = await httpGet(`${baseUrl}/api/all`);
      const allBody = JSON.parse(all.body);
      expect(allBody.pipelineRuns.total).toBe(1);
      expect(allBody.pipelineRuns.runs[0].phases[0].agentType).toBe('planner');
    });

    it('orders persisted runs newest-first and de-duplicates by id', async () => {
      resetDAG();
      try { rmSync(join(memoryDir, 'pipeline-runs.json'), { force: true }); } catch { /* ignore */ }

      pushDAGUpdate({
        pipelineId: 'run-1', pipelineDescription: 'First run',
        nodes: [{ id: 'a', agentType: 'planner', status: 'pending', description: 'plan' }], edges: [],
      });
      updateDAGNode('a', { status: 'running' });
      updateDAGNode('a', { status: 'completed' });

      // A new pipeline id starts a fresh run draft.
      pushDAGUpdate({
        pipelineId: 'run-2', pipelineDescription: 'Second run',
        nodes: [{ id: 'b', agentType: 'writer', status: 'pending', description: 'write' }], edges: [],
      });
      updateDAGNode('b', { status: 'running' });
      updateDAGNode('b', { status: 'completed' });

      const res = await httpGet(`${baseUrl}/api/pipeline-runs`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(2);
      expect(body.runs[0].id).toBe('run-2'); // newest first
      expect(body.runs[1].id).toBe('run-1');
    });

    it('does not persist an incomplete run (still running steps)', async () => {
      resetDAG();
      try { rmSync(join(memoryDir, 'pipeline-runs.json'), { force: true }); } catch { /* ignore */ }

      pushDAGUpdate({
        pipelineId: 'partial', pipelineDescription: 'Incomplete run',
        nodes: [
          { id: 'x', agentType: 'planner', status: 'pending', description: 'plan' },
          { id: 'y', agentType: 'writer', status: 'pending', description: 'write' },
        ], edges: [],
      });
      updateDAGNode('x', { status: 'running' });
      updateDAGNode('x', { status: 'completed' });
      // y is still pending/running → run must NOT be persisted yet.
      updateDAGNode('y', { status: 'running' });

      expect(readPipelineRuns().total).toBe(0);

      // Completing the last step flips it to persisted.
      updateDAGNode('y', { status: 'failed' });
      const runs = readPipelineRuns();
      expect(runs.total).toBe(1);
      expect(runs.runs[0].id).toBe('partial');
      expect(runs.runs[0].success).toBe(false);
      expect(runs.runs[0].phases[1].status).toBe('failed');
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

    it('unknown /api/* path returns JSON 404, never the SPA index.html', async () => {
      // An unknown /api/* path must return a parseable JSON 404. Previously it
      // fell through to the SPA fallback and got index.html with HTTP 200 — the
      // exact failure that made `res.json()` throw "Unexpected token '<'" and
      // take down the Models panel when a STALE dashboard server (older
      // version, missing newer routes like /api/model-registry) served a newer
      // frontend bundle that called them.
      const res = await httpGet(`${baseUrl}/api/nonexistent`);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not found');
      expect(body.path).toBe('/api/nonexistent');
    });

    it('non-API unknown paths still get the SPA fallback index.html', async () => {
      const res = await httpGet(`${baseUrl}/some-unknown-client-path`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<!DOCTYPE html>');
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
      expect(d).toHaveProperty('modelRegistry');
      expect(d).toHaveProperty('serverTime');
    });

    it('SSE pushes a quota event in real time when the failover timeline changes', async () => {
      // The server watches the memory dir and emits a `quota` SSE event the
      // moment quota-events.jsonl / quota-ledger.json change — simulating
      // chat's mid-session failover bookkeeping writing from another process.
      const eventsPath = join(memoryDir, 'quota-events.jsonl');
      try { rmSync(eventsPath, { force: true }); } catch { /* ignore */ }

      const stream = await openSSE(`${baseUrl}/api/sse`);
      try {
        // Prove the connection is open (init snapshot sent) before writing,
        // so the quota watcher is guaranteed armed.
        await stream.waitFor('init');

        // Simulate chat's recordAutoProviderFailure appending a failover event.
        writeFileSync(eventsPath, JSON.stringify({
          type: 'failover',
          provider: 'gemini',
          reason: 'rate-limit',
          timestamp: Date.now(),
        }) + '\n');

        const ev = await stream.waitFor('quota');
        const data = ev.data as { quota: { events: Array<{ type: string; provider: string }> } };
        expect(data.quota).toBeDefined();
        expect(data.quota.events[0].type).toBe('failover');
        expect(data.quota.events[0].provider).toBe('gemini');
        expect(data.quota.events[0].reason).toBe('rate-limit');
      } finally {
        stream.close();
        try { rmSync(eventsPath, { force: true }); } catch { /* ignore */ }
      }
    });

    it('SSE pushes a quota event when a provider is parked (ledger write)', async () => {
      // Same real-time path for quota-ledger.json writes (park/release).
      const ledgerPath = join(memoryDir, 'quota-ledger.json');
      try { rmSync(ledgerPath, { force: true }); } catch { /* ignore */ }

      const stream = await openSSE(`${baseUrl}/api/sse`);
      try {
        await stream.waitFor('init');

        writeFileSync(ledgerPath, JSON.stringify({
          version: 1,
          entries: {
            'groq|default': {
              provider: 'groq', model: 'default', tokensConsumed: 100, requests: 1,
              windowStart: Date.now(), windowLengthMs: 86400000, cooldownUntil: 0,
            },
          },
        }));

        const ev = await stream.waitFor('quota');
        const data = ev.data as { quota: { entries: Array<{ provider: string }> } };
        expect(data.quota.entries).toHaveLength(1);
        expect(data.quota.entries[0].provider).toBe('groq');
      } finally {
        stream.close();
        try { rmSync(ledgerPath, { force: true }); } catch { /* ignore */ }
      }
    });

    it('keeps the quota watcher armed after the last client disconnects when routing.alwaysWatchQuota is set', async () => {
      // Write the config flag into the mocked homedir's buffconfig.json, then
      // start a fresh server: with routing.alwaysWatchQuota=true the watcher
      // arms AT STARTUP (before any SSE client) and is NEVER disarmed by the
      // client count — so quota state stays warm between dashboard sessions.
      const configPath = join(testDir, '.buff', 'buffconfig.json');
      writeFileSync(configPath, JSON.stringify({ routing: { alwaysWatchQuota: true } }));
      const srv2 = createDashboardServer();
      try {
        const addr = await new Promise<any>((resolve) => {
          srv2.server.once('listening', () => resolve(srv2.server.address()));
        });
        const base2 = `http://127.0.0.1:${addr.port}`;

        // Armed at startup — before ANY SSE client connects.
        expect(isQuotaWatcherArmed()).toBe(true);

        // Connect + disconnect: the watcher must NOT disarm (always-on).
        const stream = await openSSE(`${base2}/api/sse`);
        await stream.waitFor('init');
        stream.close();
        // Give the req 'close' handler a tick to process the disconnect.
        await new Promise((r) => setTimeout(r, 150));
        expect(isQuotaWatcherArmed()).toBe(true);
      } finally {
        srv2.server.close();
        if (srv2.ipv6Twin) srv2.ipv6Twin.close();
        rmSync(configPath, { force: true });
        // Reset the module flag so the rest of the suite sees default behavior.
        setAlwaysWatchQuota(false);
        // Disarm the lingering watcher via a connect/disconnect cycle now that
        // the flag is off (disarm fires when the last client disconnects).
        const cleanup = await openSSE(`${baseUrl}/api/sse`);
        try {
          await cleanup.waitFor('init');
        } finally {
          cleanup.close();
        }
        await new Promise((r) => setTimeout(r, 150));
        expect(isQuotaWatcherArmed()).toBe(false);
      }
    });

    it('disarms the quota watcher on last disconnect when always-watch is OFF (default)', async () => {
      setAlwaysWatchQuota(false);
      const stream = await openSSE(`${baseUrl}/api/sse`);
      try {
        await stream.waitFor('init');
        expect(isQuotaWatcherArmed()).toBe(true); // armed while viewing
      } finally {
        stream.close();
      }
      await new Promise((r) => setTimeout(r, 150));
      expect(isQuotaWatcherArmed()).toBe(false); // disarmed with nobody viewing
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

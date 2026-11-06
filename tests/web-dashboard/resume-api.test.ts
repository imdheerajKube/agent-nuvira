/**
 * Resume API — GET /api/resume and POST /api/resume/run over REAL HTTP.
 *
 * The routes are what the Chat page's "Unfinished work" panel calls, so the
 * contract they must keep is the one the panel depends on:
 *
 *   - only OPEN snapshots are listed (a clean turn is history, not work),
 *   - each row carries the snapshot's own id, and `?cwd=` scopes the list,
 *   - continuing sends that id (or an explicit `all`) with a deadline,
 *   - the route SPAWNS and returns a pid/log instead of holding the request for
 *     hours, and a spawn failure is a 500 with the reason,
 *   - auth + routing.operate gate both routes.
 *
 * The spawn is injected via setResumeSpawnForTest: a route test must never leave
 * a real continuation process behind.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-resume-api-'));
const configDir = join(testDir, '.nuvira');
const memoryDir = join(configDir, 'memory');
const projectDir = join(testDir, 'shop');
const otherDir = join(testDir, 'docs-site');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });

// Read at import time — must be set before the server module is imported.
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = configDir;

const { createDashboardServer, setResumeSpawnForTest } = await import('../../src/web-dashboard/server.js');
const { openSession } = await import('../../src/learning/session-store.js');

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let adminToken = '';
let viewerToken = '';
let openRunId = '';
let otherRunId = '';

function authedFetch(path: string, method = 'GET', body?: unknown, tok = adminToken): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function login(user: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
  const data = (await res.json()) as { token?: string };
  expect(data.token).toBeTruthy();
  return data.token as string;
}

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const setup = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'test-password-123' }),
  });
  const setupData = (await setup.json()) as { token?: string };
  expect(setupData.token).toBeTruthy();
  adminToken = setupData.token as string;
  await authedFetch('/api/admin/users', 'POST', {
    user: 'viewer',
    password: 'viewer-pass-123',
    role: 'viewer',
  });
  viewerToken = await login('viewer', 'viewer-pass-123');

  // One OPEN turn (the resumable unit), one CLOSED turn (history), and one open
  // turn in ANOTHER directory for the ?cwd= filter.
  const open = openSession({ goal: 'build the checkout flow', cwd: projectDir });
  open.save(
    [
      { role: 'user', content: 'build the checkout flow' },
      { role: 'tool', content: 'wrote checkout.ts', toolCallId: 't1' },
    ],
    { steps: 7, successfulTools: ['write_file'], mutatedPaths: ['checkout.ts'] },
  );
  expect(open.lastSaved(), 'the OPEN snapshot reached the disk').toBe(true);
  openRunId = open.id;

  const closed = openSession({ goal: 'write the readme', cwd: projectDir });
  closed.save(
    [
      { role: 'user', content: 'write the readme' },
      { role: 'assistant', content: 'done' },
    ],
    { steps: 3, successfulTools: [], mutatedPaths: [] },
  );
  closed.finish();

  const other = openSession({ goal: 'build the docs site', cwd: otherDir });
  other.save(
    [
      { role: 'user', content: 'build the docs site' },
      { role: 'tool', content: 'wrote index.md', toolCallId: 't2' },
    ],
    { steps: 2, successfulTools: ['write_file'], mutatedPaths: ['index.md'] },
  );
  otherRunId = other.id;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

afterEach(() => {
  setResumeSpawnForTest(null);
});

describe('GET /api/resume', () => {
  it('rejects unauthenticated requests (401)', async () => {
    const res = await fetch(`${baseUrl}/api/resume`);
    expect(res.status).toBe(401);
  });

  it('gates the list on routing.operate (viewer denied)', async () => {
    const res = await authedFetch('/api/resume', 'GET', undefined, viewerToken);
    expect(res.status).toBe(403);
  });

  it('lists OPEN turns only, with each snapshot id', async () => {
    const res = await authedFetch('/api/resume');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      runs: Array<{ id: string; goal: string; cwd: string; steps: number }>;
    };
    expect(body.ok).toBe(true);
    const goals = body.runs.map((r) => r.goal).sort();
    expect(goals).toEqual(['build the checkout flow', 'build the docs site']);
    expect(goals).not.toContain('write the readme');
    const row = body.runs.find((r) => r.id === openRunId);
    expect(row).toMatchObject({ goal: 'build the checkout flow', cwd: projectDir, steps: 7 });
  });

  it('scopes the list to one directory with ?cwd=', async () => {
    const res = await authedFetch(`/api/resume?cwd=${encodeURIComponent(otherDir)}`);
    const body = (await res.json()) as { runs: Array<{ id: string; cwd: string }> };
    expect(body.runs.map((r) => r.id)).toEqual([otherRunId]);
  });
});

describe('POST /api/resume/run', () => {
  it('rejects unauthenticated requests (401)', async () => {
    const res = await fetch(`${baseUrl}/api/resume/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(401);
  });

  it('gates continuation on routing.operate (viewer denied)', async () => {
    const res = await authedFetch('/api/resume/run', 'POST', { all: true }, viewerToken);
    expect(res.status).toBe(403);
  });

  it('continues the EXACT id it is given, with the deadline, and returns pid + log', async () => {
    const seen: Array<Record<string, unknown>> = [];
    setResumeSpawnForTest((input) => {
      seen.push(input as Record<string, unknown>);
      return { pid: 4242, logPath: '/tmp/resume-test.log' };
    });

    const res = await authedFetch('/api/resume/run', 'POST', {
      id: openRunId,
      deadlineMinutes: 480,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pid?: number; log?: string };
    expect(body).toMatchObject({ ok: true, pid: 4242, log: '/tmp/resume-test.log' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: openRunId,
      all: false,
      minutes: 480,
      cwd: expect.any(String),
    });
  });

  it('continues ALL turns when asked, defaulting the deadline to 24h', async () => {
    const seen: Array<Record<string, unknown>> = [];
    setResumeSpawnForTest((input) => {
      seen.push(input as Record<string, unknown>);
      return { pid: 1, logPath: '/tmp/resume-all.log' };
    });

    const res = await authedFetch('/api/resume/run', 'POST', { all: true });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ all: true, minutes: 1440 });
    expect(seen[0].id).toBeUndefined();
  });

  it('caps an absurd deadline instead of passing it through', async () => {
    const seen: Array<Record<string, unknown>> = [];
    setResumeSpawnForTest((input) => {
      seen.push(input as Record<string, unknown>);
      return { pid: 2, logPath: '/tmp/resume-cap.log' };
    });

    const res = await authedFetch('/api/resume/run', 'POST', { all: true, deadlineMinutes: 9_999_999 });
    expect(res.status).toBe(200);
    expect(seen[0].minutes).toBe(43_200);
  });

  it('reports a spawn failure as a 500 with the reason, never as success', async () => {
    setResumeSpawnForTest(() => {
      throw new Error('no entry script to re-launch');
    });

    const res = await authedFetch('/api/resume/run', 'POST', { all: true });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('no entry script to re-launch');
  });
});

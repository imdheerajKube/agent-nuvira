/**
 * OmniRoute gateway lifecycle — GET/POST /api/admin/omniroute.
 *
 * The dashboard could configure OmniRoute as a provider but not start/stop the
 * EXTERNAL gateway or say whether it was up. These tests pin the contract:
 * reachability is reported (a 401 counts as up), start/stop require gateway.manage
 * (admin or operator; viewer read-only), and every lifecycle action is STUBBED
 * via setOmniRouteActionsForTest — a route test must never probe the network or
 * spawn a real gateway.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-omniroute-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
process.env.NUVIRA_WHATSAPP_SESSION_DIR = join(testDir, '.nuvira', 'whatsapp', 'session');

const { createDashboardServer, setOmniRouteActionsForTest } = await import('../../src/web-dashboard/server.js');

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let adminToken = '';
let operatorToken = '';
let viewerToken = '';

const STATUS = {
  reachable: true,
  running: true,
  baseUrl: 'http://127.0.0.1:20128/v1',
  detail: 'Reachable (HTTP 200)',
  pid: 4321,
  port: 20128,
};

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
  adminToken = setupData.token as string;

  for (const [user, role] of [['operator', 'operator'], ['viewer', 'viewer']] as const) {
    await authedFetch('/api/admin/users', 'POST', { user, password: `${user}-pass-123`, role });
  }
  operatorToken = await login('operator', 'operator-pass-123');
  viewerToken = await login('viewer', 'viewer-pass-123');
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

afterEach(() => {
  setOmniRouteActionsForTest(null);
});

describe('/api/admin/omniroute', () => {
  it('rejects unauthenticated reads and writes (401)', async () => {
    const read = await fetch(`${baseUrl}/api/admin/omniroute`);
    expect(read.status).toBe(401);
    const write = await fetch(`${baseUrl}/api/admin/omniroute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    expect(write.status).toBe(401);
  });

  it('reports reachability to any authenticated session (viewer included)', async () => {
    setOmniRouteActionsForTest({
      status: async () => STATUS,
      start: async () => ({ ok: true, started: true, status: STATUS, detail: 'started' }),
      stop: async () => ({ stopped: true, pid: 4321 }),
    });
    const res = await authedFetch('/api/admin/omniroute', 'GET', undefined, viewerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: typeof STATUS };
    expect(body.ok).toBe(true);
    expect(body.status.reachable).toBe(true);
    expect(body.status.pid).toBe(4321);
  });

  it('allows an operator to start the gateway', async () => {
    const started = { ok: true, started: true, status: STATUS, detail: 'OmniRoute started.' };
    const start = async () => started;
    setOmniRouteActionsForTest({ status: async () => STATUS, start, stop: async () => ({ stopped: true }) });

    const res = await authedFetch('/api/admin/omniroute', 'POST', { action: 'start' }, operatorToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; action: string; started: boolean; detail: string; status: typeof STATUS };
    expect(body.ok).toBe(true);
    expect(body.action).toBe('start');
    expect(body.started).toBe(true);
    expect(body.detail).toContain('started');
    expect(body.status.reachable).toBe(true);
  });

  it('denies a viewer start/stop (403, gateway.manage)', async () => {
    setOmniRouteActionsForTest({
      status: async () => STATUS,
      start: async () => ({ ok: true, started: true, status: STATUS, detail: 'started' }),
      stop: async () => ({ stopped: true }),
    });
    const res = await authedFetch('/api/admin/omniroute', 'POST', { action: 'stop' }, viewerToken);
    expect(res.status).toBe(403);
  });

  it('stops and re-reports status', async () => {
    const stoppedStatus = { ...STATUS, reachable: false, running: false, pid: null, detail: 'Not reachable (ECONNREFUSED)' };
    setOmniRouteActionsForTest({
      status: async () => stoppedStatus,
      start: async () => ({ ok: true, started: true, status: STATUS, detail: 'started' }),
      stop: async () => ({ stopped: true, pid: 4321 }),
    });
    const res = await authedFetch('/api/admin/omniroute', 'POST', { action: 'stop' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; stopped: boolean; pid?: number; status: { running: boolean } };
    expect(body.ok).toBe(true);
    expect(body.stopped).toBe(true);
    expect(body.pid).toBe(4321);
    expect(body.status.running).toBe(false);
  });

  it('surfaces a start failure as ok:false with the reason', async () => {
    setOmniRouteActionsForTest({
      status: async () => ({ ...STATUS, reachable: false, running: false, pid: null }),
      start: async () => ({
        ok: false,
        started: false,
        status: { ...STATUS, reachable: false, running: false, pid: null },
        detail: 'OmniRoute is not installed or not on PATH. Install it with: npm install -g omniroute',
      }),
      stop: async () => ({ stopped: false, reason: 'nothing running' }),
    });
    const res = await authedFetch('/api/admin/omniroute', 'POST', { action: 'start' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain('npm install -g omniroute');
  });

  it('rejects an unknown action (400)', async () => {
    setOmniRouteActionsForTest({
      status: async () => STATUS,
      start: async () => ({ ok: true, started: true, status: STATUS, detail: 'started' }),
      stop: async () => ({ stopped: true }),
    });
    const res = await authedFetch('/api/admin/omniroute', 'POST', { action: 'restart' });
    expect(res.status).toBe(400);
  });
});

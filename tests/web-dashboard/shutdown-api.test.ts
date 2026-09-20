/**
 * Shutdown API — POST /api/admin/shutdown (the GUI twin of `nuvira gateway stop`
 * / `nuvira dashboard stop`).
 *
 * Real HTTP against a server on a random port, file-based admin auth (admin +
 * operator + viewer for the RBAC gates), and a temp BUFF_CONFIG_DIR. The
 * dashboard-exit action is swapped via setDashboardShutdownForTest so a
 * dashboard-target test never exits the test runner; the gateway stop is
 * exercised through the injected action too (a real `gateway start` must never
 * be SIGTERMed by a test).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-shutdown-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
process.env.NUVIRA_WHATSAPP_SESSION_DIR = join(testDir, '.nuvira', 'whatsapp', 'session');

const { createDashboardServer, setDashboardShutdownForTest, setGatewayShutdownForTest } = await import('../../src/web-dashboard/server.js');

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let adminToken = '';
let operatorToken = '';
let viewerToken = '';

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

describe('POST /api/admin/shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated requests (401)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'gateway' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid target (400)', async () => {
    const res = await authedFetch('/api/admin/shutdown', 'POST', { target: 'database' });
    expect(res.status).toBe(400);
  });

  it('gates the dashboard target on system.manage (viewer + operator denied, admin allowed)', async () => {
    const viewer = await authedFetch('/api/admin/shutdown', 'POST', { target: 'dashboard' }, viewerToken);
    expect(viewer.status).toBe(403);
    const operator = await authedFetch('/api/admin/shutdown', 'POST', { target: 'dashboard' }, operatorToken);
    expect(operator.status).toBe(403);
    // Admin: the injected no-op action runs (never actually exits the runner).
    const run = vi.fn();
    setDashboardShutdownForTest(run);
    try {
      const admin = await authedFetch('/api/admin/shutdown', 'POST', { target: 'dashboard' });
      expect(admin.status).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      setDashboardShutdownForTest(null);
    }
  });

  it('gates the gateway target on gateway.manage (viewer denied, operator allowed)', async () => {
    const viewer = await authedFetch('/api/admin/shutdown', 'POST', { target: 'gateway' }, viewerToken);
    expect(viewer.status).toBe(403);
    // The gateway-stop action IS stubbed: the real one discovers the gateway by
    // COMMAND LINE across the whole machine, so a test run on a developer box
    // with a live gateway would kill it (observed — the suite stopped a
    // supervised gateway mid-run). This test asserts the ROUTE, not the OS.
    const stoppedPid = 4242;
    setGatewayShutdownForTest(async () => ({ stopped: true, pid: stoppedPid }));
    try {
      const operator = await authedFetch('/api/admin/shutdown', 'POST', { target: 'gateway' }, operatorToken);
      expect(operator.status).toBe(200);
      const body = (await operator.json()) as { ok: boolean; target: string; stopped: boolean; pid?: number };
      expect(body.ok).toBe(true);
      expect(body.target).toBe('gateway');
      expect(body.stopped).toBe(true);
      expect(body.pid).toBe(stoppedPid);
    } finally {
      setGatewayShutdownForTest(null);
    }
  });

  it('admin stopping the gateway responds ok when nothing is running', async () => {
    setGatewayShutdownForTest(async () => ({ stopped: false, reason: 'no running gateway process found' }));
    try {
      const res = await authedFetch('/api/admin/shutdown', 'POST', { target: 'gateway' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; stopped: boolean; reason?: string };
      expect(body.ok).toBe(true);
      expect(body.stopped).toBe(false);
      expect(typeof body.reason).toBe('string');
    } finally {
      setGatewayShutdownForTest(null);
    }
  });
});

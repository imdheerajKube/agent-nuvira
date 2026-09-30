/**
 * "Verify next N" API — /api/models/verify-next.
 *
 * Real HTTP against a server on a random port, with file-based admin auth.
 *
 * What is worth pinning at THIS layer (the run itself is unit-tested in
 * `tests/learning/model-verify-job.test.ts`) is the boundary: who may spend the
 * user's provider quota, and what the response says when there is nothing to
 * spend it on.
 *
 *   - the READ is open, like `/api/model-timeline` — the page it renders on is
 *     already readable without a session;
 *   - the WRITE is gated on `routing.operate`, because a spot-check is a real
 *     generation against a real key;
 *   - the per-run CAP is applied by the SERVER, so a hand-rolled client asking
 *     for 1000 models still gets the cap;
 *   - an empty backlog is a refusal with a reason, not a 500 and not a silent
 *     no-op — the user asked for work and deserves to be told there was none.
 *
 * No provider is reachable here, so nothing is servable and every run refuses.
 * That is exactly the deterministic case this file needs: it exercises the plan
 * step and the response shape without ever touching the network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-verify-next-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

/** The band the client renders, which the server owns. */
const DEFAULT_COUNT = 10;
const MAX_COUNT = 25;

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let token = '';
let viewerToken = '';

function authedFetch(path: string, method = 'GET', body?: unknown, tok = token): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

interface RunState {
  status: 'idle' | 'running' | 'done';
  requested: number;
  planned: number;
  refusal: string | null;
  defaultCount?: number;
  maxCount?: number;
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
  token = setupData.token as string;

  const addViewer = await authedFetch('/api/admin/users', 'POST', {
    user: 'viewer',
    password: 'viewer-pass-123',
    role: 'viewer',
  });
  expect(addViewer.status).toBe(200);
  const vLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  const vData = (await vLogin.json()) as { token?: string };
  viewerToken = vData.token as string;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('/api/models/verify-next — reads', () => {
  it('is readable without a session, like the timeline it sits on', async () => {
    const res = await fetch(`${baseUrl}/api/models/verify-next`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunState;
    expect(body.status).toBe('idle');
    expect(body.planned).toBe(0);
  });

  it('publishes the band the server will accept, so the field cannot invent one', async () => {
    const body = (await (await fetch(`${baseUrl}/api/models/verify-next`)).json()) as RunState;
    expect(body.defaultCount).toBe(DEFAULT_COUNT);
    expect(body.maxCount).toBe(MAX_COUNT);
  });
});

describe('/api/models/verify-next — the write gate', () => {
  it('rejects an unauthenticated start (401)', async () => {
    const res = await fetch(`${baseUrl}/api/models/verify-next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 5 }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a viewer (403) — spending provider quota needs routing.operate', async () => {
    const res = await authedFetch('/api/models/verify-next', 'POST', { count: 5 }, viewerToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/role 'viewer'/);
  });
});

describe('/api/models/verify-next — an empty backlog is a refusal, not a failure', () => {
  it('reports nothing-to-verify with a reason instead of a 500', async () => {
    const res = await authedFetch('/api/models/verify-next', 'POST', { count: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; started: boolean; refusal: string; state: RunState };
    expect(body.ok).toBe(false);
    expect(body.started).toBe(false);
    // No provider is reachable in this environment, so there is genuinely no
    // actionable candidate — and the wording has to say that rather than implying
    // the catalog is empty or the check failed.
    expect(body.refusal).toMatch(/nothing to verify/i);
    expect(body.state.status).toBe('idle');
  });

  it('applies the CAP server-side, whatever the client asks for', async () => {
    const res = await authedFetch('/api/models/verify-next', 'POST', { count: 1000 });
    const body = (await res.json()) as { state: RunState };
    expect(body.state.requested).toBe(MAX_COUNT);
    expect(body.state.planned).toBe(0);
  });

  it('falls back to the default for a count that is not a number', async () => {
    const res = await authedFetch('/api/models/verify-next', 'POST', { count: '5' });
    const body = (await res.json()) as { state: RunState };
    expect(body.state.requested).toBe(DEFAULT_COUNT);
  });

  it('keeps the refusal readable on a later read, so a reload still explains itself', async () => {
    await authedFetch('/api/models/verify-next', 'POST', { count: 5 });
    const body = (await (await fetch(`${baseUrl}/api/models/verify-next`)).json()) as RunState;
    expect(body.status).toBe('idle');
    expect(body.refusal).toMatch(/nothing to verify/i);
  });
});

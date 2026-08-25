/**
 * P1 — /api/tasks integration tests.
 *
 * Real HTTP against a server started on a random port, with admin auth
 * configured via the env override (BUFF_DASHBOARD_ADMIN_PASSWORD). The task
 * runner is pointed at a fixture script (BUFF_DASHBOARD_TASK_CLI_ENTRY) so no
 * real CLI runs. Covers the auth gates, start/list/detail, cancel, and the
 * SSE events stream (?token= — EventSource can't set headers).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-task-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_DASHBOARD_ADMIN_PASSWORD = 'test-password-123';
process.env.NUVIRA_DASHBOARD_ADMIN_USER = 'admin';

const FIXTURE = `
const mode = process.env.NUVIRA_TASK_FIXTURE_MODE || 'ok';
if (mode === 'ok') {
  console.log('fixture-ok');
  console.error('fixture-err');
  process.exit(0);
} else if (mode === 'sleep') {
  setTimeout(() => {}, 120000);
}
`;
const entryPath = join(testDir, 'fixture.cjs');
writeFileSync(entryPath, FIXTURE, 'utf-8');
process.env.NUVIRA_DASHBOARD_TASK_CLI_ENTRY = entryPath;

vi.mock('node:os', () => ({
  homedir: () => testDir,
}));

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let token = '';

async function waitForTask(id: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/tasks/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { task?: Record<string, unknown> };
    if (body.task && body.task.status !== 'running') return body.task;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for task ${id} to finish`);
}

function authedFetch(path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Open an SSE stream and resolve on the first named event. */
function openSSE(url: string): Promise<{ waitFor: (name: string, timeoutMs?: number) => Promise<{ event: string; data: unknown }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let buffer = '';
      const received: Array<{ event: string; data: unknown }> = [];
      const waiters: Array<{
        name: string;
        resolve: (v: { event: string; data: unknown }) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }> = [];
      const emit = (name: string, data: unknown) => {
        const idx = waiters.findIndex((w) => w.name === name);
        if (idx !== -1) {
          const w = waiters.splice(idx, 1)[0];
          clearTimeout(w.timer);
          w.resolve({ event: name, data });
          return;
        }
        received.push({ event: name, data });
      };
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const eventMatch = block.match(/event: (.+)/);
          const dataMatch = block.match(/data: (.+)/);
          if (eventMatch && dataMatch) {
            let parsed: unknown = null;
            try { parsed = JSON.parse(dataMatch[1]); } catch { /* keep null */ }
            emit(eventMatch[1], parsed);
          }
        }
      });
      res.on('error', () => { /* destroyed */ });
      resolve({
        waitFor: (name: string, timeoutMs = 5000) => {
          const idx = received.findIndex((e) => e.event === name);
          if (idx !== -1) return Promise.resolve(received.splice(idx, 1)[0]);
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => rejectWait(new Error(`Timed out waiting for SSE '${name}'`)), timeoutMs);
            waiters.push({ name, resolve: resolveWait, reject: rejectWait, timer });
          });
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'test-password-123' }),
  });
  const loginData = (await login.json()) as { token?: string };
  expect(loginData.token).toBeTruthy();
  token = loginData.token as string;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.NUVIRA_TASK_FIXTURE_MODE;
});

describe('/api/tasks', () => {
  it('rejects unauthenticated requests (401) and unknown ids (404)', async () => {
    const noAuth = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: ['x'] }) });
    expect(noAuth.status).toBe(401);

    const missing = await authedFetch('/api/tasks/nope');
    expect(missing.status).toBe(404);
  });

  it('rejects invalid task bodies (400)', async () => {
    const bad = await authedFetch('/api/tasks', 'POST', { args: 'not-an-array' });
    expect(bad.status).toBe(400);
    const empty = await authedFetch('/api/tasks', 'POST', { args: [] });
    expect(empty.status).toBe(400);
  });

  it('starts a task, streams it to done, and lists history', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'ok';
    const start = await authedFetch('/api/tasks', 'POST', { args: ['fixture'], timeoutMs: 10_000 });
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as { ok: boolean; task: { id: string; status: string } };
    expect(startBody.ok).toBe(true);
    expect(startBody.task.status).toBe('running');

    const finished = await waitForTask(startBody.task.id);
    expect(finished.status).toBe('done');
    expect(finished.exitCode).toBe(0);
    const logs = finished.logs as Array<{ text: string }>;
    expect(logs.map((l) => l.text).join('\n')).toContain('fixture-ok');

    const list = await authedFetch('/api/tasks');
    const listBody = (await list.json()) as { tasks: Array<{ id: string }> };
    expect(listBody.tasks.map((t) => t.id)).toContain(startBody.task.id);
  });

  it('cancel() terminates a running task (status cancelled)', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep';
    const start = await authedFetch('/api/tasks', 'POST', { args: ['fixture'], timeoutMs: 60_000 });
    const startBody = (await start.json()) as { ok: boolean; task: { id: string } };
    expect(startBody.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));

    const cancel = await authedFetch(`/api/tasks/${startBody.task.id}/cancel`, 'POST');
    const cancelBody = (await cancel.json()) as { ok: boolean };
    expect(cancelBody.ok).toBe(true);

    const finished = await waitForTask(startBody.task.id);
    expect(finished.status).toBe('cancelled');
  });

  it('streams log + status events over SSE (?token= auth)', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'ok';
    const start = await authedFetch('/api/tasks', 'POST', { args: ['fixture'], timeoutMs: 10_000 });
    const startBody = (await start.json()) as { ok: boolean; task: { id: string } };

    const sse = await openSSE(`${baseUrl}/api/tasks/${startBody.task.id}/events?token=${encodeURIComponent(token)}`);
    try {
      const init = await sse.waitFor('init');
      expect((init.data as { id: string }).id).toBe(startBody.task.id);
      const log = await sse.waitFor('log');
      expect((log.data as { text: string }).text).toContain('fixture-ok');
      const status = await sse.waitFor('status');
      expect((status.data as { status: string }).status).toBe('done');
    } finally {
      sse.close();
    }
  }, 15_000);

  it('rejects the SSE stream without a valid token (401)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nope/events?token=invalid`);
    expect(res.status).toBe(401);
  });
});

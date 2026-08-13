/**
 * P3 — /api/chat integration tests (dashboard chat console).
 *
 * Real HTTP against a server on a random port. The server's chat console is
 * swapped for a fake-engine console (setChatConsoleForTest) so NO real LLM or
 * tool loop runs — the API surface (auth gates, message turns, session id,
 * reset) is tested end-to-end with the same console logic the GUI drives.
 * File-based auth (setup) so a viewer-role user can exercise the RBAC gate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-chat-api-'));
const memoryDir = join(testDir, '.buff', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
// BUFF_CONFIG_DIR keeps admin.json / rbac.json hermetic (never the real ~/.buff).
process.env.BUFF_DASHBOARD_PORT = '0';
process.env.BUFF_DASHBOARD_HOST = '127.0.0.1';
process.env.BUFF_MEMORY_DIR = memoryDir;
process.env.BUFF_CONFIG_DIR = join(testDir, '.buff');

const { createDashboardServer, setChatConsoleForTest } = await import('../../src/web-dashboard/server.js');
const { ChatConsole } = await import('../../src/web-dashboard/chat-console.js');
import type { ChatEngine } from '../../src/web-dashboard/chat-console.js';

/** Fake engine: records calls, returns canned answers — no LLM, no tools. */
class FakeEngine implements ChatEngine {
  calls: Array<{ message: string; opts?: unknown }> = [];
  async answerOnce(message: string, opts?: unknown): Promise<{ content: string; followups: unknown[]; provider?: string; model?: string }> {
    this.calls.push({ message, opts });
    return {
      content: `echo: ${message}`,
      followups: [{ prompt: 'What next?', label: 'Next' }],
      provider: 'groq',
      model: 'llama-3.3-70b',
    };
  }
}

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let token = '';
let viewerToken = '';
let engine: FakeEngine;

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

  const addViewer = await authedFetch('/api/admin/users', 'POST', { user: 'viewer', password: 'viewer-pass-123', role: 'viewer' });
  expect(addViewer.status).toBe(200);
  const vLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  const vData = (await vLogin.json()) as { token?: string; role?: string };
  expect(vData.role).toBe('viewer');
  viewerToken = vData.token as string;

  engine = new FakeEngine();
  setChatConsoleForTest(new ChatConsole({ engine }));
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('/api/chat', () => {
  it('rejects unauthenticated and viewer requests', async () => {
    const noAuth = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
    expect(noAuth.status).toBe(401);
    const viewer = await authedFetch('/api/chat', 'POST', { message: 'hi' }, viewerToken);
    expect(viewer.status).toBe(403);
  });

  it('rejects empty messages (400)', async () => {
    const res = await authedFetch('/api/chat', 'POST', { message: '   ' });
    expect(res.status).toBe(400);
  });

  it('answers a message and returns content + followups + a session id', async () => {
    const res = await authedFetch('/api/chat', 'POST', { message: 'hello agent' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      sessionId: string;
      content: string;
      followups: Array<{ prompt: string }>;
      provider: string;
      model: string;
    };
    expect(body.ok).toBe(true);
    expect(body.content).toBe('echo: hello agent');
    expect(body.followups[0].prompt).toBe('What next?');
    expect(body.provider).toBe('groq');
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].message).toBe('hello agent');
  });

  it('threads conversation history across messages in the same session', async () => {
    const s1 = await authedFetch('/api/chat', 'POST', { sessionId: 'test-session-1', message: 'first' });
    expect(s1.status).toBe(200);
    const s2 = await authedFetch('/api/chat', 'POST', { sessionId: 'test-session-1', message: 'second' });
    expect(s2.status).toBe(200);
    // The second turn carried the first turn's history (user + assistant).
    const secondCall = engine.calls[engine.calls.length - 1];
    const opts = secondCall.opts as { history?: Array<{ role: string; content: string }> };
    expect(opts.history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'echo: first' },
    ]);
  });

  it('reset clears the session history', async () => {
    await authedFetch('/api/chat', 'POST', { sessionId: 'reset-session', message: 'one' });
    const reset = await authedFetch('/api/chat/reset', 'POST', { sessionId: 'reset-session' });
    expect(reset.status).toBe(200);
    const again = await authedFetch('/api/chat', 'POST', { sessionId: 'reset-session', message: 'two' });
    expect(again.status).toBe(200);
    const lastCall = engine.calls[engine.calls.length - 1];
    const opts = lastCall.opts as { history?: unknown[] };
    expect(opts.history ?? []).toHaveLength(0);
  });
});

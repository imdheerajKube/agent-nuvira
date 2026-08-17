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
  /** When set, the engine emits these lines via onProgress before answering. */
  progressLines: string[] = [];
  /** P0.6 — when set, the engine emits these tool calls via onToolCall. */
  toolCalls: Array<{ phase: 'started' | 'called'; tool: string; args?: Record<string, unknown>; ok?: boolean; result?: string; error?: string; durationMs?: number }> = [];
  /** P0.7 — when set, the engine emits these plan mutations via onPlanChange. */
  planChanges: Array<{ goal: string; steps: Array<{ id: string; description: string; status: string }>; revision: number }> = [];
  /** P3b — when set, the engine emits these git diffs via onGitDiff. */
  gitDiffs: Array<{ files: Array<{ path: string; body: string }>; summary: string }> = [];
  async answerOnce(message: string, opts?: unknown): Promise<{ content: string; followups: unknown[]; provider?: string; model?: string }> {
    this.calls.push({ message, opts });
    const o = opts as { onProgress?: (line: string) => void; onToolCall?: (phase: 'started' | 'called', info: { id?: string; tool: string; args?: Record<string, unknown>; ok?: boolean; result?: string; error?: string; durationMs?: number }) => void; onPlanChange?: (p: { goal: string; steps: Array<{ id: string; description: string; status: string }>; revision: number }) => void; onGitDiff?: (d: { files: Array<{ path: string; body: string }>; summary: string }) => void };
    for (const line of this.progressLines) o.onProgress?.(line);
    for (const t of this.toolCalls) {
      o.onToolCall?.(t.phase, { id: `call_${t.tool}`, tool: t.tool, args: t.args, ok: t.ok, result: t.result, error: t.error, durationMs: t.durationMs });
    }
    for (const p of this.planChanges) o.onPlanChange?.(p);
    for (const d of this.gitDiffs) o.onGitDiff?.(d);
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

  it('streams live progress over the SSE events endpoint during a turn', async () => {
    engine.progressLines = ['→ calling tool: read_file', '→ tool result received'];
    const sessionId = 'progress-session-1';
    // Subscribe FIRST (as the GUI does) — the onEvent listener is registered
    // synchronously in the handler, so once the fetch resolves the subscription
    // is live. Then POST the message; the turn's progress lines stream back.
    const res = await fetch(`${baseUrl}/api/chat/${sessionId}/events?token=${encodeURIComponent(token)}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const received: string[] = [];
    const postPromise = authedFetch('/api/chat', 'POST', { sessionId, message: 'analyze the repo' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && received.length < 2) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 250)),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      // Parse complete `event: progress` frames out of the buffer.
      let idx: number;
      while ((idx = buffer.indexOf('event: progress')) !== -1) {
        buffer = buffer.slice(idx);
        const lineIdx = buffer.indexOf('data: ');
        const frameEnd = buffer.indexOf('\n\n');
        if (lineIdx === -1 || frameEnd === -1) break;
        const data = buffer.slice(lineIdx + 6, frameEnd);
        try {
          const payload = JSON.parse(data) as { line?: string };
          if (payload.line) received.push(payload.line);
        } catch { /* partial frame */ }
        buffer = buffer.slice(frameEnd + 2);
      }
    }
    await reader.cancel();
    const post = await postPromise;
    engine.progressLines = [];
    expect(post.status).toBe(200);
    expect(received).toEqual(['→ calling tool: read_file', '→ tool result received']);
  });

  it('P0.6 — streams tool-call lifecycle events over SSE (id, phase, args, ok, duration)', async () => {
    engine.toolCalls = [
      { phase: 'started', tool: 'read_file', args: { path: 'src/foo.ts' } },
      { phase: 'called', tool: 'read_file', ok: true, result: '1 | export const x = 1;', durationMs: 12 },
      { phase: 'started', tool: 'run_terminal', args: { command: 'npm test' } },
      { phase: 'called', tool: 'run_terminal', ok: false, error: 'exit 1', durationMs: 300 },
    ];
    const sessionId = 'tool-session-1';
    const res = await fetch(`${baseUrl}/api/chat/${sessionId}/events?token=${encodeURIComponent(token)}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const received: Array<Record<string, unknown>> = [];
    const postPromise = authedFetch('/api/chat', 'POST', { sessionId, message: 'inspect' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && received.length < 4) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 250)),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('event: tool')) !== -1) {
        buffer = buffer.slice(idx);
        const lineIdx = buffer.indexOf('data: ');
        const frameEnd = buffer.indexOf('\n\n');
        if (lineIdx === -1 || frameEnd === -1) break;
        const data = buffer.slice(lineIdx + 6, frameEnd);
        try {
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (payload.tool) received.push(payload);
        } catch { /* partial frame */ }
        buffer = buffer.slice(frameEnd + 2);
      }
    }
    await reader.cancel();
    const post = await postPromise;
    engine.toolCalls = [];
    expect(post.status).toBe(200);
    expect(received).toHaveLength(4);
    // started→called pairs carry the same id; args summary + ok + duration ride along.
    expect(received[0]).toMatchObject({ tool: 'read_file', phase: 'started', id: 'call_read_file', args: '{path: "src/foo.ts"}' });
    expect(received[1]).toMatchObject({ tool: 'read_file', phase: 'called', id: 'call_read_file', ok: true, durationMs: 12 });
    expect(received[2]).toMatchObject({ tool: 'run_terminal', phase: 'started', args: '{command: "npm test"}' });
    expect(received[3]).toMatchObject({ tool: 'run_terminal', phase: 'called', ok: false, durationMs: 300 });
  });

  it('P0.7 — streams plan mutations over SSE (goal + steps + revision)', async () => {
    engine.planChanges = [
      { goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce', status: 'pending' }], revision: 1 },
      { goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce', status: 'done' }], revision: 2 },
    ];
    const sessionId = 'plan-session-1';
    const res = await fetch(`${baseUrl}/api/chat/${sessionId}/events?token=${encodeURIComponent(token)}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const received: Array<Record<string, unknown>> = [];
    const postPromise = authedFetch('/api/chat', 'POST', { sessionId, message: 'fix the test' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && received.length < 2) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 250)),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('event: plan')) !== -1) {
        buffer = buffer.slice(idx);
        const lineIdx = buffer.indexOf('data: ');
        const frameEnd = buffer.indexOf('\n\n');
        if (lineIdx === -1 || frameEnd === -1) break;
        const data = buffer.slice(lineIdx + 6, frameEnd);
        try {
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (payload.goal) received.push(payload);
        } catch { /* partial frame */ }
        buffer = buffer.slice(frameEnd + 2);
      }
    }
    await reader.cancel();
    const post = await postPromise;
    engine.planChanges = [];
    expect(post.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ goal: 'Fix the failing test', revision: 1 });
    expect(received[1]).toMatchObject({ goal: 'Fix the failing test', revision: 2 });
  });

  it('P3b — streams git diff payloads over SSE (files + summary)', async () => {
    engine.gitDiffs = [
      {
        files: [{ path: 'a.txt', body: 'diff --git a/a.txt b/a.txt\n+three' }],
        summary: '1 file changed',
      },
    ];
    const sessionId = 'diff-session-1';
    const res = await fetch(`${baseUrl}/api/chat/${sessionId}/events?token=${encodeURIComponent(token)}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const received: Array<Record<string, unknown>> = [];
    const postPromise = authedFetch('/api/chat', 'POST', { sessionId, message: 'show the diff' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && received.length < 1) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 250)),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('event: diff')) !== -1) {
        buffer = buffer.slice(idx);
        const lineIdx = buffer.indexOf('data: ');
        const frameEnd = buffer.indexOf('\n\n');
        if (lineIdx === -1 || frameEnd === -1) break;
        const data = buffer.slice(lineIdx + 6, frameEnd);
        try {
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (Array.isArray(payload.files)) received.push(payload);
        } catch { /* partial frame */ }
        buffer = buffer.slice(frameEnd + 2);
      }
    }
    await reader.cancel();
    const post = await postPromise;
    engine.gitDiffs = [];
    expect(post.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ summary: '1 file changed' });
  });

  it('rejects the SSE events endpoint without a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/chat/no-such-session/events?token=bad`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});

describe('/api/chat/resolve — plain-English → CLI short-circuit', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/chat/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'stop the dashboard' }) });
    expect(res.status).toBe(401);
  });

  it('resolves "stop the dashboard" to the dashboard.stop command', async () => {
    const res = await authedFetch('/api/chat/resolve', 'POST', { message: 'stop the dashboard' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; matches: Array<{ intent: string; command?: string; confirmation?: boolean }> };
    expect(body.ok).toBe(true);
    const top = body.matches[0];
    expect(top?.intent).toBe('dashboard.stop');
    expect(top?.command).toBe('buff dashboard stop');
    expect(top?.confirmation).toBe(true);
  });

  it('marks an add-contact ask as ambiguous with two resolution options', async () => {
    const res = await authedFetch('/api/chat/resolve', 'POST', { message: 'add Rahul mobile +919958604222 to whatsapp' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: Array<{ ambiguous?: boolean; options?: Array<{ command: string }> }> };
    const top = body.matches[0];
    expect(top?.ambiguous).toBe(true);
    const commands = top?.options?.map((o) => o.command) ?? [];
    expect(commands).toContain('buff config gateway allow whatsapp user 919958604222');
    expect(commands).toContain('buff whatsapp contact add Rahul 919958604222');
  });

  it('returns no matches for an ordinary chat message (falls through to the agent)', async () => {
    const res = await authedFetch('/api/chat/resolve', 'POST', { message: 'what is the meaning of life' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: unknown[] };
    expect(body.matches.length).toBe(0);
  });
});

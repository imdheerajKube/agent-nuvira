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

/** Poll until a condition holds (real-HTTP tests have no testing-library). */
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-chat-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
// BUFF_CONFIG_DIR keeps admin.json / rbac.json hermetic (never the real ~/.nuvira).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
// HOME pin keeps homedir()-resolved stores (SkillStore, drafts) off the
// developer's real ~/.nuvira — the P6a accept path writes both.
process.env.HOME = testDir;

const { createDashboardServer, setChatConsoleForTest, runChatRetryDrainForTest } = await import('../../src/web-dashboard/server.js');
const { ChatConsole } = await import('../../src/web-dashboard/chat-console.js');
import type { ChatEngine } from '../../src/web-dashboard/chat-console.js';
const { recordFailoverAttempt } = await import('../../src/learning/resilient-call.js');
const { debugLogDir, sessionDebugLog } = await import('../../src/observability/debug-log.js');
const { getPendingTask, listPendingTasks, removeDeferredTask, updateDeferredTask } = await import('../../src/learning/deferred-task.js');

/** Fake engine: records calls, returns canned answers — no LLM, no tools. */
class FakeEngine implements ChatEngine {
  calls: Array<{ message: string; opts?: unknown }> = [];
  /** When set, the engine emits these lines via onProgress before answering. */
  progressLines: string[] = [];
  /**
   * P4 — when true, answerOnce waits for the injected signal to abort, then
   * resolves (simulates the engine stopping on the Cancel button).
   */
  honorSignal = false;
  /** P0.6 — when set, the engine emits these tool calls via onToolCall. */
  toolCalls: Array<{ phase: 'started' | 'called'; tool: string; args?: Record<string, unknown>; ok?: boolean; result?: string; error?: string; durationMs?: number }> = [];
  /** P0.7 — when set, the engine emits these plan mutations via onPlanChange. */
  planChanges: Array<{ goal: string; steps: Array<{ id: string; description: string; status: string }>; revision: number }> = [];
  /** P3b — when set, the engine emits these git diffs via onGitDiff. */
  gitDiffs: Array<{ files: Array<{ path: string; body: string }>; summary: string }> = [];
  /** E2E — when set, the engine answers with this exact content (the model
   *  "wrote" a ```diff block directly in its answer — the artifact-card path). */
  answerContent: string | null = null;
  /**
   * Deferred retries — when true the turn FAILS to generate (no model
   * answered), which is the case that offers "keep trying" and queues the ask.
   * Set per test; the engine flips it off to let a retry succeed.
   */
  generationFailed = false;
  /** What the failover walk recorded while this turn was failing (see seedFailoverAttempts). */
  failoverAttempts: Array<Parameters<typeof recordFailoverAttempt>[0]> = [];
  /**
   * WS5 (#27) — the isolation this turn reports having run in, when it did.
   *
   * Set by the test to stand in for the REAL worktree the engine made: the route
   * must pass this through untouched (it is what the GUI card renders), and must
   * report NOTHING when it is absent — which is how a refused turn reads.
   */
  worktreeAnswer: {
    dir: string;
    base: string;
    /** The REAL wire shape: `files` is the changed PATHS; `payload` is the diff body. */
    diff: { files: string[]; summary: string; unchanged: boolean; payload: { files: Array<{ path: string; body: string }>; summary: string } };
    removed: boolean;
  } | null = null;
  /** WS5 (#27) — what this turn's resume replayed, when the engine reported one. */
  resumeAnswer: { id: string; replayed: number; modelCalls: number; saved: boolean; notice: string } | null = null;
  /**
   * WS5 (#27) — stand in for a turn that REFUSED to run, returning the reason as
   * its content with `generationFailed` AND `refused`. Both, because that is what
   * the engine actually returns and the route must treat them differently: the
   * first says "failed", the second says "do not retry this".
   */
  refusedAnswer: string | null = null;
  async answerOnce(message: string, opts?: unknown): Promise<{ content: string; followups: unknown[]; provider?: string; model?: string; generationFailed?: boolean }> {
    this.calls.push({ message, opts });
    const o = opts as { onProgress?: (line: string) => void; onToolCall?: (phase: 'started' | 'called', info: { id?: string; tool: string; args?: Record<string, unknown>; ok?: boolean; result?: string; error?: string; durationMs?: number }) => void; onPlanChange?: (p: { goal: string; steps: Array<{ id: string; description: string; status: string }>; revision: number }) => void; onGitDiff?: (d: { files: Array<{ path: string; body: string }>; summary: string }) => void };
    for (const line of this.progressLines) o.onProgress?.(line);
    for (const t of this.toolCalls) {
      o.onToolCall?.(t.phase, { id: `call_${t.tool}`, tool: t.tool, args: t.args, ok: t.ok, result: t.result, error: t.error, durationMs: t.durationMs });
    }
    for (const p of this.planChanges) o.onPlanChange?.(p);
    for (const d of this.gitDiffs) o.onGitDiff?.(d);
    // P4 — a turn that honors the cancel signal stays in flight until the
    // server's abort (client disconnect) fires the injected signal.
    if (this.honorSignal) {
      const sig = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (sig) {
        return new Promise((resolve) => {
          sig.addEventListener('abort', () => resolve({ content: 'late answer after abort', followups: [] }));
        });
      }
    }
    if (this.refusedAnswer !== null) {
      // Attempts recorded BEFORE the refusal, which is the real order on this
      // path: the provider walk runs first, and only then does the turn discover
      // it cannot isolate. Without this the retry broker has nothing in its window
      // and cannot report, so a test could not tell whether the route's refusal
      // guard does anything (measured: the whole refused-turn test passed with the
      // guard removed until these attempts were seeded).
      for (const a of this.failoverAttempts) recordFailoverAttempt(a);
      return {
        content: this.refusedAnswer,
        followups: [],
        generationFailed: true,
        refused: true,
        provider: 'groq',
        model: 'llama-3.3-70b',
      };
    }
    if (this.generationFailed) {
      // Logged HERE, mid-turn — the same window the real walk records into.
      for (const a of this.failoverAttempts) recordFailoverAttempt(a);
      return { content: '', followups: [], generationFailed: true, provider: 'groq', model: 'llama-3.3-70b' };
    }
    return {
      content: this.answerContent ?? `echo: ${message}`,
      followups: [{ prompt: 'What next?', label: 'Next' }],
      provider: 'groq',
      model: 'llama-3.3-70b',
      ...(this.worktreeAnswer ? { worktree: this.worktreeAnswer } : {}),
      ...(this.resumeAnswer ? { resume: this.resumeAnswer } : {}),
    };
  }
}

/**
 * Stand in for the failover walk having called two models that both gave up.
 *
 * Returned (not recorded) so the FAKE ENGINE logs them DURING the turn, exactly
 * as the real walk does — the route marks the log before the turn, so attempts
 * recorded beforehand are correctly outside the window being reported.
 */
function seedFailoverAttempts(): Array<Parameters<typeof recordFailoverAttempt>[0]> {
  return ['gemini-3.1-flash-lite', 'llama-3.3-70b-versatile'].map((model) => ({
    provider: model.startsWith('gemini') ? 'gemini' : 'groq',
    model,
    kind: 'rate-limit',
    skipped: false,
    reason: 'rate limited (quota) — still logged in, just throttled',
  }));
}

/** Read an SSE stream, collecting parsed events until closed. */
async function openSSE(url: string): Promise<{ events: Array<{ event: string; data: string }>; close: () => void }> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          events.push({
            event: /event: ([^\n]+)/.exec(chunk)?.[1] ?? 'message',
            data: /data: ([^\n]*)/.exec(chunk)?.[1] ?? '',
          });
          idx = buf.indexOf('\n\n');
        }
      }
    } catch {
      /* stream closed */
    }
  })();
  return { events, close: () => controller.abort() };
}

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let token = '';
let viewerToken = '';
let engine: FakeEngine;
let console_: ChatConsole;

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
  console_ = new ChatConsole({ engine });
  setChatConsoleForTest(console_);
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

  it('WS5 — passes the GUI`s isolation request to the engine and reports the worktree it ran in', async () => {
    engine.worktreeAnswer = {
      dir: '/tmp/profile/.nuvira/worktrees/fix-the-retry-bug-abc',
      base: '1234567890abcdef',
      diff: {
        // Paths, and the diff body beside them — mirroring `WorktreeDiff` exactly,
        // because a fixture in the wrong shape is how the client guard came to
        // reject every real payload while its test passed.
        files: ['src/retry.ts'],
        summary: '1 file changed against 1234567',
        unchanged: false,
        payload: {
          files: [{ path: 'src/retry.ts', body: '@@ -1 +1 @@\n-old\n+new\n' }],
          summary: '1 file changed against 1234567',
        },
      },
      removed: true,
    };
    engine.resumeAnswer = { id: 'cp-abc', replayed: 2, modelCalls: 1, saved: true, notice: '↩️  resume cp-abc: replayed 2, made 1 model call(s)' };
    const res = await authedFetch('/api/chat', 'POST', { message: 'fix the retry bug', worktree: true, keepWorktree: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      worktree?: { dir: string; base: string; removed: boolean; diff: { files: string[]; payload: { files: Array<{ path: string }> } } };
      resume?: { replayed: number; modelCalls: number; notice: string };
    };
    // ASKED FOR: the engine sees the request, so isolation is not a GUI-only idea.
    const opts = engine.calls.at(-1)?.opts as { worktree?: boolean; keepWorktree?: boolean };
    expect(opts.worktree).toBe(true);
    expect(opts.keepWorktree).toBe(true);
    // REPORTED: the diff and its base ride back, which is what the card renders.
    expect(body.worktree?.dir).toBe('/tmp/profile/.nuvira/worktrees/fix-the-retry-bug-abc');
    expect(body.worktree?.base).toBe('1234567890abcdef');
    expect(body.worktree?.removed).toBe(true);
    expect(body.worktree?.diff.files).toEqual(['src/retry.ts']);
    expect(body.worktree?.diff.payload.files.map((f) => f.path)).toEqual(['src/retry.ts']);
    expect(body.resume?.replayed).toBe(2);
    expect(body.resume?.notice).toContain('replayed 2');
    engine.worktreeAnswer = null;
    engine.resumeAnswer = null;
  });

  it('WS5 — sends NO isolation keys when the GUI did not ask, so the deployment environment still decides', async () => {
    // The tri-state that matters: an untouched control must be ABSENT (the
    // deployment's `NUVIRA_ISOLATE` is then in charge), not `false` (which would
    // be this one turn explicitly declining it).
    const res = await authedFetch('/api/chat', 'POST', { message: 'just saying hi' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worktree?: unknown; resume?: unknown };
    const opts = engine.calls.at(-1)?.opts as { worktree?: unknown; keepWorktree?: unknown; resume?: unknown };
    expect(opts.worktree).toBeUndefined();
    expect(opts.keepWorktree).toBeUndefined();
    expect(opts.resume).toBeUndefined();
    // And a turn the engine did not isolate reports none — including a REFUSED one,
    // whose refusal is the turn's own content. A card over such a turn would be the
    // single worst outcome this feature exists to prevent.
    expect(body.worktree).toBeUndefined();
    expect(body.resume).toBeUndefined();
  });

  it('WS5 — a REFUSED turn reaches the client as a refusal, and is never offered a retry', async () => {
    engine.refusedAnswer =
      'Isolation was requested for this turn, but the work could not be isolated: /tmp/x is not inside a git work tree.\nNothing ran.';
    // The provider walk failed before the refusal, so the retry broker HAS a report
    // to offer — the case where a refusal would otherwise be handed a "keep trying"
    // affordance and a queued background re-run of an ask that cannot succeed.
    engine.failoverAttempts = seedFailoverAttempts();
    const res = await authedFetch('/api/chat', 'POST', { message: 'write a file', worktree: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      content: string;
      refused?: boolean;
      generationFailed?: boolean;
      retryQueued?: boolean;
    };
    // The reason reaches the reader — NOT replaced by the sweep's canned "could not
    // get an answer from the model" line, which blames the model for a decision
    // about the directory (measured before this was fixed).
    expect(body.content).toContain('Isolation was requested');
    expect(body.content).toContain('Nothing ran');
    expect(body.refused).toBe(true);
    // Still a FAILED turn, so no client renders the reason as an answer.
    expect(body.generationFailed).toBe(true);
    // And nothing was queued to re-run: the same ask in the same directory refuses
    // the same way, so a background retry would be an infinite loop of refusals
    // billed to the operator.
    expect(body.retryQueued).toBeFalsy();
    engine.refusedAnswer = null;
  });

  it('P4 — cancels the in-flight turn when the client disconnects (abort)', async () => {
    engine.honorSignal = true;
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: 'cancel-session', message: 'long task' }),
      signal: controller.signal,
    });
    // The turn started server-side (the engine is in flight, honoring the signal).
    await until(() => console_.isBusy('cancel-session'));
    // The client hits Cancel → the POST aborts → the server sees the response
    // stream close (never written) and cancels the turn (busy released).
    controller.abort();
    await pending.catch(() => {}); // the aborted fetch rejects client-side
    await until(() => !console_.isBusy('cancel-session'));
    // The cancelled turn was discarded: nothing persisted for the session.
    expect(console_.history('cancel-session')).toHaveLength(0);
    engine.honorSignal = false;
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

// ─── WS2 (#24) — the support bundle, from the chat the user is looking at ───

describe('/api/chat/:sessionId/support-bundle — WS2 session debug log', () => {
  const SESSION = 'bundle-session';

  /** Write one turn's debug log, the way the console would at turn end. */
  function writeTurnLog(session: string, at: number): void {
    const log = sessionDebugLog({
      surface: 'dashboard-chat',
      session,
      goal: 'why is this not answering',
      now: () => at,
    });
    expect(log, 'the case is meaningless with logging off').not.toBeNull();
    log!.backendOf({ provider: 'groq', model: 'stub-model', transport: 'native' });
    log!.event('turn.end', { ok: true });
    expect(log!.write(), 'the log must actually land on disk').toBeTruthy();
  }

  /** Run a case with session debug logging ON, restoring the env afterwards. */
  async function withLogging(fn: () => Promise<void>): Promise<void> {
    const previous = process.env.NUVIRA_DEBUG_LOG;
    process.env.NUVIRA_DEBUG_LOG = '1';
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.NUVIRA_DEBUG_LOG;
      else process.env.NUVIRA_DEBUG_LOG = previous;
    }
  }

  it('rejects unauthenticated and viewer requests', async () => {
    const noAuth = await fetch(`${baseUrl}/api/chat/${SESSION}/support-bundle`);
    expect(noAuth.status).toBe(401);
    const viewer = await authedFetch(`/api/chat/${SESSION}/support-bundle`, 'GET', undefined, viewerToken);
    expect(viewer.status).toBe(403);
  });

  it('REFUSES when logging is off, and says exactly what to set', async () => {
    // A bundle without the log is missing the one thing a bug report needs, so
    // the endpoint answers instead of handing over an artifact that would make
    // the user think they had captured the failure.
    delete process.env.NUVIRA_DEBUG_LOG;
    const res = await authedFetch(`/api/chat/${SESSION}/support-bundle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('logging_disabled');
    // The sentence is the whole value of the refusal, so it has to be enough on
    // its own: the variable, and where the logs will land.
    expect(body.error).toContain('NUVIRA_DEBUG_LOG=1');
    expect(body.error).toContain(debugLogDir());
  });

  it('distinguishes "logging is on but this chat has no log yet" from logging being off', async () => {
    // Two different nothings with two different fixes. Collapsing them into one
    // message would tell half the users the wrong thing.
    await withLogging(async () => {
      const res = await authedFetch('/api/chat/never-ran-a-turn/support-bundle');
      const body = (await res.json()) as { ok: boolean; reason: string; error: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('no_logs');
      expect(body.error).toMatch(/turn/i);
    });
  });

  it('bundles the logs THIS conversation wrote — and nobody else`s', async () => {
    await withLogging(async () => {
      // A real turn first, so the session exists and has a transcript to carry.
      const sent = await authedFetch('/api/chat', 'POST', { sessionId: SESSION, message: 'echo: support' });
      expect(sent.status).toBe(200);
      // Two turns of THIS chat, in order, plus one of another chat.
      writeTurnLog(SESSION, 1_000);
      writeTurnLog(SESSION, 2_000);
      writeTurnLog('somebody-elses-chat', 3_000);

      const res = await authedFetch(`/api/chat/${SESSION}/support-bundle`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/zip');
      expect(res.headers.get('content-disposition')).toContain(SESSION);

      // The archive is STORED (no compression), so its text is readable in the
      // bytes — which lets this assert on CONTENT rather than on a byte count.
      const zip = Buffer.from(await res.arrayBuffer()).toString('utf8');
      expect(zip).toContain('manifest.txt');
      expect(zip).toContain('nuvira support bundle');
      expect(zip).toContain(`session: ${SESSION}`);
      expect(zip).toContain('debug logs: 2 (oldest first)');
      expect(zip).toContain('backend(s) seen: groq / stub-model / native');
      // The log itself, named for the conversation it belongs to.
      expect(zip).toContain(`# session: ${SESSION}`);
      // The conversation, so "it did not answer" arrives with the ask.
      expect(zip).toContain('conversation.txt');
      expect(zip).toContain('echo: support');
      // And selection is by the log`s OWN header, never by recency: a second tab
      // running its own chat must not end up in this bundle.
      expect(zip).not.toContain('somebody-elses-chat');
    });
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
    expect(top?.command).toBe('nuvira dashboard stop');
    expect(top?.confirmation).toBe(true);
  });

  it('marks an add-contact ask as ambiguous with two resolution options', async () => {
    const res = await authedFetch('/api/chat/resolve', 'POST', { message: 'add Rahul mobile +919958604222 to whatsapp' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: Array<{ ambiguous?: boolean; options?: Array<{ command: string }> }> };
    const top = body.matches[0];
    expect(top?.ambiguous).toBe(true);
    const commands = top?.options?.map((o) => o.command) ?? [];
    expect(commands).toContain('nuvira config gateway allow whatsapp user 919958604222');
    expect(commands).toContain('nuvira whatsapp contact add Rahul 919958604222');
  });

  it('returns no matches for an ordinary chat message (falls through to the agent)', async () => {
    const res = await authedFetch('/api/chat/resolve', 'POST', { message: 'what is the meaning of life' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: unknown[] };
    expect(body.matches.length).toBe(0);
  });
});

describe('/api/sessions — P4 session sidebar', () => {
  it('rejects unauthenticated and viewer requests', async () => {
    expect((await fetch(`${baseUrl}/api/sessions`)).status).toBe(401);
    expect((await authedFetch('/api/sessions', 'GET', undefined, viewerToken)).status).toBe(403);
    expect((await authedFetch('/api/sessions/no-such-id', 'GET', undefined, viewerToken)).status).toBe(403);
  });

  it('lists sessions after turns and returns the full transcript', async () => {
    // One turn in a fresh session → it appears in the sidebar.
    const post = await authedFetch('/api/chat', 'POST', { sessionId: 'sidebar-sess-1', message: 'assess the repo' });
    expect(post.status).toBe(200);

    const listRes = await authedFetch('/api/sessions');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      ok: boolean;
      sessions: Array<{ id: string; title: string; turnCount: number; preview: string }>;
    };
    expect(list.ok).toBe(true);
    const found = list.sessions.find((s) => s.id === 'sidebar-sess-1');
    expect(found).toBeTruthy();
    expect(found?.title).toBe('assess the repo');
    expect(found?.turnCount).toBe(2);
    expect(found?.preview).toContain('echo: assess the repo');

    // Full transcript for resume.
    const detail = await authedFetch('/api/sessions/sidebar-sess-1');
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as {
      ok: boolean;
      session: { id: string; turns: Array<{ role: string; content: string }>; title: string };
    };
    expect(d.session.id).toBe('sidebar-sess-1');
    expect(d.session.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(d.session.turns[1].content).toBe('echo: assess the repo');
    expect(d.session.title).toBe('assess the repo');

    // Unknown session → 404.
    expect((await authedFetch('/api/sessions/never-existed')).status).toBe(404);
  });
});

describe('/api/projects — P3 project attach', () => {
  it('rejects unauthenticated and viewer requests', async () => {
    expect((await fetch(`${baseUrl}/api/projects`)).status).toBe(401);
    expect((await authedFetch('/api/projects', 'GET', undefined, viewerToken)).status).toBe(403);
    expect((await authedFetch('/api/projects/attach', 'POST', { path: '/tmp' }, viewerToken)).status).toBe(403);
  });

  it('lists recent projects and attaches a real project directory', async () => {
    // Initially the list may be empty (no cwd pre-populated since v1.75.3).
    const list = await authedFetch('/api/projects');
    expect(list.status).toBe(200);
    const l = (await list.json()) as { ok: boolean; projects: Array<{ path: string; name: string; kind: string }> };
    expect(l.ok).toBe(true);

    // Attach a real directory (the test fixture dir is a valid directory).
    const attach = await authedFetch('/api/projects/attach', 'POST', { path: testDir });
    expect(attach.status).toBe(200);
    const a = (await attach.json()) as { ok: boolean; project: { path: string; name: string; fileCount: number } };
    expect(a.ok).toBe(true);
    expect(a.project.path).toBe(testDir);
    expect(typeof a.project.fileCount).toBe('number');

    // After attaching, the project should appear in the list.
    const listAfter = await authedFetch('/api/projects');
    const lAfter = (await listAfter.json()) as { ok: boolean; projects: Array<{ path: string; name: string; kind: string }> };
    expect(lAfter.projects.some((p) => p.path === testDir)).toBe(true);

    // A bogus path is rejected with 400.
    const bad = await authedFetch('/api/projects/attach', 'POST', { path: '/no/such/dir-xyz' });
    expect(bad.status).toBe(400);
  });

  it('/api/chat with projectPath injects the project context into the turn', async () => {
    // A tiny fixture project so the snapshot has content.
    const fixture = join(testDir, 'proj');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'lib.ts'), 'export function helper(): void {}\n');

    const res = await authedFetch('/api/chat', 'POST', { sessionId: 'proj-sess', message: 'assess this project', projectPath: fixture });
    expect(res.status).toBe(200);

    const call = engine.calls.find((c) => c.message === 'assess this project');
    expect(call).toBeTruthy();
    const opts = call?.opts as { projectContext?: string };
    expect(opts?.projectContext).toBeTruthy();
    expect(opts?.projectContext).toContain('Project:');
    expect(opts?.projectContext).toContain('lib.ts');
    expect(opts?.projectContext).toContain('helper');

    // Without projectPath, no context is injected.
    const plain = await authedFetch('/api/chat', 'POST', { sessionId: 'proj-sess-2', message: 'hi' });
    expect(plain.status).toBe(200);
    const plainCall = engine.calls.find((c) => c.message === 'hi');
    expect((plainCall?.opts as { projectContext?: string } | undefined)?.projectContext).toBeUndefined();
  });

  describe('P6d — /api/skills/marketplace (the private-repo-safe import surface)', () => {
    // A LOCAL-DIR fixture registry (file:// base) — hermetic, no network.
    // skills-registry honors BUFF_SKILLS_REGISTRY (single-value fallback).
    let registryDir: string;
    const envBackup: Record<string, string | undefined> = {};
    const cwdBackup = process.cwd();
    beforeEach(() => {
      // The install target is the SERVER's cwd — point it at the temp test
      // dir so installs never pollute the repo's committed .agents/skills.
      process.chdir(testDir);
      envBackup.NUVIRA_SKILLS_REGISTRY = process.env.NUVIRA_SKILLS_REGISTRY;
      registryDir = join(testDir, 'registry');
      // The registry layout: <root>/index.json + <root>/<name>/SKILL.md
      // (the same shape as the committed .agents/skills dir).
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(join(registryDir, 'index.json'), JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        skills: [
          { name: 'code-assist', description: 'Assist with code edits', version: '1.2.0', author: 'fixture', tags: ['code'], source: 'fixture', updatedAt: new Date().toISOString() },
          { name: 'schema-validator', description: 'Validate schemas', version: '0.9.0', author: 'fixture', tags: ['schema'], source: 'fixture', updatedAt: new Date().toISOString() },
        ],
      }), 'utf-8');
      mkdirSync(join(registryDir, 'code-assist'), { recursive: true });
      writeFileSync(join(registryDir, 'code-assist', 'SKILL.md'), '---\nname: code-assist\ndescription: Assist with code edits\n---\n# Code Assist\nHelp with edits.\n', 'utf-8');
      mkdirSync(join(registryDir, 'schema-validator'), { recursive: true });
      writeFileSync(join(registryDir, 'schema-validator', 'SKILL.md'), '---\nname: schema-validator\ndescription: Validate schemas\n---\n# Schema Validator\nValidate.\n', 'utf-8');
      process.env.NUVIRA_SKILLS_REGISTRY = `file://${registryDir}`;
    });
    afterEach(() => {
      process.chdir(cwdBackup);
      if (envBackup.NUVIRA_SKILLS_REGISTRY === undefined) delete process.env.NUVIRA_SKILLS_REGISTRY;
      else process.env.NUVIRA_SKILLS_REGISTRY = envBackup.NUVIRA_SKILLS_REGISTRY;
      // Remove any installed skill so the next test starts clean.
      rmSync(join(testDir, '.agents'), { recursive: true, force: true });
    });

    it('searches the registry (GET /api/skills/marketplace?q=)', async () => {
      const res = await authedFetch('/api/skills/marketplace?q=assist');
      expect(res.status).toBe(200);
      const d = (await res.json()) as { results: Array<{ name: string; version: string; sourceKind: string }> };
      expect(d.results.some((r) => r.name === 'code-assist')).toBe(true);
      expect(d.results[0].version).toBe('1.2.0');
    });

    it('installs a skill into <project>/.agents/skills/ (sandboxed + provenance)', async () => {
      const res = await authedFetch('/api/skills/marketplace/install', 'POST', { name: 'code-assist' });
      expect(res.status).toBe(200);
      const d = (await res.json()) as { ok: boolean; skill?: { name: string; version: string } };
      expect(d.ok).toBe(true);
      expect(d.skill?.name).toBe('code-assist');
      // The SKILL.md landed in the project's .agents/skills (cwd = testDir).
      expect(existsSync(join(testDir, '.agents', 'skills', 'code-assist', 'SKILL.md'))).toBe(true);
    });

    it('unknown skill → 404; invalid name → 400', async () => {
      const missing = await authedFetch('/api/skills/marketplace/install', 'POST', { name: 'no-such-skill' });
      expect(missing.status).toBe(404);
      const invalid = await authedFetch('/api/skills/marketplace/install', 'POST', { name: '../evil' });
      expect(invalid.status).toBe(400);
    });

    it('uninstalls a skill (removes the dir)', async () => {
      // Install first, then uninstall.
      await authedFetch('/api/skills/marketplace/install', 'POST', { name: 'schema-validator' });
      expect(existsSync(join(testDir, '.agents', 'skills', 'schema-validator', 'SKILL.md'))).toBe(true);
      const res = await authedFetch('/api/skills/marketplace/uninstall', 'POST', { name: 'schema-validator' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
      expect(existsSync(join(testDir, '.agents', 'skills', 'schema-validator'))).toBe(false);
    });

    it('gates install on role (viewer → 403)', async () => {
      const viewer = await authedFetch('/api/skills/marketplace/install', 'POST', { name: 'code-assist' }, viewerToken);
      expect(viewer.status).toBe(403);
    });
  });

  describe('P6a — /api/skills/drafts (the /learn preview-card gate)', () => {
    // The server reads the DEFAULT draft root — BUFF_MEMORY_DIR/skill-drafts
    // (HOME is pinned above, so nothing touches the real ~/.nuvira).
    const draftsRoot = join(memoryDir, 'skill-drafts');
    const skillMd = (name: string): string => [
      '---',
      `name: ${name}`,
      'description: Upload artifacts to S3.',
      '---',
      '',
      '## Steps',
      '',
      '### Step 1 — [runner] Sync the directory',
      'Run aws s3 sync with the output directory.',
      '',
      '### Step 2 — [reviewer] Verify the upload',
      'Confirm the object exists in the bucket.',
      '',
    ].join('\n');

    beforeEach(() => {
      rmSync(draftsRoot, { recursive: true, force: true });
    });

    it('lists drafts, accepts one (promotes to hub + compiled), and the draft is gone', async () => {
      const dir = join(draftsRoot, 's3-upload');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), skillMd('s3-upload'), 'utf-8');

      // 1. List shows the draft.
      const list = await authedFetch('/api/skills/drafts');
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { drafts: Array<{ name: string }> };
      expect(listed.drafts.some((d) => d.name === 's3-upload')).toBe(true);

      // 2. Accept promotes it.
      const accept = await authedFetch('/api/skills/drafts/s3-upload/accept', 'POST');
      expect(accept.status).toBe(200);
      const accepted = (await accept.json()) as { ok: boolean; skill?: { name?: string } };
      expect(accepted.ok).toBe(true);
      expect(accepted.skill?.name).toBe('s3-upload');

      // 3. The draft is gone (it is now live).
      const after = await authedFetch('/api/skills/drafts');
      const afterData = (await after.json()) as { drafts: Array<{ name: string }> };
      expect(afterData.drafts.some((d) => d.name === 's3-upload')).toBe(false);
    });

    it('rejects (DELETE) a draft — discarded, nothing saved', async () => {
      const dir = join(draftsRoot, 'schema-check');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), skillMd('schema-check'), 'utf-8');

      const del = await authedFetch('/api/skills/drafts/schema-check', 'DELETE');
      expect(del.status).toBe(200);
      expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
      expect(existsSync(join(draftsRoot, 'schema-check'))).toBe(false);
    });

    it('accept of a missing draft returns 400 (nothing to accept)', async () => {
      const res = await authedFetch('/api/skills/drafts/ghost/accept', 'POST');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toContain('not found');
    });

    it('gates accept on role (viewer → 403, admin → 200)', async () => {
      const dir = join(draftsRoot, 's3-upload');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), skillMd('s3-upload'), 'utf-8');

      const viewer = await authedFetch('/api/skills/drafts/s3-upload/accept', 'POST', undefined, viewerToken);
      expect(viewer.status).toBe(403);

      const admin = await authedFetch('/api/skills/drafts/s3-upload/accept', 'POST');
      expect(admin.status).toBe(200);
    });
  });

  describe('E2E — artifact cards (chat → diff extraction → accept/reject → commit)', () => {
    it('extracts a diff from the model answer and the accepted-subset commit turn names the attached project', async () => {
      // A fixture project the diff refers to (attached to the turn).
      const fixture = join(testDir, 'proj-e2e');
      mkdirSync(fixture, { recursive: true });
      writeFileSync(join(fixture, 'lib.ts'), 'export function helper(): void {}\n', 'utf-8');
      writeFileSync(join(fixture, 'README.md'), 'old readme\n', 'utf-8');

      // The model's answer embeds a unified diff it wants committed (written
      // DIRECTLY into the answer text — the artifact-card extraction path,
      // not a live git:diff SSE event).
      engine.answerContent = [
        'I fixed the helper and the README. Here is the diff:',
        '```diff',
        'diff --git a/lib.ts b/lib.ts',
        'index 111..222 100644',
        '--- a/lib.ts',
        '+++ b/lib.ts',
        '@@ -1,3 +1,3 @@',
        '-export function helper(): void {}',
        "+export function helper(): string { return 'ok'; }",
        'diff --git a/README.md b/README.md',
        'index 333..444 100644',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1 @@',
        '-old readme',
        '+new readme',
        '```',
        'Which files should I commit?',
      ].join('\n');

      try {
        // 1. CHAT — the turn runs against the REAL server with the project
        // attached (the same request ChatPage sends).
        const post = await authedFetch('/api/chat', 'POST', {
          sessionId: 'artifact-e2e-sess',
          message: 'fix the helper and show the diff',
          projectPath: fixture,
        });
        expect(post.status).toBe(200);
        const body = (await post.json()) as { ok: boolean; content: string };
        expect(body.ok).toBe(true);

        // 2. DIFF EXTRACTION — the EXACT module ChatPage runs on the answer
        // text (extractArtifacts → per-file diff sections for the card).
        const { extractArtifacts } = await import('../../src/web-dashboard/src/artifacts.js');
        const arts = extractArtifacts(body.content);
        expect(arts.diffs).toHaveLength(1);
        expect(arts.diffs[0].files.map((f) => f.path)).toEqual(['lib.ts', 'README.md']);
        expect(arts.diffs[0].summary).toBe('2 files changed');

        // 3. ACCEPT / REJECT — the user accepts lib.ts and rejects README.md;
        // the card sends exactly the accepted subset (never the whole diff).
        const accepted = ['lib.ts'];

        // 4. COMMIT — the exact message commitAcceptedDiff builds (the
        // attached project is named so the agent commits in ITS working tree).
        const commitTurn =
          `Commit exactly these files that I accepted on the diff card (and nothing else) ` +
          `in the attached project ${fixture}: ${accepted.join(', ')}. ` +
          `Show me a short confirmation before finishing.`;
        const commit = await authedFetch('/api/chat', 'POST', { sessionId: 'artifact-e2e-sess', message: commitTurn, projectPath: fixture });
        expect(commit.status).toBe(200);

        // The engine received the commit request…
        const call = engine.calls.find((c) => c.message === commitTurn);
        expect(call).toBeTruthy();
        // …and the turn threaded the diff answer as context (the agent knows
        // exactly which diff it is committing).
        const opts = call?.opts as { history?: Array<{ role: string; content: string }> };
        expect(opts.history?.map((h) => h.role)).toEqual(['user', 'assistant']);
        expect(opts.history?.[1].content).toContain('diff --git a/lib.ts b/lib.ts');
        // The project context rode into BOTH turns.
        expect((call?.opts as { projectContext?: string }).projectContext).toContain('Project:');
      } finally {
        engine.answerContent = null;
      }
    });

    it.skipIf(process.platform === 'win32')('serves the built dashboard bundle containing the artifact-card code (smoke)', async () => {
      // The running dashboard serves the SPA + its hashed assets over HTTP.
      const index = await fetch(`${baseUrl}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type') ?? '').toContain('text/html');
      const html = await index.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      expect(assets.length).toBeGreaterThan(0);
      for (const a of assets) {
        const res = await fetch(`${baseUrl}${a}`);
        expect(res.status).toBe(200);
      }
      // The JS bundle carries the Phase-2 artifact-card code (rendered markers
      // survive minification): diff card + accept/reject, the artifact nav
      // stack, and the task-run stream separation.
      const jsAsset = assets.find((a) => a.endsWith('.js'));
      expect(jsAsset).toBeTruthy();
      const js = await (await fetch(`${baseUrl}${jsAsset}`)).text();
      expect(js).toContain('Commit accepted');
      expect(js).toContain('chat-artifacts');
      expect(js).toContain('chat-task-log-sep');
    });
  });

  describe('P8 — chat attachments + session management', () => {
    it('sends attachments with the turn (server injects [Attachment: name] context)', async () => {
      const res = await authedFetch('/api/chat', 'POST', {
        sessionId: 'attach-sess',
        message: 'review this doc',
        attachments: [{ name: 'spec.md', content: 'the spec body\nsecond line', kind: 'file' }],
      });
      expect(res.status).toBe(200);
      const call = engine.calls.find((c) => c.message === 'review this doc');
      expect(call).toBeDefined();
      const ctx = call?.opts?.projectContext ?? '';
      expect(ctx).toContain('[Attachment: spec.md]');
      expect(ctx).toContain('the spec body');
    });

    it('caps attachment count at the server boundary (10 max)', async () => {
      const res = await authedFetch('/api/chat', 'POST', {
        sessionId: 'attach-cap-count',
        message: 'check',
        attachments: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, content: `body ${i}`, kind: 'file' })),
      });
      expect(res.status).toBe(200);
      const call = engine.calls.find((c) => c.message === 'check');
      const ctx = call?.opts?.projectContext ?? '';
      expect(ctx.split('[Attachment: f').length - 1).toBe(10);
    });

    it('truncates oversized attachment content to 300k chars', async () => {
      const res = await authedFetch('/api/chat', 'POST', {
        sessionId: 'attach-cap-size',
        message: 'big',
        attachments: [{ name: 'huge.txt', content: 'x'.repeat(310_000), kind: 'file' }],
      });
      expect(res.status).toBe(200);
      const call = engine.calls.find((c) => c.message === 'big');
      const ctx = call?.opts?.projectContext ?? '';
      expect(ctx).toContain('[Attachment: huge.txt]');
      expect(ctx.length).toBeLessThan(300_100);
    });

    it('rejects attachments without auth (401)', async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'x', message: 'hi', attachments: [{ name: 'a.txt', content: 'aa' }] }),
      });
      expect(res.status).toBe(401);
    });

    it('DELETE /api/sessions/:id removes the session and persists', async () => {
      await authedFetch('/api/chat', 'POST', { sessionId: 'del-sess', message: 'create me' });
      const listBefore = await authedFetch('/api/sessions');
      expect(((await listBefore.json()) as { sessions: Array<{ id: string }> }).sessions.some((s) => s.id === 'del-sess')).toBe(true);

      const del = await authedFetch('/api/sessions/del-sess', 'DELETE');
      expect(del.status).toBe(200);

      const listAfter = await authedFetch('/api/sessions');
      expect(((await listAfter.json()) as { sessions: Array<{ id: string }> }).sessions.some((s) => s.id === 'del-sess')).toBe(false);
    });

    it('POST /api/sessions/:id/rename retitles the session', async () => {
      await authedFetch('/api/chat', 'POST', { sessionId: 'ren-sess', message: 'fix the build' });
      const ren = await authedFetch('/api/sessions/ren-sess/rename', 'POST', { title: 'CI is red' });
      expect(ren.status).toBe(200);
      const list = await authedFetch('/api/sessions');
      const rec = ((await list.json()) as { sessions: Array<{ id: string; title: string }> }).sessions.find((s) => s.id === 'ren-sess');
      expect(rec?.title).toBe('CI is red');
    });

    it('gates session delete/rename on role (viewer → 403)', async () => {
      await authedFetch('/api/chat', 'POST', { sessionId: 'gated-sess', message: 'hi' });
      const del = await authedFetch('/api/sessions/gated-sess', 'DELETE', undefined, viewerToken);
      expect(del.status).toBe(403);
      const ren = await authedFetch('/api/sessions/gated-sess/rename', 'POST', { title: 'x' }, viewerToken);
      expect(ren.status).toBe(403);
    });
  });
});

/**
 * Deferred retries — the dashboard keeps the promise the gateway does.
 *
 * A failed turn that offers "reply yes and I'll keep checking" must be BACKED:
 * the ask is queued, a yes confirms it, and the drain re-runs it and pushes the
 * answer to the open conversation over the app-wide SSE channel (the per-turn
 * chat stream is long gone by then).
 */
describe('/api/chat — deferred retries', () => {
  it('a failed turn reports what was tried, offers to keep trying, and QUEUES the ask', async () => {
    engine.generationFailed = true;
    engine.failoverAttempts = seedFailoverAttempts();
    const res = await authedFetch('/api/chat', 'POST', { sessionId: 'retry-sess', message: 'explain the router' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; content: string; generationFailed: boolean; retryQueued: boolean };
    expect(body.generationFailed).toBe(true);
    expect(body.content).toMatch(/I tried 2 models/);
    expect(body.content).toMatch(/Reply \*yes\*/i);
    // The offer is BACKED: the client uses this to drop its manual Retry button.
    expect(body.retryQueued).toBe(true);

    const task = getPendingTask('dashboard', 'retry-sess');
    expect(task?.text).toBe('explain the router');
    expect(task?.kind).toBe('chat');

    // RELOAD PARITY: the bubble the reader just read is the bubble the session
    // stores — otherwise a refresh shows a failure with no explanation for a
    // retry that is queued and running.
    const stored = await authedFetch('/api/sessions/retry-sess');
    const storedBody = (await stored.json()) as { session: { turns: Array<{ role: string; content: string }> } };
    const lastAssistant = storedBody.session.turns.filter((t) => t.role === 'assistant').at(-1)!;
    expect(lastAssistant.content).toBe(body.content);
    // …and the ask is stored exactly once.
    expect(storedBody.session.turns.filter((t) => t.role === 'user' && t.content === 'explain the router')).toHaveLength(1);
    engine.generationFailed = false;
  });

  it('"yes" confirms the queue entry without running a model turn', async () => {
    const callsBefore = engine.calls.length;
    const res = await authedFetch('/api/chat', 'POST', { sessionId: 'retry-sess', message: 'yes' });
    const body = (await res.json()) as { content: string };
    expect(body.content).toMatch(/keep trying/);
    expect(body.content).toMatch(/Next attempt/);
    expect(engine.calls.length).toBe(callsBefore);
    expect(getPendingTask('dashboard', 'retry-sess')?.confirmed).toBe(true);
  });

  it('"stop" cancels it, and a real request is left alone', async () => {
    const ask = await authedFetch('/api/chat', 'POST', { sessionId: 'retry-sess', message: 'write a poem about the sea' });
    const askBody = (await ask.json()) as { content: string };
    expect(askBody.content).not.toMatch(/keep trying/);
    expect(getPendingTask('dashboard', 'retry-sess')).toBeDefined();

    const stop = await authedFetch('/api/chat', 'POST', { sessionId: 'retry-sess', message: 'stop' });
    expect(((await stop.json()) as { content: string }).content).toMatch(/stopped retrying/);
    expect(getPendingTask('dashboard', 'retry-sess')).toBeUndefined();
  });

  it('the drain re-runs the ask and PUSHES the answer over SSE', async () => {
    const stream = await openSSE(`${baseUrl}/api/sse`);
    // Wait for the stream to be established (its init frame).
    await until(() => stream.events.length > 0);

    engine.generationFailed = true;
    engine.failoverAttempts = seedFailoverAttempts();
    await authedFetch('/api/chat', 'POST', { sessionId: 'retry-drain', message: 'explain the cache' });
    engine.generationFailed = false;
    const queued = getPendingTask('dashboard', 'retry-drain')!;
    updateDeferredTask(queued.id, { notBefore: Date.now() - 1 });

    await runChatRetryDrainForTest();

    await until(() => stream.events.some((e) => e.event === 'chat-retry'));
    const pushed = stream.events.filter((e) => e.event === 'chat-retry').map((e) => JSON.parse(e.data) as { sessionId: string; kind: string; content: string });
    expect(pushed[0]).toMatchObject({ sessionId: 'retry-drain', kind: 'answer' });
    expect(pushed[0]!.content).toMatch(/Trying again now/);
    expect(pushed[0]!.content).toContain('echo: explain the cache');
    // The queue entry is settled, and the answer is in the session history so a
    // reload (or a closed tab) still shows it.
    expect(getPendingTask('dashboard', 'retry-drain')).toBeUndefined();
    const session = await authedFetch('/api/sessions/retry-drain');
    const sessionBody = (await session.json()) as { session: { turns: Array<{ role: string; content: string }> } };
    const stored = sessionBody.session.turns.map((t) => t.content).join('\n');
    expect(stored).toContain('echo: explain the cache');
    // Exactly ONE bubble for the retry: the header + the answer, written by the
    // broker. A second writer (the console) would duplicate the ask or the reply.
    expect(sessionBody.session.turns.filter((t) => t.content.includes('Trying again now')).length).toBe(1);
    expect(sessionBody.session.turns.filter((t) => t.content === 'echo: explain the cache').length).toBe(0);
    stream.close();
  });
});

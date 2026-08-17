/**
 * P3 — ChatConsole unit tests.
 *
 * The console is driven with an injectable FAKE engine (no LLM, no tool
 * loop): history threading across turns, per-session caps, busy rejection,
 * reset, the injected non-TTY ask_user renderer, live progress streaming,
 * and error propagation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import { ChatConsole, type ChatEngine } from '../../src/web-dashboard/chat-console.js';

interface EngineCall {
  message: string;
  opts: Parameters<ChatEngine['answerOnce']>[1];
}

/** A controllable fake engine: the test drives the response + latency. */
class FakeEngine implements ChatEngine {
  calls: EngineCall[] = [];
  private resolver: ((r: { content: string; followups: unknown[]; provider?: string; model?: string; generationFailed?: boolean }) => void) | null = null;
  delayResolve = false;
  /** When set, the engine emits these lines via onProgress before answering. */
  progressLines: string[] = [];
  /** P0.6 — when set, the engine replays these tool calls via onToolCall. */
  toolCalls: Array<{ phase: 'started' | 'called'; tool: string; args?: Record<string, unknown>; ok?: boolean; result?: string; error?: string; durationMs?: number }> = [];
  /** P0.7 — when set, the engine replays these plan mutations via onPlanChange. */
  planChanges: Array<{ goal: string; steps: Array<{ id: string; description: string; status: 'pending' | 'running' | 'done' | 'blocked' }>; revision: number }> = [];
  /** P3b — when set, the engine replays these git diffs via onGitDiff. */
  gitDiffs: Array<{ files: Array<{ path: string; body: string }>; summary: string }> = [];
  /** The planStore the console injected into the last engine call (if any). */
  lastPlanStore: unknown = undefined;

  async answerOnce(
    message: string,
    opts: Parameters<ChatEngine['answerOnce']>[1] = {},
  ): Promise<{ content: string; followups: unknown[]; provider?: string; model?: string; generationFailed?: boolean }> {
    this.calls.push({ message, opts });
    this.lastPlanStore = opts?.planStore;
    for (const line of this.progressLines) {
      opts?.onProgress?.(line);
    }
    for (const t of this.toolCalls) {
      opts?.onToolCall?.(t.phase, { id: `call_${t.tool}`, tool: t.tool, args: t.args, ok: t.ok, result: t.result, error: t.error, durationMs: t.durationMs });
    }
    for (const p of this.planChanges) {
      opts?.onPlanChange?.(p);
    }
    for (const d of this.gitDiffs) {
      opts?.onGitDiff?.(d);
    }
    const respond = () => ({
      content: `echo: ${message}`,
      followups: [{ prompt: 'What next?', label: 'Next' }],
      provider: 'groq',
      model: 'llama-3.3-70b',
    });
    if (!this.delayResolve) return respond();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  finish(): void {
    this.resolver?.({ content: 'late echo', followups: [] });
  }
}

describe('ChatConsole', () => {
  let engine: FakeEngine;
  let console_: ChatConsole;

  beforeEach(() => {
    engine = new FakeEngine();
    console_ = new ChatConsole({ engine });
  });

  it('answers a message and stores user + assistant turns', async () => {
    const r = await console_.answer('s1', 'hello there');
    expect(r.ok).toBe(true);
    expect(r.content).toBe('echo: hello there');
    expect(r.provider).toBe('groq');
    expect(r.followups).toEqual([{ prompt: 'What next?', label: 'Next' }]);
    const history = console_.history('s1');
    expect(history).toEqual([
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'echo: hello there' },
    ]);
  });

  it('threads the conversation history into the next turn', async () => {
    await console_.answer('s1', 'first');
    await console_.answer('s1', 'second');
    const last = engine.calls[1];
    expect(last.opts?.history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'echo: first' },
    ]);
  });

  /** Wait until the fake engine's answerOnce has been invoked. */
  async function waitForEngineCall(): Promise<void> {
    for (let i = 0; i < 20 && engine.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(engine.calls.length).toBeGreaterThan(0);
  }

  it('P0.1 — emits a question event and resolves it via respond() (the round-trip)', async () => {
    const events: Array<{ sessionId: string; event: unknown }> = [];
    console_.onEvent((sessionId, event) => events.push({ sessionId, event }));

    engine.delayResolve = true;
    const answerPromise = console_.answer('s1', 'hi');
    await waitForEngineCall();
    const askUser = engine.calls[0].opts?.askUser;
    expect(typeof askUser).toBe('function');

    // The engine asks a question; the console must emit it (not decline silently).
    const questionPromise = askUser!('Should I fix it?', [{ label: 'Yes' }, { label: 'No' }], false);
    const qEvent = events.find((e) => e.sessionId === 's1' && (e.event as { kind?: string }).kind === 'question');
    expect(qEvent).toBeTruthy();
    const q = (qEvent?.event ?? {}) as { kind: string; question: string; choices: Array<{ label: string }>; questionId: string };
    expect(q.question).toBe('Should I fix it?');
    expect(q.choices).toEqual([{ label: 'Yes' }, { label: 'No' }]);
    expect(q.questionId).toBeTruthy();

    // Unrelated questionId is refused.
    expect(console_.respond('s1', 'nope', { index: 0 })).toBe(false);
    // Wrong session is refused.
    expect(console_.respond('other', q.questionId, { index: 0 })).toBe(false);

    // The GUI answers → the engine receives the selection and the turn resumes.
    expect(console_.respond('s1', q.questionId, { index: 0 })).toBe(true);
    const answer = await questionPromise;
    expect(answer).toEqual({ answer: 0, index: 0, custom: undefined });
    engine.finish();
    const r = await answerPromise;
    expect(r.ok).toBe(true);
    expect(r.content).toBe('late echo');
  });

  it('P0.1 — skipping a question returns index -1 (agent proceeds on best judgment)', async () => {
    const events: Array<{ event: unknown }> = [];
    console_.onEvent((_sid, event) => events.push({ event }));
    engine.delayResolve = true;
    const answerPromise = console_.answer('s1', 'hi');
    await waitForEngineCall();
    const askUser = engine.calls[0].opts?.askUser;
    const questionPromise = askUser!('question?', [{ label: 'A' }], false);
    const qEvent = events.find((e) => (e.event as { kind?: string }).kind === 'question');
    const q = (qEvent?.event ?? {}) as { questionId: string };
    expect(console_.respond('s1', q.questionId, { index: -1 })).toBe(true);
    const answer = await questionPromise;
    expect(answer).toEqual({ answer: [], index: -1 });
    engine.finish();
    const r = await answerPromise;
    expect(r.ok).toBe(true);
  });

  it('P0.1 — multiSelect questions pass arrays through', async () => {
    const events: Array<{ event: unknown }> = [];
    console_.onEvent((_sid, event) => events.push({ event }));
    engine.delayResolve = true;
    const answerPromise = console_.answer('s1', 'hi');
    await waitForEngineCall();
    const askUser = engine.calls[0].opts?.askUser;
    const questionPromise = askUser!('pick', [{ label: 'A' }, { label: 'B' }], true);
    const qEvent = events.find((e) => (e.event as { kind?: string }).kind === 'question');
    const q = (qEvent?.event ?? {}) as { questionId: string; multiSelect: boolean };
    expect(q.multiSelect).toBe(true);
    expect(console_.respond('s1', q.questionId, { index: [0, 1] })).toBe(true);
    const answer = await questionPromise;
    expect(answer).toEqual({ answer: [0, 1], index: [0, 1], custom: undefined });
    engine.finish();
    await answerPromise;
  });

  it('caps turns per session (oldest dropped)', async () => {
    const capped = new ChatConsole({ engine, maxTurns: 2 });
    await capped.answer('s1', 'one');
    await capped.answer('s1', 'two');
    await capped.answer('s1', 'three');
    // Keeps the last 2 turns: the final user+assistant pair only.
    const history = capped.history('s1');
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'three' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'echo: three' });
  });

  it('rejects empty and oversized messages', async () => {
    const empty = await console_.answer('s1', '   ');
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('Empty');
    const big = await console_.answer('s1', 'x'.repeat(9000));
    expect(big.ok).toBe(false);
    expect(big.error).toContain('8000');
  });

  it('rejects a second concurrent turn in the same session', async () => {
    engine.delayResolve = true;
    const first = console_.answer('s1', 'slow');
    const second = await console_.answer('s1', 'fast');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already being answered');
    engine.finish();
    const done = await first;
    expect(done.ok).toBe(true);
  });

  it('reset forgets the session history', async () => {
    await console_.answer('s1', 'hi');
    expect(console_.history('s1')).toHaveLength(2);
    console_.reset('s1');
    expect(console_.history('s1')).toHaveLength(0);
  });

  it('propagates engine failures as errors', async () => {
    const failing: ChatEngine = {
      async answerOnce() {
        throw new Error('provider exploded');
      },
    };
    const c = new ChatConsole({ engine: failing });
    const r = await c.answer('s1', 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('provider exploded');
  });

  it('passes provider/model options through to the engine', async () => {
    await console_.answer('s1', 'hi', { provider: 'gemini', model: 'gemini-2.5-flash' });
    expect(engine.calls[0].opts?.provider).toBe('gemini');
    expect(engine.calls[0].opts?.model).toBe('gemini-2.5-flash');
  });

  it('P0.6 — forwards tool-call lifecycle events as structured cards', async () => {
    const events: Array<{ kind: string; tool?: string; phase?: string; id?: string; args?: string; ok?: boolean; durationMs?: number }> = [];
    console_.onEvent((_sid, event) => {
      events.push({
        kind: event.kind,
        ...('tool' in event ? { tool: event.tool, phase: event.phase, id: event.id, args: event.args, ok: event.ok, durationMs: event.durationMs } : {}),
      });
    });
    engine.toolCalls = [
      { phase: 'started', tool: 'read_file', args: { path: 'src/foo.ts' } },
      { phase: 'called', tool: 'read_file', ok: true, result: '1 | export const x = 1;', durationMs: 12 },
      { phase: 'started', tool: 'run_terminal', args: { command: 'npm test' } },
      { phase: 'called', tool: 'run_terminal', ok: false, error: 'exit 1', durationMs: 300 },
    ];
    const r = await console_.answer('s1', 'inspect');
    expect(r.ok).toBe(true);
    const toolEvents = events.filter((e) => e.kind === 'tool');
    expect(toolEvents).toHaveLength(4);
    // started → called pairs carry the same id and the one-line args summary.
    expect(toolEvents[0]).toMatchObject({ kind: 'tool', tool: 'read_file', phase: 'started', id: 'call_read_file', args: '{path: "src/foo.ts"}' });
    expect(toolEvents[1]).toMatchObject({ kind: 'tool', tool: 'read_file', phase: 'called', id: 'call_read_file', ok: true, durationMs: 12 });
    expect(toolEvents[2]).toMatchObject({ kind: 'tool', tool: 'run_terminal', phase: 'started', args: '{command: "npm test"}' });
    expect(toolEvents[3]).toMatchObject({ kind: 'tool', tool: 'run_terminal', phase: 'called', ok: false, durationMs: 300 });
  });

  it('P0.6 — filters ask_user / suggest_followups out of the tool-card stream', async () => {
    const events: Array<{ kind: string; tool?: string }> = [];
    console_.onEvent((_sid, event) => {
      events.push({ kind: event.kind, ...('tool' in event ? { tool: event.tool } : {}) });
    });
    engine.toolCalls = [
      { phase: 'started', tool: 'ask_user', args: { question: 'really?' } },
      { phase: 'called', tool: 'ask_user', ok: true, result: 'yes', durationMs: 1 },
      { phase: 'started', tool: 'suggest_followups', args: { items: [{ prompt: 'x' }] } },
      { phase: 'called', tool: 'suggest_followups', ok: true, durationMs: 1 },
      { phase: 'started', tool: 'read_file', args: { path: 'a.ts' } },
      { phase: 'called', tool: 'read_file', ok: true, result: 'x', durationMs: 2 },
    ];
    await console_.answer('s1', 'hi');
    const toolEvents = events.filter((e) => e.kind === 'tool');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents.map((e) => e.tool)).toEqual(['read_file', 'read_file']);
  });

  it('P0.7 — forwards plan mutations as structured plan events', async () => {
    const events: Array<{ kind: string; goal?: string; revision?: number; steps?: Array<{ id: string }> }> = [];
    console_.onEvent((_sid, event) => {
      events.push({
        kind: event.kind,
        ...('goal' in event ? { goal: event.goal, revision: event.revision, steps: event.steps } : {}),
      });
    });
    engine.planChanges = [
      { goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce', status: 'pending' }], revision: 1 },
      { goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce', status: 'done' }], revision: 2 },
    ];
    const r = await console_.answer('s1', 'fix the test');
    expect(r.ok).toBe(true);
    const planEvents = events.filter((e) => e.kind === 'plan');
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0]).toMatchObject({ kind: 'plan', goal: 'Fix the failing test', revision: 1 });
    expect(planEvents[1]).toMatchObject({ kind: 'plan', revision: 2 });
    expect(planEvents[1].steps?.[0]).toMatchObject({ id: 'reproduce' });
  });

  it('P3b — forwards git diff payloads as structured diff events', async () => {
    const events: Array<{ kind: string; summary?: string; files?: Array<{ path: string }> }> = [];
    console_.onEvent((_sid, event) => {
      events.push({
        kind: event.kind,
        ...('summary' in event ? { summary: event.summary, files: event.files } : {}),
      });
    });
    engine.gitDiffs = [
      {
        files: [{ path: 'a.txt', body: 'diff --git a/a.txt b/a.txt\n+three' }],
        summary: '1 file changed',
      },
    ];
    const r = await console_.answer('s1', 'show the diff');
    expect(r.ok).toBe(true);
    const diffEvents = events.filter((e) => e.kind === 'diff');
    expect(diffEvents).toHaveLength(1);
    expect(diffEvents[0]).toMatchObject({ kind: 'diff', summary: '1 file changed' });
    expect(diffEvents[0].files?.[0]).toMatchObject({ path: 'a.txt' });
  });

  it('P0.7 — injects a per-session plan store into the engine (survives turns)', async () => {
    await console_.answer('s1', 'start a plan');
    const store1 = engine.lastPlanStore;
    await console_.answer('s1', 'continue the plan');
    const store2 = engine.lastPlanStore;
    // Same session → the SAME store instance across turns (plan persists).
    expect(store1).toBeTruthy();
    expect(store2).toBe(store1);

    // A different session gets its OWN store (plans never leak across chats).
    await console_.answer('s2', 'another conversation');
    expect(engine.lastPlanStore).not.toBe(store1);
  });

  it('streams live progress lines to subscribers during a turn', async () => {
    const events: Array<{ sessionId: string; kind: string; line?: string }> = [];
    console_.onEvent((sessionId, event) => {
      events.push({ sessionId, kind: event.kind, ...('line' in event ? { line: event.line } : {}) });
    });
    engine.progressLines = ['→ calling tool: read_file', '→ tool result received'];
    const r = await console_.answer('s1', 'analyze');
    expect(r.ok).toBe(true);
    // status(working) → progress lines → status(done), in order.
    expect(events.map((e) => e.kind)).toEqual(['status', 'progress', 'progress', 'status']);
    expect(events[1].line).toBe('→ calling tool: read_file');
    expect(events[2].line).toBe('→ tool result received');
    expect(events[0].sessionId).toBe('s1');
  });

  it('emits status:error when the engine fails mid-turn', async () => {
    const events: Array<{ kind: string; status?: string }> = [];
    const failing: ChatEngine = {
      async answerOnce(_m, opts) {
        opts?.onProgress?.('→ tooling');
        throw new Error('provider exploded');
      },
    };
    const c = new ChatConsole({ engine: failing });
    c.onEvent((_sid, event) => events.push({ kind: event.kind, ...('status' in event ? { status: event.status } : {}) }));
    const r = await c.answer('s1', 'hi');
    expect(r.ok).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['status', 'progress', 'status']);
    expect(events[2].status).toBe('error');
  });

  describe('P4 — persistence (session sidebar)', () => {
    const tmp = join(tmpdir(), `chat-console-persist-${process.pid}-${Date.now()}`);
    const storePath = join(tmp, 'sessions.json');
    const engineFor = () => new FakeEngine();

    // Each test starts from a clean store (the file persists across consoles).
    beforeEach(() => {
      try {
        rmSync(storePath, { force: true });
        rmSync(`${storePath}.tmp`, { force: true });
      } catch {
        /* already absent */
      }
    });

    it('persists turns and metadata through the store file', async () => {
      const c = new ChatConsole({ engine: engineFor(), persistPath: storePath });
      await c.answer('s1', 'assess this project');
      await c.answer('s1', 'now fix the top issue');

      const summary = c.list();
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatchObject({ id: 's1', turnCount: 4, title: 'assess this project' });
      expect(summary[0].preview).toContain('echo:');

      const rec = c.get('s1');
      expect(rec?.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(rec?.turns[1].content).toBe('echo: assess this project');
    });

    it('a NEW console with the same store path resumes the conversation (restart)', async () => {
      const first = new ChatConsole({ engine: engineFor(), persistPath: storePath });
      await first.answer('s1', 'assess this project');
      // Ensure distinct updatedAt values so the recency sort is deterministic.
      await new Promise((r) => setTimeout(r, 5));
      await first.answer('s2', 'what is the memory panel?');

      // Simulate a dashboard restart: fresh console, same store file.
      const second = new ChatConsole({ engine: engineFor(), persistPath: storePath });
      const list = second.list();
      expect(list.map((s) => s.id).sort()).toEqual(['s1', 's2']);
      // Most recent first.
      expect(list[0].id).toBe('s2');
      expect(second.history('s1')).toHaveLength(2);

      // And the resumed session keeps answering with full history.
      const r = await second.answer('s1', 'continue');
      expect(r.ok).toBe(true);
      expect(second.history('s1').map((t) => t.content)).toEqual([
        'assess this project',
        'echo: assess this project',
        'continue',
        'echo: continue',
      ]);
    });

    it('reset removes the session from the store file', async () => {
      const c = new ChatConsole({ engine: engineFor(), persistPath: storePath });
      await c.answer('s1', 'hello');
      expect(c.list()).toHaveLength(1);
      c.reset('s1');
      expect(c.list()).toHaveLength(0);

      const reloaded = new ChatConsole({ engine: engineFor(), persistPath: storePath });
      expect(reloaded.list()).toHaveLength(0);
    });

    it('a corrupt store degrades to empty instead of crashing', async () => {
      writeFileSync(storePath, '{{{ not json', 'utf8');
      const c = new ChatConsole({ engine: engineFor(), persistPath: storePath });
      expect(c.list()).toHaveLength(0);
      const r = await c.answer('s1', 'still works');
      expect(r.ok).toBe(true);
    });
  });
});

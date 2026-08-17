/**
 * P3 — ChatConsole unit tests.
 *
 * The console is driven with an injectable FAKE engine (no LLM, no tool
 * loop): history threading across turns, per-session caps, busy rejection,
 * reset, the injected non-TTY ask_user renderer, live progress streaming,
 * and error propagation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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

  async answerOnce(
    message: string,
    opts: Parameters<ChatEngine['answerOnce']>[1] = {},
  ): Promise<{ content: string; followups: unknown[]; provider?: string; model?: string; generationFailed?: boolean }> {
    this.calls.push({ message, opts });
    for (const line of this.progressLines) {
      opts?.onProgress?.(line);
    }
    for (const t of this.toolCalls) {
      opts?.onToolCall?.(t.phase, { id: `call_${t.tool}`, tool: t.tool, args: t.args, ok: t.ok, result: t.result, error: t.error, durationMs: t.durationMs });
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
});

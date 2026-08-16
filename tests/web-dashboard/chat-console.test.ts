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

  async answerOnce(
    message: string,
    opts: Parameters<ChatEngine['answerOnce']>[1] = {},
  ): Promise<{ content: string; followups: unknown[]; provider?: string; model?: string; generationFailed?: boolean }> {
    this.calls.push({ message, opts });
    for (const line of this.progressLines) {
      opts?.onProgress?.(line);
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

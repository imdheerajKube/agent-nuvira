/**
 * P3 — ChatConsole unit tests.
 *
 * The console is driven with an injectable FAKE engine (no LLM, no tool
 * loop): history threading across turns, per-session caps, busy rejection,
 * reset, the injected non-TTY ask_user renderer, and error propagation.
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

  async answerOnce(
    message: string,
    opts: Parameters<ChatEngine['answerOnce']>[1] = {},
  ): Promise<{ content: string; followups: unknown[]; provider?: string; model?: string; generationFailed?: boolean }> {
    this.calls.push({ message, opts });
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

  it('injects a non-TTY ask_user renderer (declines the clarification)', async () => {
    await console_.answer('s1', 'hi');
    const askUser = engine.calls[0].opts?.askUser;
    expect(typeof askUser).toBe('function');
    const answer = await askUser!('question?', [{ label: 'A' }], false);
    expect(answer).toEqual({ answer: [], index: -1 });
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
});

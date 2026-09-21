/**
 * The retry loop the gateway PROMISES.
 *
 * `renderModelBreadthReport` ends a failed turn with "Reply *yes* and I will keep
 * trying until it is done", and that text went out live to WhatsApp. Nothing
 * parsed the yes, stored the task or re-ran it, so a sender who followed the
 * instruction got silence. These tests drive the real `handleInbound`, the real
 * queue and the real drain, and assert that following the instruction actually
 * produces the work.
 *
 * The intent audit is mocked: it is an LLM probe, covered by
 * tests/nlu/intent-confirm.test.ts, and mocking it here is what lets the
 * RE-ROUTE plumbing be asserted deterministically.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const audit = vi.hoisted(() => ({ verdict: null as null | Record<string, unknown>, calls: 0 }));

vi.mock('../../src/nlu/intent-confirm.js', () => ({
  confirmRoutedIntent: vi.fn(async () => {
    audit.calls += 1;
    return audit.verdict ?? { kind: 'chat', agreed: true };
  }),
  intentConfirmedNote: () => '🧭 confirmed-note',
  intentCorrectedNote: (to: string) => `🧭 corrected-note:${to}`,
}));

import { GatewayRegistry } from '../../src/gateway/registry.js';
import type { ChannelAdapter, MessageHandler } from '../../src/gateway/adapters.js';
import { ConfigManager } from '../../src/config/manager.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';
import { recordFailoverAttempt } from '../../src/learning/resilient-call.js';
import {
  getPendingTask,
  listPendingTasks,
  removeDeferredTask,
  updateDeferredTask,
} from '../../src/learning/deferred-task.js';

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-retry-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
  // A CONFIGURED model (so the failure is reported as provider trouble rather
  // than "nothing set up"), pointing at a closed port so every attempt fails
  // fast and hermetically — including the audit's own re-route.
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'local',
      providers: {
        local: {
          runner: 'ollama',
          model: 'nonexistent-fast-fail',
          baseUrl: 'http://127.0.0.1:9',
          temperature: 0.7,
          maxTokens: 1024,
        },
      },
    }),
  );
});

afterAll(() => {
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

beforeEach(() => {
  audit.verdict = null;
  audit.calls = 0;
  // Each test starts from an empty queue (the store is shared per config dir).
  for (const t of listPendingTasks()) removeDeferredTask(t.id);
});

class MockAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  readonly configured = true;
  sent: Array<{ channelId: string; text: string }> = [];
  describe(): string {
    return 'Mock (test)';
  }
  async start(_onMessage: MessageHandler): Promise<void> {}
  async stop(): Promise<void> {}
  async send(channelId: string, text: string): Promise<boolean> {
    this.sent.push({ channelId, text });
    return true;
  }
  get all(): string {
    return this.sent.map((s) => s.text).join('\n---\n');
  }
}

/** Stand in for the failover walk having called two models that both gave up. */
function seedAttempts(): void {
  recordFailoverAttempt({
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    kind: 'rate-limit',
    skipped: false,
    reason: 'rate limited (quota) — still logged in, just throttled',
  });
  recordFailoverAttempt({
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    kind: 'rate-limit',
    skipped: false,
    reason: 'rate limited (quota) — still logged in, just throttled',
  });
}

/**
 * An engine whose turn fails until `succeedAfter` calls have happened — the
 * shape of a quota window reopening while the ask sits in the queue.
 */
function flakyEngine(succeedAfter = 1, answer = 'Here is the answer you asked for.') {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    answerOnce: async () => {
      calls += 1;
      seedAttempts();
      return calls <= succeedAfter
        ? { content: '', generationFailed: true, followups: [] }
        : { content: answer, followups: [] };
    },
  };
}

function registryWith(engine: { answerOnce: (m: string) => Promise<unknown> }) {
  const adapter = new MockAdapter();
  const registry = new GatewayRegistry(
    { streamEvents: false, chatEngine: engine as never },
    new ConfigManager(),
  );
  registry.register(adapter);
  return { registry, adapter };
}

const CHANNEL = 'retry-contact';

describe('a failed turn queues the retry it just offered', () => {
  it('queues the ask, so the "Reply *yes*" line is backed by something', async () => {
    const { registry } = registryWith(flakyEngine(1));
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: CHANNEL,
      text: 'explain how the router works',
    });

    expect(reply).toMatch(/Reply \*yes\*/i);
    const task = getPendingTask('mock', CHANNEL);
    expect(task).toBeDefined();
    expect(task!.text).toBe('explain how the router works');
    expect(task!.kind).toBe('chat');
    expect(task!.attempts).toBe(0);
    // Nothing was confirmed, so it holds the SHORT horizon.
    expect(task!.confirmed).toBeUndefined();
    await registry.stop();
  });

  it('a "yes" confirms it and reports when the next attempt is', async () => {
    const { registry, adapter } = registryWith(flakyEngine(1));
    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'explain the cache' });
    const before = getPendingTask('mock', CHANNEL)!;

    const reply = await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'yes' });
    expect(reply).toMatch(/keep trying/);
    expect(reply).toMatch(/Next attempt/);
    expect(reply).toMatch(/Reply \*stop\*/);
    expect(adapter.all).toContain('keep trying');

    const after = getPendingTask('mock', CHANNEL)!;
    expect(after.id).toBe(before.id);
    expect(after.confirmed).toBe(true);
    // Confirmation is what buys the long horizon.
    expect(after.deadline).toBeGreaterThan(before.deadline);
    await registry.stop();
  });

  it('"stop" cancels it', async () => {
    const { registry } = registryWith(flakyEngine(1));
    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'explain the cache' });
    expect(getPendingTask('mock', CHANNEL)).toBeDefined();

    const reply = await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'stop' });
    expect(reply).toMatch(/stopped retrying/);
    expect(getPendingTask('mock', CHANNEL)).toBeUndefined();
    await registry.stop();
  });

  it('a NEW request is never mistaken for the answer', async () => {
    const { registry, adapter } = registryWith(flakyEngine(1, 'A poem about the sea.'));
    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'explain the cache' });

    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: CHANNEL,
      text: 'write me a short poem about the sea',
    });
    expect(reply).toContain('A poem about the sea.');
    expect(adapter.all).toContain('A poem about the sea.');
    // The queued task is untouched and still waiting.
    expect(getPendingTask('mock', CHANNEL)?.text).toBe('explain the cache');
    await registry.stop();
  });
});

describe('the drain runs the queued ask', () => {
  it('replays it and clears it on success, with the answer delivered', async () => {
    const { registry, adapter } = registryWith(flakyEngine(1, 'The router picks the cheapest healthy model.'));
    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'explain the router' });
    const task = getPendingTask('mock', CHANNEL)!;
    updateDeferredTask(task.id, { notBefore: Date.now() - 1 });

    await (registry as unknown as { drainDeferredTasks(): Promise<void> }).drainDeferredTasks();

    expect(adapter.all).toContain('The router picks the cheapest healthy model.');
    // The sender is told the retry happened — the ask may be hours old.
    expect(adapter.all).toMatch(/Trying again now \(attempt 1/);
    expect(getPendingTask('mock', CHANNEL)).toBeUndefined();
    await registry.stop();
  });

  it('a retry that fails again KEEPS the task (no drop, and the attempts are counted)', async () => {
    const { registry, adapter } = registryWith(flakyEngine(99));
    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'explain the router' });
    const task = getPendingTask('mock', CHANNEL)!;
    updateDeferredTask(task.id, { notBefore: Date.now() - 1 });

    await (registry as unknown as { drainDeferredTasks(): Promise<void> }).drainDeferredTasks();

    const after = getPendingTask('mock', CHANNEL)!;
    expect(after.id).toBe(task.id);
    expect(after.attempts).toBe(1);
    // The failure report went out again, with the confirmation the sender needs.
    expect(adapter.all).toMatch(/I tried 2 models/);
    expect(adapter.all).toContain('🧭 confirmed-note');
    expect(audit.calls).toBe(1);
    await registry.stop();
  });

  it('does NOT touch a task whose wait has not elapsed', async () => {
    const { registry, adapter } = registryWith(flakyEngine(1, 'too early'));
    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'explain the router' });
    const task = getPendingTask('mock', CHANNEL)!;
    updateDeferredTask(task.id, { notBefore: Date.now() + 60_000 });

    await (registry as unknown as { drainDeferredTasks(): Promise<void> }).drainDeferredTasks();

    expect(adapter.all).not.toContain('too early');
    expect(getPendingTask('mock', CHANNEL)?.id).toBe(task.id);
    await registry.stop();
  });
});

describe('the intent audit only runs when it is worth a model call', () => {
  it('does NOT audit a FIRST failure — one failure mostly describes the world', async () => {
    audit.verdict = { kind: 'pipeline', agreed: false, reason: 'wants it built' };
    const { registry, adapter } = registryWith(flakyEngine(99));

    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'explain the router' });

    expect(audit.calls).toBe(0);
    expect(adapter.all).not.toContain('🧭');
    expect(adapter.all).toMatch(/I tried 2 models/);
    await registry.stop();
  });
});

describe('the intent audit re-routes instead of reporting a dead end', () => {
  it('corrects chat → pipeline and RUNS it, rather than sending a chat failure', async () => {
    audit.verdict = { kind: 'pipeline', agreed: false, reason: 'wants it built' };
    // Chat fails; the pipeline (unreachable local model) fails fast too.
    const { registry, adapter } = registryWith(flakyEngine(99));
    await registry.handleInbound({ platform: 'mock', channelId: CHANNEL, text: 'get me a plan for my kid' });
    const task = getPendingTask('mock', CHANNEL)!;
    updateDeferredTask(task.id, { notBefore: Date.now() - 1 });

    await (registry as unknown as { drainDeferredTasks(): Promise<void> }).drainDeferredTasks();

    // It SAID what it re-read and then ran the other route.
    expect(adapter.all).toContain('🧭 corrected-note:pipeline');
    expect(adapter.all).toMatch(/running the/);
    // And it did not re-audit (no ping-pong) — exactly one probe for the turn.
    expect(audit.calls).toBe(1);
    await registry.stop();
  });
});

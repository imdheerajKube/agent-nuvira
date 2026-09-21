/**
 * `gateway.askUserWait` — ask a question on a messaging channel and WAIT for the
 * answer.
 *
 * The defect this pins (observed live 2026-09-21): asked "How would you like the
 * book delivered?" the gateway sent the question and immediately returned
 * `choices[0]`, so the agent acted on an option the sender never chose while
 * their real reply arrived afterwards as an unrelated new message. The sender
 * was asked something that could not affect the run.
 *
 * Invariants under test:
 *   - OFF by default: the historical behaviour is unchanged (no hold).
 *   - ON: the turn HOLDS; the contact's reply resolves it and steers the answer.
 *   - A reply that is NOT a choice releases the waiter with the default AND is
 *     handled as a normal message — a user message is never swallowed.
 *   - A silent contact cannot hang a turn: the window lapses to the default.
 *   - `stop()` releases a held turn — a question cannot outlive the gateway.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayRegistry, matchAskUserChoice } from '../../src/gateway/registry.js';
import type { ChannelAdapter, MessageHandler } from '../../src/gateway/adapters.js';
import { ConfigManager } from '../../src/config/manager.js';
import { parseAskWaitDuration } from '../../src/cli/config.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-askwait-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

const CHOICES = [{ label: 'Interactive game' }, { label: 'Printable PDF' }];

/** Write a config with ask-and-wait on/off (plus an optional window). */
function writeConfig(askUserWait: boolean, askUserTimeoutMs?: number): void {
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'auto',
      gateway: {
        ...(askUserWait ? { askUserWait: true } : {}),
        ...(askUserTimeoutMs !== undefined ? { askUserTimeoutMs } : {}),
      },
    }),
  );
}

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
  writeConfig(false);
});

afterAll(() => {
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

class MockAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  readonly configured = true;
  sent: Array<{ channelId: string; text: string }> = [];
  private handler: MessageHandler | null = null;

  describe(): string {
    return 'Mock (test)';
  }
  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
  }
  async stop(): Promise<void> {
    this.handler = null;
  }
  async send(channelId: string, text: string): Promise<boolean> {
    this.sent.push({ channelId, text });
    return true;
  }
  async sendMedia(): Promise<boolean> {
    return true;
  }
}

/**
 * An engine that asks ONE question through the injected `askUser` and reports
 * which choice came back — so a test can prove the SENDER's answer (not the
 * default) reached the model.
 */
function askingEngine() {
  return {
    answerOnce: async (
      _message: string,
      opts?: {
        askUser?: (q: string, c: Array<{ label: string }>) => Promise<{ answer: string; index: number }>;
      },
    ) => {
      const res = await opts?.askUser?.('How should I deliver it?', CHOICES);
      return { content: `Delivering as: ${res?.answer ?? 'unknown'}`, followups: [] };
    },
  };
}

function mockRegistry() {
  const adapter = new MockAdapter();
  const registry = new GatewayRegistry(
    { streamEvents: false, chatEngine: askingEngine() as never },
    new ConfigManager(),
  );
  registry.register(adapter);
  return { registry, adapter };
}

/** Poll until `predicate` holds (avoids a fixed sleep for the question send). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const askedSomething = (adapter: MockAdapter): boolean => adapter.sent.some((s) => s.text.includes('🤔'));

describe('matchAskUserChoice', () => {
  const choices = ['Interactive game', 'Printable PDF', 'No preference'];

  it('accepts a 1-based number, "option N" and "#N"', () => {
    expect(matchAskUserChoice('1', choices)).toEqual({ answer: 'Interactive game', index: 0 });
    expect(matchAskUserChoice('2', choices)).toEqual({ answer: 'Printable PDF', index: 1 });
    expect(matchAskUserChoice('option 3', choices)).toEqual({ answer: 'No preference', index: 2 });
    expect(matchAskUserChoice('#2', choices)).toEqual({ answer: 'Printable PDF', index: 1 });
    expect(matchAskUserChoice('2.', choices)).toEqual({ answer: 'Printable PDF', index: 1 });
  });

  it('accepts the label case/punctuation-insensitively, and a UNIQUE prefix', () => {
    expect(matchAskUserChoice('printable pdf', choices)).toEqual({ answer: 'Printable PDF', index: 1 });
    expect(matchAskUserChoice('Printable PDF!', choices)).toEqual({ answer: 'Printable PDF', index: 1 });
    expect(matchAskUserChoice('interactive', choices)).toEqual({ answer: 'Interactive game', index: 0 });
  });

  it('refuses to guess: out-of-range numbers, ambiguous prefixes and prose are NOT choices', () => {
    expect(matchAskUserChoice('7', choices)).toBeNull();
    expect(matchAskUserChoice('0', choices)).toBeNull();
    expect(matchAskUserChoice('summarise the book for me', choices)).toBeNull();
    expect(matchAskUserChoice('', choices)).toBeNull();
    expect(matchAskUserChoice('1', [])).toBeNull();
    // A prefix matching MORE than one label must not resolve.
    expect(matchAskUserChoice('p', ['Printable PDF', 'Popup window'])).toBeNull();
  });
});

describe('parseAskWaitDuration', () => {
  it('parses bare ms and s/m/h suffixes, rejecting nonsense', () => {
    expect(parseAskWaitDuration('90000')).toBe(90_000);
    expect(parseAskWaitDuration('90s')).toBe(90_000);
    expect(parseAskWaitDuration('2m')).toBe(120_000);
    expect(parseAskWaitDuration('1h')).toBe(3_600_000);
    expect(parseAskWaitDuration('nonsense')).toBeNull();
    expect(parseAskWaitDuration('')).toBeNull();
    expect(parseAskWaitDuration(undefined)).toBeNull();
    expect(parseAskWaitDuration('0')).toBeNull();
  });
});

describe('gateway ask-and-wait', () => {
  it('OFF (default): the question says which option it is assuming, and nothing waits', async () => {
    writeConfig(false);
    const { registry, adapter } = mockRegistry();
    const reply = await registry.handleInbound({ platform: 'mock', channelId: 'off1', text: 'hello' });
    // The engine's askUser returned the FIRST choice without any reply.
    expect(reply).toContain('Delivering as: Interactive game');
    const asked = adapter.sent.find((s) => s.text.includes('🤔'));
    expect(asked).toBeDefined();
    expect(asked!.text).toContain('Going with 1.');
    expect(asked!.text).not.toContain('I will wait');
    await registry.stop();
  });

  it('ON: the turn holds, and the contact\'s reply — not the default — reaches the model', async () => {
    writeConfig(true);
    const { registry, adapter } = mockRegistry();

    const turn = registry.handleInbound({ platform: 'mock', channelId: 'on1', text: 'hello' });
    await waitFor(() => askedSomething(adapter));
    expect(adapter.sent.find((s) => s.text.includes('🤔'))!.text).toContain('I will wait');

    // The reply resolves the held question and is recorded as such.
    const confirmation = await registry.handleInbound({ platform: 'mock', channelId: 'on1', text: '2' });
    expect(confirmation).toContain('Printable PDF');

    // The HELD turn now completes with the sender's choice, not choices[0].
    await expect(turn).resolves.toContain('Delivering as: Printable PDF');
    await registry.stop();
  });

  it('does NOT swallow a reply that matches no choice — it falls through as a new message', async () => {
    writeConfig(true);
    const { registry, adapter } = mockRegistry();
    const workingLines = (): number => adapter.sent.filter((s) => s.text.includes('Working on it')).length;

    const held = registry.handleInbound({ platform: 'mock', channelId: 'on2', text: 'hello' });
    await waitFor(() => askedSomething(adapter));
    const before = workingLines();

    // Deliberately NOT awaited: it starts a whole new turn, which asks its own
    // question and therefore holds — the assertion is that it was treated as a
    // normal message rather than consumed as an answer.
    void registry.handleInbound({
      platform: 'mock',
      channelId: 'on2',
      text: 'actually tell me more about what you mean',
    });

    // 1) The held turn finished with the DEFAULT — the waiter was released.
    await expect(held).resolves.toContain('Delivering as: Interactive game');
    // 2) …and the text began a NORMAL new turn instead of vanishing.
    await waitFor(() => workingLines() > before);
    await registry.stop();
  });

  it('a silent contact cannot hang a turn — the window lapses to the default (5s floor)', async () => {
    // askUserTimeoutMs: 1 is clamped up to the 5s floor, which is also the
    // behaviour under test: a bad value can neither hang forever nor expire
    // before a human could read the question.
    writeConfig(true, 1);
    const { registry, adapter } = mockRegistry();
    const turn = registry.handleInbound({ platform: 'mock', channelId: 'on3', text: 'hello' });
    await waitFor(() => askedSomething(adapter));
    await expect(turn).resolves.toContain('Delivering as: Interactive game');
    await registry.stop();
  }, 15_000);

  it('stop() releases a held question so it cannot outlive the gateway', async () => {
    writeConfig(true);
    const { registry, adapter } = mockRegistry();
    const held = registry.handleInbound({ platform: 'mock', channelId: 'on4', text: 'hello' });
    await waitFor(() => askedSomething(adapter));
    await registry.stop();
    // Must settle promptly rather than hanging on a question nobody will answer.
    await expect(
      Promise.race([
        held,
        new Promise((_, rej) => setTimeout(() => rej(new Error('held turn never settled')), 1500)),
      ]),
    ).resolves.toBeDefined();
    writeConfig(false);
  });
});

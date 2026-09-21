/**
 * The gateway's failure reply must name the models that were tried.
 *
 * Before this, a failed turn sent \"🤖 I couldn't get an answer from the model
 * just now — please try again in a moment\" — a line that names no cause and
 * offers no next step. The sender could not tell a genuinely empty pool from a
 * single provider that rate-limited while others sat parked on quota.
 *
 * These tests drive the REAL `handleInbound` routing and assert the composed
 * reply carries the report (tried / parked / the retry offer).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayRegistry } from '../../src/gateway/registry.js';
import type { ChannelAdapter, MessageHandler } from '../../src/gateway/adapters.js';
import { ConfigManager } from '../../src/config/manager.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';
import { recordFailoverAttempt } from '../../src/learning/resilient-call.js';

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-failreport-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
  // A provider WITH a key, so `hasConfiguredModel()` is true and the failure is
  // reported as a transient provider problem rather than \"nothing configured\".
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'auto',
      providers: { gemini: { apiKey: 'test-key-not-used' } },
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
}

/**
 * An engine whose every turn fails generation, as a provider outage does.
 *
 * The attempts are recorded FROM INSIDE the turn, because that is when the
 * failover walk really runs — and because `handleInbound` takes its mark at the
 * start of the turn, anything recorded before it is deliberately out of scope.
 */
function failingEngine() {
  return {
    answerOnce: async () => {
      seedAttempts();
      return { content: '', generationFailed: true, followups: [] };
    },
  };
}

function failingRegistry() {
  const adapter = new MockAdapter();
  const registry = new GatewayRegistry(
    { streamEvents: false, chatEngine: failingEngine() as never },
    new ConfigManager(),
  );
  registry.register(adapter);
  return { registry, adapter };
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
    kind: 'context-window',
    skipped: false,
    reason: 'the prompt was too large for its window',
  });
}

describe('gateway failure reply names the models', () => {
  it('a failed CHAT turn reports what was tried and offers to keep checking', async () => {
    const { registry, adapter } = failingRegistry();
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'fr1',
      text: 'summarise this repo for me',
    });

    expect(reply).toMatch(/couldn't get an answer from the model|couldn't finish/i);
    expect(reply).toContain('I tried 2 models');
    expect(reply).toContain('gemini/gemini-3.1-flash-lite — rate limited (quota)');
    expect(reply).toContain('groq/llama-3.3-70b-versatile');
    expect(reply).toMatch(/keep checking/i);
    expect(reply).toMatch(/Reply \*yes\*/i);
    await registry.stop();
  });

  it('the report is what the SENDER receives, not just the returned string', async () => {
    const { registry, adapter } = failingRegistry();
    await registry.handleInbound({ platform: 'mock', channelId: 'fr2', text: 'explain this code' });
    const sent = adapter.sent.map((s) => s.text).join('\n');
    expect(sent).toContain('I tried');
    expect(sent).toMatch(/keep checking/i);
    await registry.stop();
  });
});

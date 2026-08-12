/**
 * J1 — Gateway registry tests. No network: a MockAdapter records sends and a
 * stub pipeline keeps runs instant; the event-bus stream is exercised with a
 * real emitted event.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayRegistry, eventToStatusLine } from '../../src/gateway/registry.js';
import type { ChannelAdapter, InboundMessage, MessageHandler } from '../../src/gateway/adapters.js';
import { getEventBus, EventNames } from '../../src/observability/event-bus.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-reg-'));
const ORIG_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(() => {
  process.env.BUFF_CONFIG_DIR = cfgDir;
  process.env.BUFF_MEMORY_DIR = join(cfgDir, 'memory');
  // Fast-fail local model so the real runPipelineTool resolves without network.
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'local',
      providers: {
        local: { runner: 'ollama', model: 'nonexistent-fast-fail', temperature: 0.7, maxTokens: 1024 },
      },
    }),
  );
});

afterAll(() => {
  // Close the SQLite workspace handle BEFORE removing the dir — an open
  // workspaces.db makes rmSync fail on Windows (EBUSY).
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

/** In-memory adapter — records every send; configured by default. */
class MockAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  readonly configured = true;
  sent: Array<{ channelId: string; text: string }> = [];
  started = false;
  private handler: MessageHandler | null = null;

  describe(): string {
    return 'Mock (test)';
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async send(channelId: string, text: string): Promise<boolean> {
    this.sent.push({ channelId, text });
    return true;
  }

}

/** A registry with the mock adapter (pipeline runs fail fast via the config). */
function mockRegistry(options?: ConstructorParameters<typeof GatewayRegistry>[0]): { registry: GatewayRegistry; adapter: MockAdapter } {
  const adapter = new MockAdapter();
  const registry = new GatewayRegistry(options ?? { streamEvents: false });
  registry.register(adapter);
  return { registry, adapter };
}

describe('eventToStatusLine', () => {
  it('renders pipeline + exec events as compact channel lines', () => {
    expect(eventToStatusLine(EventNames.ORCHESTRATOR_PIPELINE_STARTED, { goal: 'fix tests' })).toContain('fix tests');
    expect(eventToStatusLine(EventNames.ORCHESTRATOR_PIPELINE_COMPLETED, { success: true })).toContain('complete');
    expect(eventToStatusLine(EventNames.ORCHESTRATOR_TASK_STARTED, { agentType: 'writer', description: 'write' })).toContain('writer');
    expect(eventToStatusLine(EventNames.EXEC_SHELL_START, { command: 'npm test' })).toContain('npm test');
    expect(eventToStatusLine(EventNames.CRON_RESULT, { name: 'nightly', output: 'ok' })).toContain('nightly');
  });

  it('returns null for non-board events', () => {
    expect(eventToStatusLine(EventNames.SYSTEM_WARN, {})).toBeNull();
  });
});

describe('GatewayRegistry.handleInbound', () => {
  it('non-pipeline requests reply with an understood/help line', async () => {
    const { registry, adapter } = mockRegistry();
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-1',
      text: 'what is agent-nuvira?',
    });
    expect(reply).toContain('I understood');
    expect(adapter.sent.length).toBeGreaterThan(0);
    expect(adapter.sent[0].channelId).toBe('chan-1');
  });

  it('pipeline requests reply with the run result (fast-fail local model)', async () => {
    const { registry, adapter } = mockRegistry();
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-2',
      text: 'add auth to the API',
    });
    expect(reply).toMatch(/Done|Failed/);
    // First send = the "Got it" ack; second = the result.
    expect(adapter.sent.length).toBeGreaterThanOrEqual(2);
    expect(adapter.sent[0].text).toContain('Got it');
  });

  it('does not reply for non-pipeline requests in pipelineOnly mode', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false, pipelineOnly: true });
    await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'hello' });
    expect(adapter.sent).toHaveLength(0);
  });

  it('refuses pipeline triggers from non-allow-listed channels', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      allowIds: ['mock:trusted'],
    });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'untrusted',
      text: 'add auth to the API',
    });
    expect(reply).toContain('not authorized');
    // Only the refusal is sent — no pipeline ack, no run.
    expect(adapter.sent.length).toBe(1);
  });

  it('runs pipelines from allow-listed channels', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      allowIds: ['mock:trusted'],
    });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'trusted',
      text: 'add auth to the API',
    });
    expect(reply).toMatch(/Done|Failed/);
    expect(adapter.sent.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GatewayRegistry.send', () => {
  it('sends via sendToRef with the mock platform', async () => {
    const { registry, adapter } = mockRegistry();
    const ok = await registry.sendToRef({ platform: 'mock', channelId: 'z' }, 'hello world');
    expect(ok).toBe(true);
    expect(adapter.sent).toEqual([{ channelId: 'z', text: 'hello world' }]);
  });

  it('send() to an unknown target returns false', async () => {
    const { registry } = mockRegistry();
    expect(await registry.send('missing-alias', 'x')).toBe(false);
  });
});

describe('event streaming', () => {
  it('streams board events to the active channel after start()', async () => {
    const adapter = new MockAdapter();
    const registry = new GatewayRegistry({ streamEvents: true });
    registry.register(adapter);
    await registry.start();

    // A pipeline message sets the active channel (fast-fail local model).
    await registry.handleInbound({ platform: 'mock', channelId: 'live', text: 'add auth to the API' });
    getEventBus().emit(EventNames.ORCHESTRATOR_PIPELINE_STARTED, { goal: 'live demo' }, 'test');

    // Allow the async stream handler a microtask to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.sent.some((s) => s.text.includes('pipeline started'))).toBe(true);
    await registry.stop();
  });
});

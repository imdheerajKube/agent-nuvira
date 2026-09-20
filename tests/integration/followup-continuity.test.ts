/**
 * P5 — Followup continuity across the surfaces.
 *
 * The user-facing contract: when someone acts on a SUGGESTED followup (clicks a
 * dashboard chip, re-types a "Try next" line on WhatsApp/Telegram), the turn is a
 * CONTINUATION of the previous execution — the previous answer stays in the
 * thread AND the model is told it is a follow-up — never a fresh independent
 * request. A genuinely new message must NOT be marked as a continuation.
 *
 * Hermetic: a fake engine records what it received; no LLM, no network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatConsole, type ChatEngine } from '../../src/web-dashboard/chat-console.js';
import { GatewayRegistry } from '../../src/gateway/registry.js';
import type { ChannelAdapter, InboundMessage, MessageHandler } from '../../src/gateway/adapters.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-followup-cont-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
  mkdirSync(join(cfgDir, 'gateway'), { recursive: true });
  writeFileSync(
    join(cfgDir, 'nuviraconfig.json'),
    JSON.stringify({ defaultProvider: 'local', providers: { local: { runner: 'ollama', model: 'fast-fail', baseUrl: 'http://127.0.0.1:9' } } }),
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

// ─── A recording fake engine ────────────────────────────────────────────────

interface EngineCall {
  message: string;
  continuation?: boolean;
  history?: Array<{ role: string; content: string }>;
}

class RecordingEngine implements ChatEngine {
  calls: EngineCall[] = [];
  followups: Array<{ prompt: string; label?: string }> = [];
  content = 'The previous answer (Philippines vs Vietnam in December).';

  async answerOnce(
    message: string,
    opts: Parameters<ChatEngine['answerOnce']>[1] = {},
  ): Promise<{ content: string; followups: Array<{ prompt: string; label?: string }> }> {
    this.calls.push({ message, continuation: opts?.continuation, history: opts?.history });
    return { content: this.content, followups: this.followups };
  }
}

// ─── Dashboard console ──────────────────────────────────────────────────────

describe('P5 — dashboard console', () => {
  it('marks a message that matches a suggested followup as a continuation, and keeps the prior turn in history', async () => {
    const engine = new RecordingEngine();
    engine.followups = [{ prompt: 'Draft a 7-day Vietnam itinerary with costs' }];
    const console_ = new ChatConsole({ engine });

    await console_.answer('s1', 'Philippines or Vietnam in December?');
    const followup = await console_.answer('s1', 'Draft a 7-day Vietnam itinerary with costs');

    // The engine saw it as a continuation...
    expect(engine.calls[1].continuation).toBe(true);
    // ...and the previous execution is still threaded.
    expect(engine.calls[1].history).toEqual([
      { role: 'user', content: 'Philippines or Vietnam in December?' },
      { role: 'assistant', content: 'The previous answer (Philippines vs Vietnam in December).' },
    ]);
    // The followup is not duplicated in history (only the raw text once).
    expect(console_.history('s1').filter((t) => t.role === 'user')).toHaveLength(2);
    expect(followup.ok).toBe(true);
  });

  it('does NOT mark an unrelated new message as a continuation', async () => {
    const engine = new RecordingEngine();
    engine.followups = [{ prompt: 'Draft a 7-day Vietnam itinerary with costs' }];
    const console_ = new ChatConsole({ engine });

    await console_.answer('s1', 'Philippines or Vietnam in December?');
    await console_.answer('s1', 'Book the flights for me');

    expect(engine.calls[1].continuation).toBeFalsy();
  });

  it('keeps working when the engine offers no followups at all', async () => {
    const engine = new RecordingEngine();
    engine.followups = [];
    const console_ = new ChatConsole({ engine });
    await console_.answer('s1', 'hello');
    await console_.answer('s1', 'hello again');
    expect(engine.calls[1].continuation).toBeFalsy();
  });
});

// ─── Gateway (WhatsApp/Telegram path) ───────────────────────────────────────

class CaptureAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  readonly configured = true;
  sent: Array<{ channelId: string; text: string }> = [];
  private handler: MessageHandler | null = null;
  describe(): string {
    return 'Capture (test)';
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
}

function gatewayWith(engine: ChatEngine): { registry: GatewayRegistry; adapter: CaptureAdapter } {
  const adapter = new CaptureAdapter();
  const registry = new GatewayRegistry({ streamEvents: false, chatEngine: engine });
  registry.register(adapter);
  return { registry, adapter };
}

describe('P5 — gateway chat', () => {
  beforeEach(() => {
    writeFileSync(join(cfgDir, 'gateway', 'contacts.json'), JSON.stringify({ version: 1, contacts: [] }, null, 2));
  });

  const inbound = (text: string): InboundMessage => ({
    platform: 'telegram',
    channelId: '555000111',
    text,
    from: 'Tester',
    senderId: '555000111',
  });

  it('treats a replied followup as a continuation and renders a clean "Try next" list', async () => {
    const engine = new RecordingEngine();
    engine.followups = [
      { prompt: 'Compare Philippines vs Vietnam in December with a budget' },
      { prompt: '{"tool":"suggest_followups","arguments":{"followups":[]}}' },
      { prompt: '' },
    ];
    const { registry } = gatewayWith(engine);

    const first = await registry.handleInbound(inbound('explain the trade-offs of Philippines vs Vietnam'));

    // The rendered list is CLEAN: leaked tool JSON and empty entries dropped.
    expect(first).toContain('Compare Philippines vs Vietnam in December with a budget');
    expect(first).not.toContain('{"tool"');
    expect(first).toContain('Try next:');
    // Exactly one usable line survived normalization.
    const tryNext = first.slice(first.indexOf('Try next:'));
    expect(tryNext.match(/^\d+\./gm)?.length ?? 0).toBe(1);

    // Now the sender replies with that followup line.
    await registry.handleInbound(inbound('Compare Philippines vs Vietnam in December with a budget'));

    const second = engine.calls[1];
    expect(second.continuation).toBe(true);
    // The prior exchange (including its answer) is in the thread it received.
    expect((second.history ?? []).some((t) => t.role === 'assistant')).toBe(true);
  });

  it('does NOT mark an unrelated inbound as a continuation', async () => {
    const engine = new RecordingEngine();
    engine.followups = [{ prompt: 'Draft a Vietnam itinerary' }];
    const { registry } = gatewayWith(engine);

    await registry.handleInbound(inbound('explain the trade-offs'));
    await registry.handleInbound(inbound('what is the weather in Delhi tomorrow'));

    expect(engine.calls[1].continuation).toBeFalsy();
  });
});

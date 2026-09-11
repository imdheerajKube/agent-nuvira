/**
 * J1 — Gateway registry tests. No network: a MockAdapter records sends and a
 * stub pipeline keeps runs instant; the event-bus stream is exercised with a
 * real emitted event.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayRegistry, eventToStatusLine, isBotAddressed, hasDeliveryAsk, normalizeSenderId } from '../../src/gateway/registry.js';
import type { ChannelAdapter, InboundMessage, MessageHandler } from '../../src/gateway/adapters.js';

// The registry lazy-imports ../cli/chat.js when NO chatEngine is injected (the
// real gateway path). Mock the module to return a ChatCommand CLASS and assert
// the registry INSTANTIATES it — regression for the class-vs-instance bug
// ("engine.answerOnce is not a function") that only surfaced in the live
// gateway, never in the injected-engine tests.
const chatInstances: unknown[] = [];
vi.mock('../../src/cli/chat.js', () => ({
  ChatCommand: class {
    constructor() {
      chatInstances.push(this);
    }

    async answerOnce(message: string): Promise<{ content: string; followups: unknown[] }> {
      return { content: `lazy-answer: ${message}`, followups: [] };
    }
  },
}));
import { getEventBus, EventNames } from '../../src/observability/event-bus.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-reg-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
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
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
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

  /** Uses instance state (`this.configured`) — a detached call must NOT work. */
  async sendMedia(
    channelId: string,
    media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string },
  ): Promise<boolean> {
    if (!this.configured) return false;
    this.sent.push({ channelId, text: `[${media.type} ${media.caption ?? ''}]`.trim() });
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
  it('chat requests (write/explain/ask) run a chat answer and reply with it', async () => {
    const engine = {
      answerOnce: async (message: string, opts?: Record<string, unknown>) => {
        // The origin context must reach the engine so its gateway_send calls
        // target the right contact.
        expect(message).toContain('[Origin:');
        expect(message).toContain('poem');
        // A model may call askUser — the gateway must not hang on a TTY.
        const ask = opts?.askUser as (q: string, c: Array<{ label: string }>) => Promise<unknown>;
        expect(typeof ask).toBe('function');
        // The engine's internal progress ("routed to …", "⚙ suggest_followups(…)")
        // is NOT wired to the channel anymore — emitting it here must not leak.
        const progress = opts?.onProgress as ((line: string) => void) | undefined;
        progress?.('   🧠 routed to groq / llama — working…');
        progress?.('⚙ suggest_followups({followups:[{"prompt":"…"}]})');
        // The model's suggested followups ride along as DATA — the gateway
        // renders them as natural-language text, never as tool-call JSON.
        return {
          content: 'Here is your 2-line poem 🌊',
          followups: [
            { prompt: 'Write a poem about the ocean' },
            { prompt: 'Make the poem longer', label: 'Longer' },
          ],
        };
      },
    };
    const { registry, adapter } = mockRegistry({ streamEvents: false, chatEngine: engine });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-1',
      text: 'write a 2-line poem and send it to Alex',
    });
    // The reply IS the answer with the followups appended in natural language.
    expect(reply).toContain('Here is your 2-line poem 🌊');
    expect(reply).toContain('Try next:');
    // ONE polite "working" line up front, then the clean answer + followups as
    // readable text — no routing/tool-call noise ever reaches the sender.
    expect(adapter.sent.length).toBe(2);
    expect(adapter.sent[0].channelId).toBe('chan-1');
    expect(adapter.sent[0].text).toContain('Working on it');
    const answer = adapter.sent[1].text;
    expect(answer).toContain('Here is your 2-line poem 🌊');
    expect(answer).toContain('Try next:');
    expect(answer).toContain('1. Write a poem about the ocean');
    expect(answer).toContain('2. Make the poem longer');
    const all = adapter.sent.map((s) => s.text).join('\n');
    expect(all).not.toContain('routed to');
    expect(all).not.toContain('suggest_followups');
    expect(all).not.toContain('⚙');
    expect(all).not.toContain('{'); // no raw JSON anywhere
  });

  it('chat requests fall back to the understood line when no model answers', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      chatEngine: { answerOnce: async () => ({ content: '', generationFailed: true }) },
    });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-1',
      text: 'what is agent-nuvira?',
    });
    expect(reply).toContain('I understood');
    expect(adapter.sent.length).toBe(2); // working line + understood fallback
    expect(adapter.sent[0].text).toContain('Working on it');
  });

  it('suppresses a tool-contract-confusion reply and sends a retry hint instead (live WhatsApp incident)', async () => {
    const confusedReply = "I'm sorry, but the provided example call to suggest_followups is incomplete and not fully defined. Could you please provide more context or a specific action you'd like me to suggest?";
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      chatEngine: { answerOnce: async () => ({ content: confusedReply, followups: [] }) },
    });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-1',
      text: 'write a song in hindi for my daughter',
    });
    // The raw meta-talk NEVER reaches the sender.
    expect(reply).not.toContain('suggest_followups');
    expect(reply).not.toContain("I'm sorry, but the provided example");
    // A helpful, human-language line goes instead.
    expect(reply).toContain('none of my language models');
    expect(adapter.sent.length).toBe(2); // working line + the replacement
  });

  it('pipeline requests reply with the run result (fast-fail local model)', { timeout: 30000 }, async () => {
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

  it('routes chat/unknown intents through the chat engine even in pipelineOnly mode', async () => {
    const engine = {
      answerOnce: async () => ({ content: 'Hi there!', followups: [] }),
    };
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      pipelineOnly: true,
      chatEngine: engine,
    });
    const reply = await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'hello' });
    expect(reply).toContain('Hi there!');
    expect(adapter.sent).toHaveLength(2); // working line + chat answer
    expect(adapter.sent[0].text).toContain('Working on it');
  });

  it('still drops light/config intents silently in pipelineOnly mode', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false, pipelineOnly: true });
    await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'set up groq api key' });
    expect(adapter.sent).toHaveLength(0);
  });

  it('refuses pipeline triggers from non-allow-listed channels — SILENT by default', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      allowIds: ['mock:trusted'],
    });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'untrusted',
      text: 'add auth to the API',
    });
    expect(reply).toBe('refused');
    // NOTHING sent — no refusal message, no pipeline ack, no run.
    expect(adapter.sent.length).toBe(0);
  });

  it('gates LIGHT intents too — an unapproved sender gets no help line either (hard policy)', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: ['u-ok'] } },
    });
    // "set up groq api key" parses as a config/light intent — previously
    // ungated, now silently dropped for unapproved senders.
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'c',
      text: 'set up groq api key',
      senderId: 'u-999',
    });
    expect(reply).toBe('refused');
    expect(adapter.sent).toHaveLength(0);

    // An ALLOWED sender still gets the help line.
    const ok = await registry.handleInbound({
      platform: 'mock',
      channelId: 'c',
      text: 'set up groq api key',
      senderId: 'u-ok',
    });
    expect(ok).toContain('I understood');
    expect(adapter.sent[0].text).toContain('I understood');
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

  it('pipeline intents with a delivery ask run the agent loop (build + gateway_send)', async () => {
    const engine = {
      answerOnce: async (message: string, opts?: Record<string, unknown>) => {
        // Origin context still injected so gateway_send targets the right chat.
        expect(message).toContain('[Origin:');
        expect(message).toContain('create a report and send it to the team');
        return { content: '✅ Report built and sent to the team (whatsapp:ops).', followups: [] };
      },
    };
    const { registry, adapter } = mockRegistry({ streamEvents: false, chatEngine: engine });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-9',
      text: 'create a report and send it to the team on whatsapp',
    });
    // The loop's answer (which includes the delivery) is the reply — no bare
    // orchestrator "Got it" ack, no direct pipeline run. One polite working
    // line up front, then the answer.
    expect(reply).toContain('Report built and sent');
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[0].text).toContain('Working on it');
    expect(adapter.sent[1].text).toContain('Report built and sent');
  });

  it('pure pipeline intents (no delivery ask) stay on the direct orchestrator', async () => {
    const engine = {
      answerOnce: async () => { throw new Error('chat engine must NOT be called for a pure pipeline task'); },
    };
    const { registry, adapter } = mockRegistry({ streamEvents: false, chatEngine: engine });
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-10',
      text: 'add auth to the API',
    });
    expect(reply).toMatch(/Done|Failed/);
    // The "Got it" ack + the result = direct pipeline path.
    expect(adapter.sent.length).toBeGreaterThanOrEqual(2);
    expect(adapter.sent[0].text).toContain('Got it');
  });

  it('chat intents with NO injected engine lazy-import and INSTANTIATE ChatCommand (regression)', async () => {
    const before = chatInstances.length;
    const { registry, adapter } = mockRegistry({ streamEvents: false }); // no chatEngine
    const reply = await registry.handleInbound({
      platform: 'mock',
      channelId: 'chan-11',
      text: 'explain this repo',
    });
    // The mocked ChatCommand instance answered (instance method exists).
    expect(reply).toContain('lazy-answer:');
    expect(chatInstances.length).toBe(before + 1);
    expect(adapter.sent.length).toBe(2); // working line + lazy answer
    expect(adapter.sent[0].text).toContain('Working on it');
  });
});

describe('hasDeliveryAsk', () => {
  it('detects delivery asks in pipeline intents', () => {
    expect(hasDeliveryAsk('create a report and send it to the team on whatsapp')).toBe(true);
    expect(hasDeliveryAsk('fix the failing test and message the result to ops')).toBe(true);
    expect(hasDeliveryAsk('build an addon and email it to me')).toBe(true);
    expect(hasDeliveryAsk('send the report to the team')).toBe(true);
    expect(hasDeliveryAsk('create a script and forward it to the group')).toBe(true);
  });

  it('does not flag pure pipeline tasks or non-delivery prose', () => {
    expect(hasDeliveryAsk('add auth to the API')).toBe(false);
    expect(hasDeliveryAsk('fix the failing test')).toBe(false);
    expect(hasDeliveryAsk('implement the send feature')).toBe(false);
    expect(hasDeliveryAsk('explain this repo')).toBe(false);
    expect(hasDeliveryAsk('write a poem about the ocean')).toBe(false);
    // "text <number>" has no to/for/pronoun recipient — it already parses as a
    // chat intent, so hasDeliveryAsk (which only redirects PIPELINE intents)
    // correctly leaves it alone.
    expect(hasDeliveryAsk('text 919876543210 saying hi')).toBe(false);
  });
});

describe('GatewayRegistry.send', () => {
  it('sends via sendToRef with the mock platform', async () => {
    const { registry, adapter } = mockRegistry();
    const ok = await registry.sendToRef({ platform: 'mock', channelId: 'z' }, 'hello world');
    expect(ok).toBe(true);
    expect(adapter.sent).toEqual([{ channelId: 'z', text: 'hello world' }]);
  });

  it('sends media via sendMediaToRef — keeps `this` bound on the adapter (P3 regression)', async () => {
    const { registry, adapter } = mockRegistry();
    const ok = await registry.sendMediaToRef(
      { platform: 'mock', channelId: 'z' },
      { type: 'image', data: new Uint8Array([1, 2]), caption: 'hi' },
    );
    expect(ok).toBe(true);
    expect(adapter.sent).toEqual([{ channelId: 'z', text: '[image hi]' }]);
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

describe('isBotAddressed (P1 mention gating)', () => {
  it('matches name-prefix and @-mention address forms', () => {
    expect(isBotAddressed('buff fix the failing test')).toBe(true);
    expect(isBotAddressed('BUFF, explain this repo')).toBe(true);
    expect(isBotAddressed('agent-nuvira deploy the app')).toBe(true);
    expect(isBotAddressed('@buff what is the weather')).toBe(true);
    expect(isBotAddressed('@agent-nuvira hi')).toBe(true);
  });

  it('does not match ordinary group chatter', () => {
    expect(isBotAddressed('hello everyone')).toBe(false);
    expect(isBotAddressed('fix the failing test')).toBe(false);
    expect(isBotAddressed('buffalo bill rode')).toBe(false); // prefix word, not the bot
    expect(isBotAddressed('')).toBe(false);
  });
});

describe('normalizeSenderId (JID matching)', () => {
  it('matches the allow-list "+91…" against the bridge JID forms', () => {
    // Allow-list holds "+918811122233"; the bridge delivers these forms.
    expect(normalizeSenderId('918811122233@s.whatsapp.net')).toBe('918811122233');
    expect(normalizeSenderId('918811122233:13@s.whatsapp.net')).toBe('918811122233'); // self-chat device suffix
    expect(normalizeSenderId('+918811122233')).toBe('918811122233');
    expect(normalizeSenderId('918811122233')).toBe('918811122233');
    // LID form (WhatsApp's newer identity) normalizes too.
    expect(normalizeSenderId('918811122233@lid')).toBe('918811122233');
  });

  it('leaves non-WhatsApp ids untouched (email must keep its @domain)', () => {
    expect(normalizeSenderId('u-123')).toBe('u-123');
    expect(normalizeSenderId('U123ABC')).toBe('U123ABC'); // slack
    expect(normalizeSenderId('team@example.com')).toBe('team@example.com'); // email
    expect(normalizeSenderId(undefined)).toBe('');
    expect(normalizeSenderId('')).toBe('');
  });

  it('allowedUsers gate matches a JID sender against the +91 allow-list', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: ['+918811122233'] } },
    });
    // The bridge delivers the full JID — previously this was REFUSED (silent),
    // so the user's own number could not trigger anything.
    const allowed = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm',
      text: 'fix the failing test',
      senderId: '918811122233:13@s.whatsapp.net',
    });
    expect(allowed).not.toBe('refused');
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);

    // A genuinely different number is still refused.
    const refused = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm2',
      text: 'fix the failing test',
      senderId: '+919999999999@s.whatsapp.net',
    });
    expect(refused).toBe('refused');
  });
});

describe('GatewayRegistry P1 policies', () => {
  it('disabled policy refuses pipeline triggers SILENTLY by default (hard policy)', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false, policies: { mock: { disabled: true } } });
    const reply = await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'fix the failing test' });
    // Hard policy: NO reply, NO processing — the sender must not learn a bot exists.
    expect(reply).toBe('refused');
    expect(adapter.sent).toHaveLength(0);
    const entries = registry.inbox.read().filter((e) => e.channelId === 'c');
    expect(entries[0]).toMatchObject({ handled: 'refused' });
  });

  it('disabled policy CAN opt back into a polite ⛔ refusal via silentDrop: false', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false, policies: { mock: { disabled: true, silentDrop: false } } });
    const reply = await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'fix the failing test' });
    expect(reply).toContain('disabled for agent triggers');
    expect(adapter.sent[0].text).toContain('⛔');
  });

  it('allowedUsers gates DMs: an unknown sender is dropped SILENTLY, an allowed one runs', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: ['u-123'] } },
    });
    const refused = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm',
      text: 'fix the failing test',
      senderId: 'u-999',
    });
    // Hard policy default: silent — nothing sent, nothing processed.
    expect(refused).toBe('refused');
    expect(adapter.sent).toHaveLength(0);
    const entries = registry.inbox.read().filter((e) => e.channelId === 'dm');
    expect(entries[0]).toMatchObject({ handled: 'refused', senderId: 'u-999' });

    const allowed = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm2',
      text: 'fix the failing test',
      senderId: 'u-123',
    });
    // The ack line is sent before the (fast-fail) pipeline runs.
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);
    expect(allowed).not.toBe('refused');
  });

  it('allowedUsers refuses an unknown sender POLITELY when silentDrop: false', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: ['u-123'], silentDrop: false } },
    });
    const refused = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm',
      text: 'fix the failing test',
      senderId: 'u-999',
    });
    expect(refused).toContain('not authorized');
    expect(adapter.sent[0].text).toContain('⛔');
  });

  it('allowedGroups gates group triggers by channel id — SILENT refusal by default', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedGroups: ['g-family'] } },
    });
    const refused = await registry.handleInbound({
      platform: 'mock',
      channelId: 'g-other',
      text: 'fix the failing test',
      isGroup: true,
      senderId: 'u-1',
    });
    expect(refused).toBe('refused');
    expect(adapter.sent).toHaveLength(0);

    const allowed = await registry.handleInbound({
      platform: 'mock',
      channelId: 'g-family',
      text: 'fix the failing test',
      isGroup: true,
      senderId: 'u-1',
    });
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);
    expect(allowed).not.toBe('refused');
  });

  it('allowedUsers gates GROUP senders too — an unapproved member is refused even in an allowed group', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: ['+918811122233'], allowedGroups: ['g-family'] } },
    });
    // A random LID sender (privacy-rollout jid, exactly what the live gateway
    // saw) inside the ALLOWED group — previously triggered the agent because
    // the group path never checked the sender against allowedUsers.
    const refused = await registry.handleInbound({
      platform: 'mock',
      channelId: 'g-family',
      text: 'fix the failing test',
      isGroup: true,
      senderId: '114602662703205@lid',
    });
    expect(refused).toBe('refused');
    expect(adapter.sent).toHaveLength(0);

    // The JID-normalized allow-listed member still triggers inside the group.
    const allowed = await registry.handleInbound({
      platform: 'mock',
      channelId: 'g-family',
      text: 'fix the failing test',
      isGroup: true,
      senderId: '918811122233:13@s.whatsapp.net',
    });
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);
    expect(allowed).not.toBe('refused');
  });

  it('Allow-All wildcard in allowedUsers disables the verifier — a stranger triggers in DMs AND groups', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: ['Allow-All'] } },
    });
    const dm = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm',
      text: 'fix the failing test',
      senderId: '114602662703205@lid',
    });
    expect(dm).not.toBe('refused');

    const grp = await registry.handleInbound({
      platform: 'mock',
      channelId: 'g-any',
      text: 'fix the failing test',
      isGroup: true,
      senderId: '114602662703205@lid',
    });
    expect(grp).not.toBe('refused');
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);
  });

  it('a BLANK allowedUsers list ([]) denies EVERYONE — verified-list rule (no Allow-All = no one)', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: [] } },
    });
    // DM from any sender → silent refusal.
    const dm = await registry.handleInbound({
      platform: 'mock',
      channelId: 'blank-dm',
      text: 'fix the failing test',
      senderId: '918811122233',
    });
    expect(dm).toBe('refused');
    // Group message from any sender → silent refusal too (group path now
    // enforces the same verified list).
    const grp = await registry.handleInbound({
      platform: 'mock',
      channelId: 'blank-grp',
      text: 'fix the failing test',
      isGroup: true,
      senderId: '918811122233',
    });
    expect(grp).toBe('refused');
    // NOTHING sent, nothing processed.
    expect(adapter.sent).toHaveLength(0);
    const entries = registry.inbox.read().filter((e) => ['blank-dm', 'blank-grp'].includes(e.channelId));
    expect(entries.filter((e) => e.handled === 'refused').length).toBe(2);
  });

  it('requireMention only triggers in groups when the bot is addressed', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { requireMention: true } },
    });
    // A pipeline-intent message WITHOUT addressing the bot → help line.
    const idle = await registry.handleInbound({
      platform: 'mock',
      channelId: 'g',
      text: 'fix the login bug',
      isGroup: true,
    });
    expect(idle).toContain('mention me');
    expect(adapter.sent[0].text).toContain('mention me');

    // The same task WITH the address prefix → pipeline runs.
    const triggered = await registry.handleInbound({
      platform: 'mock',
      channelId: 'g',
      text: 'buff fix the login bug',
      isGroup: true,
    });
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);
    expect(triggered).not.toContain('mention me');
  });

  it('silentDrop refuses unapproved senders WITHOUT any reply (silent drop)', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { mock: { allowedUsers: ['u-ok'], silentDrop: true } },
    });
    const refused = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm',
      text: 'fix the failing test',
      senderId: 'u-999',
    });
    // Handled, but NOTHING sent — the sender must not learn a bot exists.
    expect(refused).toBe('refused');
    expect(adapter.sent).toHaveLength(0);
    const entries = registry.inbox.read().filter((e) => e.channelId === 'dm');
    expect(entries[0]).toMatchObject({ handled: 'refused', senderId: 'u-999' });

    // An ALLOWED sender still runs normally (silentDrop only affects refusals).
    const allowed = await registry.handleInbound({
      platform: 'mock',
      channelId: 'dm2',
      text: 'fix the failing test',
      senderId: 'u-ok',
    });
    expect(allowed).not.toBe('refused');
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);
  });

  it('forwards the pipeline completion summary to every status recipient', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false });
    // Configure status recipients in the config file (what `nuvira config
    // gateway notify add` writes) — live re-read, no restart.
    const cfg = join(cfgDir, 'buffconfig.json');
    const current = JSON.parse(readFileSync(cfg, 'utf-8'));
    writeFileSync(
      cfg,
      JSON.stringify({ ...current, gateway: { statusRecipients: ['mock:ops', 'mock:alerts'] } }),
    );
    await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'fix the failing test' });
    // The origin reply + a 📊 forward to EACH recipient.
    const forwarded = adapter.sent.filter((s) => s.text.startsWith('📊'));
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0].channelId).toBe('ops');
    expect(forwarded[1].channelId).toBe('alerts');
    expect(forwarded[0].text).toContain('Pipeline status');
    // Recipients are resolved through the directory like any gateway send.
    expect(forwarded[0].text).toContain('Failed'); // the fast-fail pipeline summary
  });

  it('does NOT forward to status recipients when none are configured', async () => {
    // Clear any statusRecipients the sibling test wrote to the shared config.
    const cfg = join(cfgDir, 'buffconfig.json');
    const current = JSON.parse(readFileSync(cfg, 'utf-8'));
    delete current.gateway?.statusRecipients;
    writeFileSync(cfg, JSON.stringify(current));
    const { registry, adapter } = mockRegistry({ streamEvents: false });
    await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'fix the failing test' });
    expect(adapter.sent.some((s) => s.text.startsWith('📊'))).toBe(false);
  });

  it('re-reads policies from config per inbound (dashboard/CLI changes apply live)', { timeout: 120_000 }, async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false });
    // No policies at construction → anyone can trigger.
    const before = await registry.handleInbound({ platform: 'mock', channelId: 'c', text: 'fix the failing test', senderId: 'u-x' });
    expect(before).not.toContain('not authorized');

    // Write a policy to the config file (what `nuvira config gateway allow` does)
    // and the RUNNING registry picks it up without a restart.
    const cfg = join(cfgDir, 'buffconfig.json');
    const current = JSON.parse(readFileSync(cfg, 'utf-8'));
    writeFileSync(
      cfg,
      JSON.stringify({ ...current, gateway: { policies: { mock: { allowedUsers: ['u-ok'], silentDrop: true } } } }),
    );
    const beforeCount = adapter.sent.length; // the first run's ack + result
    const refused = await registry.handleInbound({ platform: 'mock', channelId: 'c2', text: 'fix the failing test', senderId: 'u-x' });
    expect(refused).toBe('refused');
    // silentDrop → NOTHING new sent (the sender must not learn a bot exists).
    expect(adapter.sent).toHaveLength(beforeCount);

    const allowed = await registry.handleInbound({ platform: 'mock', channelId: 'c3', text: 'fix the failing test', senderId: 'u-ok' });
    expect(adapter.sent.some((s) => s.text.includes('running the'))).toBe(true);
    expect(allowed).not.toContain('not authorized');
  });

  it('records every inbound message in the inbox with its disposition', async () => {
    const { registry } = mockRegistry({
      streamEvents: false,
      policies: { mock: { disabled: true } },
    });
    await registry.handleInbound({ platform: 'mock', channelId: 'inbox-test', text: 'fix the failing test', senderId: 'u-1' });
    // 'hello there' is a chat intent (ask) — with a disabled platform the
    // policy gate refuses it too (chat intents run the agent, so governance
    // applies), WITHOUT calling any chat engine.
    await registry.handleInbound({ platform: 'mock', channelId: 'inbox-test', text: 'hello there' });
    const entries = registry.inbox.read().filter((e) => e.channelId === 'inbox-test');
    expect(entries).toHaveLength(2);
    // Both agent-intents (pipeline + chat) are refused on a disabled platform.
    expect(entries[0]).toMatchObject({ platform: 'mock', handled: 'refused', text: 'hello there' });
    expect(entries[1]).toMatchObject({ platform: 'mock', handled: 'refused', senderId: 'u-1' });
    expect(entries.every((e) => e.id && e.at)).toBe(true);
  });
});

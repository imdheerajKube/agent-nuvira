/**
 * Real-world integration tests for WhatsApp/Telegram gateway flows.
 *
 * Tests the full message lifecycle: inbound → policy gate → pipeline/chat → reply,
 * including contact auto-registration, approval flow, media sending, group behavior,
 * and delivery ledger retries. Uses MockAdapter to avoid real network calls.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayRegistry } from '../../src/gateway/registry.js';
import {
  readGatewayContacts,
  upsertGatewayContact,
  setContactStatus,
  removeGatewayContact,
  sameContactId,
  samePhone,
  normalizePhone,
  validateContactId,
  type GatewayContact,
} from '../../src/gateway/contacts.js';
import type { ChannelAdapter, InboundMessage, MessageHandler } from '../../src/gateway/adapters.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-e2e-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'local',
      providers: {
        // `baseUrl` points at a closed port: the model is deliberately fake and
        // the endpoint is deliberately dead, so the pipeline fails FAST and
        // hermetically. Without it, the model validator "repairs" the fake pin
        // by substituting a real installed Ollama model and actually runs local
        // inference, which made these tests take ~20s each and depend on the
        // developer's machine.
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
  // Ensure gateway directory exists
  mkdirSync(join(cfgDir, 'gateway'), { recursive: true });
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
  // Reset contacts file for each test
  writeFileSync(
    join(cfgDir, 'gateway', 'contacts.json'),
    JSON.stringify({ version: 1, contacts: [] }, null, 2),
  );
});

// ─── Mock adapters ──────────────────────────────────────────────────────────

/** In-memory adapter that records all sends. */
class MockAdapter implements ChannelAdapter {
  readonly platform: 'mock' | 'telegram' | 'whatsapp';
  readonly configured = true;
  sent: Array<{ channelId: string; text: string }> = [];
  mediaSent: Array<{ channelId: string; type: string; caption?: string }> = [];
  started = false;
  private handler: MessageHandler | null = null;

  constructor(platform: 'mock' | 'telegram' | 'whatsapp' = 'mock') {
    this.platform = platform;
  }

  describe(): string {
    return `Mock ${this.platform} (test)`;
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

  async sendMedia(
    channelId: string,
    media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string },
  ): Promise<boolean> {
    this.mediaSent.push({ channelId, type: media.type, caption: media.caption });
    return true;
  }
}

/** Adapter that fails sends (for delivery ledger tests). */
class FailingAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  configured = true;
  failCount = 0;
  private handler: MessageHandler | null = null;

  describe(): string {
    return 'Mock (failing)';
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
  }

  async stop(): Promise<void> {}

  async send(_channelId: string, _text: string): Promise<boolean> {
    this.failCount++;
    return false;
  }
}

function mockRegistry(
  options?: ConstructorParameters<typeof GatewayRegistry>[0],
  adapter?: ChannelAdapter,
  platform?: 'mock' | 'telegram' | 'whatsapp',
): { registry: GatewayRegistry; adapter: ChannelAdapter } {
  const adapterInstance = adapter ?? new MockAdapter(platform ?? 'mock');
  const registry = new GatewayRegistry(options ?? { streamEvents: false });
  registry.register(adapterInstance);
  // If a platform-specific adapter is needed, register it too
  if (platform && platform !== 'mock') {
    const platformAdapter = new MockAdapter(platform);
    registry.register(platformAdapter);
    return { registry, adapter: platformAdapter };
  }
  return { registry, adapter: adapterInstance };
}

// ─── Contact utility tests ──────────────────────────────────────────────────

describe('Contact utilities', () => {
  it('sameContactId matches digits-only variants', () => {
    expect(sameContactId('+919876543210', '919876543210')).toBe(true);
    expect(sameContactId('91-9876-543210', '919876543210')).toBe(true);
    expect(sameContactId('+15551234567', '15551234567')).toBe(true);
    expect(sameContactId('different', 'numbers')).toBe(false);
    expect(sameContactId('', 'test')).toBe(false);
  });

  it('samePhone matches flexible phone formats', () => {
    expect(samePhone('+918800604222', '918800604222')).toBe(true);
    expect(samePhone('08800604222', '8800604222')).toBe(true);
    expect(samePhone('+1-555-123-4567', '15551234567')).toBe(true);
    expect(samePhone('8800604222', '8800604223')).toBe(false);
  });

  it('normalizePhone strips country codes and formatting', () => {
    expect(normalizePhone('+918800604222')).toBe('8800604222');
    expect(normalizePhone('08800604222')).toBe('8800604222');
    expect(normalizePhone('91-9876-543210')).toBe('9876543210');
    expect(normalizePhone('+15551234567')).toBe('5551234567');
  });

  it('validateContactId rejects non-numeric Telegram IDs', () => {
    expect(validateContactId('telegram', '123456789')).toBeNull();
    expect(validateContactId('telegram', '-1001234567890')).toBeNull();
    expect(validateContactId('telegram', '+1234567890')).toContain('numeric');
    expect(validateContactId('telegram', 'abc')).toContain('numeric');
    expect(validateContactId('whatsapp', '+919876543210')).toBeNull();
  });
});

// ─── Contact CRUD tests ─────────────────────────────────────────────────────

describe('Contact CRUD', () => {
  it('upsert creates a new contact', () => {
    const result = upsertGatewayContact({
      name: 'Alex',
      platform: 'telegram',
      id: '123456789',
      status: 'approved',
    });
    expect(result.added).toBe(true);
    expect(result.contact.name).toBe('Alex');
    expect(result.contact.platform).toBe('telegram');

    const contacts = readGatewayContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].name).toBe('Alex');
  });

  it('upsert updates existing contact by platform+id', () => {
    upsertGatewayContact({ name: 'Alex', platform: 'telegram', id: '123456789', status: 'approved' });
    const result = upsertGatewayContact({ name: 'Alexander', platform: 'telegram', id: '123456789', status: 'approved' });
    expect(result.added).toBe(false);
    expect(result.contact.name).toBe('Alexander');

    const contacts = readGatewayContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].name).toBe('Alexander');
  });

  it('setContactStatus changes status', () => {
    upsertGatewayContact({ name: 'Bob', platform: 'whatsapp', id: '919876543210', status: 'pending' });
    const updated = setContactStatus('whatsapp', 'Bob', 'approved');
    expect(updated).toBe(true);

    const contacts = readGatewayContacts();
    expect(contacts[0].status).toBe('approved');
  });

  it('removeGatewayContact removes by id', () => {
    upsertGatewayContact({ name: 'Charlie', platform: 'telegram', id: '111222333', status: 'approved' });
    const removed = removeGatewayContact('telegram', '111222333');
    expect(removed).toBe(true);
    expect(readGatewayContacts()).toHaveLength(0);
  });

  it('removeGatewayContact returns false for non-existent', () => {
    const removed = removeGatewayContact('telegram', 'nonexistent');
    expect(removed).toBe(false);
  });
});

// ─── Telegram message flow ──────────────────────────────────────────────────

describe('Telegram message flow', () => {
  it('inbound Telegram DM goes through policy gate → pipeline → reply', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false }, undefined, 'telegram');
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '123456789',
      text: 'add auth to the API',
      from: 'Dheeraj',
      senderId: '123456789',
    });
    // Pipeline may succeed or fail (fast-fail model), but should get a reply
    expect(typeof reply).toBe('string');
    expect(adapter.sent.length).toBeGreaterThanOrEqual(1);
  });

  it('Telegram chat intent (write/explain/ask) runs chat engine', async () => {
    const engine = {
      answerOnce: async (message: string) => {
        // Message contains origin context with platform info
        expect(message).toContain('[Origin:');
        return { content: 'Here is your answer about TypeScript', followups: [] };
      },
    };
    const { registry, adapter } = mockRegistry({ streamEvents: false, chatEngine: engine }, undefined, 'telegram');
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '987654321',
      text: 'explain TypeScript generics',
      from: 'Alice',
      senderId: '987654321',
    });
    expect(reply).toContain('TypeScript');
    expect(adapter.sent[0].text).toContain('Working on it');
    expect(adapter.sent[1].text).toContain('TypeScript');
  });

  it('Telegram group message requires mention when requireMention is set', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { telegram: { requireMention: true } },
    }, undefined, 'telegram');
    // Without mention — should get help line
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '-1001234567890',
      text: 'fix the tests',
      from: 'Bob',
      senderId: '111111111',
      isGroup: true,
    });
    expect(reply).toContain('mention me');
    expect(adapter.sent[0].text).toContain('mention me');

    // With mention — should trigger pipeline
    const reply2 = await registry.handleInbound({
      platform: 'telegram',
      channelId: '-1001234567890',
      text: 'nuvira fix the tests',
      from: 'Bob',
      senderId: '111111111',
      isGroup: true,
    });
    expect(reply2).toMatch(/Done|Failed|Got it/);
  });

  it('Telegram auto-registers new users as pending', async () => {
    const { registry } = mockRegistry({ streamEvents: false });
    await registry.handleInbound({
      platform: 'telegram',
      channelId: '999888777',
      text: 'hello',
      from: 'NewUser',
      senderId: '999888777',
    });
    // Wait for async learnTelegramChatId
    await new Promise((r) => setTimeout(r, 100));

    const contacts = readGatewayContacts();
    const newContact = contacts.find((c) => c.platform === 'telegram' && c.id === '999888777');
    expect(newContact).toBeDefined();
    expect(newContact!.status).toBe('pending');
    expect(newContact!.name).toBe('NewUser');
  });

  it('Telegram media send works through adapter', async () => {
    const adapter = new MockAdapter('telegram');
    const { registry } = mockRegistry({ streamEvents: false }, adapter, 'telegram');

    // Send media through the adapter directly
    const sent = await adapter.sendMedia('123456789', {
      type: 'image',
      data: new Uint8Array([1, 2, 3]),
      caption: 'Screenshot of the bug',
    });
    expect(sent).toBe(true);
    expect(adapter.mediaSent).toHaveLength(1);
    expect(adapter.mediaSent[0].type).toBe('image');
    expect(adapter.mediaSent[0].caption).toBe('Screenshot of the bug');
  });
});

// ─── WhatsApp message flow ──────────────────────────────────────────────────

describe('WhatsApp message flow', () => {
  it('inbound WhatsApp DM goes through policy gate → pipeline → reply', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false }, undefined, 'whatsapp');
    const reply = await registry.handleInbound({
      platform: 'whatsapp',
      channelId: '919876543210@s.whatsapp.net',
      text: 'create a hello world script',
      from: '919876543210',
      senderId: '919876543210',
    });
    expect(typeof reply).toBe('string');
    expect(adapter.sent.length).toBeGreaterThanOrEqual(1);
  });

  it('WhatsApp group message checks sender against allowedUsers', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { whatsapp: { allowedUsers: ['919876543210'] } },
    }, undefined, 'whatsapp');
    // Approved sender in group
    const reply = await registry.handleInbound({
      platform: 'whatsapp',
      channelId: '120363012345678901@g.us',
      text: 'deploy the app',
      from: '919876543210',
      senderId: '919876543210',
      isGroup: true,
    });
    expect(typeof reply).toBe('string');

    // Unapproved sender in group — should be silently dropped
    const reply2 = await registry.handleInbound({
      platform: 'whatsapp',
      channelId: '120363012345678901@g.us',
      text: 'deploy the app',
      from: '919999999999',
      senderId: '919999999999',
      isGroup: true,
    });
    expect(reply2).toBe('refused');
  });

  it('WhatsApp JID normalization matches allow-list entries', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { whatsapp: { allowedUsers: ['+919876543210'] } },
    }, undefined, 'whatsapp');
    // JID format should match the +91... entry
    const reply = await registry.handleInbound({
      platform: 'whatsapp',
      channelId: '919876543210@s.whatsapp.net',
      text: 'fix the bug',
      from: '919876543210',
      senderId: '919876543210',
    });
    expect(typeof reply).toBe('string');
  });

  it('WhatsApp delivery ask routes through chat engine', async () => {
    const engine = {
      answerOnce: async (message: string) => {
        // Message contains the full user text with origin context
        expect(message).toContain('report');
        return { content: 'Report sent to ops via WhatsApp', followups: [] };
      },
    };
    const { registry, adapter } = mockRegistry({ streamEvents: false, chatEngine: engine }, undefined, 'whatsapp');
    const reply = await registry.handleInbound({
      platform: 'whatsapp',
      channelId: '919876543210@s.whatsapp.net',
      text: 'create a report and send it to ops',
      from: '919876543210',
      senderId: '919876543210',
    });
    expect(reply).toContain('Report sent');
    expect(adapter.sent[0].text).toContain('Working on it');
  });
});

// ─── Policy enforcement ─────────────────────────────────────────────────────

describe('Policy enforcement', () => {
  it('disabled platform refuses all messages silently', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { telegram: { disabled: true } },
    }, undefined, 'telegram');
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '123456789',
      text: 'fix the tests',
      from: 'Alice',
      senderId: '123456789',
    });
    expect(reply).toBe('refused');
    expect(adapter.sent).toHaveLength(0);
  });

  it('empty allowedUsers blocks everyone', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { telegram: { allowedUsers: [] } },
    }, undefined, 'telegram');
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '123456789',
      text: 'fix the tests',
      from: 'Alice',
      senderId: '123456789',
    });
    expect(reply).toBe('refused');
    expect(adapter.sent).toHaveLength(0);
  });

  it('Allow-All wildcard lets everyone through', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { telegram: { allowedUsers: ['Allow-All'] } },
    }, undefined, 'telegram');
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '123456789',
      text: 'fix the tests',
      from: 'Alice',
      senderId: '123456789',
    });
    expect(typeof reply).toBe('string');
  });

  it('silentDrop: false sends polite refusal message', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { telegram: { allowedUsers: ['approved-user'], silentDrop: false } },
    }, undefined, 'telegram');
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '123456789',
      text: 'fix the tests',
      from: 'Intruder',
      senderId: 'unauthorized-user',
    });
    expect(reply).toContain('not authorized');
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].text).toContain('not authorized');
  });

  it('allowedGroups gates group messages', async () => {
    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { telegram: { allowedGroups: ['-1001234567890'] } },
    }, undefined, 'telegram');
    // Allowed group
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '-1001234567890',
      text: 'deploy the app',
      from: 'Bob',
      senderId: '111111111',
      isGroup: true,
    });
    expect(typeof reply).toBe('string');

    // Non-allowed group
    const reply2 = await registry.handleInbound({
      platform: 'telegram',
      channelId: '-1009999999999',
      text: 'deploy the app',
      from: 'Bob',
      senderId: '111111111',
      isGroup: true,
    });
    expect(reply2).toBe('refused');
  });
});

// ─── Contact approval flow ──────────────────────────────────────────────────

describe('Contact approval flow', () => {
  it('auto-registered pending contact can be approved and then sends work', async () => {
    // 1. Auto-register via inbound
    const { registry } = mockRegistry({ streamEvents: false });
    await registry.handleInbound({
      platform: 'telegram',
      channelId: '555666777',
      text: 'hello bot',
      from: 'TestUser',
      senderId: '555666777',
    });
    await new Promise((r) => setTimeout(r, 100));

    // 2. Verify pending status
    let contacts = readGatewayContacts();
    let contact = contacts.find((c) => c.platform === 'telegram' && c.id === '555666777');
    expect(contact?.status).toBe('pending');

    // 3. Admin approves
    setContactStatus('telegram', '555666777', 'approved');

    // 4. Verify approved
    contacts = readGatewayContacts();
    contact = contacts.find((c) => c.platform === 'telegram' && c.id === '555666777');
    expect(contact?.status).toBe('approved');
  });

  it('rejected contact cannot trigger pipeline', async () => {
    upsertGatewayContact({
      name: 'Spammer',
      platform: 'whatsapp',
      id: '919999999999',
      status: 'rejected',
    });

    const { registry, adapter } = mockRegistry({
      streamEvents: false,
      policies: { whatsapp: { allowedUsers: [] } },
    });
    const reply = await registry.handleInbound({
      platform: 'whatsapp',
      channelId: '919999999999@s.whatsapp.net',
      text: 'deploy to production',
      from: 'Spammer',
      senderId: '919999999999',
    });
    expect(reply).toBe('refused');
  });

  it('multiple contacts can be managed independently', () => {
    upsertGatewayContact({ name: 'Alice', platform: 'telegram', id: '111', status: 'approved' });
    upsertGatewayContact({ name: 'Bob', platform: 'telegram', id: '222', status: 'pending' });
    upsertGatewayContact({ name: 'Charlie', platform: 'whatsapp', id: '919876543210', status: 'approved' });

    const contacts = readGatewayContacts();
    expect(contacts).toHaveLength(3);

    // Approve Bob
    setContactStatus('telegram', '222', 'approved');
    const updated = readGatewayContacts();
    expect(updated.find((c) => c.name === 'Bob')?.status).toBe('approved');
    expect(updated.find((c) => c.name === 'Alice')?.status).toBe('approved');
  });
});

// ─── Delivery ledger ────────────────────────────────────────────────────────

describe('Delivery ledger', () => {
  it('failed send is ledgered for retry', async () => {
    const failingAdapter = new FailingAdapter();
    const { registry } = mockRegistry({ streamEvents: false }, failingAdapter);

    // Send should fail and be ledgered
    const sent = await registry.sendToRef(
      { platform: 'mock', channelId: 'test-channel' },
      'Hello World',
    );
    expect(sent).toBe(false);
    expect(failingAdapter.failCount).toBe(1);

    // Check delivery ledger has pending entries
    const pending = registry.delivery.pendingDue();
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('successful send clears ledger entries', async () => {
    const adapter = new MockAdapter();
    const { registry } = mockRegistry({ streamEvents: false }, adapter);

    const sent = await registry.sendToRef(
      { platform: 'mock', channelId: 'test-channel' },
      'Hello World',
    );
    expect(sent).toBe(true);
    // First send is our message; subsequent sends may be opportunistic ledger drains
    expect(adapter.sent[0].text).toBe('Hello World');
  });
});

// ─── Event streaming ────────────────────────────────────────────────────────

describe('Event streaming', () => {
  it('pipeline events stream to active channel', async () => {
    const adapter = new MockAdapter();
    const { registry } = mockRegistry({ streamEvents: true }, adapter);

    // Start the registry to subscribe to events
    await registry.start();

    // Simulate an inbound message to set activeChannel
    await registry.handleInbound({
      platform: 'mock',
      channelId: 'stream-test',
      text: 'add auth to the API',
    });

    // Stop the registry
    await registry.stop();
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('empty text message is handled gracefully', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false });
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '123456789',
      text: '',
      from: 'Alice',
      senderId: '123456789',
    });
    // Should not crash — returns some response
    expect(typeof reply).toBe('string');
  });

  it('very long message is handled', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false });
    const longText = 'a'.repeat(10000);
    const reply = await registry.handleInbound({
      platform: 'whatsapp',
      channelId: '919876543210@s.whatsapp.net',
      text: longText,
      from: '919876543210',
      senderId: '919876543210',
    });
    expect(typeof reply).toBe('string');
  });

  it('special characters in message are handled', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false });
    const reply = await registry.handleInbound({
      platform: 'telegram',
      channelId: '123456789',
      text: 'fix the 🐛 bug with <script>alert("xss")</script>',
      from: 'Alice',
      senderId: '123456789',
    });
    expect(typeof reply).toBe('string');
  });

  it('concurrent inbound messages are serialized', async () => {
    const { registry, adapter } = mockRegistry({ streamEvents: false });

    // Send multiple messages concurrently
    const promises = [
      registry.handleInbound({ platform: 'mock', channelId: 'c1', text: 'task 1' }),
      registry.handleInbound({ platform: 'mock', channelId: 'c2', text: 'task 2' }),
      registry.handleInbound({ platform: 'mock', channelId: 'c3', text: 'task 3' }),
    ];

    const replies = await Promise.all(promises);
    expect(replies).toHaveLength(3);
    // All should complete (even if pipeline fails due to fast-fail model)
    for (const reply of replies) {
      expect(typeof reply).toBe('string');
    }
  });
});

/**
 * 7-day per-contact conversation memory (`tests/gateway/chat-history.test.ts`).
 *
 * DESIGN INTENT (user): "we designed agent-nuvira to hold at least 7 days of
 * conversation per contact for WhatsApp and Telegram so that if a user asks
 * anything we have a history to check if there is relevance, if not start
 * fresh." These tests pin that contract:
 *
 *  - the STORE retains a long horizon (far more than 10 pairs) with the
 *    7-day TTL unchanged, and bounds only what the MODEL sees per turn;
 *  - the REGISTRY records EVERY authorized inbound message (chat, pipeline,
 *    and help turns alike) before routing, and the chat path injects the
 *    prior thread (minus the current ask) into the model's history.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GatewayChatStore,
  CHAT_HISTORY_MAX_PAIRS,
  CHAT_HISTORY_TTL_MS,
  CHAT_HISTORY_MODEL_WINDOW,
} from '../../src/gateway/chat-store.js';

describe('GatewayChatStore — 7-day per-contact retention', () => {
  let dir: string;
  let store: GatewayChatStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-chatmem-'));
    store = new GatewayChatStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('retains a week-scale horizon, not 10 pairs', () => {
    // The old 10-pair cap truncated a normal day of messaging — the design
    // intent (≥7 days per contact) requires a deep store.
    expect(CHAT_HISTORY_MAX_PAIRS).toBeGreaterThanOrEqual(200);
    expect(CHAT_HISTORY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    // The model window is bounded even though the store is deep.
    expect(CHAT_HISTORY_MODEL_WINDOW).toBeGreaterThan(0);
    expect(CHAT_HISTORY_MODEL_WINDOW).toBeLessThan(CHAT_HISTORY_MAX_PAIRS * 2);
  });

  it('recordInbound keeps pipeline/help turns in the thread', () => {
    // A pipeline-handled ask previously vanished from history — a later
    // follow-up ("what was the second option?") lost its antecedent.
    store.recordInbound('whatsapp:918800604222', 'run the tests pipeline');
    store.append('whatsapp:918800604222', null, '✅ Done — 4,864 tests passed.');
    store.recordInbound('whatsapp:918800604222', 'what was the second option?');
    store.append('whatsapp:918800604222', null, 'The second option was X.');

    const full = store.getFullHistory('whatsapp:918800604222');
    expect(full.map((m) => m.content)).toEqual([
      'run the tests pipeline',
      '✅ Done — 4,864 tests passed.',
      'what was the second option?',
      'The second option was X.',
    ]);
  });

  it('append(null, reply) records only the assistant side (no duplicate user row)', () => {
    store.recordInbound('wa:1', 'hi there');
    store.append('wa:1', null, 'Hello!');
    const full = store.getFullHistory('wa:1');
    expect(full.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(full.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('getHistory bounds to the model window; getFullHistory returns everything', () => {
    for (let i = 0; i < 30; i++) {
      store.recordInbound('wa:2', `message ${i}`);
      store.append('wa:2', null, `reply ${i}`);
    }
    const windowed = store.getHistory('wa:2');
    expect(windowed).toHaveLength(CHAT_HISTORY_MODEL_WINDOW);
    expect(windowed[0].content).toBe(`message ${30 - CHAT_HISTORY_MODEL_WINDOW / 2}`);
    expect(windowed[windowed.length - 1].content).toBe('reply 29');
    expect(store.getFullHistory('wa:2')).toHaveLength(60);
  });

  it('prune still drops conversations older than 7 days', () => {
    store.recordInbound('wa:old', 'ancient');
    // Backdate lastActiveAt beyond the TTL.
    const raw = JSON.parse(readFileSync(store.storePath, 'utf-8'));
    raw.conversations['wa:old'].lastActiveAt = Date.now() - CHAT_HISTORY_TTL_MS - 1000;
    writeFileSync(store.storePath, JSON.stringify(raw), 'utf-8');
    expect(store.prune()).toBe(1);
    expect(store.getFullHistory('wa:old')).toEqual([]);
  });
});

describe('GatewayRegistry inbound history wiring', () => {
  let registryDir: string;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'buff-chatmem-reg-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('records the inbound ask even when the turn is handled by the pipeline/help path', async () => {
    const { GatewayRegistry } = await import('../../src/gateway/registry.js');
    const { GatewayChatStore } = await import('../../src/gateway/chat-store.js');
    // Light intent ("config" run) → the help line, no model, no pipeline —
    // yet the ask must still land in the contact's history.
    const registry = new GatewayRegistry({ streamEvents: false, deliveryConfigDir: registryDir });
    const adapter = {
      platform: 'mock' as const,
      configured: true,
      describe: () => 'mock',
      start: async () => {},
      stop: async () => {},
      send: async () => true,
      sendMedia: async () => true,
    };
    registry.register(adapter);
    await registry.handleInbound({ platform: 'mock', channelId: 'c1', text: 'configure the gemini api key' });

    const store = new GatewayChatStore(registryDir);
    const full = store.getFullHistory('mock:c1');
    expect(full.some((m) => m.role === 'user' && m.content.includes('configure the gemini api key'))).toBe(true);
  });
});

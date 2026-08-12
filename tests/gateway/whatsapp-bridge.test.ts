/**
 * I8 — WhatsApp bridge tests.
 *
 * The WhatsApp platform is the personal Baileys bridge (no paid API): the
 * adapter is exercised with a fake bridge (hermetic — never imports baileys),
 * jid normalization is pure, and the real BaileysBridge is asserted in its
 * unpaired state (temp session dir, no creds.json).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeWhatsAppJid, type WhatsAppBridge } from '../../src/gateway/whatsapp/bridge.js';
import { WhatsAppBridgeAdapter } from '../../src/gateway/adapters.js';
import { BaileysBridge } from '../../src/gateway/whatsapp/baileys-bridge.js';
import { hasWhatsAppSession, whatsappSessionDir } from '../../src/gateway/whatsapp/session.js';

// ─── JID normalization (pure) ───────────────────────────────────────────────

describe('normalizeWhatsAppJid', () => {
  it('maps E.164 and plain numbers to @s.whatsapp.net', () => {
    expect(normalizeWhatsAppJid('+15551234567')).toBe('15551234567@s.whatsapp.net');
    expect(normalizeWhatsAppJid('15551234567')).toBe('15551234567@s.whatsapp.net');
    // Internal whitespace is stripped — never emits a jid containing spaces.
    expect(normalizeWhatsAppJid('+1 555 123 4567')).toBe('15551234567@s.whatsapp.net');
  });

  it('passes native JIDs through verbatim', () => {
    expect(normalizeWhatsAppJid('12025550123@s.whatsapp.net')).toBe('12025550123@s.whatsapp.net');
    expect(normalizeWhatsAppJid('123456789@g.us')).toBe('123456789@g.us');
    expect(normalizeWhatsAppJid('123456789@lid')).toBe('123456789@lid');
    expect(normalizeWhatsAppJid('12025550123@broadcast')).toBe('12025550123@broadcast');
  });

  it('falls back to @s.whatsapp.net for arbitrary ids and empty input', () => {
    expect(normalizeWhatsAppJid('alice')).toBe('alice@s.whatsapp.net');
    expect(normalizeWhatsAppJid('  ')).toBe('');
  });
});

// ─── Adapter + fake bridge (hermetic) ───────────────────────────────────────

class FakeBridge implements WhatsAppBridge {
  paired: boolean;
  connected = false;
  sent: Array<{ jid: string; text: string }> = [];
  failSend = false;
  inbound: Array<{ from: string; text: string }> = [];
  onMessage: ((from: string, text: string) => void) | null = null;

  constructor(paired = true) {
    this.paired = paired;
  }

  describe(): string {
    return this.paired ? 'fake bridge paired' : 'fake bridge unpaired';
  }

  async connect(onMessage: (from: string, text: string) => void): Promise<void> {
    this.onMessage = onMessage;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(target: string, text: string): Promise<boolean> {
    if (!this.paired || this.failSend) return false;
    this.sent.push({ jid: normalizeWhatsAppJid(target), text });
    return true;
  }

  emit(from: string, text: string): void {
    this.onMessage?.(from, text);
  }
}

describe('WhatsAppBridgeAdapter', () => {
  it('configured reflects the bridge paired state, describe() passes through', () => {
    const paired = new WhatsAppBridgeAdapter(new FakeBridge(true));
    const unpaired = new WhatsAppBridgeAdapter(new FakeBridge(false));
    expect(paired.configured).toBe(true);
    expect(unpaired.configured).toBe(false);
    expect(paired.describe()).toContain('paired');
  });

  it('send() normalizes E.164 to a JID and passes the text to the bridge', async () => {
    const fake = new FakeBridge(true);
    const adapter = new WhatsAppBridgeAdapter(fake);
    expect(await adapter.send('+15551234567', 'hello')).toBe(true);
    expect(fake.sent).toEqual([{ jid: '15551234567@s.whatsapp.net', text: 'hello' }]);
  });

  it('send() returns false when unpaired (never throws)', async () => {
    const adapter = new WhatsAppBridgeAdapter(new FakeBridge(false));
    expect(await adapter.send('+15551234567', 'hello')).toBe(false);
  });

  it('start() dispatches inbound messages to the handler, stop() disconnects', async () => {
    const fake = new FakeBridge(true);
    const adapter = new WhatsAppBridgeAdapter(fake);
    const received: Array<{ platform: string; channelId: string; text: string }> = [];
    await adapter.start((m) => received.push(m));
    fake.emit('15551234567@s.whatsapp.net', 'hi there');
    await adapter.stop();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ platform: 'whatsapp', channelId: '15551234567@s.whatsapp.net', text: 'hi there' });
    expect(fake.connected).toBe(false);
  });
});

// ─── Real BaileysBridge — unpaired state (no network, no baileys socket) ───

describe('BaileysBridge (unpaired)', () => {
  let sessionDir = '';
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'buff-wa-session-'));
    envBackup.BUFF_WHATSAPP_SESSION_DIR = process.env.BUFF_WHATSAPP_SESSION_DIR;
    process.env.BUFF_WHATSAPP_SESSION_DIR = sessionDir;
  });

  afterEach(() => {
    if (envBackup.BUFF_WHATSAPP_SESSION_DIR === undefined) delete process.env.BUFF_WHATSAPP_SESSION_DIR;
    else process.env.BUFF_WHATSAPP_SESSION_DIR = envBackup.BUFF_WHATSAPP_SESSION_DIR;
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('reports unpaired when no creds.json exists and send() fails fast', async () => {
    const bridge = new BaileysBridge(sessionDir);
    expect(bridge.paired).toBe(false);
    expect(hasWhatsAppSession(sessionDir)).toBe(false);
    expect(await bridge.send('+15551234567', 'hello')).toBe(false);
    expect(bridge.describe()).toContain('not paired');
  });

  it('reports paired once a creds.json exists (session presence = configured)', () => {
    writeFileSync(join(sessionDir, 'creds.json'), '{}', 'utf-8');
    expect(hasWhatsAppSession(sessionDir)).toBe(true);
    const bridge = new BaileysBridge(sessionDir);
    expect(bridge.paired).toBe(true);
    expect(bridge.describe()).toContain('paired');
  });

  it('whatsappSessionDir honors BUFF_WHATSAPP_SESSION_DIR', () => {
    expect(whatsappSessionDir()).toBe(sessionDir);
  });
});

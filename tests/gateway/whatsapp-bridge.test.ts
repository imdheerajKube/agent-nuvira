/**
 * I8 — WhatsApp bridge tests.
 *
 * The WhatsApp platform is the personal Baileys bridge (no paid API): the
 * adapter is exercised with a fake bridge (hermetic — never imports baileys),
 * jid normalization is pure, and the real BaileysBridge is asserted in its
 * unpaired state (temp session dir, no creds.json).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeWhatsAppJid, type WhatsAppBridge } from '../../src/gateway/whatsapp/bridge.js';
import { WhatsAppBridgeAdapter } from '../../src/gateway/adapters.js';
import { BaileysBridge, normalizePairingPhone, renderQrToTerminal, renderQrToDataUrl } from '../../src/gateway/whatsapp/baileys-bridge.js';
import { hasWhatsAppSession, whatsappSessionDir } from '../../src/gateway/whatsapp/session.js';

// A controllable fake baileys module for the pair() AbortSignal test — the
// mock is hoisted above every import, so ANY 'baileys' import in this file
// (including the bridge's lazy `await import('baileys')`) gets the fake.
const fakeBaileys = vi.hoisted(() => {
  const sockets: Array<{ ev: unknown; ended: boolean }> = [];
  return { sockets };
});

vi.mock('baileys', () => {
  const makeEmitter = () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of [...(listeners.get(event) ?? [])]) cb(...args);
      },
    };
  };
  return {
    makeWASocket: () => {
      const sock = {
        ev: makeEmitter(),
        ended: false,
        sendMessage: async () => undefined,
        requestPairingCode: async () => '12345678',
        end: () => {
          sock.ended = true;
        },
      };
      fakeBaileys.sockets.push(sock);
      return sock;
    },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined }),
  };
});

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

// ─── Pairing helpers (pure / hermetic) ──────────────────────────────────────

describe('normalizePairingPhone', () => {
  it('keeps digits and drops +/spaces, 10-15 digits = valid', () => {
    expect(normalizePairingPhone('+91 88006 63237')).toBe('918800663237');
    expect(normalizePairingPhone('918800663237')).toBe('918800663237');
    expect(normalizePairingPhone('1-555-123-4567')).toBe('15551234567');
    expect(normalizePairingPhone('8800663237')).toBe('8800663237');
  });

  it('rejects junk and implausible lengths', () => {
    expect(normalizePairingPhone('')).toBe('');
    expect(normalizePairingPhone('abc')).toBe('');
    expect(normalizePairingPhone('12345')).toBe(''); // too short
    expect(normalizePairingPhone('1234567890123456')).toBe(''); // too long
  });
});

describe('renderQrToTerminal', () => {
  it('renders a scannable block QR for a payload', async () => {
    const rendered = await renderQrToTerminal('2@test-payload-12345');
    expect(rendered).toContain('▄'); // qrcode block characters
    expect(rendered.length).toBeGreaterThan(50);
  });
});

describe('renderQrToDataUrl', () => {
  it('renders a browser-scannable PNG data URL for a payload', async () => {
    const url = await renderQrToDataUrl('2@test-payload-12345');
    expect(url).toMatch(/^data:image\/png;base64,/);
    expect(url.length).toBeGreaterThan(100);
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

// ─── Real BaileysBridge — pair() with a fake baileys module (no network) ───

describe('BaileysBridge.pair() (fake baileys)', () => {
  let sessionDir = '';

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'buff-wa-pair-'));
    fakeBaileys.sockets.length = 0;
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('aborting the signal ends the socket and resolves { ok:false, reason: cancelled }', async () => {
    const bridge = new BaileysBridge(sessionDir);
    const controller = new AbortController();
    const promise = bridge.pair({ signal: controller.signal, timeoutMs: 30_000 });
    // Give the lazy baileys import + socket creation a beat.
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeBaileys.sockets).toHaveLength(1);
    controller.abort();
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(fakeBaileys.sockets[0].ended).toBe(true);
  });

  it('phone mode requests a pairing code via requestPairingCode and surfaces it', async () => {
    const bridge = new BaileysBridge(sessionDir);
    let code = '';
    const promise = bridge.pair({
      phoneNumber: '918800663237',
      timeoutMs: 30_000,
      onPairingCode: (c) => {
        code = c;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeBaileys.sockets).toHaveLength(1);
    // The fake resolves requestPairingCode with '12345678' immediately.
    await new Promise((r) => setTimeout(r, 20));
    expect(code).toBe('12345678');
    // A QR (8 digits) in connection.update also surfaces as the code.
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', {
      qr: '87654321',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(code).toBe('87654321');
    // Open the connection so the pending pair() promise resolves.
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', {
      connection: 'open',
    });
    const result = await promise;
    expect(result).toEqual({ ok: true, reason: 'paired' });
  }, 10_000);
});

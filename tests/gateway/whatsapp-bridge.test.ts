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
import type { InboundMedia } from '../../src/gateway/inbound-media.js';
import {
  BaileysBridge,
  BACKFILL_MAX_AGE_MS,
  isSelfChatEnabled,
  normalizePairingPhone,
  renderQrToTerminal,
  renderQrToDataUrl,
  LidJidMapper,
  readLidMappingsFile,
  writeLidMappingsFile,
} from '../../src/gateway/whatsapp/baileys-bridge.js';
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
        calls: [] as string[],
        sentTo: [] as string[],
        sentContent: [] as unknown[],
        /** Every `onWhatsApp` query the bridge made (registration check). */
        onWhatsAppCalls: [] as string[][],
        /**
         * USync answer override. `undefined` (default) = every queried number
         * is a registered account; `[]` = none are (the "not a WhatsApp
         * account" case); a custom array models partial results.
         */
        onWhatsAppResult: undefined as Array<{ jid: string; exists: boolean }> | undefined,
        /** Simulate a USync failure (inconclusive — must NOT block a send). */
        onWhatsAppThrows: false,
        /** Override the sendMessage result (no id / stub / error). */
        sendMessageResult: undefined as unknown,
        // Resolves with a message key id so the bridge's echo filter can
        // record it (real Baileys sendMessage does the same).
        sendMessage: async (jid: string, content: unknown) => {
          sock.sentTo.push(jid);
          sock.sentContent.push(content);
          sock.calls.push('sendMessage');
          if (sock.sendMessageResult !== undefined) return sock.sendMessageResult;
          return { key: { id: `SENT-${sock.sentTo.length}` } };
        },
        onWhatsApp: async (...jids: string[]) => {
          sock.onWhatsAppCalls.push(jids);
          sock.calls.push('onWhatsApp');
          if (sock.onWhatsAppThrows) throw new Error('usync query failed');
          if (sock.onWhatsAppResult !== undefined) return sock.onWhatsAppResult;
          return jids.map((jid) => ({ jid, exists: true }));
        },
        requestPairingCode: async () => {
          sock.calls.push('requestPairingCode');
          return '12345678';
        },
        waitForSocketOpen: async () => {
          sock.calls.push('waitForSocketOpen');
        },
        end: () => {
          sock.ended = true;
        },
      };
      fakeBaileys.sockets.push(sock);
      return sock;
    },
    // Media downloader (Baileys `downloadMediaMessage`) — a fixed payload so
    // the bridge's inbound-document path is asserted without real media.
    downloadMediaMessage: async () => Buffer.from('PDF-BYTES', 'utf-8'),
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
    expect(normalizePairingPhone('+91 88444 33322')).toBe('918844433322');
    expect(normalizePairingPhone('918844433322')).toBe('918844433322');
    expect(normalizePairingPhone('1-555-123-4567')).toBe('15551234567');
    expect(normalizePairingPhone('8844332211')).toBe('8844332211');
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
  onMessage:
    | ((from: string, text: string, participant?: string, messageId?: string, media?: InboundMedia) => void)
    | null = null;

  constructor(paired = true) {
    this.paired = paired;
  }

  describe(): string {
    return this.paired ? 'fake bridge paired' : 'fake bridge unpaired';
  }

  async connect(
    onMessage: (from: string, text: string, participant?: string, messageId?: string, media?: InboundMedia) => void,
  ): Promise<void> {
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

  emit(from: string, text: string, participant?: string, messageId?: string, media?: InboundMedia): void {
    this.onMessage?.(from, text, participant, messageId, media);
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

  it('forwards the transport message id so the gateway can dedup re-deliveries', async () => {
    const fake = new FakeBridge(true);
    const adapter = new WhatsAppBridgeAdapter(fake);
    const received: Array<{ messageId?: string }> = [];
    await adapter.start((m) => received.push(m));
    fake.emit('15551234567@s.whatsapp.net', 'hi there', undefined, 'WA-MSG-ID-1');
    await adapter.stop();
    expect(received[0].messageId).toBe('WA-MSG-ID-1');
  });

  it('carries a downloaded document through to InboundMessage.media', async () => {
    const fake = new FakeBridge(true);
    const adapter = new WhatsAppBridgeAdapter(fake);
    const received: Array<{ text: string; media?: InboundMedia }> = [];
    await adapter.start((m) => received.push(m));
    fake.emit('15551234567@s.whatsapp.net', 'summarise this', undefined, 'WA-DOC-1', {
      type: 'document',
      filename: 'report.pdf',
      data: new Uint8Array([1, 2, 3]),
    });
    await adapter.stop();
    expect(received[0].text).toBe('summarise this');
    expect(received[0].media?.type).toBe('document');
    expect(received[0].media?.filename).toBe('report.pdf');
  });

  it('an EMPTY-string participant never blanks the sender id (Baileys 7 DM quirk)', async () => {
    // Regression: Baileys 7 can deliver DMs with `key.participant: ''` — an
    // empty string is NOT nullish, so `participant ?? fromJid` would produce
    // senderId '' and the policy gate would refuse every sender. The adapter
    // must fall back to the chat jid.
    const fake = new FakeBridge(true);
    const adapter = new WhatsAppBridgeAdapter(fake);
    const received: Array<{ senderId?: string; from?: string }> = [];
    await adapter.start((m) => received.push(m));
    fake.emit('220722781786162:1@lid', 'write a 2-line poem about Diwali', '');
    await adapter.stop();
    expect(received).toHaveLength(1);
    expect(received[0].senderId).toBe('220722781786162:1@lid');
    expect(received[0].from).toBe('220722781786162:1@lid');
    // A REAL participant (group sender) still wins over the chat jid.
    const fake2 = new FakeBridge(true);
    const adapter2 = new WhatsAppBridgeAdapter(fake2);
    const received2: Array<{ senderId?: string }> = [];
    await adapter2.start((m) => received2.push(m));
    fake2.emit('1203630283471234@g.us', 'buff fix the tests', '918877766655@s.whatsapp.net');
    await adapter2.stop();
    expect(received2[0].senderId).toBe('918877766655@s.whatsapp.net');
  });
});

// ─── LidJidMapper — privacy-rollout LID→PN resolution ──────────────────────

describe('LidJidMapper (privacy-rollout LID→PN resolution)', () => {
  it('resolves a learned @lid jid to its phone-number jid and passes others through', () => {
    const mapper = new LidJidMapper();
    mapper.learn('123456789012345@lid', '918844433322@s.whatsapp.net');
    expect(mapper.resolve('123456789012345@lid')).toBe('918844433322@s.whatsapp.net');
    expect(mapper.resolve('918844433322@s.whatsapp.net')).toBe('918844433322@s.whatsapp.net'); // non-LID passthrough
    expect(mapper.resolve('918811122233:13@s.whatsapp.net')).toBe('918811122233:13@s.whatsapp.net'); // device suffix untouched
    expect(mapper.resolve('1203630283471234@g.us')).toBe('1203630283471234@g.us'); // groups untouched
    expect(mapper.resolve(undefined)).toBeUndefined();
    // Unknown LID passes through (mapping arrives shortly after).
    expect(mapper.resolve('999999999999999@lid')).toBe('999999999999999@lid');
  });

  it('accepts bare digits and ignores invalid pairs', () => {
    const mapper = new LidJidMapper();
    mapper.learn('123456789012345', '918844433322');
    expect(mapper.resolve('123456789012345@lid')).toBe('918844433322@s.whatsapp.net');
    mapper.learn('', '918844433322'); // empty lid
    mapper.learn('123456789012345', ''); // empty pn
    expect(mapper.size).toBe(1);
  });

  it('persists learned pairs and reloads them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-wa-lid-'));
    try {
      const mapper = new LidJidMapper(dir);
      mapper.learn('123456789012345@lid', '918844433322@s.whatsapp.net');
      writeLidMappingsFile(dir, mapper.pairs());
      expect(readLidMappingsFile(dir)).toEqual([{ lid: '123456789012345@lid', pn: '918844433322@s.whatsapp.net' }]);
      const reloaded = new LidJidMapper(dir);
      expect(reloaded.resolve('123456789012345@lid')).toBe('918844433322@s.whatsapp.net');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves an unknown @lid from Baileys own persisted mapping files (the live fix)', () => {
    // Regression (live WhatsApp test): Baileys persists the pairs it learns
    // (from message envelopes / linked-profile notifications) as
    // `lid-mapping-<pn>.json` + `lid-mapping-<lid>_reverse.json`, but never
    // emits `lid-mapping.update` for the envelope path — so an event-only
    // bridge refused Bibi's first message (silent drop, senderId unknown).
    const dir = mkdtempSync(join(tmpdir(), 'buff-wa-lid-'));
    try {
      // What Baileys wrote when Bibi messaged us: LID 220722781786162 ↔ 918844433322.
      writeFileSync(join(dir, 'lid-mapping-220722781786162_reverse.json'), JSON.stringify('918844433322'), 'utf-8');
      const mapper = new LidJidMapper(dir);
      // Device suffix stripped for the lookup, PN jid returned.
      expect(mapper.resolve('220722781786162:1@lid')).toBe('918844433322@s.whatsapp.net');
      expect(mapper.resolve('220722781786162@lid')).toBe('918844433322@s.whatsapp.net');
      // Learned + cached now; a missing file passes the raw jid through.
      expect(mapper.resolve('999999999999999@lid')).toBe('999999999999999@lid');
      // Non-LID jids never consult the files.
      expect(mapper.resolve('918844433322@s.whatsapp.net')).toBe('918844433322@s.whatsapp.net');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Real BaileysBridge — unpaired state (no network, no baileys socket) ───

describe('BaileysBridge (unpaired)', () => {
  let sessionDir = '';
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'buff-wa-session-'));
    envBackup.NUVIRA_WHATSAPP_SESSION_DIR = process.env.NUVIRA_WHATSAPP_SESSION_DIR;
    process.env.NUVIRA_WHATSAPP_SESSION_DIR = sessionDir;
  });

  afterEach(() => {
    if (envBackup.NUVIRA_WHATSAPP_SESSION_DIR === undefined) delete process.env.NUVIRA_WHATSAPP_SESSION_DIR;
    else process.env.NUVIRA_WHATSAPP_SESSION_DIR = envBackup.NUVIRA_WHATSAPP_SESSION_DIR;
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
      phoneNumber: '918844433322',
      timeoutMs: 30_000,
      onPairingCode: (c) => {
        code = c;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeBaileys.sockets).toHaveLength(1);
    // The bridge waits for the WebSocket handshake BEFORE requesting the code
    // (an immediate call would race the socket and never reach WhatsApp).
    const calls = fakeBaileys.sockets[0].calls;
    expect(calls).toEqual(['waitForSocketOpen', 'requestPairingCode']);
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

  it('a 515 "Stream Errored (restart required)" close restarts the socket and still pairs', async () => {
    const bridge = new BaileysBridge(sessionDir);
    const promise = bridge.pair({ timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeBaileys.sockets).toHaveLength(1);
    // WhatsApp's post-scan 515 restart-required close (Boom-shaped error).
    const emit = (i: number, u: unknown) =>
      (fakeBaileys.sockets[i].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', u);
    emit(0, {
      connection: 'close',
      lastDisconnect: { error: { message: 'Stream Errored (restart required)', output: { statusCode: 515 } } },
    });
    await new Promise((r) => setTimeout(r, 20));
    // The bridge must NOT treat this as a failure — it swaps in a fresh socket.
    expect(fakeBaileys.sockets).toHaveLength(2);
    expect(fakeBaileys.sockets[0].ended).toBe(true);
    // The restarted socket reuses the saved creds and opens → pairing succeeds.
    emit(1, { connection: 'open' });
    const result = await promise;
    expect(result).toEqual({ ok: true, reason: 'paired' });
  }, 10_000);

  it('a plain server close AFTER a pairing code is issued restarts and still pairs (phone mode)', async () => {
    const bridge = new BaileysBridge(sessionDir);
    let code = '';
    const promise = bridge.pair({
      phoneNumber: '91112223344',
      timeoutMs: 30_000,
      onPairingCode: (c) => {
        code = c;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeBaileys.sockets).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(code).toBe('12345678');
    const emit = (i: number, u: unknown) =>
      (fakeBaileys.sockets[i].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', u);
    // WhatsApp terminates the WS right after issuing the code — the bridge
    // must NOT treat it as a failure; it swaps in a fresh socket.
    emit(0, { connection: 'close', lastDisconnect: { error: new Error('Connection Terminated') } });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeBaileys.sockets).toHaveLength(2);
    expect(fakeBaileys.sockets[0].ended).toBe(true);
    emit(1, { connection: 'open' });
    const result = await promise;
    expect(result).toEqual({ ok: true, reason: 'paired' });
  }, 10_000);

  it('keeps restarting through repeated 515 closes instead of failing early', async () => {
    const bridge = new BaileysBridge(sessionDir);
    const promise = bridge.pair({ timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 50));
    const emit = (i: number, u: unknown) =>
      (fakeBaileys.sockets[i].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', u);
    const close515 = {
      connection: 'close',
      lastDisconnect: { error: { message: 'Stream Errored (restart required)', output: { statusCode: 515 } } },
    };
    // A server that cycles the connection many times must NOT fail the
    // pairing — the bridge keeps swapping in fresh sockets until the window
    // expires or the connection opens.
    let pending = true;
    promise.then(() => {
      pending = false;
    });
    for (let i = 0; i < 10; i += 1) {
      emit(i, close515);
      await new Promise((r) => setTimeout(r, 10));
      expect(pending).toBe(true); // still waiting — never gave up
    }
    expect(fakeBaileys.sockets).toHaveLength(11);
    emit(10, { connection: 'open' });
    const result = await promise;
    expect(result).toEqual({ ok: true, reason: 'paired' });
  }, 10_000);

  it('the pairing window still bounds the whole attempt', async () => {
    const bridge = new BaileysBridge(sessionDir);
    // No QR, no code, no open — the window must fire.
    const result = await bridge.pair({ timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pairing timed out');
  }, 10_000);

  it('a 401 "Connection Failure" after a code is issued restarts and still pairs', async () => {
    const bridge = new BaileysBridge(sessionDir);
    let code = '';
    const promise = bridge.pair({
      phoneNumber: '91112223344',
      timeoutMs: 30_000,
      onPairingCode: (c) => {
        code = c;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 20));
    expect(code).toBe('12345678');
    const emit = (i: number, u: unknown) =>
      (fakeBaileys.sockets[i].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', u);
    // Unregistered-with-code sessions get 401 "Connection Failure" on
    // reconnect until the phone completes the pairing server-side.
    emit(0, { connection: 'close', lastDisconnect: { error: { message: 'Connection Failure', output: { statusCode: 401 } } } });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeBaileys.sockets).toHaveLength(2);
    emit(1, { connection: 'open' });
    const result = await promise;
    expect(result).toEqual({ ok: true, reason: 'paired' });
  }, 10_000);

  it('a non-restart close still fails the pairing', async () => {
    const bridge = new BaileysBridge(sessionDir);
    const promise = bridge.pair({ timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 50));
    const emit = (i: number, u: unknown) =>
      (fakeBaileys.sockets[i].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', u);
    emit(0, { connection: 'close', lastDisconnect: { error: new Error('boom: connection reset by peer') } });
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: 'pair failed: boom: connection reset by peer' });
    expect(fakeBaileys.sockets).toHaveLength(1);
  }, 10_000);
});

describe('BaileysBridge.ensureSocket() self-healing (fake baileys)', () => {
  let sessionDir = '';

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'buff-wa-heal-'));
    fakeBaileys.sockets.length = 0;
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('drops a socket that closed with an error so the next connect recreates it', async () => {
    const bridge = new BaileysBridge(sessionDir);
    await bridge.connect(() => {});
    expect(fakeBaileys.sockets).toHaveLength(1);
    // A dying socket (e.g. a 515 restart on an established session).
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Error('Stream Errored (restart required)') },
    });
    await new Promise((r) => setTimeout(r, 20));
    // The dead socket is dropped — the next connect() builds a fresh one.
    await bridge.connect(() => {});
    expect(fakeBaileys.sockets).toHaveLength(2);
    expect(fakeBaileys.sockets[1].ended).toBe(false);
  }, 10_000);

  it('auto-reconnects after the socket dies while connected — inbound keeps flowing', async () => {
    const waitFor = async (fn: () => boolean, timeoutMs = 3_000): Promise<void> => {
      const start = Date.now();
      while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const bridge = new BaileysBridge(sessionDir, { reconnectDelayMs: 20 });
    const received: Array<{ from: string; text: string }> = [];
    await bridge.connect((from, text) => received.push({ from, text }));
    expect(fakeBaileys.sockets).toHaveLength(1);
    // The socket dies mid-session (network drop / 515 restart)…
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Error('Stream Errored (restart required)') },
    });
    // …and the watcher recreates it automatically (no manual reconnect).
    await waitFor(() => fakeBaileys.sockets.length >= 2);
    expect(fakeBaileys.sockets[1].ended).toBe(false);
    // Inbound messages flow on the NEW socket.
    (fakeBaileys.sockets[1].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '15551234567@s.whatsapp.net' }, message: { conversation: 'fix the failing test' } }],
    });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ from: '15551234567@s.whatsapp.net', text: 'fix the failing test' });
    await bridge.disconnect();
  }, 10_000);

  it('translates a privacy-rollout LID sender to its phone-number jid before delivering', async () => {
    const waitFor = async (fn: () => boolean, timeoutMs = 3_000): Promise<void> => {
      const start = Date.now();
      while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const bridge = new BaileysBridge(sessionDir, { reconnectDelayMs: 20 });
    const received: Array<{ from: string; text: string }> = [];
    await bridge.connect((from, text) => received.push({ from, text }));
    // Baileys learns the pair (linked-profile notification / contactAction
    // sync) and emits lid-mapping.update — the bridge mirrors it.
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('lid-mapping.update', {
      lid: '123456789012345@lid',
      pn: '918844433322@s.whatsapp.net',
    });
    // The DM arrives with the sender's LID as remoteJid — NOT the number.
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '123456789012345@lid' }, message: { conversation: 'send a good night message to Mother' } }],
    });
    await waitFor(() => received.length === 1);
    // The policy gate compares digits — the bridge must hand it the PN jid.
    expect(received[0].from).toBe('918844433322@s.whatsapp.net');
    expect(received[0].text).toBe('send a good night message to Mother');
    // The learned pair is persisted for the next process.
    expect(readLidMappingsFile(sessionDir)).toEqual([{ lid: '123456789012345@lid', pn: '918844433322@s.whatsapp.net' }]);
    await bridge.disconnect();
  }, 10_000);

  it('translates a group participant LID to its phone-number jid', async () => {
    const waitFor = async (fn: () => boolean, timeoutMs = 3_000): Promise<void> => {
      const start = Date.now();
      while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const bridge = new BaileysBridge(sessionDir, { reconnectDelayMs: 20 });
    const received: Array<{ from: string; text: string; participant?: string }> = [];
    await bridge.connect((from, text, participant) => received.push({ from, text, participant }));
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('lid-mapping.update', {
      lid: '987654321098765@lid',
      pn: '918877766655@s.whatsapp.net',
    });
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '1203630283471234@g.us', participant: '987654321098765@lid' },
          message: { conversation: 'buff fix the tests' },
        },
      ],
    });
    await waitFor(() => received.length === 1);
    expect(received[0].from).toBe('1203630283471234@g.us');
    expect(received[0].participant).toBe('918877766655@s.whatsapp.net');
    await bridge.disconnect();
  }, 10_000);

  it('treats an empty-string key.participant as absent (Baileys 7 DM quirk)', async () => {
    // Baileys 7 can deliver DMs with `key.participant: ''` — the bridge must
    // pass undefined (not '') so the adapter's `participant || fromJid` keeps
    // the sender id set to the chat jid.
    const waitFor = async (fn: () => boolean, timeoutMs = 3_000): Promise<void> => {
      const start = Date.now();
      while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const bridge = new BaileysBridge(sessionDir, { reconnectDelayMs: 20 });
    const received: Array<{ from: string; text: string; participant?: string }> = [];
    await bridge.connect((from, text, participant) => received.push({ from, text, participant }));
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '220722781786162:1@lid', participant: '' }, message: { conversation: 'hi' } }],
    });
    await waitFor(() => received.length === 1);
    expect(received[0].from).toBe('220722781786162:1@lid');
    expect(received[0].participant).toBeUndefined();
    await bridge.disconnect();
  }, 10_000);

  it('stops auto-reconnecting on a server-side logout (401)', async () => {
    const bridge = new BaileysBridge(sessionDir, { reconnectDelayMs: 20 });
    await bridge.connect(() => {});
    expect(fakeBaileys.sockets).toHaveLength(1);
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { message: 'Connection Failure', output: { statusCode: 401 } } },
    });
    // Give the watcher time to (wrongly) recreate — it must NOT.
    await new Promise((r) => setTimeout(r, 400));
    expect(fakeBaileys.sockets).toHaveLength(1);
    await bridge.disconnect();
  }, 10_000);

  it('disconnect() stops the reconnect watcher', async () => {
    const bridge = new BaileysBridge(sessionDir, { reconnectDelayMs: 20 });
    await bridge.connect(() => {});
    await bridge.disconnect();
    // Simulate the ended socket's close arriving after disconnect.
    (fakeBaileys.sockets[0].ev as { emit: (e: string, ...a: unknown[]) => void }).emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Error('Stream Errored (restart required)') },
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(fakeBaileys.sockets).toHaveLength(1);
  }, 10_000);
});

// ─── I8b echo filter, self-chat mode + contact-name resolution ──────────────

describe('BaileysBridge I8b — echo filter / self-chat / contacts (fake baileys)', () => {
  let sessionDir = '';
  const emit = (i: number, event: string, ...args: unknown[]): void =>
    (fakeBaileys.sockets[i].ev as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
  const waitFor = async (fn: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'buff-wa-i8b-'));
    fakeBaileys.sockets.length = 0;
    // Paired — send() must proceed past the paired gate and the socket's
    // waitForOpen resolves on the fake 'open' we emit below.
    writeFileSync(join(sessionDir, 'creds.json'), '{}', 'utf-8');
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  /** Connect (emit open so waitForOpen settles) and return the bridge. */
  const openBridge = async (opts?: { selfChat?: boolean }): Promise<BaileysBridge> => {
    const bridge = new BaileysBridge(sessionDir, opts);
    const p = bridge.connect(() => {});
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    await p;
    return bridge;
  };

  /**
   * THE reply-storm fix: WhatsApp replays history as `append` on every
   * (re)connect. Observed live: one ask arrived 20+ times and was answered 20+
   * times (re-running a 112s pipeline each time), because every backfill entry
   * was treated as brand new. A backfill entry is now age-gated; a live
   * `notify` never is.
   */
  it('age-gates offline backfill (append) while live messages (notify) always pass — and forwards the message id', async () => {
    const received: Array<{ from: string; text: string; messageId?: string }> = [];
    const bridge = new BaileysBridge(sessionDir);
    const p = bridge.connect((from, text, _participant, messageId) => received.push({ from, text, messageId }));
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    await p;

    const nowSec = Math.floor(Date.now() / 1000);
    const msg = (id: string, text: string, ts?: number): unknown => ({
      key: { id, remoteJid: '12025550123@s.whatsapp.net', fromMe: false },
      message: { conversation: text },
      ...(ts === undefined ? {} : { messageTimestamp: ts }),
      pushName: 'Sara',
    });

    // A STALE backfill entry — the reconnect replay that caused the storm.
    emit(0, 'messages.upsert', { type: 'append', messages: [msg('OLD-1', 'ancient ask', nowSec - 3600)] });
    // A FRESH backfill entry — the gateway was briefly offline; still handled.
    emit(0, 'messages.upsert', { type: 'append', messages: [msg('FRESH-1', 'sent while offline', nowSec - 30)] });
    // A live message — always handled.
    emit(0, 'messages.upsert', { type: 'notify', messages: [msg('LIVE-1', 'live ask', nowSec)] });
    // Backfill with NO timestamp: an unfilterable replay cannot be judged, so
    // it is NOT processed (the failure this gate exists to stop).
    emit(0, 'messages.upsert', { type: 'append', messages: [msg('NOTS-1', 'unknown age')] });

    expect(received.map((r) => r.text)).toEqual(['sent while offline', 'live ask']);
    expect(received.map((r) => r.messageId)).toEqual(['FRESH-1', 'LIVE-1']);
    await bridge.disconnect();
  }, 10_000);

  it('downloads an inbound document and forwards it with its caption as text', async () => {
    // Previously a document message had no `conversation`/`extendedTextMessage`,
    // so it was dropped at `if (!text) continue` — the sender's own file
    // vanished. The bridge now downloads the bytes and forwards the caption.
    const received: Array<{ text: string; media?: InboundMedia }> = [];
    const bridge = new BaileysBridge(sessionDir);
    const p = bridge.connect((_from, text, _participant, _messageId, media) => received.push({ text, media }));
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    await p;

    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'DOC-1', remoteJid: '12025550123@s.whatsapp.net', fromMe: false },
        message: {
          documentMessage: {
            mimetype: 'application/pdf',
            fileName: 'report.pdf',
            caption: 'summarise this',
            fileLength: 1234,
          },
        },
        pushName: 'Sara',
      }],
    });
    await waitFor(() => received.length === 1);
    expect(received[0].text).toBe('summarise this');
    expect(received[0].media?.type).toBe('document');
    expect(received[0].media?.filename).toBe('report.pdf');
    expect(received[0].media?.mimetype).toBe('application/pdf');
    expect(Buffer.from(received[0].media!.data).toString('utf-8')).toBe('PDF-BYTES');
    await bridge.disconnect();
  }, 10_000);

  it('understands a Long-shaped messageTimestamp (Baileys delivers seconds as a Long)', async () => {
    const received: Array<string> = [];
    const bridge = new BaileysBridge(sessionDir);
    const p = bridge.connect((_from, text) => received.push(text));
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    await p;

    const nowSec = Math.floor(Date.now() / 1000);
    const longMsg = (id: string, text: string, seconds: number): unknown => ({
      key: { id, remoteJid: '12025550123@s.whatsapp.net', fromMe: false },
      message: { conversation: text },
      messageTimestamp: { toNumber: () => seconds },
    });
    emit(0, 'messages.upsert', { type: 'append', messages: [longMsg('L-OLD', 'stale (Long)', nowSec - 7200)] });
    emit(0, 'messages.upsert', { type: 'append', messages: [longMsg('L-NEW', 'fresh (Long)', nowSec - 5)] });

    expect(received).toEqual(['fresh (Long)']);
    await bridge.disconnect();
  }, 10_000);

  it('the backfill window has a real default (10 minutes) and is env-overridable', () => {
    expect(BACKFILL_MAX_AGE_MS).toBe(10 * 60 * 1000);
  });

  it('drops its own outbound echo (fromMe + recentlySent id) and other fromMe messages in bot mode', async () => {
    const received: Array<{ from: string; text: string }> = [];
    const bridge = new BaileysBridge(sessionDir);
    const p = bridge.connect((from, text) => received.push({ from, text }));
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    await p;
    // Send something — the fake returns key.id 'SENT-1' which the bridge records.
    expect(await bridge.send('+15551234567', 'hello echo')).toBe(true);
    // The outbound echo arrives back via upsert (fromMe, id matches).
    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '15551234567@s.whatsapp.net', id: 'SENT-1', fromMe: true }, message: { conversation: 'hello echo' } }],
    });
    // A fromMe message with an UNKNOWN id (e.g. the paired number typing in a
    // group) must also be dropped in bot mode (selfChat off).
    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '15551234567@s.whatsapp.net', id: 'USER-TYPED-1', fromMe: true }, message: { conversation: 'please fix this' } }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);
    // A genuine inbound (fromMe false) still flows.
    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '15551234567@s.whatsapp.net' }, message: { conversation: 'fix the failing test' } }],
    });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ from: '15551234567@s.whatsapp.net', text: 'fix the failing test' });
    await bridge.disconnect();
  }, 10_000);

  it('self-chat mode forwards user-typed fromMe messages but still drops echoes', async () => {
    const received: Array<{ from: string; text: string }> = [];
    const bridge = new BaileysBridge(sessionDir, { selfChat: true });
    const p = bridge.connect((from, text) => received.push({ from, text }));
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    await p;
    await bridge.send('+15551234567', 'agent reply'); // records SENT-1
    // The user's own self-chat message (fromMe, unknown id) is forwarded.
    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '15551234567@s.whatsapp.net', id: 'USER-SELF-1', fromMe: true }, message: { conversation: 'write a poem' } }],
    });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ from: '15551234567@s.whatsapp.net', text: 'write a poem' });
    // The agent's own reply echo (fromMe + SENT-1) must still be dropped.
    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '15551234567@s.whatsapp.net', id: 'SENT-1', fromMe: true }, message: { conversation: 'agent reply' } }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    await bridge.disconnect();
  }, 10_000);

  it('resolves a contact NAME to its JID from the address-book sync and sends there', async () => {
    const bridge = await openBridge();
    emit(0, 'contacts.upsert', [{ id: '919876543210@s.whatsapp.net', name: 'Alex', notify: 'Alex' }]);
    expect(await bridge.send('Alex', 'Charansoarsh - By Agent-Nuvira')).toBe(true);
    expect(fakeBaileys.sockets[0].sentTo).toEqual(['919876543210@s.whatsapp.net']);
    await bridge.disconnect();
  }, 10_000);

  it('learns contact names from inbound pushName and matches partial names', async () => {
    const bridge = await openBridge();
    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '12025550123@s.whatsapp.net' }, pushName: 'Sara', message: { conversation: 'hi' } }],
    });
    // Exact + partial (prefix) resolution against the learned name.
    expect(bridge.resolveContact('Sara')).toBe('12025550123@s.whatsapp.net');
    expect(bridge.resolveContact('Sar')).toBe('12025550123@s.whatsapp.net');
    expect(bridge.resolveContact('Nobody')).toBeNull();
    expect(await bridge.send('Sara', 'hi there')).toBe(true);
    expect(fakeBaileys.sockets[0].sentTo).toEqual(['12025550123@s.whatsapp.net']);
    await bridge.disconnect();
  }, 10_000);

  it('keeps resolving a name while the address-book sync is still landing (one-shot send)', async () => {
    const bridge = new BaileysBridge(sessionDir);
    const p = bridge.send('Alex', 'late sync test');
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    // The sync arrives a beat AFTER the send started — resolveContactJid polls.
    setTimeout(() => emit(0, 'contacts.upsert', [{ id: '919876543210@s.whatsapp.net', name: 'Alex' }]), 120);
    expect(await p).toBe(true);
    expect(fakeBaileys.sockets[0].sentTo).toEqual(['919876543210@s.whatsapp.net']);
    await bridge.disconnect();
  }, 10_000);

  it('isSelfChatEnabled reads BUFF_WHATSAPP_SELF_CHAT truthy values', () => {
    expect(isSelfChatEnabled({ BUFF_WHATSAPP_SELF_CHAT: '1' })).toBe(true);
    expect(isSelfChatEnabled({ BUFF_WHATSAPP_SELF_CHAT: 'true' })).toBe(true);
    expect(isSelfChatEnabled({})).toBe(false);
    expect(isSelfChatEnabled({ BUFF_WHATSAPP_SELF_CHAT: '0' })).toBe(false);
  });

  it('addContact persists to the mapping file and resolves by name WITHOUT a socket', async () => {
    const bridge = new BaileysBridge(sessionDir);
    expect(bridge.addContact('Alex', '+91 98765 43210')).toBe(true);
    // Resolves straight from the file (no connection needed).
    expect(bridge.resolveContact('Alex')).toBe('919876543210@s.whatsapp.net');
    expect(bridge.resolveContact('alex')).toBe('919876543210@s.whatsapp.net');
    // A NEW bridge instance in the same dir re-seeds from the file.
    const again = new BaileysBridge(sessionDir);
    expect(again.resolveContact('Alex')).toBe('919876543210@s.whatsapp.net');
  });

  it('removeContact deletes from the file and the live maps', async () => {
    const bridge = new BaileysBridge(sessionDir);
    bridge.addContact('Alex', '9876543210');
    expect(bridge.removeContact('Alex')).toBe(true);
    expect(bridge.resolveContact('Alex')).toBeNull();
    expect(bridge.removeContact('Alex')).toBe(false);
  });

  it('addContact rejects empty names / invalid numbers', () => {
    const bridge = new BaileysBridge(sessionDir);
    expect(bridge.addContact('', '9876543210')).toBe(false);
    expect(bridge.addContact('Alex', 'abc')).toBe(false);
  });

  it('sendMedia sends image/video/audio/document to a resolved JID (P3)', async () => {
    const bridge = await openBridge();
    bridge.addContact('Alex', '919876543210');
    const img = new Uint8Array([1, 2, 3]);
    expect(await bridge.sendMedia?.('Alex', { type: 'image', data: img, caption: 'look' })).toBe(true);
    expect(fakeBaileys.sockets[0].sentTo).toEqual(['919876543210@s.whatsapp.net']);
    expect(fakeBaileys.sockets[0].sentContent[0]).toMatchObject({ image: img, caption: 'look' });
    expect(await bridge.sendMedia?.('+15551234567', { type: 'document', data: img, filename: 'a.pdf' })).toBe(true);
    expect(fakeBaileys.sockets[0].sentContent[1]).toMatchObject({ document: img, fileName: 'a.pdf' });
    await bridge.disconnect();
  }, 10_000);

  it('sendMedia returns false when unpaired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-wa-media-unpaired-'));
    const bridge = new BaileysBridge(dir);
    expect(await bridge.sendMedia?.('Alex', { type: 'image', data: new Uint8Array([1]) })).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * DELIVERY VERIFICATION — a resolved `sendMessage` is NOT a delivery.
 *
 * Live incident (2026-09-21): a WhatsApp send reported success while the
 * recipient received nothing, because `sendMessage` resolving was taken as
 * proof. The bridge now verifies the recipient EXISTS, that WhatsApp returned a
 * real message id (not a stub), and reports HOW FAR the send was confirmed.
 */
describe('BaileysBridge — verified sends (fake baileys)', () => {
  let sessionDir = '';
  const envBackup: Record<string, string | undefined> = {};
  const emit = (i: number, event: string, ...args: unknown[]): void =>
    (fakeBaileys.sockets[i].ev as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
  const waitFor = async (fn: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'buff-wa-verify-'));
    fakeBaileys.sockets.length = 0;
    writeFileSync(join(sessionDir, 'creds.json'), '{}', 'utf-8');
    envBackup.NUVIRA_WHATSAPP_ACK_WAIT_MS = process.env.NUVIRA_WHATSAPP_ACK_WAIT_MS;
    delete process.env.NUVIRA_WHATSAPP_ACK_WAIT_MS;
  });

  afterEach(() => {
    if (envBackup.NUVIRA_WHATSAPP_ACK_WAIT_MS === undefined) delete process.env.NUVIRA_WHATSAPP_ACK_WAIT_MS;
    else process.env.NUVIRA_WHATSAPP_ACK_WAIT_MS = envBackup.NUVIRA_WHATSAPP_ACK_WAIT_MS;
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const openBridge = async (): Promise<BaileysBridge> => {
    const bridge = new BaileysBridge(sessionDir);
    const p = bridge.connect(() => {});
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    await p;
    return bridge;
  };

  it('reports a REGISTERED send as accepted (never a bare "sent")', async () => {
    const bridge = await openBridge();
    const result = await bridge.sendVerified?.('+15551234567', 'hello');
    expect(result).toMatchObject({ ok: true, verification: 'accepted' });
    expect(result?.jid).toBe('15551234567@s.whatsapp.net');
    // The recipient-existence check actually ran.
    expect(fakeBaileys.sockets[0].onWhatsAppCalls).toEqual([['15551234567@s.whatsapp.net']]);
    await bridge.disconnect();
  }, 10_000);

  it('FAILS (does not claim sent) when the number is not a WhatsApp account', async () => {
    const bridge = await openBridge();
    fakeBaileys.sockets[0].onWhatsAppResult = []; // Baileys filters unknown users out
    const result = await bridge.sendVerified?.('+918800663237', 'guide');
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain('is not a WhatsApp account');
    // Nothing was even attempted over the wire.
    expect(fakeBaileys.sockets[0].sentTo).toEqual([]);
    expect(await bridge.send('+918800663237', 'guide')).toBe(false);
    await bridge.disconnect();
  }, 10_000);

  it('memoizes the registration answer instead of re-querying on every send', async () => {
    const bridge = await openBridge();
    await bridge.sendVerified?.('+15551234567', 'one');
    await bridge.sendVerified?.('+15551234567', 'two');
    await bridge.sendVerified?.('15551234567@s.whatsapp.net', 'three');
    expect(fakeBaileys.sockets[0].onWhatsAppCalls).toHaveLength(1);
    expect(fakeBaileys.sockets[0].sentTo).toHaveLength(3);
    await bridge.disconnect();
  }, 10_000);

  it('an INCONCLUSIVE registration check never blocks a send', async () => {
    const bridge = await openBridge();
    fakeBaileys.sockets[0].onWhatsAppThrows = true;
    const thrown = await bridge.sendVerified?.('+15551234567', 'hello');
    expect(thrown?.ok).toBe(true);
    fakeBaileys.sockets[0].onWhatsAppThrows = false;
    fakeBaileys.sockets[0].onWhatsAppResult = undefined; // returns undefined = query failed
    const undef = await bridge.sendVerified?.('+15551234568', 'hello');
    expect(undef?.ok).toBe(true);
    await bridge.disconnect();
  }, 10_000);

  it('requires a real message id — a resolve without one is NOT a send', async () => {
    const bridge = await openBridge();
    fakeBaileys.sockets[0].sendMessageResult = { key: {} };
    const result = await bridge.sendVerified?.('+15551234567', 'hello');
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain('no message id');
    expect(await bridge.send('+15551234567', 'hello')).toBe(false);
    await bridge.disconnect();
  }, 10_000);

  it('treats a stub (undeliverable) result as a failure', async () => {
    const bridge = await openBridge();
    fakeBaileys.sockets[0].sendMessageResult = { key: { id: 'STUB-1' }, messageStubType: 2 };
    const result = await bridge.sendVerified?.('+15551234567', 'hello');
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain('undeliverable');
    await bridge.disconnect();
  }, 10_000);

  it('reports the transport error when sendMessage throws', async () => {
    const bridge = await openBridge();
    fakeBaileys.sockets[0].sendMessageResult = undefined;
    // Force a throw by replacing the fake's sendMessage for this instance.
    fakeBaileys.sockets[0].sendMessage = async () => {
      throw new Error('Connection Closed');
    };
    const result = await bridge.sendVerified?.('+15551234567', 'hello');
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain('Connection Closed');
    await bridge.disconnect();
  }, 10_000);

  it('upgrades to "delivered" when WhatsApp confirms the device ack', async () => {
    process.env.NUVIRA_WHATSAPP_ACK_WAIT_MS = '1500';
    const bridge = await openBridge();
    const pending = bridge.sendVerified?.('+15551234567', 'hello');
    // The delivery receipt arrives while the send is still confirming.
    await waitFor(() => fakeBaileys.sockets[0].sentTo.length === 1);
    emit(0, 'messages.update', [{ key: { id: 'SENT-1' }, update: { status: 3 } }]);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, verification: 'delivered' });
    await bridge.disconnect();
  }, 10_000);

  it('fails when WhatsApp reports an ERROR status for the message', async () => {
    process.env.NUVIRA_WHATSAPP_ACK_WAIT_MS = '1500';
    const bridge = await openBridge();
    const pending = bridge.sendVerified?.('+15551234567', 'hello');
    await waitFor(() => fakeBaileys.sockets[0].sentTo.length === 1);
    emit(0, 'messages.update', [{ key: { id: 'SENT-1' }, update: { status: 0 } }]);
    const result = await pending;
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain('reported an error');
    await bridge.disconnect();
  }, 10_000);

  it('verifies media sends too (no id = no delivery)', async () => {
    const bridge = await openBridge();
    const img = new Uint8Array([1, 2, 3]);
    expect(await bridge.sendMedia?.('+15551234567', { type: 'image', data: img })).toBe(true);
    fakeBaileys.sockets[0].sendMessageResult = { key: {} };
    expect(await bridge.sendMedia?.('+15551234567', { type: 'image', data: img })).toBe(false);
    await bridge.disconnect();
  }, 10_000);
});

/**
 * The adapter must surface the VERIFIED reason — the registry, the delivery
 * ledger and `gateway_send`'s output all consume it.
 */
describe('WhatsAppBridgeAdapter.sendDetailed', () => {
  it('passes the bridge reason through on failure', async () => {
    const bridge = new FakeBridge(true);
    bridge.failSend = true;
    (bridge as unknown as { sendVerified: unknown }).sendVerified = async () => ({
      ok: false,
      reason: '918800663237@s.whatsapp.net is not a WhatsApp account — the message was NOT sent.',
    });
    const adapter = new WhatsAppBridgeAdapter(bridge);
    const outcome = await adapter.sendDetailed?.('+918800663237', 'hello');
    expect(outcome?.ok).toBe(false);
    expect(outcome?.error).toContain('is not a WhatsApp account');
  });

  it('falls back to the plain boolean for a bridge without verification', async () => {
    const adapter = new WhatsAppBridgeAdapter(new FakeBridge(true));
    expect(await adapter.sendDetailed?.('+15551234567', 'hello')).toEqual({ ok: true });
  });

  it('reports an unpaired transport instead of a bare failure', async () => {
    const adapter = new WhatsAppBridgeAdapter(new FakeBridge(false));
    const outcome = await adapter.sendDetailed?.('+15551234567', 'hello');
    expect(outcome?.ok).toBe(false);
    expect(outcome?.error).toContain('not paired');
  });
});

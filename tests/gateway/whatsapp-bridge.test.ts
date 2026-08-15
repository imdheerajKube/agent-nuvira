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
import { BaileysBridge, isSelfChatEnabled, normalizePairingPhone, renderQrToTerminal, renderQrToDataUrl } from '../../src/gateway/whatsapp/baileys-bridge.js';
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
        // Resolves with a message key id so the bridge's echo filter can
        // record it (real Baileys sendMessage does the same).
        sendMessage: async (jid: string, content: unknown) => {
          sock.sentTo.push(jid);
          sock.sentContent.push(content);
          sock.calls.push('sendMessage');
          return { key: { id: `SENT-${sock.sentTo.length}` } };
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
      phoneNumber: '91880060422',
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
      phoneNumber: '91880060422',
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
    emit(0, 'contacts.upsert', [{ id: '919876543210@s.whatsapp.net', name: 'Daddy', notify: 'Daddy' }]);
    expect(await bridge.send('Daddy', 'Charansoarsh - By Agent-Nuvira')).toBe(true);
    expect(fakeBaileys.sockets[0].sentTo).toEqual(['919876543210@s.whatsapp.net']);
    await bridge.disconnect();
  }, 10_000);

  it('learns contact names from inbound pushName and matches partial names', async () => {
    const bridge = await openBridge();
    emit(0, 'messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '12025550123@s.whatsapp.net' }, pushName: 'Mumma', message: { conversation: 'hi' } }],
    });
    // Exact + partial (prefix) resolution against the learned name.
    expect(bridge.resolveContact('Mumma')).toBe('12025550123@s.whatsapp.net');
    expect(bridge.resolveContact('mum')).toBe('12025550123@s.whatsapp.net');
    expect(bridge.resolveContact('Nobody')).toBeNull();
    expect(await bridge.send('Mumma', 'hi mum')).toBe(true);
    expect(fakeBaileys.sockets[0].sentTo).toEqual(['12025550123@s.whatsapp.net']);
    await bridge.disconnect();
  }, 10_000);

  it('keeps resolving a name while the address-book sync is still landing (one-shot send)', async () => {
    const bridge = new BaileysBridge(sessionDir);
    const p = bridge.send('Daddy', 'late sync test');
    await waitFor(() => fakeBaileys.sockets.length >= 1);
    emit(0, 'connection.update', { connection: 'open' });
    // The sync arrives a beat AFTER the send started — resolveContactJid polls.
    setTimeout(() => emit(0, 'contacts.upsert', [{ id: '919876543210@s.whatsapp.net', name: 'Daddy' }]), 120);
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
    expect(bridge.addContact('Daddy', '+91 98765 43210')).toBe(true);
    // Resolves straight from the file (no connection needed).
    expect(bridge.resolveContact('Daddy')).toBe('919876543210@s.whatsapp.net');
    expect(bridge.resolveContact('daddy')).toBe('919876543210@s.whatsapp.net');
    // A NEW bridge instance in the same dir re-seeds from the file.
    const again = new BaileysBridge(sessionDir);
    expect(again.resolveContact('Daddy')).toBe('919876543210@s.whatsapp.net');
  });

  it('removeContact deletes from the file and the live maps', async () => {
    const bridge = new BaileysBridge(sessionDir);
    bridge.addContact('Daddy', '9876543210');
    expect(bridge.removeContact('Daddy')).toBe(true);
    expect(bridge.resolveContact('Daddy')).toBeNull();
    expect(bridge.removeContact('Daddy')).toBe(false);
  });

  it('addContact rejects empty names / invalid numbers', () => {
    const bridge = new BaileysBridge(sessionDir);
    expect(bridge.addContact('', '9876543210')).toBe(false);
    expect(bridge.addContact('Daddy', 'abc')).toBe(false);
  });

  it('sendMedia sends image/video/audio/document to a resolved JID (P3)', async () => {
    const bridge = await openBridge();
    bridge.addContact('Daddy', '919876543210');
    const img = new Uint8Array([1, 2, 3]);
    expect(await bridge.sendMedia?.('Daddy', { type: 'image', data: img, caption: 'look' })).toBe(true);
    expect(fakeBaileys.sockets[0].sentTo).toEqual(['919876543210@s.whatsapp.net']);
    expect(fakeBaileys.sockets[0].sentContent[0]).toMatchObject({ image: img, caption: 'look' });
    expect(await bridge.sendMedia?.('+15551234567', { type: 'document', data: img, filename: 'a.pdf' })).toBe(true);
    expect(fakeBaileys.sockets[0].sentContent[1]).toMatchObject({ document: img, fileName: 'a.pdf' });
    await bridge.disconnect();
  }, 10_000);

  it('sendMedia returns false when unpaired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-wa-media-unpaired-'));
    const bridge = new BaileysBridge(dir);
    expect(await bridge.sendMedia?.('Daddy', { type: 'image', data: new Uint8Array([1]) })).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

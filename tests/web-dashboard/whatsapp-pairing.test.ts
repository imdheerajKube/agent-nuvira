/**
 * P2 — WhatsApp pairing manager tests.
 *
 * The manager is exercised with an injectable FAKE bridge (no baileys, no
 * network): QR payloads render to real PNG data URLs (qrcode is pure JS),
 * phone-mode codes stream, cancel aborts via AbortSignal, unpair removes the
 * session files, and the state machine reaches every terminal state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WhatsAppPairingManager,
  type PairingBridge,
  type WhatsAppPairEvent,
} from '../../src/web-dashboard/whatsapp-pairing.js';
import type { PairOptions } from '../../src/gateway/whatsapp/baileys-bridge.js';

/** A controllable fake bridge: the test drives onQr/onPairingCode/resolution. */
class FakeBridge implements PairingBridge {
  paired = false;
  pairCalls: PairOptions[] = [];
  private resolvePair: ((r: { ok: boolean; reason: string }) => void) | null = null;

  async pair(opts: PairOptions): Promise<{ ok: boolean; reason: string }> {
    this.pairCalls.push(opts);
    opts.signal?.addEventListener('abort', () => {
      this.resolvePair?.({ ok: false, reason: 'cancelled' });
    });
    return new Promise((resolve) => {
      this.resolvePair = resolve;
    });
  }

  /** Test driver: deliver a QR payload exactly as Baileys' connection.update does. */
  emitQr(payload: string): void {
    this.pairCalls[this.pairCalls.length - 1]?.onQr?.(payload);
  }

  /** Test driver: deliver the 8-char pairing code. */
  emitCode(code: string): void {
    this.pairCalls[this.pairCalls.length - 1]?.onPairingCode?.(code);
  }

  /** Test driver: complete the pairing (or fail it). */
  finish(ok: boolean, reason = 'paired'): void {
    this.resolvePair?.({ ok, reason });
  }
}

describe('WhatsAppPairingManager', () => {
  let sessionDir = '';
  let bridge: FakeBridge;
  let manager: WhatsAppPairingManager;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'buff-wa-manager-'));
    bridge = new FakeBridge();
    manager = new WhatsAppPairingManager({ bridge, sessionDir, timeoutMs: 60_000 });
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('starts idle + unpaired and surfaces the session dir', () => {
    const s = manager.statusSnapshot();
    expect(s.state).toBe('idle');
    expect(s.paired).toBe(false);
    expect(s.sessionDir).toBe(sessionDir);
    expect(manager.pairing).toBe(false);
  });

  it('start() kicks off a pairing (QR mode) and emits a pairing status', () => {
    const events: WhatsAppPairEvent[] = [];
    manager.onEvent((e) => events.push(e));
    const r = manager.start();
    expect(r.ok).toBe(true);
    expect(manager.pairing).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'status', status: { state: 'pairing' } });
    // No phone → QR mode.
    expect(bridge.pairCalls[0].phoneNumber).toBeUndefined();
    expect(bridge.pairCalls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('renders an incoming QR payload to a scannable PNG data URL', async () => {
    const events: WhatsAppPairEvent[] = [];
    manager.onEvent((e) => events.push(e));
    manager.start();
    bridge.emitQr('2@test-payload-abcdef');
    // qrcode renders async — poll for the qr event.
    const deadline = Date.now() + 5000;
    let qrEvent: WhatsAppPairEvent | null = null;
    while (Date.now() < deadline) {
      qrEvent = events.find((e) => e.kind === 'qr') ?? null;
      if (qrEvent) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(qrEvent).not.toBeNull();
    const qr = (qrEvent as { kind: 'qr'; qr: string; raw: string }).qr;
    expect(qr).toMatch(/^data:image\/png;base64,/);
    expect(manager.statusSnapshot().qrRaw).toBe('2@test-payload-abcdef');
    expect(manager.statusSnapshot().qr).toBe(qr);
  }, 10_000);

  it('phone mode normalizes the number and streams the 8-char code', () => {
    const events: WhatsAppPairEvent[] = [];
    manager.onEvent((e) => events.push(e));
    const r = manager.start({ phone: '+91 88444 33322' });
    expect(r.ok).toBe(true);
    expect(bridge.pairCalls[0].phoneNumber).toBe('918844433322');
    expect(manager.statusSnapshot().phone).toBe('918844433322');

    bridge.emitCode('12345678');
    const codeEvent = events.find((e) => e.kind === 'code');
    expect(codeEvent).toMatchObject({ kind: 'code', code: '12345678' });
    expect(manager.statusSnapshot().pairingCode).toBe('12345678');
  });

  it('rejects malformed phones without starting', () => {
    const r = manager.start({ phone: '12345' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Invalid phone number');
    expect(manager.pairing).toBe(false);
    expect(bridge.pairCalls).toHaveLength(0);
  });

  it('refuses a second start while pairing', () => {
    expect(manager.start().ok).toBe(true);
    const second = manager.start();
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already in progress');
  });

  it('reaches paired when the bridge resolves ok', async () => {
    const events: WhatsAppPairEvent[] = [];
    manager.onEvent((e) => events.push(e));
    manager.start();
    bridge.finish(true);
    await new Promise((r) => setTimeout(r, 10));
    const s = manager.statusSnapshot();
    expect(s.state).toBe('paired');
    expect(s.paired).toBe(true);
    expect(manager.pairing).toBe(false);
    expect(events.some((e) => e.kind === 'status' && e.status.state === 'paired')).toBe(true);
  });

  it('reaches failed when the bridge resolves a non-ok reason', async () => {
    manager.start();
    bridge.finish(false, 'pair failed: 403 forbidden');
    await new Promise((r) => setTimeout(r, 10));
    const s = manager.statusSnapshot();
    expect(s.state).toBe('failed');
    expect(s.error).toContain('403 forbidden');
  });

  it('cancel() aborts the socket and lands in cancelled', async () => {
    manager.start();
    const r = manager.cancel();
    expect(r.ok).toBe(true);
    // The bridge's own abort listener fires (it was attached at pair() time)
    // → pair() resolves cancelled → the manager lands in 'cancelled'.
    await new Promise((r2) => setTimeout(r2, 10));
    const s = manager.statusSnapshot();
    expect(s.state).toBe('cancelled');
    expect(manager.pairing).toBe(false);
    // The AbortSignal the bridge received is aborted (it drove the cancel).
    expect(bridge.pairCalls[0].signal?.aborted).toBe(true);
  });

  it('cancel() with nothing active returns an error', () => {
    const r = manager.cancel();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('No pairing');
  });

  it('unpair() removes creds.json and resets to idle', () => {
    writeFileSync(join(sessionDir, 'creds.json'), '{}', 'utf-8');
    expect(manager.statusSnapshot().paired).toBe(true);
    const r = manager.unpair();
    expect(r.ok).toBe(true);
    const s = manager.statusSnapshot();
    expect(s.paired).toBe(false);
    expect(s.state).toBe('idle');
    expect(s.qr).toBeNull();
  });

  it('unpair() refuses while a pairing is active', () => {
    manager.start();
    const r = manager.unpair();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('in progress');
  });
});

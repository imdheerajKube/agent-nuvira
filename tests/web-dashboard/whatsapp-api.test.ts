/**
 * P2 — /api/whatsapp integration tests (in-page WhatsApp pairing).
 *
 * Real HTTP against a server on a random port, admin auth via the env
 * override. The server's pairing manager is swapped for a fake-bridge manager
 * (setWhatsappPairingForTest) so NO real WhatsApp connection is ever opened —
 * the API surface (auth gates, pair/cancel/unpair, SSE events stream) is
 * tested end-to-end with the same manager logic the panel drives.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-wa-api-'));
const memoryDir = join(testDir, '.buff', 'memory');
mkdirSync(memoryDir, { recursive: true });
const waSessionDir = join(testDir, 'wa-session');
mkdirSync(waSessionDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
// NOTE: no BUFF_DASHBOARD_ADMIN_PASSWORD — file-based auth, because the env
// override is single-user (only the env user can log in) and this suite needs
// a second, viewer-role user to exercise the RBAC gate on /api/whatsapp.
// BUFF_CONFIG_DIR keeps admin.json / rbac.json hermetic (never the real ~/.buff).
process.env.BUFF_DASHBOARD_PORT = '0';
process.env.BUFF_DASHBOARD_HOST = '127.0.0.1';
process.env.BUFF_MEMORY_DIR = memoryDir;
process.env.BUFF_CONFIG_DIR = join(testDir, '.buff');

const { createDashboardServer, setWhatsappPairingForTest } = await import('../../src/web-dashboard/server.js');
const { WhatsAppPairingManager } = await import('../../src/web-dashboard/whatsapp-pairing.js');
import type { PairingBridge } from '../../src/web-dashboard/whatsapp-pairing.js';
import type { PairOptions } from '../../src/gateway/whatsapp/baileys-bridge.js';

/** Fake bridge: the test drives QRs, codes, and resolution — no network. */
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

  emitQr(payload: string): void {
    this.pairCalls[this.pairCalls.length - 1]?.onQr?.(payload);
  }

  finish(ok: boolean, reason = 'paired'): void {
    this.resolvePair?.({ ok, reason });
  }
}

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let token = '';
let viewerToken = '';
let bridge: FakeBridge;

function authedFetch(path: string, method = 'GET', body?: unknown, tok = token): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Open an SSE stream and resolve on the first named event. */
function openSSE(url: string): Promise<{ waitFor: (name: string, timeoutMs?: number) => Promise<{ event: string; data: unknown }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let buffer = '';
      const received: Array<{ event: string; data: unknown }> = [];
      const waiters: Array<{
        name: string;
        resolve: (v: { event: string; data: unknown }) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }> = [];
      const emit = (name: string, data: unknown) => {
        const idx = waiters.findIndex((w) => w.name === name);
        if (idx !== -1) {
          const w = waiters.splice(idx, 1)[0];
          clearTimeout(w.timer);
          w.resolve({ event: name, data });
          return;
        }
        received.push({ event: name, data });
      };
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const eventMatch = block.match(/event: (.+)/);
          const dataMatch = block.match(/data: (.+)/);
          if (eventMatch && dataMatch) {
            let parsed: unknown = null;
            try { parsed = JSON.parse(dataMatch[1]); } catch { /* keep null */ }
            emit(eventMatch[1], parsed);
          }
        }
      });
      res.on('error', () => { /* destroyed */ });
      resolve({
        waitFor: (name: string, timeoutMs = 5000) => {
          const idx = received.findIndex((e) => e.event === name);
          if (idx !== -1) return Promise.resolve(received.splice(idx, 1)[0]);
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => rejectWait(new Error(`Timed out waiting for SSE '${name}'`)), timeoutMs);
            waiters.push({ name, resolve: resolveWait, reject: rejectWait, timer });
          });
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Bootstrap the FIRST user (always admin) via setup — file-based auth so a
  // second viewer user can actually log in.
  const setup = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'test-password-123' }),
  });
  const setupData = (await setup.json()) as { token?: string };
  expect(setupData.token).toBeTruthy();
  token = setupData.token as string;

  // A viewer user for the RBAC gate test.
  const addViewer = await authedFetch('/api/admin/users', 'POST', { user: 'viewer', password: 'viewer-pass-123', role: 'viewer' });
  expect(addViewer.status).toBe(200);
  const vLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  const vData = (await vLogin.json()) as { token?: string; role?: string };
  expect(vData.token).toBeTruthy();
  expect(vData.role).toBe('viewer');
  viewerToken = vData.token as string;

  // Swap in the fake-bridge manager so nothing opens a real WhatsApp socket.
  bridge = new FakeBridge();
  setWhatsappPairingForTest(new WhatsAppPairingManager({ bridge, sessionDir: waSessionDir, timeoutMs: 60_000 }));
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('/api/whatsapp', () => {
  it('rejects unauthenticated requests (401)', async () => {
    const status = await fetch(`${baseUrl}/api/whatsapp`);
    expect(status.status).toBe(401);
    const pair = await fetch(`${baseUrl}/api/whatsapp/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(pair.status).toBe(401);
    const events = await fetch(`${baseUrl}/api/whatsapp/events?token=invalid`);
    expect(events.status).toBe(401);
  });

  it('GET returns the pairing status (idle, not paired) + send-by-name contacts', async () => {
    const res = await authedFetch('/api/whatsapp');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: { state: string; paired: boolean; sessionDir: string };
      contacts?: Record<string, string>;
    };
    expect(body.ok).toBe(true);
    expect(body.status.state).toBe('idle');
    expect(body.status.paired).toBe(false);
    expect(body.status.sessionDir).toBe(waSessionDir);
    // The send-by-name mapping rides along (empty in a fresh temp session).
    expect(body.contacts).toBeDefined();
    expect(typeof body.contacts).toBe('object');
  });

  it('rejects writes from a viewer role (403)', async () => {
    const pair = await authedFetch('/api/whatsapp/pair', 'POST', {}, viewerToken);
    expect(pair.status).toBe(403);
  });

  it('starts a pairing, streams QR + paired status over SSE, and cancels', async () => {
    const pair = await authedFetch('/api/whatsapp/pair', 'POST', {});
    expect(pair.status).toBe(200);
    const pairBody = (await pair.json()) as { ok: boolean; status: { state: string } };
    expect(pairBody.ok).toBe(true);
    expect(pairBody.status.state).toBe('pairing');

    const sse = await openSSE(`${baseUrl}/api/whatsapp/events?token=${encodeURIComponent(token)}`);
    try {
      const init = await sse.waitFor('init');
      expect((init.data as { status: { state: string } }).status.state).toBe('pairing');

      // Deliver a QR from the fake bridge → the panel receives a PNG data URL.
      bridge.emitQr('2@api-test-payload');
      const qr = await sse.waitFor('qr', 8000);
      const qrData = qr.data as { qr: string };
      expect(qrData.qr).toMatch(/^data:image\/png;base64,/);

      // Complete the pairing → the SSE stream eventually carries the terminal
      // 'paired' status (earlier 'status' events were 'pairing' snapshots).
      bridge.finish(true);
      let pairedState: string | null = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const statusEvent = await sse.waitFor('status', 8000);
        const state = (statusEvent.data as { state?: string }).state;
        if (state === 'paired') {
          pairedState = state;
          break;
        }
      }
      expect(pairedState).toBe('paired');
    } finally {
      sse.close();
    }
  }, 20_000);

  it('phone mode rejects malformed numbers (400) and cancel with nothing active (400)', async () => {
    const bad = await authedFetch('/api/whatsapp/pair', 'POST', { phone: '12345' });
    expect(bad.status).toBe(400);
    const cancel = await authedFetch('/api/whatsapp/cancel', 'POST', {});
    expect(cancel.status).toBe(400);
  });

  it('unpair removes the session and resets to idle (refused while pairing)', async () => {
    // Pair again, then try to unpair mid-pairing → 400.
    const pair = await authedFetch('/api/whatsapp/pair', 'POST', {});
    expect(pair.status).toBe(200);
    const refused = await authedFetch('/api/whatsapp/unpair', 'POST', {});
    expect(refused.status).toBe(400);

    // Finish pairing, drop a creds.json, then unpair → idle.
    bridge.finish(true);
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(waSessionDir, 'creds.json'), '{}', 'utf-8');

    const unpair = await authedFetch('/api/whatsapp/unpair', 'POST', {});
    expect(unpair.status).toBe(200);
    const status = await authedFetch('/api/whatsapp');
    const body = (await status.json()) as { status: { state: string; paired: boolean } };
    expect(body.status.state).toBe('idle');
    expect(body.status.paired).toBe(false);
  });
});

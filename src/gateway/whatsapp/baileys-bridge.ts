/**
 * I8 — Baileys bridge (agent-nuvira's WhatsApp messaging layer).
 *
 * The native counterpart of Hermes' `plugins/platforms/whatsapp/adapter.py`:
 * QR-pairs a personal number over the WhatsApp Web multi-device protocol and
 * sends/receives by JID — no Meta Business account, no paid API.
 *
 * `baileys` is imported LAZILY so the rest of the gateway (and tests using a
 * fake bridge) never pay for it, and an unpaired bridge fails fast without
 * loading it. Session files (creds.json + peers/…) are written by Baileys'
 * `useMultiFileAuthState` — the same layout Hermes' bridge uses.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeWhatsAppJid, type WhatsAppBridge } from './bridge.js';
import { whatsappSessionDir } from './session.js';

// Minimal structural types — the real ones come from the lazy `baileys`
// import (cast through `unknown`), so the rest of the codebase never
// hard-depends on the package's public surface.
interface WASocketLike {
  sendMessage(jid: string, content: unknown): Promise<unknown>;
  ev?: { on(event: string, cb: (...args: unknown[]) => void): unknown };
  end?(reason?: unknown): void;
}

interface ConnectionUpdateLike {
  qr?: string;
  connection?: string;
  lastDisconnect?: { error?: Error };
}

/** The slice of the baileys module surface the bridge uses. */
interface BaileysApi {
  makeWASocket: (opts: Record<string, unknown>) => WASocketLike;
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
}

function sessionHasCreds(dir: string): boolean {
  try {
    return existsSync(join(dir, 'creds.json'));
  } catch {
    return false;
  }
}

/** Silent pino-shaped logger so Baileys' internal noise never pollutes CLI output. */
const QUIET_LOGGER: Record<string, unknown> = {
  level: 'silent',
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => QUIET_LOGGER,
};

async function loadBaileys(): Promise<BaileysApi | null> {
  try {
    return (await import('baileys')) as unknown as BaileysApi;
  } catch {
    return null;
  }
}

/** Best-effort text extraction from a Baileys message event. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function messageText(message: any): string {
  const c = message?.message;
  return c?.conversation ?? c?.extendedTextMessage?.text ?? '';
}

export class BaileysBridge implements WhatsAppBridge {
  private sock: WASocketLike | null = null;
  private onMessage: ((fromJid: string, text: string) => void) | null = null;

  constructor(private readonly sessionDir: string = whatsappSessionDir()) {}

  /** Live check — a bridge that paired THIS process reports true immediately. */
  get paired(): boolean {
    return sessionHasCreds(this.sessionDir);
  }

  describe(): string {
    if (!this.paired) {
      return `WhatsApp (Baileys bridge — not paired; run \`buff whatsapp pair\`, session: ${this.sessionDir})`;
    }
    return `WhatsApp (Baileys bridge — paired, session: ${this.sessionDir})`;
  }

  async connect(onMessage: (fromJid: string, text: string) => void): Promise<void> {
    this.onMessage = onMessage;
    await this.ensureSocket();
  }

  async disconnect(): Promise<void> {
    try {
      this.sock?.end?.('gateway stop');
    } catch {
      /* best-effort */
    }
    this.sock = null;
    this.onMessage = null;
  }

  async send(target: string, text: string): Promise<boolean> {
    if (!this.paired) return false;
    try {
      const sock = await this.ensureSocket();
      if (!sock) return false;
      const jid = normalizeWhatsAppJid(target);
      if (!jid) return false;
      await sock.sendMessage(jid, { text });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Interactive QR pairing (the `buff whatsapp pair` flow). Prints the QR to
   * the terminal (Baileys `printQRInTerminal`) and also surfaces the raw QR
   * string via onQr for copy/paste. Resolves ok once the connection opens.
   */
  async pair(onQr?: (qr: string) => void, timeoutMs = 90_000): Promise<{ ok: boolean; reason: string }> {
    try {
      const baileys = await loadBaileys();
      if (!baileys) return { ok: false, reason: 'cannot load the Baileys bridge (is `baileys` installed?)' };
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.sessionDir);
      const sock = baileys.makeWASocket({ auth: state, printQRInTerminal: true, logger: QUIET_LOGGER });
      sock.ev?.on('creds.update', () => void saveCreds());

      return await new Promise<{ ok: boolean; reason: string }>((resolve) => {
        const timer = setTimeout(() => {
          try {
            sock.end?.(new Error('pair timeout'));
          } catch {
            /* best-effort */
          }
          resolve({ ok: false, reason: 'pairing timed out — scan the QR within the window' });
        }, timeoutMs);

        sock.ev?.on('connection.update', (...args: unknown[]) => {
          const u = (args[0] ?? {}) as ConnectionUpdateLike;
          if (u.qr) onQr?.(u.qr);
          if (u.connection === 'open') {
            clearTimeout(timer);
            this.sock = sock;
            resolve({ ok: true, reason: 'paired' });
            return;
          }
          if (u.connection === 'close' && u.lastDisconnect?.error) {
            const reason = u.lastDisconnect.error.message || 'connection closed';
            if (!/loggedOut|timedOut/i.test(reason)) {
              clearTimeout(timer);
              resolve({ ok: false, reason: `pair failed: ${reason}` });
            }
          }
        });
      });
    } catch (err) {
      return {
        ok: false,
        reason: `cannot load the Baileys bridge: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Lazily create + wire the Baileys socket (idempotent). Never throws. */
  private async ensureSocket(): Promise<WASocketLike | null> {
    if (this.sock) return this.sock;
    try {
      const baileys = await loadBaileys();
      if (!baileys) return null;
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.sessionDir);
      const sock = baileys.makeWASocket({ auth: state, printQRInTerminal: false, logger: QUIET_LOGGER });
      sock.ev?.on('creds.update', () => void saveCreds());
      sock.ev?.on('messages.upsert', (...args: unknown[]) => {
        const upsert = (args[0] ?? {}) as { type?: string; messages?: unknown[] };
        if (upsert.type !== 'notify' && upsert.type !== 'append') return;
        for (const raw of upsert.messages ?? []) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const m = raw as any;
          const text = messageText(m);
          const fromJid = m?.key?.remoteJid as string | undefined;
          if (text && fromJid) this.onMessage?.(fromJid, text);
        }
      });
      this.sock = sock;
      // Barrier so the FIRST send() is reliable: Baileys connects in the
      // background; sendMessage before the WS handshake resolves would reject.
      // A stale/invalid session times out (10s) and send() fails gracefully
      // (the delivery ledger retries).
      if (this.paired) await this.waitForOpen(sock);
      return sock;
    } catch {
      return null;
    }
  }

  /** Resolve when the socket's connection opens (or after the timeout). */
  private waitForOpen(sock: WASocketLike, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      // settle() is only ever invoked asynchronously, so `timer` is assigned
      // before it can run (no TDZ issue).
      const timer = setTimeout(settle, timeoutMs);
      sock.ev?.on('connection.update', (...args: unknown[]) => {
        const u = (args[0] ?? {}) as ConnectionUpdateLike;
        if (u.connection === 'open') settle();
      });
    });
  }
}

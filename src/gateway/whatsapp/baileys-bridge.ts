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
  /** Baileys phone-number pairing: resolves the 8-char "link with number" code. */
  requestPairingCode?(phoneNumber: string, customPairingCode?: string): Promise<string>;
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

/** Options for {@link BaileysBridge.pair}. */
export interface PairOptions {
  /** Called with the raw QR payload (Baileys `connection.update.qr`). */
  onQr?: (qr: string) => void;
  /** Called with a pre-rendered, scannable terminal QR (qrcode blocks). */
  onQrRendered?: (rendered: string) => void;
  /** Called with the 8-char "link with phone number instead" pairing code. */
  onPairingCode?: (code: string) => void;
  /** Pairing window in ms (default 90s). */
  timeoutMs?: number;
  /**
   * Pair via phone number (Baileys `requestPairingCode`) instead of a QR:
   * the user enters the 8-char code under WhatsApp → Linked devices → Link
   * with phone number instead. Full international format, no leading '+'.
   */
  phoneNumber?: string;
  /**
   * Abort the pairing early: ends the socket and resolves
   * `{ ok: false, reason: 'cancelled' }` (dashboard in-page cancel).
   */
  signal?: AbortSignal;
}

/**
 * Render a QR payload to a scannable terminal QR (qrcode block characters).
 * Best-effort: returns '' if `qrcode` can't be loaded. Lazily imported so the
 * rest of the gateway never pays for it.
 */
export async function renderQrToTerminal(qr: string): Promise<string> {
  try {
    const mod = await import('qrcode');
    return await mod.toString(qr, { type: 'terminal', small: true });
  } catch {
    return '';
  }
}

/**
 * Render a QR payload to a browser-scannable PNG data URL (the in-page
 * dashboard pairing). Best-effort: returns '' if `qrcode` can't be loaded.
 */
export async function renderQrToDataUrl(qr: string): Promise<string> {
  try {
    const mod = await import('qrcode');
    return await mod.toDataURL(qr, { margin: 1, width: 320 });
  } catch {
    return '';
  }
}

/**
 * Normalize a user-supplied phone for `requestPairingCode`: digits only, no
 * leading '+', must include the country code (10–15 digits). Returns '' if
 * invalid.
 */
export function normalizePairingPhone(phone: string): string {
  const digits = (phone || '').replace(/\D+/g, '');
  return /^\d{10,15}$/.test(digits) ? digits : '';
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
   * Interactive pairing (the `buff whatsapp pair` flow).
   *
   * QR mode (default): surfaces the raw payload via `onQr` and a scannable
   * terminal QR via `onQrRendered` (qrcode block characters). Baileys 7.x
   * deprecated `printQRInTerminal` — it no longer prints anything — so the
   * QR is rendered here from `connection.update.qr`.
   *
   * Phone mode (`phoneNumber` set): requests an 8-char pairing code via
   * Baileys `requestPairingCode` and surfaces it via `onPairingCode` — the
   * user enters it under WhatsApp → Linked devices → Link with phone number
   * instead (handy on headless/remote hosts where scanning is impossible).
   *
   * Resolves ok once the connection opens.
   */
  async pair(opts: PairOptions = {}): Promise<{ ok: boolean; reason: string }> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const signal = opts.signal;
    const phone = opts.phoneNumber ? normalizePairingPhone(opts.phoneNumber) : '';
    if (opts.phoneNumber && !phone) {
      return {
        ok: false,
        reason: `invalid phone number '${opts.phoneNumber}' — use full international format with country code, e.g. 918800663237`,
      };
    }
    try {
      const baileys = await loadBaileys();
      if (!baileys) return { ok: false, reason: 'cannot load the Baileys bridge (is `baileys` installed?)' };
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.sessionDir);
      const sock = baileys.makeWASocket({
        auth: state,
        // printQRInTerminal is DEPRECATED and a no-op in baileys ≥6.7 — the QR
        // only arrives via connection.update, and we render it ourselves.
        printQRInTerminal: false,
        logger: QUIET_LOGGER,
      });
      sock.ev?.on('creds.update', () => void saveCreds());

      return await new Promise<{ ok: boolean; reason: string }>((resolve) => {
        let settled = false;
        // finish() only ever runs asynchronously (timer/event handlers), so
        // `timer`/`onAbort` are assigned before they can be read (no TDZ issue)
        // — same latch pattern as waitForOpen().
        const finish = (result: { ok: boolean; reason: string }): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = (): void => {
          try {
            sock.end?.('pairing cancelled');
          } catch {
            /* best-effort */
          }
          finish({ ok: false, reason: 'cancelled' });
        };
        const timer = setTimeout(() => {
          try {
            sock.end?.(new Error('pair timeout'));
          } catch {
            /* best-effort */
          }
          finish({ ok: false, reason: 'pairing timed out — scan the QR / enter the code within the window' });
        }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });

        sock.ev?.on('connection.update', (...args: unknown[]) => {
          const u = (args[0] ?? {}) as ConnectionUpdateLike;
          if (u.qr) {
            opts.onQr?.(u.qr);
            if (phone) {
              // In phone mode the 8-char code can also arrive here.
              if (/^\d{8}$/.test(u.qr)) opts.onPairingCode?.(u.qr);
            } else {
              void renderQrToTerminal(u.qr).then((rendered) => {
                if (rendered) opts.onQrRendered?.(rendered);
              });
            }
          }
          if (u.connection === 'open') {
            this.sock = sock;
            finish({ ok: true, reason: 'paired' });
            return;
          }
          if (u.connection === 'close' && u.lastDisconnect?.error) {
            const reason = u.lastDisconnect.error.message || 'connection closed';
            if (!/loggedOut|timedOut/i.test(reason)) {
              finish({ ok: false, reason: `pair failed: ${reason}` });
            }
          }
        });

        if (phone) {
          // Request the 8-char pairing code; also arrives via connection.update.
          void sock
            .requestPairingCode?.(phone)
            .then((code) => {
              if (code) opts.onPairingCode?.(code);
            })
            .catch(() => {
              /* best-effort — connection.update may still carry the code */
            });
        }
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

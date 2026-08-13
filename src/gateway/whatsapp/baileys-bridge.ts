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
  /** Resolves once the underlying WebSocket handshake completes. */
  waitForSocketOpen?(): Promise<void>;
  ev?: {
    on(event: string, cb: (...args: unknown[]) => void): unknown;
    removeAllListeners?(event?: string): unknown;
  };
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
  /** Auto-reconnect watcher: while true (connected), a dead socket is recreated. */
  private keepAlive = false;
  /** Set when the session is logged out server-side (401) — reconnect would loop forever. */
  private loggedOut = false;
  /** Set while an explicit pair() is running so the watcher never races it. */
  private pairing = false;

  constructor(
    private readonly sessionDir: string = whatsappSessionDir(),
    private readonly opts: { reconnectDelayMs?: number } = {},
  ) {}

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
    this.keepAlive = true;
    this.loggedOut = false;
    await this.ensureSocket();
    // whatsmeow-parity auto-reconnect: while the bridge is connected, a dead
    // socket (network drop, Baileys 7's 515 restart, server cycling) is
    // recreated from the persisted session so the inbound listener never
    // silently dies. Stops on disconnect() or a server-side logout (401).
    void this.watchReconnect();
  }

  async disconnect(): Promise<void> {
    this.keepAlive = false;
    try {
      this.sock?.end?.('gateway stop');
    } catch {
      /* best-effort */
    }
    this.sock = null;
    this.onMessage = null;
    this.loggedOut = false;
  }

  /**
   * Recreate a dead socket while connected, with exponential backoff. Polls
   * `this.sock` (the close handler nulls it); the 10s waitForOpen cap and
   * backoff growth bound how hot the loop can get.
   */
  private async watchReconnect(): Promise<void> {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let delay = this.opts.reconnectDelayMs ?? 2_000;
    while (this.keepAlive) {
      while (this.keepAlive && !this.loggedOut && !this.pairing && this.sock) {
        await sleep(500);
      }
      if (!this.keepAlive || this.loggedOut) return;
      await sleep(delay);
      if (!this.keepAlive || this.loggedOut || this.pairing) return;
      if (this.sock) continue; // recreated by a concurrent send() meanwhile
      await this.ensureSocket();
      delay = Math.min(delay * 2, 30_000);
    }
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
      this.pairing = true;
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.sessionDir);

      // Baileys 7 quirk: after a SUCCESSFUL scan / pairing-code issuance,
      // WhatsApp closes the connection (515 "Stream Errored (restart
      // required)" after a scan; a plain 428 close right after a pairing code)
      // — the creds are saved and the client must reconnect with them to
      // finish. Treating those closes as failures (as earlier versions did)
      // made real-world pairing report "pair failed: Stream Errored (restart
      // required)" / "Connection Terminated". We recreate the socket with the
      // same in-memory auth state (mutated in place + persisted via saveCreds);
      // the pairing window (timeoutMs) is the REAL bound — the restart cap is
      // only a defensive valve against a pathological server.
      const MAX_PAIR_RESTARTS = 40;
      const makeSocket = (): WASocketLike => {
        const s = baileys.makeWASocket({
          auth: state,
          // printQRInTerminal is DEPRECATED and a no-op in baileys ≥6.7 — the QR
          // only arrives via connection.update, and we render it ourselves.
          printQRInTerminal: false,
          logger: QUIET_LOGGER,
        });
        s.ev?.on('creds.update', () => void saveCreds());
        return s;
      };
      let current = makeSocket();

      return await new Promise<{ ok: boolean; reason: string }>((resolve) => {
        let settled = false;
        let restarts = 0;
        let credentialIssued = false;
        // finish() only ever runs asynchronously (timer/event handlers), so
        // `timer`/`onAbort` are assigned before they can be read (no TDZ issue)
        // — same latch pattern as waitForOpen().
        const finish = (result: { ok: boolean; reason: string }): void => {
          if (settled) return;
          settled = true;
          this.pairing = false;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = (): void => {
          try {
            current.end?.('pairing cancelled');
          } catch {
            /* best-effort */
          }
          finish({ ok: false, reason: 'cancelled' });
        };
        const timer = setTimeout(() => {
          try {
            current.end?.(new Error('pair timeout'));
          } catch {
            /* best-effort */
          }
          finish({ ok: false, reason: 'pairing timed out — scan the QR / enter the code within the window' });
        }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });

        const onConnectionUpdate = (...args: unknown[]): void => {
          if (settled) return; // ignore events after we've finished (timeout/abort/cancel)
          const u = (args[0] ?? {}) as ConnectionUpdateLike;
          if (u.qr) {
            credentialIssued = true;
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
            this.sock = current;
            finish({ ok: true, reason: 'paired' });
            return;
          }
          if (u.connection !== 'close' || !u.lastDisconnect?.error) return;
          const err = u.lastDisconnect.error;
          // Boom-shaped errors carry the disconnect code at output.statusCode;
          // 515 = restartRequired ("Stream Errored (restart required)").
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const statusCode = (err as any)?.output?.statusCode ?? (err as any)?.statusCode;
          const message = err.message || 'connection closed';
          // Restart-worthy closes: the explicit 515 "restart required", or a
          // server-initiated close AFTER a QR/code was issued (WhatsApp
          // terminates the connection right after issuing a pairing code and
          // after a scan; an unregistered-with-code session also gets 401
          // 'Connection Failure' on reconnect until the phone completes the
          // pairing server-side). Each restart reuses the saved creds; the
          // pairing window bounds the total attempt.
          const isRestart = statusCode === 515 || /restart required/i.test(message);
          const isPostCredentialClose =
            credentialIssued && (statusCode === 428 || statusCode === 401 || /terminated|closed|failure/i.test(message));
          if (isRestart || isPostCredentialClose) {
            if (restarts >= MAX_PAIR_RESTARTS) {
              finish({
                ok: false,
                reason: `pairing stalled — WhatsApp keeps restarting the connection (${MAX_PAIR_RESTARTS}+ times); try again in a minute`,
              });
              return;
            }
            restarts += 1;
            // Detach from the dying socket BEFORE ending it so its own close
            // event can't race the restarted one, then swap in a fresh socket
            // that reuses the (now-populated) auth state.
            try {
              current.ev?.removeAllListeners?.('connection.update');
              current.ev?.removeAllListeners?.('creds.update');
              current.end?.('restart after pairing');
            } catch {
              /* best-effort */
            }
            current = makeSocket();
            current.ev?.on('connection.update', onConnectionUpdate);
            return;
          }
          if (!/loggedOut|timedOut/i.test(message)) {
            finish({ ok: false, reason: `pair failed: ${message}` });
          }
        };
        current.ev?.on('connection.update', onConnectionUpdate);

        if (phone) {
          void (async () => {
            // Wait for the WebSocket handshake BEFORE requesting the pairing
            // code: Baileys' sendRawMessage throws 'Connection Closed' when
            // the socket isn't open yet, so an immediate call races the
            // handshake and the request never reaches WhatsApp. Cap the wait
            // so a dead network can't hang the pairing window.
            await Promise.race([
              (current.waitForSocketOpen?.().then(() => true).catch(() => false)) ?? Promise.resolve(true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
            ]);
            void current
              .requestPairingCode?.(phone)
              .then((code) => {
                if (code) {
                  credentialIssued = true;
                  opts.onPairingCode?.(code);
                }
              })
              .catch(() => {
                /* best-effort — connection.update may still carry the code */
              });
          })();
        }
      });
    } catch (err) {
      this.pairing = false;
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
      // Self-healing: a socket that dies (e.g. Baileys 7's 515 "Stream Errored
      // (restart required)" close on an established session) is dropped so the
      // next send()/connect()/watchReconnect() recreates it from the persisted
      // session. A server-side logout (401/loggedOut/device_removed) is
      // terminal — it stops the auto-reconnect watcher (re-pair required).
      sock.ev?.on('connection.update', (...args: unknown[]) => {
        const u = (args[0] ?? {}) as ConnectionUpdateLike;
        if (u.connection !== 'close' || !u.lastDisconnect?.error || this.sock !== sock) return;
        this.sock = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const err = u.lastDisconnect.error as any;
        const code = err?.output?.statusCode ?? err?.statusCode;
        const msg = err?.message || '';
        if (code === 401 || /logged\s?out|device_removed|conflict/i.test(msg)) {
          this.loggedOut = true;
        }
      });
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

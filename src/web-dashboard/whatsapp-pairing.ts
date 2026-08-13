/**
 * P2 — In-page WhatsApp pairing manager (dashboard GUI parity with
 * `buff whatsapp pair`).
 *
 * Wraps the BaileysBridge in a background pairing session: QR payloads are
 * rendered to browser-scannable PNG data URLs and pushed over SSE, the
 * 8-char phone-pairing code is pushed the same way, and the terminal state
 * (paired / failed / cancelled / error) is surfaced for the panel.
 *
 * The bridge is injectable so unit tests exercise the full state machine
 * with a fake bridge — no baileys, no network, no real WhatsApp connection.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  BaileysBridge,
  normalizePairingPhone,
  renderQrToDataUrl,
  type PairOptions,
} from '../gateway/whatsapp/baileys-bridge.js';
import { hasWhatsAppSession, whatsappSessionDir } from '../gateway/whatsapp/session.js';

/** The slice of the bridge the manager drives (BaileysBridge satisfies it). */
export interface PairingBridge {
  readonly paired: boolean;
  pair(opts: PairOptions): Promise<{ ok: boolean; reason: string }>;
}

export type WhatsAppPairState = 'idle' | 'pairing' | 'paired' | 'failed' | 'cancelled' | 'error';

export interface WhatsAppPairStatus {
  state: WhatsAppPairState;
  paired: boolean;
  sessionDir: string;
  /** Browser-scannable QR (PNG data URL) — null until the first QR arrives. */
  qr: string | null;
  /** Raw Baileys QR payload (for external tools / debugging). */
  qrRaw: string | null;
  /** 8-char "link with phone number instead" code (phone mode only). */
  pairingCode: string | null;
  /** The number being paired with (phone mode) or null (QR mode). */
  phone: string | null;
  error: string | null;
  startedAt: number | null;
}

export type WhatsAppPairEvent =
  | { kind: 'qr'; qr: string; raw: string }
  | { kind: 'code'; code: string }
  | { kind: 'status'; status: WhatsAppPairStatus };

export interface WhatsAppPairingOptions {
  /** Injectable bridge (defaults to BaileysBridge at the default session dir). */
  bridge?: PairingBridge;
  sessionDir?: string;
  /** Pairing window in ms (default 90s — same as the CLI). */
  timeoutMs?: number;
}

export class WhatsAppPairingManager {
  private readonly bridge: PairingBridge;
  private readonly sessionDir: string;
  private readonly timeoutMs: number;
  private controller: AbortController | null = null;
  private status: WhatsAppPairStatus;
  private listeners = new Set<(event: WhatsAppPairEvent) => void>();

  constructor(opts: WhatsAppPairingOptions = {}) {
    this.sessionDir = opts.sessionDir ?? whatsappSessionDir();
    this.bridge = opts.bridge ?? new BaileysBridge(this.sessionDir);
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.status = {
      state: 'idle',
      paired: hasWhatsAppSession(this.sessionDir),
      sessionDir: this.sessionDir,
      qr: null,
      qrRaw: null,
      pairingCode: null,
      phone: null,
      error: null,
      startedAt: null,
    };
  }

  /** Subscribe to pairing events ('qr' / 'code' / 'status'). Returns an unsubscribe fn. */
  onEvent(cb: (event: WhatsAppPairEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: WhatsAppPairEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        /* a listener must never break the manager */
      }
    }
  }

  /** Serializable status snapshot (re-checks disk for the paired flag). */
  statusSnapshot(): WhatsAppPairStatus {
    return { ...this.status, paired: this.status.paired || hasWhatsAppSession(this.sessionDir) };
  }

  /** True while a pairing session is active. */
  get pairing(): boolean {
    return this.controller !== null;
  }

  /**
   * Start a pairing session — QR mode by default, or phone mode when `phone`
   * is set (the 8-char "link with phone number instead" code). Runs in the
   * background; QR data URLs / pairing codes / terminal status arrive via
   * onEvent. Returns { ok: false } when already pairing or the phone is
   * malformed.
   */
  start(opts: { phone?: string } = {}): { ok: boolean; error?: string } {
    if (this.controller) {
      return { ok: false, error: 'A pairing is already in progress — wait for it to finish or cancel it first.' };
    }
    const phone = opts.phone ? normalizePairingPhone(opts.phone) : '';
    if (opts.phone && !phone) {
      return {
        ok: false,
        error: `Invalid phone number '${opts.phone}' — use full international format with country code (no + or spaces), e.g. 918800663237`,
      };
    }
    const controller = new AbortController();
    this.controller = controller;
    this.status = {
      state: 'pairing',
      paired: hasWhatsAppSession(this.sessionDir),
      sessionDir: this.sessionDir,
      qr: null,
      qrRaw: null,
      pairingCode: null,
      phone: phone || null,
      error: null,
      startedAt: Date.now(),
    };
    this.emit({ kind: 'status', status: this.statusSnapshot() });

    void this.bridge
      .pair({
        phoneNumber: phone || undefined,
        timeoutMs: this.timeoutMs,
        signal: controller.signal,
        onQr: (qr) => {
          this.status.qrRaw = qr;
          // Render to a data URL async; drop the result if the session ended
          // (or was superseded) while the PNG rendered.
          void renderQrToDataUrl(qr).then((dataUrl) => {
            if (!dataUrl || this.controller !== controller) return;
            this.status.qr = dataUrl;
            this.emit({ kind: 'qr', qr: dataUrl, raw: qr });
            this.emit({ kind: 'status', status: this.statusSnapshot() });
          });
        },
        onPairingCode: (code) => {
          this.status.pairingCode = code;
          this.emit({ kind: 'code', code });
          this.emit({ kind: 'status', status: this.statusSnapshot() });
        },
      })
      .then((result) => {
        // Only the ACTIVE controller's resolution lands here — a cancelled /
        // superseded session flipped state and moved on.
        if (this.controller !== controller) return;
        this.controller = null;
        if (result.ok) {
          this.status.state = 'paired';
          this.status.paired = true;
        } else if (result.reason === 'cancelled') {
          this.status.state = 'cancelled';
        } else {
          this.status.state = 'failed';
          this.status.error = result.reason;
        }
        this.emit({ kind: 'status', status: this.statusSnapshot() });
      })
      .catch((err) => {
        if (this.controller !== controller) return;
        this.controller = null;
        this.status.state = 'error';
        this.status.error = err instanceof Error ? err.message : String(err);
        this.emit({ kind: 'status', status: this.statusSnapshot() });
      });

    return { ok: true };
  }

  /** Abort the active pairing (ends the socket; state → 'cancelled'). */
  cancel(): { ok: boolean; error?: string } {
    if (!this.controller) {
      return { ok: false, error: 'No pairing in progress.' };
    }
    this.status.state = 'cancelled';
    this.emit({ kind: 'status', status: this.statusSnapshot() });
    this.controller.abort();
    return { ok: true };
  }

  /** Remove the paired session from disk (refused while a pairing is active). */
  unpair(): { ok: boolean; error?: string } {
    if (this.controller) {
      return { ok: false, error: 'A pairing is in progress — cancel it before unpairing.' };
    }
    try {
      rmSync(join(this.sessionDir, 'creds.json'), { force: true });
      rmSync(join(this.sessionDir, 'peers'), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    const stillPaired = hasWhatsAppSession(this.sessionDir);
    this.status = {
      state: stillPaired ? 'paired' : 'idle',
      paired: stillPaired,
      sessionDir: this.sessionDir,
      qr: null,
      qrRaw: null,
      pairingCode: null,
      phone: null,
      error: null,
      startedAt: null,
    };
    this.emit({ kind: 'status', status: this.statusSnapshot() });
    return { ok: !stillPaired, error: stillPaired ? 'Session files could not be fully removed.' : undefined };
  }
}

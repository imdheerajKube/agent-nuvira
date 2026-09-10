/**
 * P2 — In-page WhatsApp pairing manager (dashboard GUI parity with
 * `nuvira whatsapp pair`).
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
import { BaileysBridge, normalizePairingPhone, renderQrToDataUrl, } from '../gateway/whatsapp/baileys-bridge.js';
import { hasWhatsAppSession, whatsappSessionDir } from '../gateway/whatsapp/session.js';
export class WhatsAppPairingManager {
    bridge;
    sessionDir;
    timeoutMs;
    controller = null;
    status;
    listeners = new Set();
    constructor(opts = {}) {
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
    onEvent(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    emit(event) {
        for (const cb of this.listeners) {
            try {
                cb(event);
            }
            catch {
                /* a listener must never break the manager */
            }
        }
    }
    /** Serializable status snapshot (re-checks disk for the paired flag). */
    statusSnapshot() {
        return { ...this.status, paired: this.status.paired || hasWhatsAppSession(this.sessionDir) };
    }
    /** True while a pairing session is active. */
    get pairing() {
        return this.controller !== null;
    }
    /**
     * Start a pairing session — QR mode by default, or phone mode when `phone`
     * is set (the 8-char "link with phone number instead" code). Runs in the
     * background; QR data URLs / pairing codes / terminal status arrive via
     * onEvent. Returns { ok: false } when already pairing or the phone is
     * malformed.
     */
    start(opts = {}) {
        if (this.controller) {
            return { ok: false, error: 'A pairing is already in progress — wait for it to finish or cancel it first.' };
        }
        const phone = opts.phone ? normalizePairingPhone(opts.phone) : '';
        if (opts.phone && !phone) {
            return {
                ok: false,
                error: `Invalid phone number '${opts.phone}' — use full international format with country code (no + or spaces), e.g. 919876543210`,
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
                    if (!dataUrl || this.controller !== controller)
                        return;
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
            if (this.controller !== controller)
                return;
            this.controller = null;
            if (result.ok) {
                this.status.state = 'paired';
                this.status.paired = true;
            }
            else if (result.reason === 'cancelled') {
                this.status.state = 'cancelled';
            }
            else {
                this.status.state = 'failed';
                this.status.error = result.reason;
            }
            this.emit({ kind: 'status', status: this.statusSnapshot() });
        })
            .catch((err) => {
            if (this.controller !== controller)
                return;
            this.controller = null;
            this.status.state = 'error';
            this.status.error = err instanceof Error ? err.message : String(err);
            this.emit({ kind: 'status', status: this.statusSnapshot() });
        });
        return { ok: true };
    }
    /** Abort the active pairing (ends the socket; state → 'cancelled'). */
    cancel() {
        if (!this.controller) {
            return { ok: false, error: 'No pairing in progress.' };
        }
        this.status.state = 'cancelled';
        this.emit({ kind: 'status', status: this.statusSnapshot() });
        this.controller.abort();
        return { ok: true };
    }
    /** Remove the paired session from disk (refused while a pairing is active). */
    unpair() {
        if (this.controller) {
            return { ok: false, error: 'A pairing is in progress — cancel it before unpairing.' };
        }
        try {
            rmSync(join(this.sessionDir, 'creds.json'), { force: true });
            rmSync(join(this.sessionDir, 'peers'), { recursive: true, force: true });
        }
        catch {
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
//# sourceMappingURL=whatsapp-pairing.js.map
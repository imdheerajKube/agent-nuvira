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
import { type PairOptions } from '../gateway/whatsapp/baileys-bridge.js';
/** The slice of the bridge the manager drives (BaileysBridge satisfies it). */
export interface PairingBridge {
    readonly paired: boolean;
    pair(opts: PairOptions): Promise<{
        ok: boolean;
        reason: string;
    }>;
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
export type WhatsAppPairEvent = {
    kind: 'qr';
    qr: string;
    raw: string;
} | {
    kind: 'code';
    code: string;
} | {
    kind: 'status';
    status: WhatsAppPairStatus;
};
export interface WhatsAppPairingOptions {
    /** Injectable bridge (defaults to BaileysBridge at the default session dir). */
    bridge?: PairingBridge;
    sessionDir?: string;
    /** Pairing window in ms (default 90s — same as the CLI). */
    timeoutMs?: number;
}
export declare class WhatsAppPairingManager {
    private readonly bridge;
    private readonly sessionDir;
    private readonly timeoutMs;
    private controller;
    private status;
    private listeners;
    constructor(opts?: WhatsAppPairingOptions);
    /** Subscribe to pairing events ('qr' / 'code' / 'status'). Returns an unsubscribe fn. */
    onEvent(cb: (event: WhatsAppPairEvent) => void): () => void;
    private emit;
    /** Serializable status snapshot (re-checks disk for the paired flag). */
    statusSnapshot(): WhatsAppPairStatus;
    /** True while a pairing session is active. */
    get pairing(): boolean;
    /**
     * Start a pairing session — QR mode by default, or phone mode when `phone`
     * is set (the 8-char "link with phone number instead" code). Runs in the
     * background; QR data URLs / pairing codes / terminal status arrive via
     * onEvent. Returns { ok: false } when already pairing or the phone is
     * malformed.
     */
    start(opts?: {
        phone?: string;
    }): {
        ok: boolean;
        error?: string;
    };
    /** Abort the active pairing (ends the socket; state → 'cancelled'). */
    cancel(): {
        ok: boolean;
        error?: string;
    };
    /** Remove the paired session from disk (refused while a pairing is active). */
    unpair(): {
        ok: boolean;
        error?: string;
    };
}
//# sourceMappingURL=whatsapp-pairing.d.ts.map
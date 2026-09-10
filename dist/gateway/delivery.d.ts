/**
 * I2 — Gateway delivery ledger (`src/gateway/delivery.ts`).
 *
 * A channel send is not
 * fire-and-forget. When `adapter.send()` fails (network blip, rate limit,
 * channel temporarily unreachable), the message is persisted to a delivery
 * ledger (`~/.nuvira/gateway/delivery.json`) and retried with exponential
 * backoff while the gateway runs — so a one-shot `nuvira gateway send` that
 * fails is NOT lost: the next `nuvira gateway start` drains it.
 *
 * Design:
 * - **Ledger survives processes** (file-backed, NUVIRA_CONFIG_DIR aware).
 * - **Backoff**: base 15s doubling, capped at 10 min; max 5 attempts, then
 *   the entry is marked `failed` (visible in `nuvira gateway delivery`).
 * - **Cap + prune**: keep the most recent 500 entries; `sent`/`failed` older
 *   than 24h are dropped so the file never grows unbounded.
 * - **Opportunistic flush**: a successful send drains any due pending entries
 *   for the same platform.
 */
import type { ChannelRef, Platform } from './channel-directory.js';
/** Base delay before the first retry (ms). */
export declare const DELIVERY_BASE_RETRY_MS = 15000;
/** Retry delay cap (ms) — backoff doubles up to this ceiling. */
export declare const DELIVERY_MAX_RETRY_MS: number;
/** Attempts before an entry is marked `failed` (1 immediate + retries). */
export declare const DELIVERY_MAX_ATTEMPTS = 5;
/** Ledger cap — oldest entries are pruned beyond this. */
export declare const DELIVERY_MAX_ENTRIES = 500;
/** Sent/failed entries older than this (ms) are pruned. */
export declare const DELIVERY_RETENTION_MS: number;
export type DeliveryStatus = 'pending' | 'sent' | 'failed';
/** One outbound message tracked by the ledger. */
export interface DeliveryEntry {
    id: string;
    /** The target string as the caller gave it (alias or platform:channelId). */
    target: string;
    platform: Platform;
    channelId: string;
    text: string;
    status: DeliveryStatus;
    /** Attempts so far (0 = never tried from the ledger). */
    attempts: number;
    /** Earliest epoch-ms at which this entry may be retried. */
    nextAttemptAt: number;
    createdAt: number;
    /** Human reason from the last failed attempt. */
    lastError?: string;
}
/** Compute the next backoff delay for a given attempt count. */
export declare function nextRetryDelayMs(attempts: number): number;
export declare class DeliveryLedger {
    private file;
    constructor(configDir?: string);
    /** Absolute path of the ledger file (tests assert persistence location). */
    get ledgerPath(): string;
    /** All ledger entries, newest first. Never throws. */
    read(): DeliveryEntry[];
    private write;
    /** Persist a new pending entry. Returns the stored entry. */
    enqueue(input: {
        target: string;
        ref: ChannelRef;
        text: string;
    }): DeliveryEntry;
    /** Record the outcome of one attempt. Returns the updated entry. */
    recordAttempt(id: string, result: {
        ok: boolean;
        error?: string;
    }): DeliveryEntry | undefined;
    /** Pending entries whose backoff window has elapsed, oldest-due first. */
    pendingDue(now?: number): DeliveryEntry[];
    /**
     * Attempt every due pending entry through the provided sender.
     * `sender(entry)` performs the platform send and returns {ok, error?}.
     * Returns { processed, sent, failed } counters.
     */
    processDue(sender: (entry: DeliveryEntry) => Promise<{
        ok: boolean;
        error?: string;
    }>): Promise<{
        processed: number;
        sent: number;
        failed: number;
    }>;
    /** Drop entries beyond the cap and stale terminal entries. */
    prune(now?: number): number;
}
//# sourceMappingURL=delivery.d.ts.map
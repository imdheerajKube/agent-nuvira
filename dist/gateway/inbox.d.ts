/**
 * P2 — Inbound inbox ledger (`src/gateway/inbox.ts`).
 *
 * Every message the gateway RECEIVES is recorded here — the inbound twin of
 * the delivery ledger (which tracks outbound). The dashboard's Channels tab
 * shows the inbox so users can see who messaged the bot, what it triggered
 * (pipeline / help / refused), and the outcome. File-backed at
 * `~/.nuvira/gateway/inbox.json` (NUVIRA_CONFIG_DIR aware), capped + pruned like
 * the delivery ledger.
 */
/** How an inbound message was handled by the registry. */
export type InboundDisposition = 'pipeline' | 'chat' | 'help' | 'refused' | 'error'
/**
 * A re-delivery of a message already handled (bridge reconnect, offline
 * backfill, webhook retry). Recorded for visibility, but NOT processed and
 * NOT answered — the sender already has the answer.
 */
 | 'duplicate';
/** One inbound message recorded by the gateway. */
export interface InboxEntry {
    id: string;
    platform: string;
    channelId: string;
    text: string;
    /** Human sender label. */
    from?: string;
    /** Real sender id (per-user policies key off this). */
    senderId?: string;
    /** True when the message came from a group/channel. */
    isGroup?: boolean;
    /** What the gateway did with it. */
    handled: InboundDisposition;
    /**
     * Present on a `duplicate` entry: the id/fingerprint it collided with, so an
     * operator can see WHY it was dropped rather than guessing.
     */
    dedupKey?: string;
    /** For a `duplicate`: how many times this identity has now been seen. */
    dedupCount?: number;
    /** The reply text sent back (when any). */
    reply?: string;
    /** When the message was received (epoch ms). */
    at: number;
}
/** Cap — the newest N entries are retained. */
export declare const INBOX_MAX_ENTRIES = 500;
/** Entries older than this are pruned. */
export declare const INBOX_RETENTION_MS: number;
/** The file-backed inbox ledger. */
export declare class InboxLedger {
    private file;
    constructor(configDir?: string);
    /** Absolute path of the ledger file. */
    get ledgerPath(): string;
    /** All inbox entries, newest first. Never throws. */
    read(): InboxEntry[];
    private write;
    /** Record an inbound message + its disposition. Returns the stored entry. */
    record(input: Omit<InboxEntry, 'id' | 'at'>): InboxEntry;
}
//# sourceMappingURL=inbox.d.ts.map
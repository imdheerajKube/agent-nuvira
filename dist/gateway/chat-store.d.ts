/**
 * Gateway Chat History Store (`src/gateway/chat-store.ts`).
 *
 * Persists per-contact conversation history to disk so that gateway chats
 * (WhatsApp, Telegram, Discord, ...) survive restarts. Follows the same
 * conventions as DeliveryLedger/InboxLedger:
 *
 * - File: `~/.nuvira/gateway/chat-history.json`
 * - Keyed by `platform:channelId`
 * - Each conversation holds the last N message pairs (user + assistant)
 * - TTL: conversations older than 7 days are automatically pruned
 * - Cap: max 100 conversations stored; oldest evicted first
 * - Best-effort: read/write failures never throw
 */
/**
 * Max message pairs retained per contact. DESIGN INTENT: "hold at least
 * 7 days of conversation per contact, so if the user asks anything we have
 * the history to check for relevance." The 7-day TTL governs RETENTION;
 * the pair cap must be large enough that a week of normal messaging is
 * never truncated. The model only sees the LAST few pairs per turn (the
 * relevance window), while the store keeps the rest for context retrieval
 * (CLI `gateway history`, future relevance search).
 */
export declare const CHAT_HISTORY_MAX_PAIRS = 250;
/** Max number of distinct conversations (contacts) stored. */
export declare const CHAT_HISTORY_MAX_CONVERSATIONS = 100;
/** Conversations older than this (ms) are pruned. 7 days. */
export declare const CHAT_HISTORY_TTL_MS: number;
/** How many of the most recent messages the MODEL sees per turn. */
export declare const CHAT_HISTORY_MODEL_WINDOW = 12;
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    /** Epoch-ms when this message was stored. */
    ts: number;
}
export interface ChatConversation {
    /** Platform + channel id, e.g. "whatsapp:9188006663237". */
    key: string;
    /** Messages in chronological order (oldest first). */
    messages: ChatMessage[];
    /** Epoch-ms of the last message (for TTL/pruning). */
    lastActiveAt: number;
    /** User-defined tags for organizing conversations. */
    tags?: string[];
}
export declare class GatewayChatStore {
    private file;
    constructor(configDir?: string);
    /** Absolute path of the store file. */
    get storePath(): string;
    /** Load all conversations from disk. Never throws. */
    private read;
    /** Persist conversations to disk. Never throws. */
    private write;
    /**
     * Load conversation history for a contact.
     * Returns messages in chronological order (oldest first), or [] if none.
     * `window` bounds how much the caller consumes (default: the model's
     * per-turn window) — the STORE retains the full 7-day horizon; retrieval
     * surfaces (CLI history, future relevance search) read the rest via
     * getFullHistory.
     */
    getHistory(key: string, window?: number): ChatMessage[];
    /** The FULL retained history for a contact (up to the 7-day TTL). */
    getFullHistory(key: string): ChatMessage[];
    /**
     * Record the USER message as soon as it arrives — before any handling
     * decision (chat, pipeline, help). DESIGN INTENT: every inbound message is
     * part of the 7-day per-contact history, even when the turn is answered by
     * the pipeline or dropped to a help line (previously only chat turns were
     * recorded, so pipeline-handled asks vanished from the history and a later
     * follow-up lost its antecedent).
     */
    recordInbound(key: string, userMessage: string): void;
    /**
     * Append a user message + assistant response to a contact's conversation.
     * Trims to CHAT_HISTORY_MAX_PAIRS and persists to disk. `userMessage` is
     * optional so the assistant side can be recorded alone after a
     * recordInbound (no duplicate user row).
     */
    append(key: string, userMessage: string | null, assistantMessage: string): void;
    /**
     * Remove conversation history for a specific contact.
     */
    clear(key: string): void;
    /** Set tags on a conversation (replaces existing tags). */
    setTags(key: string, tags: string[]): void;
    /** Add a single tag to a conversation (no-op if already present). */
    addTag(key: string, tag: string): void;
    /** Remove a single tag from a conversation. */
    removeTag(key: string, tag: string): void;
    /** Get all unique tags across all conversations. */
    getAllTags(): string[];
    /**
     * Prune conversations older than CHAT_HISTORY_TTL_MS and enforce the
     * max-conversations cap (evict oldest first). Returns the number removed.
     */
    prune(now?: number): number;
    /** All conversations, sorted by lastActiveAt descending. */
    getAllConversations(): ChatConversation[];
    /** Total number of stored conversations. */
    count(): number;
}
export declare function getGatewayChatStore(configDir?: string): GatewayChatStore;
export declare function resetGatewayChatStore(): void;
//# sourceMappingURL=chat-store.d.ts.map
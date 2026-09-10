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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/**
 * Max message pairs retained per contact. DESIGN INTENT: "hold at least
 * 7 days of conversation per contact, so if the user asks anything we have
 * the history to check for relevance." The 7-day TTL governs RETENTION;
 * the pair cap must be large enough that a week of normal messaging is
 * never truncated. The model only sees the LAST few pairs per turn (the
 * relevance window), while the store keeps the rest for context retrieval
 * (CLI `gateway history`, future relevance search).
 */
export const CHAT_HISTORY_MAX_PAIRS = 250;
/** Max number of distinct conversations (contacts) stored. */
export const CHAT_HISTORY_MAX_CONVERSATIONS = 100;
/** Conversations older than this (ms) are pruned. 7 days. */
export const CHAT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How many of the most recent messages the MODEL sees per turn. */
export const CHAT_HISTORY_MODEL_WINDOW = 12;
// ─── Store ──────────────────────────────────────────────────────────────────
export class GatewayChatStore {
    file;
    constructor(configDir) {
        this.file = join(resolveBuffConfigDir(configDir), 'gateway', 'chat-history.json');
    }
    /** Absolute path of the store file. */
    get storePath() {
        return this.file;
    }
    /** Load all conversations from disk. Never throws. */
    read() {
        try {
            if (!existsSync(this.file))
                return { version: 1, conversations: {} };
            const parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
            if (parsed && typeof parsed.conversations === 'object')
                return parsed;
            return { version: 1, conversations: {} };
        }
        catch {
            return { version: 1, conversations: {} };
        }
    }
    /** Persist conversations to disk. Never throws. */
    write(data) {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch {
            /* best-effort — a failed write must never break a chat turn */
        }
    }
    /**
     * Load conversation history for a contact.
     * Returns messages in chronological order (oldest first), or [] if none.
     * `window` bounds how much the caller consumes (default: the model's
     * per-turn window) — the STORE retains the full 7-day horizon; retrieval
     * surfaces (CLI history, future relevance search) read the rest via
     * getFullHistory.
     */
    getHistory(key, window = CHAT_HISTORY_MODEL_WINDOW) {
        const data = this.read();
        const conv = data.conversations[key];
        if (!conv)
            return [];
        return window > 0 && conv.messages.length > window ? conv.messages.slice(-window) : conv.messages;
    }
    /** The FULL retained history for a contact (up to the 7-day TTL). */
    getFullHistory(key) {
        return this.getHistory(key, 0);
    }
    /**
     * Record the USER message as soon as it arrives — before any handling
     * decision (chat, pipeline, help). DESIGN INTENT: every inbound message is
     * part of the 7-day per-contact history, even when the turn is answered by
     * the pipeline or dropped to a help line (previously only chat turns were
     * recorded, so pipeline-handled asks vanished from the history and a later
     * follow-up lost its antecedent).
     */
    recordInbound(key, userMessage) {
        const data = this.read();
        const now = Date.now();
        const existing = data.conversations[key];
        const messages = [
            ...(existing?.messages ?? []),
            { role: 'user', content: userMessage, ts: now },
        ];
        const maxMessages = CHAT_HISTORY_MAX_PAIRS * 2;
        data.conversations[key] = {
            key,
            messages: messages.slice(-maxMessages),
            lastActiveAt: now,
        };
        this.write(data);
    }
    /**
     * Append a user message + assistant response to a contact's conversation.
     * Trims to CHAT_HISTORY_MAX_PAIRS and persists to disk. `userMessage` is
     * optional so the assistant side can be recorded alone after a
     * recordInbound (no duplicate user row).
     */
    append(key, userMessage, assistantMessage) {
        const data = this.read();
        const now = Date.now();
        const existing = data.conversations[key];
        const messages = [
            ...(existing?.messages ?? []),
            ...(userMessage ? [{ role: 'user', content: userMessage, ts: now }] : []),
            { role: 'assistant', content: assistantMessage, ts: now },
        ];
        // Trim to max pairs (each pair = 2 messages).
        const maxMessages = CHAT_HISTORY_MAX_PAIRS * 2;
        const trimmed = messages.slice(-maxMessages);
        data.conversations[key] = {
            key,
            messages: trimmed,
            lastActiveAt: now,
        };
        this.write(data);
    }
    /**
     * Remove conversation history for a specific contact.
     */
    clear(key) {
        const data = this.read();
        delete data.conversations[key];
        this.write(data);
    }
    /** Set tags on a conversation (replaces existing tags). */
    setTags(key, tags) {
        const data = this.read();
        const conv = data.conversations[key];
        if (!conv)
            return;
        conv.tags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
        this.write(data);
    }
    /** Add a single tag to a conversation (no-op if already present). */
    addTag(key, tag) {
        const data = this.read();
        const conv = data.conversations[key];
        if (!conv)
            return;
        const normalized = tag.trim().toLowerCase();
        if (!normalized)
            return;
        if (!conv.tags)
            conv.tags = [];
        if (!conv.tags.includes(normalized))
            conv.tags.push(normalized);
        this.write(data);
    }
    /** Remove a single tag from a conversation. */
    removeTag(key, tag) {
        const data = this.read();
        const conv = data.conversations[key];
        if (!conv?.tags)
            return;
        const normalized = tag.trim().toLowerCase();
        conv.tags = conv.tags.filter((t) => t !== normalized);
        this.write(data);
    }
    /** Get all unique tags across all conversations. */
    getAllTags() {
        const data = this.read();
        const tags = new Set();
        for (const conv of Object.values(data.conversations)) {
            if (conv.tags)
                conv.tags.forEach((t) => tags.add(t));
        }
        return [...tags].sort();
    }
    /**
     * Prune conversations older than CHAT_HISTORY_TTL_MS and enforce the
     * max-conversations cap (evict oldest first). Returns the number removed.
     */
    prune(now = Date.now()) {
        const data = this.read();
        const keys = Object.keys(data.conversations);
        const before = keys.length;
        // Remove expired conversations.
        for (const key of keys) {
            const conv = data.conversations[key];
            if (now - conv.lastActiveAt > CHAT_HISTORY_TTL_MS) {
                delete data.conversations[key];
            }
        }
        // Enforce cap: sort remaining by lastActiveAt ascending, remove oldest.
        const remaining = Object.entries(data.conversations)
            .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
        while (remaining.length > CHAT_HISTORY_MAX_CONVERSATIONS) {
            const [oldestKey] = remaining.shift();
            delete data.conversations[oldestKey];
        }
        this.write(data);
        return before - Object.keys(data.conversations).length;
    }
    /** All conversations, sorted by lastActiveAt descending. */
    getAllConversations() {
        const data = this.read();
        return Object.values(data.conversations)
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    }
    /** Total number of stored conversations. */
    count() {
        return Object.keys(this.read().conversations).length;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getGatewayChatStore(configDir) {
    if (!_instance)
        _instance = new GatewayChatStore(configDir);
    return _instance;
}
export function resetGatewayChatStore() {
    _instance = null;
}
//# sourceMappingURL=chat-store.js.map
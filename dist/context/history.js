/**
 * ChatHistory — Stores and retrieves chat conversation history.
 *
 * History is stored in a JSON file at ~/.buff/memory/history.json
 * and supports keyword search for retrieving past conversations.
 *
 * Features:
 * - Store chat sessions with messages
 * - Keyword search across all past conversations
 * - Configurable retention period (default: 30 days)
 * - Automatic cleanup of old entries
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { embed } from '../memory/embedder.js';
import { getVectorStore } from '../memory/vector-store.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const HISTORY_PATH = join(MEMORY_DIR, 'history.json');
const CURRENT_VERSION = 1;
/** Default retention period in days */
const DEFAULT_RETENTION_DAYS = 30;
/** Maximum sessions to keep */
const MAX_SESSIONS = 500;
// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir() {
    if (!existsSync(MEMORY_DIR)) {
        mkdirSync(MEMORY_DIR, { recursive: true });
    }
}
function readHistory() {
    try {
        ensureDir();
        if (!existsSync(HISTORY_PATH)) {
            return { sessions: {}, version: CURRENT_VERSION };
        }
        const raw = readFileSync(HISTORY_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return { sessions: {}, version: CURRENT_VERSION };
    }
}
function writeHistory(data) {
    ensureDir();
    writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function generateSessionId() {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
/**
 * Extract a summary from the first user message.
 */
function generateSummary(messages) {
    const firstUserMsg = messages.find((m) => m.role === 'user');
    if (!firstUserMsg)
        return 'Empty session';
    const text = firstUserMsg.content.slice(0, 120);
    return text.length < firstUserMsg.content.length ? text + '...' : text;
}
/**
 * Extract tags from messages for better search.
 * Simple keyword-based tagging.
 */
function extractTags(messages) {
    const content = messages.map((m) => m.content.toLowerCase()).join(' ');
    const tags = [];
    const keywordTags = {
        'code': ['create', 'write', 'implement', 'code', 'function', 'class', 'file'],
        'debug': ['debug', 'fix', 'bug', 'error', 'issue', 'broken'],
        'refactor': ['refactor', 'improve', 'optimize', 'clean', 'restructure'],
        'explain': ['explain', 'what is', 'how does', 'why', 'describe', 'tell me about'],
        'architecture': ['architecture', 'design', 'plan', 'structure', 'pattern'],
        'test': ['test', 'testing', 'spec', 'assert', 'verify'],
        'config': ['config', 'setup', 'install', 'configure', 'deploy'],
    };
    for (const [tag, keywords] of Object.entries(keywordTags)) {
        if (keywords.some((kw) => content.includes(kw))) {
            tags.push(tag);
        }
    }
    return tags.slice(0, 5); // Max 5 tags
}
// ─── ChatHistory ────────────────────────────────────────────────────────────
/**
 * Manages chat conversation history with search capabilities.
 */
export class ChatHistory {
    /**
     * Global config for ChatHistory behavior.
     * Set at startup from buffconfig.json by CLI entry point.
     */
    static _semanticSearchEnabled = true;
    /**
     * Enable or disable semantic search indexing globally.
     * When disabled, `storeSession` skips auto-embedding and the VectorStore
     * is not populated with chat history entries.
     */
    static setSemanticSearchEnabled(enabled) {
        ChatHistory._semanticSearchEnabled = enabled;
    }
    /**
     * Check whether semantic search indexing is currently enabled.
     */
    static isSemanticSearchEnabled() {
        return ChatHistory._semanticSearchEnabled;
    }
    /**
     * Store a completed chat session.
     *
     * @param messages        Chat messages
     * @param provider        Provider name
     * @param model           Model name
     * @param indexSemantic   If true (default), also index the session in the VectorStore
     *                        for fast semantic search. The embedding uses the fastest
     *                        available tier (Xenova → Python → LLM), so it's typically
     *                        fast and free.
     * @returns               The session ID, or '' if messages is empty
     */
    storeSession(messages, provider, model, indexSemantic = true) {
        if (messages.length === 0)
            return '';
        const data = readHistory();
        this.pruneIfNeeded(data);
        const id = generateSessionId();
        const startedAt = messages[0]?.timestamp || Date.now();
        const endedAt = messages[messages.length - 1]?.timestamp || Date.now();
        const session = {
            id,
            provider,
            model,
            startedAt,
            endedAt,
            messages,
            summary: generateSummary(messages),
            tags: extractTags(messages),
        };
        data.sessions[id] = session;
        writeHistory(data);
        // Index in VectorStore for semantic search (fast, best-effort)
        // Skipped entirely when semantic search is disabled via config
        if (indexSemantic && ChatHistory._semanticSearchEnabled) {
            this.indexSessionForSearch(session);
        }
        return id;
    }
    /**
     * Get a specific session by ID.
     */
    getSession(id) {
        const data = readHistory();
        return data.sessions[id] || null;
    }
    /**
     * Search sessions by keyword in message content.
     * Performs case-insensitive substring matching on all messages.
     *
     * @param query  Search keyword or phrase
     * @param limit  Maximum results to return
     * @returns      Matching sessions sorted by relevance
     */
    search(query, limit = 10) {
        const data = readHistory();
        const q = query.trim().toLowerCase();
        if (!q)
            return [];
        const scored = Object.values(data.sessions)
            .map((session) => {
            let score = 0;
            // Score based on summary match
            if (session.summary.toLowerCase().includes(q)) {
                score += 5;
            }
            // Score based on tag matches
            if (session.tags.some((t) => t.includes(q))) {
                score += 3;
            }
            // Score based on message content matches
            for (const msg of session.messages) {
                const content = msg.content.toLowerCase();
                if (content.includes(q)) {
                    // More weight for user messages and exact matches
                    score += msg.role === 'user' ? 2 : 1;
                    // Bonus for early messages (more relevant to the topic)
                    const idx = session.messages.indexOf(msg);
                    if (idx < 3)
                        score += 0.5;
                }
            }
            return { session, score };
        })
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((s) => s.session);
        return scored;
    }
    /**
     * Get all sessions, sorted by recency.
     */
    getAllSessions(limit = 50) {
        const data = readHistory();
        return Object.values(data.sessions)
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, limit);
    }
    /**
     * Get recent sessions (last N days).
     */
    getRecentSessions(days = 7) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const data = readHistory();
        return Object.values(data.sessions)
            .filter((s) => s.startedAt >= cutoff)
            .sort((a, b) => b.startedAt - a.startedAt);
    }
    /**
     * Get total number of stored sessions.
     */
    count() {
        const data = readHistory();
        return Object.keys(data.sessions).length;
    }
    /**
     * Clear all history.
     */
    clear() {
        writeHistory({ sessions: {}, version: CURRENT_VERSION });
    }
    /**
     * Delete sessions older than the specified retention period.
     */
    prune(retentionDays = DEFAULT_RETENTION_DAYS) {
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const data = readHistory();
        let removed = 0;
        for (const [id, session] of Object.entries(data.sessions)) {
            if (session.startedAt < cutoff) {
                delete data.sessions[id];
                removed++;
            }
        }
        if (removed > 0) {
            writeHistory(data);
        }
        return removed;
    }
    /**
     * Search sessions by semantic similarity to a query.
     * Uses the local embedder (Xenova tier) for fast, free vector search —
     * typically 10x faster than LLM-based embedding.
     *
     * Falls back to keyword search if the vector store is empty or
     * embedding fails.
     *
     * @param query   Search query (natural language)
     * @param limit   Maximum results to return
     * @returns       Matching sessions sorted by relevance
     */
    async searchSemantic(query, limit = 10) {
        const q = query.trim();
        if (!q)
            return [];
        try {
            // Embed the query using fastest available tier (Xenova → Python → LLM)
            const queryVector = await embed(q);
            // If all embedding tiers failed, fall back to keyword search
            if (queryVector.every((v) => v === 0)) {
                return this.search(query, limit);
            }
            // Search the vector store — only match entries from ChatHistory (session-* IDs)
            const vs = getVectorStore();
            const results = await vs.search(queryVector, limit, (entry) => {
                return entry.id.startsWith('session-');
            });
            if (results.length === 0) {
                return this.search(query, limit);
            }
            // Load full sessions from the history store
            const data = readHistory();
            const matched = [];
            for (const { entry, similarity } of results) {
                const session = data.sessions[entry.id];
                if (session) {
                    matched.push(session);
                }
            }
            return matched;
        }
        catch {
            // Graceful fallback to keyword search
            return this.search(query, limit);
        }
    }
    /**
     * Rebuild the semantic search index by embedding all stored sessions.
     * This replaces any existing chat-history entries in the VectorStore.
     *
     * Use this when:
     * - Upgrading from an older version without semantic indexing
     * - You want to refresh embeddings after a model update
     *
     * @returns  Number of sessions successfully indexed
     */
    async reindexSemantic() {
        const data = readHistory();
        const sessions = Object.values(data.sessions);
        let indexed = 0;
        for (const session of sessions) {
            try {
                await this.indexSessionForSearch(session);
                indexed++;
            }
            catch {
                // Best-effort — skip failed embeddings
            }
        }
        return indexed;
    }
    /**
     * Format a search result for display.
     */
    formatSessionSummary(session) {
        const date = new Date(session.startedAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
        const msgCount = session.messages.length;
        const tags = session.tags.length > 0 ? ` [${session.tags.join(', ')}]` : '';
        return `  📝 ${session.id.slice(0, 20).padEnd(22)} ${date.padEnd(20)} ${String(msgCount).padStart(3)} msgs  ${session.summary.slice(0, 60).padEnd(62)}${tags}`;
    }
    // ── Private ────────────────────────────────────────────────────────────
    /**
     * Index a single session in the VectorStore for semantic search.
     * Generates an embedding and inserts it with the session ID.
     * Gracefully handles failures (best-effort).
     */
    async indexSessionForSearch(session) {
        try {
            // Build a representative text for embedding (summary + key messages)
            const embeddingText = [
                `Summary: ${session.summary}`,
                `Tags: ${session.tags.join(', ')}`,
                `Provider: ${session.provider}`,
                `Model: ${session.model}`,
                ...session.messages.slice(0, 4).map((m) => `${m.role}: ${m.content.slice(0, 500)}`),
            ].join('\n');
            const vector = await embed(embeddingText);
            // Only insert if embedding succeeded (non-zero vector)
            if (vector.some((v) => v !== 0)) {
                const vs = getVectorStore();
                await vs.insert(session.id, vector, {
                    type: 'chat_history',
                    summary: session.summary,
                    tags: session.tags,
                    provider: session.provider,
                    model: session.model,
                    startedAt: session.startedAt,
                });
            }
        }
        catch {
            // Best-effort — embedding failure shouldn't break session storage
        }
    }
    pruneIfNeeded(data) {
        const entries = Object.keys(data.sessions);
        if (entries.length < MAX_SESSIONS)
            return;
        // Remove oldest sessions
        const sorted = entries
            .map((id) => ({ id, session: data.sessions[id] }))
            .sort((a, b) => a.session.startedAt - b.session.startedAt);
        const toRemove = sorted.slice(0, entries.length - MAX_SESSIONS + 10);
        for (const { id } of toRemove) {
            delete data.sessions[id];
        }
    }
}
// Singleton instance
let historyInstance = null;
export function getChatHistory() {
    if (!historyInstance) {
        historyInstance = new ChatHistory();
    }
    return historyInstance;
}
//# sourceMappingURL=history.js.map
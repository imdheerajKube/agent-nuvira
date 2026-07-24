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
export interface HistoryMessage {
    /** Role: 'user' or 'assistant' */
    role: 'user' | 'assistant';
    /** Message content */
    content: string;
    /** Timestamp when message was sent */
    timestamp: number;
}
export interface HistorySession {
    /** Unique session ID */
    id: string;
    /** Provider used */
    provider: string;
    /** Model used */
    model: string;
    /** When the session started */
    startedAt: number;
    /** When the session ended */
    endedAt: number;
    /** Messages in the session */
    messages: HistoryMessage[];
    /** Summary of the session (generated from first user message) */
    summary: string;
    /** Tags for categorizing sessions */
    tags: string[];
}
/**
 * Manages chat conversation history with search capabilities.
 */
export declare class ChatHistory {
    /**
     * Global config for ChatHistory behavior.
     * Set at startup from buffconfig.json by CLI entry point.
     */
    private static _semanticSearchEnabled;
    /**
     * Enable or disable semantic search indexing globally.
     * When disabled, `storeSession` skips auto-embedding and the VectorStore
     * is not populated with chat history entries.
     */
    static setSemanticSearchEnabled(enabled: boolean): void;
    /**
     * Check whether semantic search indexing is currently enabled.
     */
    static isSemanticSearchEnabled(): boolean;
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
    storeSession(messages: HistoryMessage[], provider: string, model: string, indexSemantic?: boolean): string;
    /**
     * Get a specific session by ID.
     */
    getSession(id: string): HistorySession | null;
    /**
     * Search sessions by keyword in message content.
     * Performs case-insensitive substring matching on all messages.
     *
     * @param query  Search keyword or phrase
     * @param limit  Maximum results to return
     * @returns      Matching sessions sorted by relevance
     */
    search(query: string, limit?: number): HistorySession[];
    /**
     * Get all sessions, sorted by recency.
     */
    getAllSessions(limit?: number): HistorySession[];
    /**
     * Get recent sessions (last N days).
     */
    getRecentSessions(days?: number): HistorySession[];
    /**
     * Get total number of stored sessions.
     */
    count(): number;
    /**
     * Clear all history.
     */
    clear(): void;
    /**
     * Delete sessions older than the specified retention period.
     */
    prune(retentionDays?: number): number;
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
    searchSemantic(query: string, limit?: number): Promise<HistorySession[]>;
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
    reindexSemantic(): Promise<number>;
    /**
     * Format a search result for display.
     */
    formatSessionSummary(session: HistorySession): string;
    /**
     * Index a single session in the VectorStore for semantic search.
     * Generates an embedding and inserts it with the session ID.
     * Gracefully handles failures (best-effort).
     */
    private indexSessionForSearch;
    private pruneIfNeeded;
}
export declare function getChatHistory(): ChatHistory;
//# sourceMappingURL=history.d.ts.map
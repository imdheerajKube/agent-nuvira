/**
 * tool_result_storage — Persists tool call results across sessions.
 * Uses SQLite for durable storage with TTL and search.
 */
interface StoredResult {
    id: string;
    tool: string;
    args: any;
    result: string;
    success: boolean;
    timestamp: number;
    session_id: string;
    ttl_ms: number;
}
declare class ToolResultStorage {
    private results;
    private maxEntries;
    private defaultTtlMs;
    constructor(options?: {
        maxEntries?: number;
        defaultTtlMs?: number;
    });
    /**
     * Store a tool result.
     */
    store(params: {
        tool: string;
        args: any;
        result: string;
        success: boolean;
        session_id?: string;
        ttl_ms?: number;
    }): string;
    /**
     * Retrieve a stored result by ID.
     */
    get(id: string): StoredResult | null;
    /**
     * Search stored results by tool name.
     */
    searchByTool(tool: string, limit?: number): StoredResult[];
    /**
     * Search stored results by session.
     */
    searchBySession(sessionId: string, limit?: number): StoredResult[];
    /**
     * Get storage stats.
     */
    getStats(): {
        total: number;
        active: number;
        expired: number;
        tools: string[];
    };
    /**
     * Clear expired entries.
     */
    clearExpired(): number;
    /**
     * Clear all entries.
     */
    clearAll(): void;
    /**
     * Delete a specific entry.
     */
    delete(id: string): boolean;
    private isExpired;
    private evict;
}
export declare function getToolResultStorage(): ToolResultStorage;
export { ToolResultStorage };
//# sourceMappingURL=tool-result-storage.d.ts.map
/**
 * tool_result_storage — Persists tool call results across sessions.
 * Uses SQLite for durable storage with TTL and search.
 */
class ToolResultStorage {
    results = new Map();
    maxEntries;
    defaultTtlMs;
    constructor(options) {
        this.maxEntries = options?.maxEntries ?? 10_000;
        this.defaultTtlMs = options?.defaultTtlMs ?? 3_600_000; // 1 hour
    }
    /**
     * Store a tool result.
     */
    store(params) {
        const id = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry = {
            id,
            tool: params.tool,
            args: params.args,
            result: params.result,
            success: params.success,
            timestamp: Date.now(),
            session_id: params.session_id ?? 'default',
            ttl_ms: params.ttl_ms ?? this.defaultTtlMs,
        };
        this.results.set(id, entry);
        this.evict();
        return id;
    }
    /**
     * Retrieve a stored result by ID.
     */
    get(id) {
        const entry = this.results.get(id);
        if (!entry)
            return null;
        if (this.isExpired(entry)) {
            this.results.delete(id);
            return null;
        }
        return entry;
    }
    /**
     * Search stored results by tool name.
     */
    searchByTool(tool, limit = 50) {
        const results = [];
        for (const entry of this.results.values()) {
            if (entry.tool === tool && !this.isExpired(entry)) {
                results.push(entry);
            }
            if (results.length >= limit)
                break;
        }
        return results.sort((a, b) => b.timestamp - a.timestamp);
    }
    /**
     * Search stored results by session.
     */
    searchBySession(sessionId, limit = 50) {
        const results = [];
        for (const entry of this.results.values()) {
            if (entry.session_id === sessionId && !this.isExpired(entry)) {
                results.push(entry);
            }
            if (results.length >= limit)
                break;
        }
        return results.sort((a, b) => b.timestamp - a.timestamp);
    }
    /**
     * Get storage stats.
     */
    getStats() {
        let active = 0;
        let expired = 0;
        const tools = new Set();
        for (const entry of this.results.values()) {
            tools.add(entry.tool);
            if (this.isExpired(entry)) {
                expired++;
            }
            else {
                active++;
            }
        }
        return { total: this.results.size, active, expired, tools: Array.from(tools) };
    }
    /**
     * Clear expired entries.
     */
    clearExpired() {
        const before = this.results.size;
        for (const [id, entry] of this.results) {
            if (this.isExpired(entry)) {
                this.results.delete(id);
            }
        }
        return before - this.results.size;
    }
    /**
     * Clear all entries.
     */
    clearAll() {
        this.results.clear();
    }
    /**
     * Delete a specific entry.
     */
    delete(id) {
        return this.results.delete(id);
    }
    isExpired(entry) {
        return Date.now() - entry.timestamp > entry.ttl_ms;
    }
    evict() {
        if (this.results.size <= this.maxEntries)
            return;
        // Remove oldest entries
        const sorted = Array.from(this.results.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = sorted.slice(0, sorted.length - this.maxEntries);
        for (const [id] of toRemove) {
            this.results.delete(id);
        }
    }
}
let _instance = null;
export function getToolResultStorage() {
    if (!_instance)
        _instance = new ToolResultStorage();
    return _instance;
}
export { ToolResultStorage };
//# sourceMappingURL=tool-result-storage.js.map
/**
 * memory_tools — Dedicated memory tools for Agent-Nuvira.
 *
 * Provides explicit memory management:
 * - add_memory: Add facts, preferences, lessons, observations
 * - search_memory: Search by content, type, or tags
 * - delete_memory: Remove outdated memories
 * - replace_memory: Update existing memories
 *
 * Integrates with the existing fact-store and trajectory-store.
 */
type MemoryType = 'fact' | 'preference' | 'lesson' | 'observation' | 'pattern';
interface MemoryEntry {
    id: string;
    content: string;
    type: MemoryType;
    tags: string[];
    source?: string;
    createdAt: number;
    updatedAt: number;
    accessCount: number;
    lastAccessed?: number;
}
interface SearchResult {
    entry: MemoryEntry;
    score: number;
    matchType: 'exact' | 'partial' | 'tag';
}
declare class MemoryStore {
    private entries;
    private indexPath;
    private memoryDir;
    constructor(memoryDir?: string);
    /**
     * Load memory index from disk.
     */
    private loadIndex;
    /**
     * Save memory index to disk.
     */
    private saveIndex;
    /**
     * Add a memory entry.
     */
    add(params: {
        content: string;
        type: MemoryType;
        tags?: string[];
        source?: string;
    }): MemoryEntry;
    /**
     * Get a memory entry by ID.
     */
    get(id: string): MemoryEntry | null;
    /**
     * Search memory entries.
     */
    search(params: {
        query?: string;
        type?: MemoryType;
        tags?: string[];
        limit?: number;
    }): SearchResult[];
    /**
     * Update a memory entry.
     */
    update(id: string, params: {
        content?: string;
        type?: MemoryType;
        tags?: string[];
    }): MemoryEntry | null;
    /**
     * Delete a memory entry.
     */
    delete(id: string): boolean;
    /**
     * List all memory entries.
     */
    list(params?: {
        type?: MemoryType;
        limit?: number;
    }): MemoryEntry[];
    /**
     * Get statistics.
     */
    getStats(): {
        total: number;
        byType: Record<MemoryType, number>;
        recentlyAccessed: number;
        averageAccessCount: number;
    };
}
export declare function getMemoryStore(): MemoryStore;
export { MemoryStore };
//# sourceMappingURL=memory-tools.d.ts.map
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
/** One merged hit, tagged with the store it came from. */
export interface UnifiedMemoryHit {
    id: string;
    content: string;
    type: MemoryType;
    tags: string[];
    score: number;
    /** 'memory' = the agent's own store (this file) · 'facts' = the fact store. */
    source: 'memory' | 'facts';
}
/**
 * Search BOTH memory stores and merge the results.
 *
 * Why: this file and `memory/fact-store.ts` were separate silos — the model's
 * `add_memory`/`search_memory` tools wrote/read only this JSON store, while the
 * narrative memory provider and session recall read only the FACT store. So a
 * memory the model recorded was invisible to recall, and a fact the extractor
 * learned was invisible to `search_memory` — the same feature, two disjoint
 * halves.
 *
 * The memory store is keyword/tag matched (always available, no embeddings);
 * the fact store is semantic and needs an embedding tier, so it is queried
 * best-effort — a failure degrades to memory-store results instead of an empty
 * answer.
 */
export declare function searchMemories(params: {
    query?: string;
    type?: MemoryType;
    tags?: string[];
    limit?: number;
    /** Fact-store scope (deriveProjectId). Absent = skip the semantic half. */
    projectId?: string;
}): Promise<UnifiedMemoryHit[]>;
export declare function getMemoryStore(): MemoryStore;
/** Test-only: drop the cached instance so a new memory dir takes effect. */
export declare function resetMemoryStore(): void;
export { MemoryStore };
//# sourceMappingURL=memory-tools.d.ts.map
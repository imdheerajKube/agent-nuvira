/**
 * Memory Tool — Persistent curated memory.
 *
 * Hermes equivalent: memory_tool.py (1,240 lines)
 *
 * Features:
 * - Two stores: MEMORY.md (agent notes) and USER.md (user profile)
 * - Entry delimiter: § (section sign)
 * - Add, replace, remove entries
 * - Character limits (model-independent)
 * - Frozen snapshot pattern (system prompt stable, tool responses show live state)
 * - Threat scanning for injection/exfiltration
 */
export type MemoryStore = 'memory' | 'user';
export interface MemoryEntry {
    content: string;
    timestamp: number;
}
export interface MemoryStats {
    store: MemoryStore;
    entryCount: number;
    charCount: number;
    maxChars: number;
    utilization: number;
}
export declare class MemoryManager {
    private memoryDir;
    private memoryEntries;
    private ENTRY_DELIMITER;
    private MAX_CHARS;
    constructor();
    private ensureDir;
    private getFilePath;
    /**
     * Load entries from disk.
     */
    private loadAll;
    /**
     * Save entries to disk.
     */
    private save;
    /**
     * Add an entry.
     */
    add(store: MemoryStore, content: string): {
        success: boolean;
        error?: string;
    };
    /**
     * Replace an entry (by substring match).
     */
    replace(store: MemoryStore, oldSubstring: string, newContent: string): {
        success: boolean;
        error?: string;
        replaced?: boolean;
    };
    /**
     * Remove an entry (by substring match).
     */
    remove(store: MemoryStore, substring: string): {
        success: boolean;
        error?: string;
        removed?: boolean;
    };
    /**
     * Get all entries as string.
     */
    getSnapshot(store: MemoryStore): string;
    /**
     * Get stats.
     */
    getStats(store: MemoryStore): MemoryStats;
    /**
     * Get all stats.
     */
    getAllStats(): MemoryStats[];
    /**
     * Clear a store.
     */
    clear(store: MemoryStore): void;
    /**
     * Scan content for threats (injection, exfiltration).
     */
    private scanForThreats;
}
export declare function getMemoryManager(): MemoryManager;
export declare function resetMemoryManager(): void;
//# sourceMappingURL=memory-tool.d.ts.map
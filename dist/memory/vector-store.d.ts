/**
 * VectorStore — A lightweight, JSON-based vector index with cosine similarity search.
 *
 * Stores embeddings as `{ id, vector, metadata }` entries in a single JSON file.
 * No external dependencies — uses only Node.js built-in fs and crypto.
 *
 * File location: ~/.buff/memory/vectors.json
 */
/** A single entry in the vector index */
export interface VectorEntry {
    /** Unique identifier for this entry */
    id: string;
    /** The embedding vector (array of numbers) */
    vector: number[];
    /** Arbitrary metadata for filtering/display */
    metadata: Record<string, unknown>;
    /** Timestamp when this entry was created */
    createdAt: number;
}
/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (higher = more similar).
 */
export declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * Lightweight vector store for semantic search.
 *
 * Usage:
 * ```ts
 * const store = new VectorStore();
 * await store.insert("traj-001", [0.1, 0.2, ...], { goal: "add auth" });
 * const results = await store.search([0.15, 0.25, ...], 3);
 * ```
 */
export declare class VectorStore {
    /**
     * Insert a vector entry into the index.
     * If an entry with the same `id` already exists, it is overwritten.
     */
    insert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
    /**
     * Retrieve a single entry by ID.
     */
    get(id: string): Promise<VectorEntry | null>;
    /**
     * Remove an entry from the index.
     */
    delete(id: string): Promise<boolean>;
    /**
     * Search for the top-k most similar entries to the query vector.
     * Returns results sorted by similarity (highest first).
     */
    search(queryVector: number[], k?: number, filterFn?: (entry: VectorEntry) => boolean): Promise<Array<{
        entry: VectorEntry;
        similarity: number;
    }>>;
    /**
     * Get the total number of stored entries.
     */
    count(): Promise<number>;
    /**
     * Clear all entries from the index.
     */
    clear(): Promise<void>;
    /**
     * Get all entries (for iteration/export).
     */
    getAll(): Promise<VectorEntry[]>;
    /**
     * Get vector store statistics.
     */
    stats(): {
        totalEntries: number;
        dimensions: number;
    };
}
export declare function getVectorStore(): VectorStore;
//# sourceMappingURL=vector-store.d.ts.map
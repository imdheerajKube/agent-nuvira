/**
 * VectorStore — pluggable vector index for semantic search.
 *
 * Stores embeddings as `{ id, vector, metadata }` entries in a JSON file
 * (~/.buff/memory/vectors.json, or vectors-<namespace>.json). No hard native
 * dependencies — uses only Node.js built-in fs and crypto.
 *
 * Backends (selected by `memory.vectorBackend` in config):
 *   - `json`  → JsonBackend: exact flat cosine scan (the original behavior).
 *   - `faiss` → a FAISS-style backend: pure-JS IVF-flat ANN by default
 *               (FaissIvfBackend, see faiss-backend.ts), or the real
 *               `@faiss-node/native` bindings when the user has installed and
 *               built them (best-effort native tier with graceful fallback).
 *   - `auto`  → FAISS-style backend when usable, JSON otherwise (default).
 *
 * The on-disk ENTRY format is identical across backends, so existing
 * memory/history/repo vectors survive upgrades AND backend switches.
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
/** A search result: entry + cosine similarity (1 = identical). */
export interface SearchResult {
    entry: VectorEntry;
    similarity: number;
}
/** Supported vector-backend identifiers. */
export type VectorBackendType = 'json' | 'faiss' | 'auto';
/** Backend contract — all store implementations share this surface. */
export interface VectorStoreBackend {
    /** Stable backend name for diagnostics (`json` | `faiss-ivf` | `faiss-native`). */
    readonly name: string;
    insert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
    get(id: string): Promise<VectorEntry | null>;
    delete(id: string): Promise<boolean>;
    search(queryVector: number[], k?: number, filterFn?: (entry: VectorEntry) => boolean): Promise<SearchResult[]>;
    count(): Promise<number>;
    clear(): Promise<void>;
    getAll(): Promise<VectorEntry[]>;
    /** Synchronous stats — callers (CLI) read this without awaiting. */
    stats(): {
        totalEntries: number;
        dimensions: number;
    };
}
/** Resolve the index file path for a namespace (default → vectors.json). */
export declare function indexPathFor(namespace: string): string;
/**
 * Synchronously read all entries for a namespace (used by backends' sync
 * `stats()` and by the FAISS-style backend to rebuild its in-memory index).
 * Returns an empty map when the file is missing/corrupt — never throws.
 */
export declare function readNamespaceEntries(namespace: string): Record<string, VectorEntry>;
/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (higher = more similar).
 */
export declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * Exact backend: linear scan with cosine similarity over the namespace index
 * file. This is the historical VectorStore behavior — deterministic, lossless,
 * and used for small indexes where exact search is cheapest.
 */
export declare class JsonBackend implements VectorStoreBackend {
    readonly name = "json";
    private namespace;
    constructor(namespace?: string);
    /** Resolve the index path per operation so `BUFF_MEMORY_DIR` changes (tests) take effect. */
    private get indexPath();
    insert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
    get(id: string): Promise<VectorEntry | null>;
    delete(id: string): Promise<boolean>;
    search(queryVector: number[], k?: number, filterFn?: (entry: VectorEntry) => boolean): Promise<SearchResult[]>;
    count(): Promise<number>;
    clear(): Promise<void>;
    getAll(): Promise<VectorEntry[]>;
    stats(): {
        totalEntries: number;
        dimensions: number;
    };
}
/**
 * Pluggable vector store for semantic search.
 *
 * Usage:
 * ```ts
 * const store = getVectorStore();            // config-selected backend
 * await store.insert("traj-001", [0.1, 0.2], { goal: "add auth" });
 * const results = await store.search([0.15, 0.25], 3);
 * ```
 *
 * Direct construction (`new VectorStore()`) defaults to the exact JSON backend
 * (backward compatible); `getVectorStore()` applies config-driven selection.
 */
export declare class VectorStore {
    private namespace;
    /** Explicit backend (direct construction) — null means resolve via config. */
    private explicitBackend;
    private backendPromise;
    constructor(namespace?: string, backend?: VectorStoreBackend);
    /** Lazily resolve the backend once (config-selected when not explicit). */
    private backend;
    /** Name of the active backend (`json` | `faiss-ivf` | `faiss-native`). */
    backendName(): Promise<string>;
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
    search(queryVector: number[], k?: number, filterFn?: (entry: VectorEntry) => boolean): Promise<SearchResult[]>;
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
     * Get vector store statistics (SYNCHRONOUS — reads the on-disk index file,
     * identical format across backends, so callers like the CLI can call it
     * without awaiting).
     */
    stats(): {
        totalEntries: number;
        dimensions: number;
    };
}
export declare function getVectorStore(namespace?: string, backend?: VectorStoreBackend): VectorStore;
/**
 * Force a backend type for tests (`'json' | 'faiss' | 'auto'`).
 * Also honored via the `BUFF_VECTOR_BACKEND` env var.
 */
export declare function setVectorBackendOverride(type: VectorBackendType | null): void;
/** Clear the backend-type override + cached backend instances. */
export declare function resetVectorBackendSelection(): void;
//# sourceMappingURL=vector-store.d.ts.map
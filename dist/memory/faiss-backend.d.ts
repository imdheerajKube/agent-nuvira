/**
 * FaissBackend — FAISS-style vector search for Agent-Nuvira.
 *
 * Two tiers, both behind the same `VectorStoreBackend` interface:
 *
 *   Tier 1 — native FAISS (`@faiss-node/native`, best-effort)
 *     Real Facebook FAISS bindings (IndexFlatIP). Only activated when the
 *     package is installed AND its native module built successfully; a smoke
 *     test at load time verifies usability. Every method is defensive and
 *     falls back to the pure-JS tier on any native error, so semantic search
 *     never breaks.
 *
 *   Tier 2 — pure-JS IVF-flat ANN (`FaissIvfBackend`, DEFAULT)
 *     A faithful TypeScript implementation of FAISS's `IndexIVFFlat`
 *     algorithm: nlist inverted lists with k-means++ centroids, nprobe probe
 *     lists per query, and cosine similarity computed as the inner product of
 *     L2-normalized vectors (the IndexFlatIP convention). Small indexes
 *     (≤ exactThreshold) use an exact scan so results are IDENTICAL to the
 *     JSON backend; large indexes get approximate sub-linear search.
 *
 * Persistence is the SHARED `vectors-<namespace>.json` entry format (same as
 * JsonBackend), so switching backends never loses data and existing vectors
 * survive upgrades.
 *
 * Why native FAISS is NOT a hard dependency (decision, documented):
 *   @faiss-node/native ships no prebuilt binaries and requires compiling
 *   FAISS from source (cmake + OpenBLAS + libomp) at install time — verified
 *   to fail on a stock macOS dev box. Making it a required dependency would
 *   break zero-setup `npx agent-nuvira` on most machines. The pure-JS
 *   IVF-flat backend provides FAISS-style approximate-NN behavior with zero
 *   native deps; users who install+build the native package automatically get
 *   the real thing.
 */
import type { VectorStoreBackend, VectorEntry, SearchResult } from './vector-store.js';
/** Default number of inverted lists (centroids) for IVF-flat. */
export declare const DEFAULT_NLIST = 16;
/** Default lists probed per query. */
export declare const DEFAULT_NPROBE = 4;
/**
 * Indexes at or below this many entries use an EXACT scan, guaranteeing
 * results identical to the JSON backend (small corpora — the common case for
 * a CLI — stay lossless; only large indexes go approximate).
 */
export declare const DEFAULT_EXACT_THRESHOLD = 512;
/** Options for the pure-JS IVF backend. */
export interface FaissIvfOptions {
    /** Number of inverted lists (centroids). Default: 16. */
    nlist?: number;
    /** Lists probed per query. Default: 4. */
    nprobe?: number;
    /** Below this entry count, search exactly. Default: 512. */
    exactThreshold?: number;
    /** Deterministic k-means++ seed (tests rely on reproducibility). */
    seed?: number;
}
/**
 * FAISS `IndexIVFFlat` reimplemented in pure TypeScript.
 *
 * Structure: nlist centroids (k-means++) partition entries into inverted
 * lists. A query normalizes, ranks centroids by inner product, probes the
 * top-nprobe lists, and scores candidates by cosine similarity. Filter-aware:
 * if the filter leaves fewer than k candidates, nprobe expands up to nlist
 * (guaranteeing the same results as exact search when the filter is sparse).
 */
export declare class FaissIvfBackend implements VectorStoreBackend {
    readonly name = "faiss-ivf";
    private namespace;
    private nlist;
    private nprobe;
    private exactThreshold;
    private seed;
    /** Lazy-loaded entries (source of truth is the shared JSON file). */
    private entries;
    /** True when the in-memory IVF index must be rebuilt from entries. */
    private dirty;
    /** Normalized centroids (nlist × dim). */
    private centroids;
    /** Inverted lists: centroid index → entry ids. */
    private lists;
    /** Entry ids with zero vectors (cannot be assigned to a centroid). */
    private unassigned;
    private dim;
    constructor(namespace?: string, opts?: FaissIvfOptions);
    /** Resolve the index path per operation so `NUVIRA_MEMORY_DIR` changes (tests) take effect. */
    private get indexPath();
    private ensureLoaded;
    private persist;
    private rebuildIndex;
    /** Index of the centroid nearest to `vector` (by cosine / normalized IP). */
    private nearestCentroid;
    insert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
    get(id: string): Promise<VectorEntry | null>;
    delete(id: string): Promise<boolean>;
    search(queryVector: number[], k?: number, filterFn?: (entry: VectorEntry) => boolean): Promise<SearchResult[]>;
    /** Exact linear scan with cosine similarity (parity with JsonBackend). */
    private exactSearch;
    /** IVF-flat approximate search with filter-aware probe expansion. */
    private ivfSearch;
    count(): Promise<number>;
    clear(): Promise<void>;
    getAll(): Promise<VectorEntry[]>;
    stats(): {
        totalEntries: number;
        dimensions: number;
    };
}
/**
 * Wrap real FAISS bindings (IndexFlatIP) behind the same backend interface.
 * Native failures are caught per method and fall back to the pure-JS IVF
 * backend, so a broken native build can never break semantic search.
 */
export declare class NativeFaissBackend implements VectorStoreBackend {
    readonly name = "faiss-native";
    private namespace;
    private fallback;
    private faiss;
    private nativeIndex;
    private idToNative;
    private nativeToId;
    private nextId;
    constructor(namespace: string, faissModule: unknown);
    /**
     * Rebuild the native FLAT_IP index from the shared entries file.
     *
     * `@faiss-node/native` v0.1.11 exposes a `FaissIndex` class configured with
     * `{ type: 'FLAT_IP', dims }` (NOT the raw `IndexFlatIP`). Vectors are
     * L2-normalized before add, so FAISS's inner-product distance equals cosine
     * similarity (higher = more similar).
     */
    private rebuildNative;
    /** Dispose the native index (frees C++ memory); safe when null. */
    private disposeNative;
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
/** Result of a native-FAISS availability check. */
export interface NativeFaissCheck {
    /** Whether the native @faiss-node/native module is installed AND usable. */
    available: boolean;
    /** Human-readable reason (why it's available / why it fell back). */
    reason: string;
}
/**
 * Check whether native FAISS is actually usable on this machine.
 * Used by `nuvira memory backend --check` for diagnostics.
 */
export declare function checkNativeFaiss(): Promise<NativeFaissCheck>;
/**
 * Create the best available FAISS-style backend for a namespace:
 * native FAISS when installed+buildable, otherwise the pure-JS IVF-flat
 * backend. Never throws — the caller can always fall back to JsonBackend.
 */
export declare function createFaissBackend(namespace: string): Promise<VectorStoreBackend>;
//# sourceMappingURL=faiss-backend.d.ts.map
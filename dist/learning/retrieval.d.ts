/**
 * RetrievalEngine — vectorization layer for Agent-Nuvira.
 *
 * Turns large code/doc context into token-efficient, semantically-relevant
 * context using a local embedding model + the pure-JS VectorStore (cosine
 * similarity, JSON-persisted, honors NUVIRA_MEMORY_DIR). This complements the
 * quota ledger: retrieval SAVES tokens (so free quotas stretch further),
 * the ledger MANAGES quotas.
 *
 * Flow (mirrors the assessment's 6-step plan):
 *   1. Chunking   — split large files into ~512-token chunks (with overlap)
 *   2. Indexing   — embed each chunk (bge-small-en-v1.5, 384-dim) into the
 *                   'repo' VectorStore namespace
 *   3. Query      — embed the user goal/subtask
 *   4. Retrieval  — top-k cosine search over the repo index
 *   5. Assembly   — concatenate retrieved chunks → reduced context
 *   6. Router hook— simple tasks go direct; large tasks embed+retrieve;
 *                   quota optimization = token reduction; failover = full
 *                   context fallback when retrieval fails.
 *
 * Every reduction is logged ("Retrieved 5 chunks — context 20k → 3k tokens")
 * and persisted to retrieval-stats.json for the dashboard + `nuvira retrieval`.
 */
import type { ConfigManager } from '../config/manager.js';
import type { LLMCallFn } from '../agents/agent.js';
/** Default chunk size (tokens). */
export declare const DEFAULT_CHUNK_TOKENS = 512;
/** Overlap between adjacent chunks (tokens) — preserves boundary context. */
export declare const DEFAULT_OVERLAP_TOKENS = 64;
/** Default top-k chunks to retrieve. */
export declare const DEFAULT_TOP_K = 5;
/**
 * Default context threshold (tokens). Contexts SMALLER than this go straight
 * to the LLM (no embedding cost — simple tasks → direct call). Contexts
 * LARGER than this are vectorized (embed + retrieve → reduced context).
 */
export declare const DEFAULT_THRESHOLD_TOKENS = 12000;
/** Retrieval VectorStore namespace (kept separate from memory/history vectors). */
export declare const REPO_NAMESPACE = "repo";
/** Stats file for token-savings transparency (dashboard + CLI). */
export declare const RETRIEVAL_STATS_FILE = "retrieval-stats.json";
/** Router-facing options for the retrieval hook. */
export interface RetrievalOptions {
    /** Master switch (default true — cheap for small contexts, big win for large). */
    enabled?: boolean;
    /** Top-k chunks to retrieve (default 5). */
    topK?: number;
    /** Chunk size in tokens (default 512). */
    chunkTokens?: number;
    /** Overlap in tokens (default 64). */
    overlapTokens?: number;
    /** Contexts above this token count are vectorized (default 12k). */
    thresholdTokens?: number;
    /** Embedding model override (default bge-small-en-v1.5). */
    model?: string;
    /** Optional LLM call function — only needed if the embedder falls back to LLM tier. */
    callLLM?: LLMCallFn;
}
/** One indexed chunk. */
export interface RetrievalChunk {
    /** Stable id: `<filePath>#<chunkIndex>`. */
    id: string;
    filePath: string;
    chunkIndex: number;
    text: string;
    tokenCount: number;
}
/** A retrieval hit with similarity. */
export interface RetrievalHit {
    chunk: RetrievalChunk;
    similarity: number;
}
/** Per-call token-savings stats (transparency + quota optimization). */
export interface RetrievalStats {
    /** Whether retrieval was actually used (context was large enough). */
    used: boolean;
    /** Full context tokens BEFORE reduction. */
    originalTokens: number;
    /** Context tokens AFTER reduction (or original when not used). */
    reducedTokens: number;
    /** originalTokens - reducedTokens. */
    savedTokens: number;
    /** Percentage reduction (0-100). */
    pctReduced: number;
    /** Number of chunks retrieved (0 when not used). */
    chunksRetrieved: number;
    /** Retrieval failed → fell back to full context (never breaks the call). */
    failover: boolean;
    /** Top-k hits (file + similarity) for transparency. */
    hits: Array<{
        filePath: string;
        similarity: number;
    }>;
    timestamp: number;
}
/** Result of assembleContext — reduced (or unchanged) context + stats. */
export interface AssembledContext {
    context: string;
    stats: RetrievalStats;
}
/** Persisted aggregate stats (dashboard + CLI). */
export interface RetrievalAggregateStats {
    totalCalls: number;
    totalRetrievals: number;
    totalFailovers: number;
    totalOriginalTokens: number;
    totalReducedTokens: number;
    totalSavedTokens: number;
    avgPctReduced: number;
    lastCall?: RetrievalStats;
    recent: RetrievalStats[];
    updatedAt: number;
}
/** Estimate token count from text length (~4 chars/token). */
export declare function estimateTokens(text: string): number;
/**
 * Split text into overlapping chunks of ~chunkTokens. Chunk boundaries prefer
 * paragraph breaks, then line breaks, and finally hard-split on character
 * count (so code files with no blank lines still chunk deterministically).
 * Each chunk carries a stable id (`<label>#<i>`) so re-indexing overwrites
 * the same entries instead of duplicating.
 */
export declare function chunkText(text: string, label: string, chunkTokens?: number, overlapTokens?: number): RetrievalChunk[];
/**
 * Read a file, chunk it, embed each chunk, and store it in the repo index.
 * Idempotent per chunk id — re-indexing a changed file overwrites its chunks.
 * Returns the number of chunks indexed.
 */
export declare function indexFile(filePath: string, opts?: RetrievalOptions): Promise<number>;
/**
 * Index a list of files (best-effort per file — a missing/unreadable file is
 * skipped, never thrown). Returns { files, chunks }.
 */
export declare function indexFiles(filePaths: string[], opts?: RetrievalOptions): Promise<{
    files: number;
    chunks: number;
}>;
/**
 * Embed the query and return the top-k most similar repo chunks.
 * Throws on embed failure — callers decide whether to fail over.
 */
export declare function retrieve(query: string, opts?: RetrievalOptions): Promise<RetrievalHit[]>;
/**
 * Assemble context for a task/goal with retrieval-aware token reduction.
 *
 * Router policy:
 *   - retrieval disabled OR context ≤ threshold → direct call (no embedding,
 *     zero overhead — simple tasks go straight to the LLM).
 *   - context > threshold → index files (idempotent) + retrieve top-k +
 *     assemble reduced context.
 *   - any retrieval failure → FAIL OVER to the full context unchanged
 *     (never break the LLM call on a retrieval error).
 *
 * @param query        The user goal / subtask description
 * @param filePaths    Files to consider as context (already gathered)
 * @param rawContext   The full context string those files represent (or null
 *                     to rebuild from filePaths)
 * @param opts         Retrieval options
 * @returns Assembled (possibly reduced) context + per-call stats
 */
export declare function assembleContext(query: string, filePaths: string[], rawContext?: string | null, opts?: RetrievalOptions): Promise<AssembledContext>;
/** Append a call's stats to the aggregate retrieval-stats file (best-effort). */
export declare function recordRetrievalStats(stats: RetrievalStats): void;
/** Read the aggregate retrieval stats (empty default when missing/corrupt). */
export declare function readRetrievalAggregateStats(): RetrievalAggregateStats;
/**
 * Clear retrieval stats + the repo index (used by `nuvira retrieval clear`).
 * ASYNC: the VectorStore facade lazily resolves its backend, so the clear must
 * be awaited to guarantee the on-disk index is wiped before callers check it.
 */
export declare function clearRetrievalState(): Promise<void>;
/** Resolve retrieval options from config (routing.retrieval). */
export declare function retrievalOptionsFromConfig(configManager: ConfigManager | undefined, overrides?: RetrievalOptions): RetrievalOptions;
//# sourceMappingURL=retrieval.d.ts.map
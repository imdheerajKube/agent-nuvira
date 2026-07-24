/**
 * Embedder — Generates vector embeddings from text using a tiered approach.
 *
 * Embedding Tier Strategy:
 *   Tier 1: @huggingface/transformers (fast, local, 384-dim) — DEFAULT
 *   Tier 2: Python sentence-transformers via subprocess
 *   Tier 3: LLM-based (any configured InferenceProvider) — FALLBACK
 *
 * The embedder auto-selects the best available tier, caches results to avoid
 * redundant computation, and gracefully degrades when tiers are unavailable.
 *
 * Dimensionality: 384 (all-MiniLM-L6-v2 default) — 6x more expressive than
 * the previous 64-dim LLM-based embeddings while being 10x faster and free.
 */
import type { LLMCallFn } from '../agents/agent.js';
/** Dimensionality of the generated embeddings (all-MiniLM-L6-v2 default) */
export declare const EMBEDDING_DIM = 384;
/**
 * Generate a vector embedding for the given text.
 *
 * Uses a tiered approach:
 *   1. @huggingface/transformers (fast local embeddings) — preferred
 *   2. Python sentence-transformers via subprocess
 *   3. LLM-based embedding (requires callLLM function) — fallback
 *
 * @param text          The text to embed (e.g., a user goal or task description)
 * @param callLLM       Optional LLM call function (only needed for Tier 3 fallback)
 * @param forceLLM      If true, skip native tiers and use LLM directly (useful for testing)
 * @returns             A promise that resolves to a number[] embedding vector (384-dim)
 */
export declare function embed(text: string, callLLM?: LLMCallFn, forceLLM?: boolean): Promise<number[]>;
/**
 * Reset the tier availability cache.
 * Call this when the environment changes (e.g., user installs a package)
 * or in test setup to force re-detection.
 */
export declare function resetEmbeddingTierCache(): void;
/**
 * Set the force-LLM mode for testing.
 * When called with force=true, all native embedding tiers are disabled
 * and only the LLM-based fallback (Tier 3) is used.
 */
export declare function setForceLLM(force: boolean): void;
/**
 * Check if @huggingface/transformers is available.
 * This is a lightweight check that doesn't load the model.
 */
export declare function isXenovaAvailable(): Promise<boolean>;
/**
 * Check if Python sentence-transformers is available.
 */
export declare function isPythonAvailable(): Promise<boolean>;
/**
 * Get the name of the currently active embedding tier.
 */
export declare function getActiveEmbeddingTier(): Promise<string>;
/**
 * Clear the in-memory embedding cache.
 */
export declare function clearEmbeddingCache(): void;
/**
 * Get the current size of the embedding cache.
 */
export declare function embeddingCacheSize(): number;
//# sourceMappingURL=embedder.d.ts.map
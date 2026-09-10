/**
 * Semantic intent matcher — embedding-based recall tier for the intent router.
 *
 * Tier-1 of the 3-tier design (deterministic → semantic → ask_user):
 * the deterministic matcher (src/commands/intent-router.ts) requires the
 * actual words to appear; this tier finds intents by MEANING, so novel
 * phrasings ("terminate the bot", "bounce the UI", "shut down that web thing
 * on 3030") resolve without adding a new alias to the JSON manifest.
 *
 * Design:
 *   - Pure JS + the existing local embedder (`embed()` in src/memory/embedder.ts)
 *     and `cosineSimilarity` — NO FAISS, no native deps, no network at query
 *     time. The alias corpus (~85 intents × a few aliases) is tiny, so a flat
 *     cosine scan over cached alias vectors is sub-ms once the model is loaded.
 *   - Aliases are embedded lazily and cached in-process; the model load
 *     happens once per process (same pattern as src/learning/retrieval.ts).
 *   - Embedding tiers degrade gracefully (Xenova → Python → LLM → zero vector),
 *     so a machine without any embedding backend still returns a ranking
 *     (zero vector ⇒ similarity 0 ⇒ treated as "no semantic signal").
 *
 * This module is deliberately a RECALL tier: it does NOT replace entity
 * extraction, ambiguity handling, or the confirmation/RBAC flags — those stay
 * in the deterministic matcher. The CLI surfaces both side-by-side
 * (`nuvira intent resolve --semantic`) so the semantic tier can be measured
 * against the deterministic one before it ever gates execution.
 */
/** A semantic match — one alias whose embedding is closest to the ask. */
export interface SemanticMatch {
    intent: string;
    summary: string;
    command?: string;
    example?: string;
    /** The exact alias that matched (for debugging/audit). */
    matchedAlias: string;
    /** Cosine similarity (1 = identical meaning). */
    similarity: number;
}
/** Options for semanticResolve — tests inject a fake embedFn. */
export interface SemanticResolveOptions {
    /** Max matches to return (default 3). */
    topK?: number;
    /** Cosine floor below which matches are dropped (default 0.30). */
    minSimilarity?: number;
    /** Embedding function override (tests inject a deterministic stub). */
    embedFn?: (text: string) => Promise<number[]>;
    /** Embedding model override (defaults to the embedder's own default). */
    model?: string;
}
/**
 * Rank manifest intents by embedding similarity to the ask.
 *
 * Pure JS flat cosine over the alias corpus — appropriate because the corpus
 * is small (hundreds of entries). Returns top-K matches above the floor,
 * best-first. Never throws: an empty result just means "no semantic signal".
 */
export declare function semanticResolve(ask: string, opts?: SemanticResolveOptions): Promise<SemanticMatch[]>;
/** Testing + diagnostics: how many aliases are in the corpus. */
export declare function aliasCorpusSize(): number;
//# sourceMappingURL=semantic-intent.d.ts.map
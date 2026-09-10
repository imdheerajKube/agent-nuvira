/**
 * FactStore — Fact & preference memory (Phase B1).
 *
 * Stores durable, project-scoped facts and user preferences extracted from
 * conversations and executions, retrievable semantically across sessions.
 *
 * Design (mirrors the plan's B1 spec, reusing what already exists):
 * - Reuses `embed()` (embedder.ts) + `VectorStore` (vector-store.ts, FAISS
 *   backend) in a DEDICATED `facts` namespace — no new dependency, and fact
 *   vectors never mix with trajectory vectors.
 * - Each fact is a vector entry with metadata
 *   `{ kind:'fact', projectId, agentRole, timestamp, tags, source, text }` so
 *   retrieval filters by project (the A2 projectId) and time range — the
 *   temporal-filter gap the existing stores don't cover.
 * - `extractFactsFromTurn` distills facts from a chat/execution turn: ONE LLM
 *   JSON call (the router-selected cheap model — caller passes `callLLM`) with
 *   a deterministic rule fallback when the LLM path is unavailable.
 * - Dedupe by cosine similarity (near-duplicate facts are not re-added).
 * - Per-project budget + 180-day expiry (expired facts are pruned, never
 *   surfaced).
 *
 * File location: facts live in the vector index namespace `facts`
 * (`~/.nuvira/memory/vectors-facts.json`).
 */
import type { LLMCallFn } from '../agents/agent.js';
/** A fact to be stored. */
export interface FactInput {
    /** The fact text (self-contained, durable). */
    text: string;
    /** Optional domain tags (e.g. ['typescript', 'auth']). */
    tags?: string[];
    /** Optional provenance (e.g. 'chat', 'execution', 'manual'). */
    source?: string;
    /** Which agent observed this (e.g. 'planner', 'writer'). */
    agentRole?: string;
}
/** A stored fact (returned by retrieval/list). */
export interface StoredFact {
    id: string;
    text: string;
    projectId: string;
    agentRole: string;
    tags: string[];
    source: string;
    /** Epoch ms when the fact was stored. */
    timestamp: number;
}
/** Time-range filter for retrieval (epoch ms). */
export interface FactTimeRange {
    start?: number;
    end?: number;
}
/** Options for retrieveFacts. */
export interface FactRetrievalOptions {
    /** Max results (default 5). */
    k?: number;
    /** Restrict to a time range (overrides the default 180-day freshness). */
    timeRange?: FactTimeRange;
    /** Minimum cosine similarity to return (default 0.3). */
    minSimilarity?: number;
}
/** Facts older than this are expired (pruned, never surfaced). */
export declare const FACT_TTL_MS: number;
/** Max facts per project (oldest pruned when exceeded). */
export declare const MAX_FACTS_PER_PROJECT = 200;
/** Near-duplicate threshold: a fact within this cosine is NOT re-added. */
export declare const DEDUPE_COSINE_THRESHOLD = 0.92;
export declare class FactStore {
    private namespace;
    private ttlMs;
    private maxPerProject;
    private dedupeThreshold;
    constructor(opts?: {
        ttlMs?: number;
        maxPerProject?: number;
        dedupeThreshold?: number;
    });
    /**
     * Store a fact for a project: embed the text, dedupe by cosine against the
     * project's existing facts, then insert into the `facts` vector namespace.
     * Returns the fact id, or null when it was a near-duplicate (not re-added).
     * Best-effort — never throws (a failed embed/insert is a no-op).
     */
    addFact(projectId: string, input: FactInput, callLLM?: LLMCallFn): Promise<string | null>;
    /** Store multiple facts for a project (best-effort; returns stored count). */
    addFacts(projectId: string, facts: FactInput[], callLLM?: LLMCallFn): Promise<number>;
    /**
     * Distill durable facts from a conversation turn via ONE LLM JSON call with
     * a deterministic rule fallback. Returns the number of facts stored.
     * Never throws — any failure falls back to the rules (or a 0).
     */
    extractFactsFromTurn(projectId: string, turn: {
        userText: string;
        assistantText?: string;
        source?: string;
        agentRole?: string;
    }, callLLM?: LLMCallFn): Promise<number>;
    /**
     * Retrieve the top-k facts for a project most similar to the query.
     * Filters by projectId (metadata) and, unless an explicit timeRange is given,
     * drops facts older than the freshness window (180 days) — the temporal
     * filter the other stores lack. Best-effort — never throws.
     */
    retrieveFacts(projectId: string, query: string, callLLM?: LLMCallFn, opts?: FactRetrievalOptions): Promise<StoredFact[]>;
    /** List all facts for a project (or all projects), newest first. */
    listFacts(projectId?: string): Promise<StoredFact[]>;
    /**
     * Format retrieved facts as a prompt block for planner/chat injection.
     * Returns '' when there is nothing to inject.
     */
    formatAsPrompt(facts: StoredFact[]): string;
    /** Basic stats (for `nuvira memory facts` / doctor). */
    stats(): Promise<{
        total: number;
        byProject: Record<string, number>;
    }>;
    /**
     * Prune facts older than the TTL. Returns how many were removed.
     */
    expireFacts(): Promise<number>;
    /** Remove one fact by id. Returns true when deleted. */
    removeFact(id: string): Promise<boolean>;
    /** Clear all facts (all projects). */
    clear(): Promise<void>;
    /**
     * Deterministic fact extraction used when the LLM path is unavailable and as
     * the base for LLM enrichment. Exported for testing.
     */
    ruleExtractFacts(userText: string, assistantText: string): string[];
    private metadataToFact;
    private parseFactArray;
}
export declare function getFactStore(): FactStore;
/** Reset the singleton (test isolation). */
export declare function resetFactStore(): void;
//# sourceMappingURL=fact-store.d.ts.map
/**
 * MLRouter — task-similarity learned routing (ruflo neural-router analog).
 *
 * Where the Thompson-sampling bandit learns per PROVIDER × COMPLEXITY-BUCKET,
 * the ML router learns per TASK FEATURES: "tasks that LOOK like this task
 * succeeded on provider X". It hashes the task text (plus complexity and
 * intent) into a fixed-dimension sparse vector, stores every real outcome as
 * a feature vector, and at resolve time finds the k most similar past tasks
 * (cosine similarity), then derives a per-provider empirical win rate among
 * those neighbors.
 *
 * This generalizes across complexity buckets using text similarity — the
 * exact capability ruflo's KNN/FastGRNN neural-router provides — without any
 * external ML dependency (pure hashing + cosine, sub-ms at reasonable record
 * counts, fully offline).
 *
 * Design rules (mirror the bandit's conservatism):
 * - COLD START IS NEUTRAL: no data → learned factor 1.0 (deterministic).
 * - MIN-SAMPLES GUARD: a provider needs >= minSamples neighbors before its
 *   win rate counts; below that the factor stays 1.0.
 * - STRENGTH-CLAMPED: factor = 1 + mlStrength × (winRate − 0.5), so a raw
 *   win rate can only nudge the deterministic score by ±50% × strength
 *   (default strength 0.5 → ±25%). It can never overturn a large
 *   deterministic advantage on its own.
 * - OPT-IN: enabled only when `routing.mlRouter` is true (feature-shipped,
 *   off by default — "off-by-default for anything risky").
 *
 * Persistence: `~/.buff/memory/ml-router.jsonl` (honors BUFF_MEMORY_DIR),
 * append-only, capped at MAX_RECORDS (oldest trimmed).
 */
import type { BanditOutcome } from './router-bandit.js';
/** Feature vector dimension (hash buckets). Intent/complexity add more. */
export declare const FEATURE_DIMS = 256;
/** Cap on persisted records (oldest trimmed). */
export declare const MAX_RECORDS = 5000;
/** Default k nearest neighbors. */
export declare const DEFAULT_ML_K = 8;
/** Default minimum neighbor samples before a provider's factor counts. */
export declare const DEFAULT_ML_MIN_SAMPLES = 5;
/** Default blend strength: factor = 1 + strength × (winRate − 0.5). */
export declare const DEFAULT_ML_STRENGTH = 0.5;
/** One persisted learned decision. */
export interface MLRecord {
    /** Feature vector (hash-bucket indices with a 1). */
    features: number[];
    provider: string;
    model: string;
    outcome: BanditOutcome;
    /** 1 = cheapest (used to weight cheap wins slightly higher). */
    costScore: number;
    agentType: string;
    complexity: string;
    intent: string;
    ts: number;
}
/** Learned score for one provider from similar past tasks. */
export interface LearnedScore {
    provider: string;
    /** Empirical win rate among the k nearest neighbors (0–1). */
    winRate: number;
    /** Number of neighbor records for this provider (>= minSamples to count). */
    samples: number;
    /** The learned multiplier: 1 + strength × (winRate − 0.5). 1.0 = neutral. */
    factor: number;
    /** Whether the factor is trustworthy (samples >= minSamples). */
    trusted: boolean;
}
/**
 * Extract a sparse binary feature vector from a task: hashed word tokens
 * (lowercased, non-alnum stripped) into FEATURE_DIMS buckets, plus a
 * TAIL_DIMS one-hot tail hashing complexity and intent so the similarity
 * signal carries the same bucketing the bandit learns by.
 */
export declare function extractFeatures(task: string, complexity?: string, intent?: string): number[];
/** Cosine similarity between two sparse binary feature vectors. */
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare class MLRouter {
    /** In-memory record cache (persisted on write). */
    private records;
    constructor();
    private load;
    private save;
    /** Number of persisted records (diagnostics). */
    size(): number;
    /** Records for diagnostics (newest last). */
    all(): MLRecord[];
    /** Wipe all learned state (CLI escape hatch). */
    reset(): void;
    /**
     * Record a real outcome as a feature vector. Called by the router's
     * recordOutcome() alongside the bandit — one learning pipeline, two views
     * (per-bucket bandit + per-task-feature ML).
     */
    record(task: string, provider: string, model: string, outcome: BanditOutcome, costScore: number, agentType: string, complexity?: string, intent?: string): void;
    /**
     * Compute the learned factor for EVERY candidate provider from the k most
     * similar past tasks. Cold start / no neighbors → all factors 1.0.
     */
    learnedScores(task: string, providers: string[], opts?: {
        k?: number;
        minSamples?: number;
        strength?: number;
        complexity?: string;
        intent?: string;
    }): Map<string, LearnedScore>;
}
export declare function getMlRouter(): MLRouter;
export declare function resetMlRouter(): void;
//# sourceMappingURL=ml-router.d.ts.map
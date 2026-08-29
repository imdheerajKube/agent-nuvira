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
 * Persistence: `~/.nuvira/memory/ml-router.jsonl` (honors NUVIRA_MEMORY_DIR),
 * append-only, capped at MAX_RECORDS (oldest trimmed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { dirname, join } from 'node:path';
// ─── Constants ─────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');
/** Feature vector dimension (hash buckets). Intent/complexity add more. */
export const FEATURE_DIMS = 256;
/** Buckets reserved for the intent + complexity one-hot tail. */
const TAIL_DIMS = 64;
/** Cap on persisted records (oldest trimmed). */
export const MAX_RECORDS = 5000;
/** Default k nearest neighbors. */
export const DEFAULT_ML_K = 8;
/** Default minimum neighbor samples before a provider's factor counts. */
export const DEFAULT_ML_MIN_SAMPLES = 5;
/** Default blend strength: factor = 1 + strength × (winRate − 0.5). */
export const DEFAULT_ML_STRENGTH = 0.5;
function memoryPath() {
    return join(envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR, 'ml-router.jsonl');
}
// ─── Hashing helpers ────────────────────────────────────────────────────────
/** FNV-1a 32-bit hash (stable across runs — deterministic features). */
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/**
 * Extract a sparse binary feature vector from a task: hashed word tokens
 * (lowercased, non-alnum stripped) into FEATURE_DIMS buckets, plus a
 * TAIL_DIMS one-hot tail hashing complexity and intent so the similarity
 * signal carries the same bucketing the bandit learns by.
 */
export function extractFeatures(task, complexity = '', intent = '') {
    const buckets = new Set();
    const tokens = task.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
    for (const tok of tokens) {
        if (tok.length < 3)
            continue; // skip 1–2 char noise
        buckets.add(fnv1a(tok) % FEATURE_DIMS);
    }
    if (complexity)
        buckets.add(FEATURE_DIMS + (fnv1a(complexity) % TAIL_DIMS));
    if (intent)
        buckets.add(FEATURE_DIMS + TAIL_DIMS + (fnv1a(intent) % TAIL_DIMS));
    return [...buckets];
}
/** Cosine similarity between two sparse binary feature vectors. */
export function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length === 0)
        return 0;
    const setB = new Set(b);
    let inter = 0;
    for (const idx of a)
        if (setB.has(idx))
            inter++;
    return inter / Math.sqrt(a.length * b.length);
}
// ─── MLRouter ──────────────────────────────────────────────────────────────
export class MLRouter {
    /** In-memory record cache (persisted on write). */
    records = [];
    constructor() {
        this.load();
    }
    load() {
        try {
            const p = memoryPath();
            if (!existsSync(p))
                return;
            const lines = readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim() !== '');
            // Keep the newest MAX_RECORDS.
            this.records = lines.slice(-MAX_RECORDS).map((l) => JSON.parse(l));
        }
        catch {
            this.records = [];
        }
    }
    save() {
        try {
            const p = memoryPath();
            mkdirSync(dirname(p), { recursive: true });
            const lines = this.records.slice(-MAX_RECORDS).map((r) => JSON.stringify(r));
            writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
        }
        catch {
            // Best-effort — persistence must never break routing.
        }
    }
    /** Number of persisted records (diagnostics). */
    size() {
        return this.records.length;
    }
    /** Records for diagnostics (newest last). */
    all() {
        return [...this.records];
    }
    /** Wipe all learned state (CLI escape hatch). */
    reset() {
        this.records = [];
        try {
            writeFileSync(memoryPath(), '', 'utf-8');
        }
        catch {
            // Best-effort.
        }
    }
    /**
     * Record a real outcome as a feature vector. Called by the router's
     * recordOutcome() alongside the bandit — one learning pipeline, two views
     * (per-bucket bandit + per-task-feature ML).
     */
    record(task, provider, model, outcome, costScore, agentType, complexity = '', intent = '') {
        try {
            this.records.push({
                features: extractFeatures(task, complexity, intent),
                provider,
                model,
                outcome,
                costScore,
                agentType,
                complexity,
                intent,
                ts: Date.now(),
            });
            if (this.records.length > MAX_RECORDS) {
                this.records = this.records.slice(-MAX_RECORDS);
            }
            this.save();
        }
        catch {
            // Best-effort — a record write must never break outcome handling.
        }
    }
    /**
     * Compute the learned factor for EVERY candidate provider from the k most
     * similar past tasks. Cold start / no neighbors → all factors 1.0.
     */
    learnedScores(task, providers, opts = {}) {
        const k = opts.k ?? DEFAULT_ML_K;
        const minSamples = opts.minSamples ?? DEFAULT_ML_MIN_SAMPLES;
        const strength = opts.strength ?? DEFAULT_ML_STRENGTH;
        const result = new Map();
        if (this.records.length === 0) {
            for (const p of providers) {
                result.set(p, { provider: p, winRate: 0.5, samples: 0, factor: 1, trusted: false });
            }
            return result;
        }
        const query = extractFeatures(task, opts.complexity, opts.intent);
        // Score every record by similarity, keep the top-k.
        const scored = this.records
            .map((r) => ({ rec: r, sim: cosineSimilarity(query, r.features) }))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, k);
        for (const provider of providers) {
            const neighbors = scored.filter((s) => s.rec.provider === provider);
            const samples = neighbors.length;
            if (samples === 0 || samples < minSamples) {
                result.set(provider, { provider, winRate: 0.5, samples, factor: 1, trusted: false });
                continue;
            }
            // Similarity-weighted win rate. 'escalated' counts as a half-win (the
            // provider succeeded at a harder-than-planned tier) — same convention
            // as the bandit's cost-adjusted reward.
            let winSum = 0;
            let simSum = 0;
            for (const { rec, sim } of neighbors) {
                const w = rec.outcome === 'success' ? 1 : rec.outcome === 'escalated' ? 0.5 : 0;
                winSum += sim * w;
                simSum += sim;
            }
            const winRate = simSum > 0 ? winSum / simSum : 0.5;
            const factor = 1 + strength * (winRate - 0.5);
            result.set(provider, { provider, winRate, samples, factor, trusted: true });
        }
        return result;
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let mlRouterInstance = null;
export function getMlRouter() {
    if (!mlRouterInstance)
        mlRouterInstance = new MLRouter();
    return mlRouterInstance;
}
export function resetMlRouter() {
    mlRouterInstance = null;
}
//# sourceMappingURL=ml-router.js.map
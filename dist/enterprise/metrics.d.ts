/**
 * K2 — Runtime metrics (counters + timers, JSON persistence).
 *
 * Lightweight, dependency-free counters and timers for the operational
 * surfaces the plan scoped: latency budgets (rule-vs-LLM), memory
 * hits/misses, and vault access. Persisted as `metrics.json` in the memory
 * dir (`NUVIRA_MEMORY_DIR` override honored for test hermeticity) and surfaced
 * by `nuvira doctor` (and the dashboard via the same file).
 *
 * Design:
 * - No new dependency (the plan explicitly says "counters/timers (no new dep)").
 * - Writes are batched/lazy: increments update an in-memory map; `save()` is
 *   called explicitly (end of a run, or `nuvira doctor`) so hot loops never
 *   touch disk.
 * - Never throws: a failed write degrades to an in-memory-only session.
 * - Concurrency note: `metrics.json` is a snapshot file (last-writer-wins).
 *   Two processes running at once (chat + gateway) can clobber each other's
 *   counters on save — acceptable for a lightweight store; a merge-on-save
 *   would be the upgrade if it ever matters.
 */
export interface MetricsData {
    version: number;
    counters: Record<string, number>;
    /** name → { count, totalMs, maxMs } — for avg/max latency budgets. */
    timers: Record<string, {
        count: number;
        totalMs: number;
        maxMs: number;
    }>;
    updatedAt: number;
}
export interface MetricsSnapshot {
    counters: Record<string, number>;
    timers: Record<string, {
        count: number;
        avgMs: number;
        maxMs: number;
    }>;
    updatedAt: number;
}
declare class MetricsStore {
    private counters;
    private timers;
    private loaded;
    /** Load persisted metrics (idempotent; missing/corrupt file → empty). */
    private ensureLoaded;
    /** Increment a named counter by 1 (or by `by`). */
    increment(name: string, by?: number): void;
    /** Record one timer observation (ms). */
    record(name: string, ms: number): void;
    /** Time a synchronous function, recording `name` with its duration. */
    timeSync<T>(name: string, fn: () => T): T;
    /** Time an async function, recording `name` with its duration. */
    time<T>(name: string, fn: () => Promise<T>): Promise<T>;
    /** Snapshot the current state without touching disk. */
    snapshot(): MetricsSnapshot;
    /** Persist to disk (best-effort — never throws). */
    save(): void;
    /** Reset to empty (test isolation). */
    reset(): void;
}
/** Get the shared metrics store. */
export declare function getMetrics(): MetricsStore;
/** Reset the singleton (test isolation). */
export declare function resetMetrics(): void;
/** Increment a counter (e.g. `memory.hits`, `vault.reads`). */
export declare function countMetric(name: string, by?: number): void;
/** Time a synchronous function and record its duration under `name`. */
export declare function recordMetricTime<T>(name: string, fn: () => T): T;
export {};
//# sourceMappingURL=metrics.d.ts.map
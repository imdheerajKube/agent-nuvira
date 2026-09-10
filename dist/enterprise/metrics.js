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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
// ─── Storage ────────────────────────────────────────────────────────────────
/** Resolve the memory dir lazily so NUVIRA_MEMORY_DIR hermeticity works. */
function memoryDir() {
    return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}
function metricsPath() {
    return join(memoryDir(), 'metrics.json');
}
// ─── Store ──────────────────────────────────────────────────────────────────
class MetricsStore {
    counters = {};
    timers = {};
    loaded = false;
    /** Load persisted metrics (idempotent; missing/corrupt file → empty). */
    ensureLoaded() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const p = metricsPath();
            if (!existsSync(p))
                return;
            const data = JSON.parse(readFileSync(p, 'utf-8'));
            this.counters = data.counters ?? {};
            this.timers = data.timers ?? {};
        }
        catch {
            // Corrupt file — start fresh; metrics must never break a run.
        }
    }
    /** Increment a named counter by 1 (or by `by`). */
    increment(name, by = 1) {
        this.ensureLoaded();
        this.counters[name] = (this.counters[name] ?? 0) + by;
    }
    /** Record one timer observation (ms). */
    record(name, ms) {
        this.ensureLoaded();
        const t = this.timers[name] ?? { count: 0, totalMs: 0, maxMs: 0 };
        t.count += 1;
        t.totalMs += ms;
        if (ms > t.maxMs)
            t.maxMs = ms;
        this.timers[name] = t;
    }
    /** Time a synchronous function, recording `name` with its duration. */
    timeSync(name, fn) {
        const start = Date.now();
        try {
            return fn();
        }
        finally {
            this.record(name, Date.now() - start);
        }
    }
    /** Time an async function, recording `name` with its duration. */
    async time(name, fn) {
        const start = Date.now();
        try {
            return await fn();
        }
        finally {
            this.record(name, Date.now() - start);
        }
    }
    /** Snapshot the current state without touching disk. */
    snapshot() {
        this.ensureLoaded();
        const timers = {};
        for (const [name, t] of Object.entries(this.timers)) {
            timers[name] = {
                count: t.count,
                avgMs: t.count > 0 ? t.totalMs / t.count : 0,
                maxMs: t.maxMs,
            };
        }
        return { counters: { ...this.counters }, timers, updatedAt: Date.now() };
    }
    /** Persist to disk (best-effort — never throws). */
    save() {
        this.ensureLoaded();
        try {
            mkdirSync(memoryDir(), { recursive: true });
            const data = {
                version: 1,
                counters: this.counters,
                timers: this.timers,
                updatedAt: Date.now(),
            };
            writeFileSync(metricsPath(), JSON.stringify(data, null, 2), 'utf-8');
        }
        catch {
            // Best-effort — a metrics write must never break a run.
        }
    }
    /** Reset to empty (test isolation). */
    reset() {
        this.counters = {};
        this.timers = {};
        this.loaded = true;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let instance = null;
/** Get the shared metrics store. */
export function getMetrics() {
    if (!instance)
        instance = new MetricsStore();
    return instance;
}
/** Reset the singleton (test isolation). */
export function resetMetrics() {
    instance = null;
}
// ─── Convenience helpers used by the hot paths ─────────────────────────────
/** Increment a counter (e.g. `memory.hits`, `vault.reads`). */
export function countMetric(name, by = 1) {
    getMetrics().increment(name, by);
}
/** Time a synchronous function and record its duration under `name`. */
export function recordMetricTime(name, fn) {
    return getMetrics().timeSync(name, fn);
}
//# sourceMappingURL=metrics.js.map
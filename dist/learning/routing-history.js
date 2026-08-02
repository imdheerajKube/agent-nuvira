/**
 * Routing History — records every Auto router decision over time.
 *
 * Every time the Auto model router picks a provider/model for a task, the
 * decision can be recorded here so the dashboard can show:
 *   - Usage stats — which providers/models were actually picked, by source
 *     (chat, orchestrator, explain, benchmark, eval) and by complexity
 *   - Audit trail — a timeline of `buff model explain` snapshots
 *
 * Persisted to ~/.buff/memory/routing-history.json (respects BUFF_MEMORY_DIR
 * for tests). Writes are best-effort — a failure must never break routing.
 *
 * Sources:
 *   - 'chat'          — live `buff chat` auto-routing (per message)
 *   - 'orchestrator'  — live multi-agent pipeline auto-routing (per task)
 *   - 'explain'       — `buff model explain` snapshots (audit trail)
 *   - 'benchmark'     — `buff benchmark --routing` picks
 *   - 'eval'          — `buff eval --routing` picks
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// ─── Storage ────────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const CURRENT_VERSION = 1;
/** Keep the most recent 500 decisions. */
const MAX_ENTRIES = 500;
/**
 * Resolve the memory directory at call time so tests can override it via
 * BUFF_MEMORY_DIR without import-order tricks.
 */
function memoryDir() {
    return process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}
function historyPath() {
    return join(memoryDir(), 'routing-history.json');
}
function ensureDir() {
    if (!existsSync(memoryDir())) {
        mkdirSync(memoryDir(), { recursive: true });
    }
}
function readData() {
    try {
        ensureDir();
        if (!existsSync(historyPath()))
            return { version: CURRENT_VERSION, entries: [] };
        const raw = readFileSync(historyPath(), 'utf-8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.entries))
            return { version: CURRENT_VERSION, entries: [] };
        return data;
    }
    catch {
        return { version: CURRENT_VERSION, entries: [] };
    }
}
function writeData(data) {
    try {
        ensureDir();
        writeFileSync(historyPath(), JSON.stringify(data, null, 2), 'utf-8');
    }
    catch {
        // Best-effort — a failed write must never break routing
    }
}
// ─── API ────────────────────────────────────────────────────────────────────
/**
 * Record a routing decision. Appends to the store (capped at MAX_ENTRIES,
 * keeping the most recent) and persists it.
 */
export function recordRoutingDecision(entry) {
    const data = readData();
    data.entries.push({
        ...entry,
        id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
    });
    if (data.entries.length > MAX_ENTRIES) {
        data.entries = data.entries.slice(-MAX_ENTRIES);
    }
    writeData(data);
}
/**
 * Get recorded decisions, most recent first.
 */
export function getRoutingHistory(limit = 100) {
    const data = readData();
    return [...data.entries].reverse().slice(0, limit);
}
/**
 * Aggregate usage statistics over the recorded history:
 * totals, last-24h, and counts by provider/model/source/complexity.
 */
export function getRoutingUsageStats() {
    const entries = readData().entries;
    const byProvider = {};
    const byModel = {};
    const bySource = {};
    const byComplexity = {};
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let last24h = 0;
    for (const e of entries) {
        byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
        byModel[e.model] = (byModel[e.model] || 0) + 1;
        bySource[e.source] = (bySource[e.source] || 0) + 1;
        byComplexity[e.complexity] = (byComplexity[e.complexity] || 0) + 1;
        if (e.timestamp >= dayAgo)
            last24h++;
    }
    return {
        total: entries.length,
        last24h,
        byProvider,
        byModel,
        bySource,
        byComplexity,
        updatedAt: Date.now(),
    };
}
/**
 * Clear all recorded routing history.
 */
export function clearRoutingHistory() {
    writeData({ version: CURRENT_VERSION, entries: [] });
}
//# sourceMappingURL=routing-history.js.map
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

// ─── Types ──────────────────────────────────────────────────────────────────

/** Where a routing decision came from. */
export type RoutingSource = 'explain' | 'benchmark' | 'eval' | 'chat' | 'orchestrator';

/** A single recorded routing decision. */
export interface RoutingHistoryEntry {
  /** Unique id (timestamp + random suffix) */
  id: string;
  /** Epoch ms when the decision was made */
  timestamp: number;
  /** Source of the decision */
  source: RoutingSource;
  /** Agent type the decision was for (e.g., 'chat', 'writer', 'planner') */
  agentType: string;
  /** The task description that was routed */
  task: string;
  /** Detected complexity (trivial…critical) */
  complexity: string;
  /** Selected provider */
  provider: string;
  /** Selected model within that provider */
  model: string;
  /** Router composite score of the pick (0–1) */
  score: number;
}

/** Aggregated usage statistics over the recorded history. */
export interface RoutingUsageStats {
  total: number;
  /** Decisions made in the last 24h */
  last24h: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  bySource: Record<string, number>;
  byComplexity: Record<string, number>;
  updatedAt: number;
}

interface RoutingHistoryData {
  version: number;
  entries: RoutingHistoryEntry[];
}

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const CURRENT_VERSION = 1;
/** Keep the most recent 500 decisions. */
const MAX_ENTRIES = 500;

/**
 * Resolve the memory directory at call time so tests can override it via
 * BUFF_MEMORY_DIR without import-order tricks.
 */
function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}

function historyPath(): string {
  return join(memoryDir(), 'routing-history.json');
}

function ensureDir(): void {
  if (!existsSync(memoryDir())) {
    mkdirSync(memoryDir(), { recursive: true });
  }
}

function readData(): RoutingHistoryData {
  try {
    ensureDir();
    if (!existsSync(historyPath())) return { version: CURRENT_VERSION, entries: [] };
    const raw = readFileSync(historyPath(), 'utf-8');
    const data = JSON.parse(raw) as RoutingHistoryData;
    if (!Array.isArray(data.entries)) return { version: CURRENT_VERSION, entries: [] };
    return data;
  } catch {
    return { version: CURRENT_VERSION, entries: [] };
  }
}

function writeData(data: RoutingHistoryData): void {
  try {
    ensureDir();
    writeFileSync(historyPath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Best-effort — a failed write must never break routing
  }
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Record a routing decision. Appends to the store (capped at MAX_ENTRIES,
 * keeping the most recent) and persists it.
 */
export function recordRoutingDecision(entry: Omit<RoutingHistoryEntry, 'id' | 'timestamp'>): void {
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
export function getRoutingHistory(limit = 100): RoutingHistoryEntry[] {
  const data = readData();
  return [...data.entries].reverse().slice(0, limit);
}

/**
 * Aggregate usage statistics over the recorded history:
 * totals, last-24h, and counts by provider/model/source/complexity.
 */
export function getRoutingUsageStats(): RoutingUsageStats {
  const entries = readData().entries;
  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byComplexity: Record<string, number> = {};
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let last24h = 0;

  for (const e of entries) {
    byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    byModel[e.model] = (byModel[e.model] || 0) + 1;
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    byComplexity[e.complexity] = (byComplexity[e.complexity] || 0) + 1;
    if (e.timestamp >= dayAgo) last24h++;
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
export function clearRoutingHistory(): void {
  writeData({ version: CURRENT_VERSION, entries: [] });
}

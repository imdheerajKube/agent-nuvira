/**
 * Routing History — records every Auto router decision over time.
 *
 * Every time the Auto model router picks a provider/model for a task, the
 * decision can be recorded here so the dashboard can show:
 *   - Usage stats — which providers/models were actually picked, by source
 *     (chat, orchestrator, explain, benchmark, eval) and by complexity
 *   - Audit trail — a timeline of `nuvira model explain` snapshots
 *
 * Persisted to ~/.nuvira/memory/routing-history.json (respects NUVIRA_MEMORY_DIR
 * for tests). Writes are best-effort — a failure must never break routing.
 *
 * Sources:
 *   - 'chat'          — live `nuvira chat` auto-routing (per message)
 *   - 'orchestrator'  — live multi-agent pipeline auto-routing (per task)
 *   - 'explain'       — `nuvira model explain` snapshots (audit trail)
 *   - 'benchmark'     — `nuvira benchmark --routing` picks
 *   - 'eval'          — `nuvira eval --routing` picks
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {envBuff, resolveNuviraHome} from '../config/paths';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Where a routing decision came from. */
export type RoutingSource = 'explain' | 'benchmark' | 'eval' | 'chat' | 'orchestrator';

/**
 * The scale a recorded `score` is on.
 *
 * Two scales decide a walk and they are NOT interchangeable: the auto-router
 * ranks PROVIDERS by a weighted composite, while `buildModelCandidates` ranks
 * MODELS. Comparing one against the other is meaningless, so a row states which
 * it used (see `RoutingHistoryEntry.score`).
 */
export type RoutingScoreBasis =
  /** The auto-router's provider-level weighted composite for this task. */
  | 'provider'
  /** A model-level candidate score from `buildModelCandidates`. */
  | 'model';

/**
 * A full routing-decision snapshot — the ranked candidate list with scores and
 * the decision context, captured at decision time. Recorded for `explain`
 * decisions so `model explain --since <ref>` (P3-M3.3) can diff two decisions
 * (bandit shift, new verification, constraints added). Additive and optional:
 * older entries without a snapshot diff as "no prior snapshot available".
 */
export interface RoutingSnapshot {
  /** Detected complexity (trivial…critical). */
  complexity: string;
  /** Task type classification (code/reasoning/chat/…). */
  taskType?: string;
  /** Dimension weights at decision time (key = dimension, value 0–1). */
  weights?: Record<string, number>;
  /** The winning pick. */
  winner: { provider: string; model: string; score: number };
  /** Ranked candidate list (best first) — the scored breakdown. */
  ranked: Array<{
    provider: string;
    /** Resolved model for this provider ('' when the ranking is provider-level). */
    model?: string;
    score: number;
    reason: string;
    /** M2.1 capability fit 0–1 (undefined = gate OFF). */
    capabilityFit?: number;
    /** M2.2 cost basis: 'measured' (wire tokens) vs 'estimated'. */
    costSource?: 'measured' | 'estimated';
    /** M2.5 context-fit 0–1 (undefined = gate OFF). */
    contextFit?: number;
  }>;
  /** Ordered fallback chain. */
  fallbackChain?: Array<{ provider: string; model: string; reason: string }>;
  /** Providers eliminated by the governance policy (M2.4). */
  governanceBlocked?: Array<{ provider: string; reason: string }>;
}

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
  /**
   * The score of THIS row's own pick — and ONLY this row's pick.
   *
   * B2-a, measured live. There are two scales in play: the auto-router's
   * provider-level COMPOSITE (`decision.score`) and the model-level candidate
   * score from `buildModelCandidates`. `cli/chat.ts` used to write
   * `score: decision.score` onto EVERY row of a failover walk, so three
   * different pairs appeared to share one number — measured:
   * `0.43836864406779663` on gemini/`gemma-4-26b-a4b-it`,
   * openrouter/`cohere/command-r7b-12-2024` and deepseek/`deepseek-flash`, while
   * the provider scores `model explain` prints for that same ask are
   * `local 0.438` / `gemini 0.438`. A reader could only conclude the models had
   * tied — and that is exactly the wrong inference the Bundle 8 live run drew
   * ("equal priors, so the ranking carries no information"), when the
   * model-level scores were in fact ORDERED at 0.9206 / 0.77 / 0.597148.
   *
   * So a row carries its own pick's score or nothing: an audit record may not
   * borrow a number from a different pair, and may not invent one for an
   * ordering placeholder. `scoreBasis` names the scale, because the two scales
   * are not comparable and a column that silently mixes them is the same defect
   * wearing a different hat.
   */
  score?: number;
  /**
   * Which scale `score` is on. Present whenever `score` is meant to be read or
   * compared; absent alongside an absent `score`.
   */
  scoreBasis?: RoutingScoreBasis;
  /**
   * Full decision snapshot (ranked candidates + context) — recorded for
   * `explain` decisions to power `model explain --since` (P3-M3.3). Optional:
   * non-explain sources and older entries omit it.
   */
  snapshot?: RoutingSnapshot;
  /**
   * A1/A3 — may the FINAL routed model hold an agentic software task? Recorded
   * with the same shared predicate the router used, so the dashboard can flag a
   * weak pick with a warning chip instead of only showing its score. Optional:
   * entries written before this field load unchanged.
   */
  agenticCapable?: boolean;
  /** A3 — how the model-first override affected the final pick, if known. */
  overrideReason?: string;
  /** B — the consent-gate outcome for this route (`proceed` | `ask` | …). */
  gateAction?: string;
  /** C3 — the pair this route failed over FROM (the failover chain's head). */
  fallbackFrom?: string;
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

const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');
const CURRENT_VERSION = 1;
/** Keep the most recent 500 decisions. */
const MAX_ENTRIES = 500;

/**
 * Resolve the memory directory at call time so tests can override it via
 * NUVIRA_MEMORY_DIR without import-order tricks.
 */
function memoryDir(): string {
  return envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
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
 * Explain decisions that carry a full snapshot, most recent first — the
 * candidate set for `model explain --since <ref>` diffs (P3-M3.3).
 */
export function getExplainSnapshots(limit = 100): RoutingHistoryEntry[] {
  return getRoutingHistory(limit).filter((e) => e.source === 'explain' && e.snapshot);
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

/**
 * D1 — Agent-driven auto-recall.
 *
 * `autoRecall` rebuilds a project's working context from prior sessions with
 * ZERO manual commands: workspace project row (A2) → session history scoped by
 * project + optional temporal range (D1 searchSessions) → facts (B1) → latest
 * checkpoint (resume point). The result is a one-line recall card for the user
 * plus a context block that gets injected into the planner/chat prompt so a
 * "continue last week's plan" request resumes with the project's actual state.
 *
 * Cross-command parity (STANDING RULE): chat, execute, and plan all invoke
 * this from the shared NLU dispatch (intent continue/resume → mode 'recall').
 * Best-effort everywhere — recall must never break a command.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import {
  deriveProjectId,
  getWorkspaceStore,
  type WorkspaceProject,
  type WorkspaceStore,
} from '../config/workspace.js';
import { getChatHistory, type HistorySession } from './history.js';
import { getFactStore, type StoredFact } from '../memory/fact-store.js';
import { listCheckpoints, type CheckpointMeta } from '../agents/checkpoint-store.js';
import { extractTimeRange } from '../nlu/intent.js';

// ─── Recall-hit telemetry (G2 dashboard memory panel) ───────────────────────

/** Append-only JSONL of every successful recall (one line per hit). */
const RECALL_HITS_FILENAME = 'recall-hits.jsonl';

/**
 * Dedupe window: the same request flows through autoRecall up to twice per
 * user action (entry point + pipeline-tool when recallContext isn't prebuilt).
 * Consecutive hits for the same project within this window count as ONE —
 * keeps the user-facing G2 counter accurate.
 */
const RECALL_HIT_DEDUPE_MS = 5_000;

/** Last hit timestamp per project (in-memory dedupe). */
const lastHitAt = new Map<string, number>();

/** Test-only: clear the in-memory dedupe map between test cases. */
export function resetRecallHitDedupe(): void {
  lastHitAt.clear();
}

/** Same memory-dir resolution the dashboard server uses (env override). */
function recallHitsPath(): string {
  const dir = process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
  return join(dir, RECALL_HITS_FILENAME);
}

/**
 * Record one recall hit (project + timestamp). Called from autoRecall when
 * the recall actually returned something — one shared choke point, so every
 * entry point (chat / execute / plan / edit / session resume) counts a hit
 * without per-command wiring. Best-effort: a failed append never breaks recall.
 *
 * Dedupe: consecutive hits for the same project within RECALL_HIT_DEDUPE_MS
 * are skipped (same user action re-entering autoRecall). Skipped entirely
 * under test (VITEST) so suites never pollute a real ~/.buff telemetry file.
 */
export function recordRecallHit(projectId: string): void {
  // Test isolation: vitest sets VITEST — never write telemetry during tests.
  if (process.env.VITEST) return;
  try {
    const now = Date.now();
    const last = lastHitAt.get(projectId) ?? 0;
    if (now - last < RECALL_HIT_DEDUPE_MS) return;
    lastHitAt.set(projectId, now);

    const file = recallHitsPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ t: now, projectId })}\n`, 'utf-8');
  } catch {
    // Best-effort — telemetry must never break recall.
  }
}

/**
 * Read recall-hit telemetry for the dashboard memory panel. Best-effort;
 * a missing/corrupt file returns zeros.
 */
export function readRecallHits(): {
  total: number;
  today: number;
  last7d: number;
  byProject: Record<string, number>;
} {
  const out = { total: 0, today: 0, last7d: 0, byProject: {} as Record<string, number> };
  try {
    if (!existsSync(recallHitsPath())) return out;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    for (const line of readFileSync(recallHitsPath(), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const hit = JSON.parse(line) as { t?: number; projectId?: string };
        const t = hit.t ?? 0;
        out.total++;
        if (now - t < dayMs) out.today++;
        if (now - t < 7 * dayMs) out.last7d++;
        if (hit.projectId) out.byProject[hit.projectId] = (out.byProject[hit.projectId] || 0) + 1;
      } catch {
        // Skip corrupt lines.
      }
    }
  } catch {
    // Best-effort.
  }
  return out;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecallOptions {
  /** Working directory the project is rooted at (default: process.cwd()). */
  cwd?: string;
  /** Explicit project id (A2 deriveProjectId). Derived from cwd when absent. */
  projectId?: string;
  /** Temporal reference from the parsed request ("last week") — resolved with C1's recognizer, no LLM. */
  timeRangeText?: string;
  /** Pre-resolved epoch range (overrides timeRangeText). */
  timeRange?: { start?: number; end?: number };
  /** Workspace store override (tests / custom config dir). Defaults to getWorkspaceStore(). */
  store?: WorkspaceStore;
  /** Max recent sessions to return (default 8). */
  maxSessions?: number;
  /** Max facts to return (default 5). */
  maxFacts?: number;
}

export interface RecallResult {
  projectId: string;
  project: WorkspaceProject | null;
  sessionCount: number;
  sessions: HistorySession[];
  factCount: number;
  facts: StoredFact[];
  checkpoint: CheckpointMeta | null;
  lastGoal: string;
  runSummary: string;
  /** e.g. "step 3/8" when a checkpoint exists; null otherwise. */
  resumedStep: string | null;
}

// ─── Temporal range (deterministic, no LLM) ────────────────────────────────

/**
 * Resolve a temporal phrase ("last week", "yesterday", "2 days ago") to an
 * epoch range using C1's Microsoft recognizer — the exact "continue last
 * week's plan" path. Returns undefined when nothing temporal is found.
 */
export function textRangeToEpoch(
  text: string,
  referenceDate: Date = new Date(),
): { start?: number; end?: number } | undefined {
  const range = extractTimeRange(text, referenceDate);
  if (!range) return undefined;
  const out: { start?: number; end?: number } = {};
  if (range.start) {
    const s = Date.parse(range.start);
    if (!Number.isNaN(s)) out.start = s;
  }
  if (range.end) {
    const e = Date.parse(range.end);
    if (!Number.isNaN(e)) out.end = e;
  }
  if (out.start !== undefined && out.end === undefined) {
    // A point reference ("yesterday") — treat as that day (24h window).
    out.end = out.start + 24 * 60 * 60 * 1000 - 1;
  }
  return out.start !== undefined || out.end !== undefined ? out : undefined;
}

// ─── Auto-recall ────────────────────────────────────────────────────────────

/**
 * Rebuild a project's working context from prior sessions with zero manual
 * commands: workspace row → sessions (project + optional time range) → facts →
 * latest checkpoint. All reads are best-effort (never throw).
 */
export async function autoRecall(opts: RecallOptions = {}): Promise<RecallResult> {
  const cwd = opts.cwd ?? process.cwd();
  const projectId = opts.projectId ?? deriveProjectId(cwd).id;
  const store = opts.store ?? getWorkspaceStore();

  let project: WorkspaceProject | null = null;
  try {
    project = store.getProject(projectId);
  } catch { /* best-effort */ }

  const timeRange =
    opts.timeRange ??
    (opts.timeRangeText ? textRangeToEpoch(opts.timeRangeText) : undefined);

  let sessions: HistorySession[] = [];
  try {
    sessions = getChatHistory().searchSessions({
      projectId,
      timeRange,
      limit: opts.maxSessions ?? 8,
    });
  } catch { /* best-effort */ }

  let facts: StoredFact[] = [];
  try {
    facts = await getFactStore().retrieveFacts(
      projectId,
      project?.lastGoal || 'project context',
      undefined,
      { k: opts.maxFacts ?? 5, timeRange },
    );
  } catch { /* best-effort */ }

  let checkpoint: CheckpointMeta | null = null;
  try {
    checkpoint = listCheckpoints().find((c) => c.workingDirectory === cwd) ?? null;
  } catch { /* best-effort */ }

  const resumedStep =
    checkpoint && checkpoint.tasksTotal > 0
      ? `step ${Math.min(checkpoint.tasksCompleted + 1, checkpoint.tasksTotal)}/${checkpoint.tasksTotal}`
      : null;

  // G2: count the hit when recall actually returned something (the shared
  // choke point — one line covers every entry point).
  if (sessions.length > 0 || facts.length > 0 || project) {
    try { recordRecallHit(projectId); } catch { /* best-effort */ }
  }

  return {
    projectId,
    project,
    sessionCount: sessions.length,
    sessions,
    factCount: facts.length,
    facts,
    checkpoint,
    lastGoal: project?.lastGoal ?? '',
    runSummary: project?.runSummary ?? '',
    resumedStep,
  };
}

/**
 * Convenience wrapper for the action commands: runs autoRecall and returns
 * null when there is nothing to recall (so callers skip the card/injection
 * entirely). Shared by chat / execute / plan / edit — the D1 cross-command
 * parity hook.
 */
export async function maybeAutoRecall(
  cwd: string,
  store?: WorkspaceStore,
): Promise<RecallResult | null> {
  const recall = await autoRecall({ cwd, store });
  if (recall.sessionCount === 0 && recall.factCount === 0 && !recall.project) return null;
  return recall;
}

// ─── Presentation ───────────────────────────────────────────────────────────

/** One-line recall card shown to the user. */
export function recallCard(r: RecallResult): string {
  const label =
    r.project?.gitRepo || r.projectId.replace(/^cwd:/, '').slice(0, 24) || r.projectId;
  const parts = [
    `📦 Recalled project '${label}' — ${r.sessionCount} session(s), ${r.factCount} fact(s)`,
  ];
  if (r.resumedStep) parts.push(`resuming ${r.resumedStep}`);
  if (r.lastGoal) parts.push(`last goal: "${r.lastGoal.slice(0, 60)}"`);
  return parts.join(' · ');
}

/** Context block injected into the planner/chat prompt. */
export function recallContextBlock(r: RecallResult): string {
  const lines: string[] = ['[Recalled project context — from a previous session]'];
  if (r.lastGoal) lines.push(`Last goal: ${r.lastGoal}`);
  if (r.runSummary) lines.push(`Last result: ${r.runSummary.slice(0, 200)}`);
  if (r.resumedStep) lines.push(`Resume point: ${r.resumedStep}`);
  if (r.sessions.length > 0) {
    lines.push('Recent sessions:');
    for (const s of r.sessions.slice(0, 3)) {
      const d = new Date(s.startedAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      lines.push(`- ${d}: ${s.summary.slice(0, 100)}`);
    }
  }
  if (r.facts.length > 0) {
    lines.push('Known facts:');
    for (const f of r.facts.slice(0, 5)) lines.push(`- ${f.text.slice(0, 160)}`);
  }
  return lines.join('\n');
}

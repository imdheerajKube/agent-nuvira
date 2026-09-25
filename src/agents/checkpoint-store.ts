/**
 * CheckpointStore — persist and restore orchestration state for `--resume`.
 *
 * Assessment item #6 ("maintain continuity"): serialize intermediate state so
 * subtasks can resume on another model without loss. After every task batch the
 * orchestrator saves a snapshot of the ContextVault (task plan with per-step
 * statuses, artifacts, file changes, metadata) to disk. A later run with
 * `--resume <id>` rehydrates the vault and continues from the first pending
 * step — completed steps are never re-run, so a crash / quota kill / token
 * expiry mid-pipeline doesn't restart the whole plan.
 *
 * Checkpoints are JSON-serialized (JSON.stringify drops function fields like
 * `onRateLimit` automatically), keyed by a deterministic id derived from
 * `goal + workingDirectory` plus an optional explicit id. Persisted to
 * `~/.nuvira/memory/checkpoints/` (honors NUVIRA_MEMORY_DIR). All reads/writes are
 * best-effort — a corrupt or missing checkpoint must never crash a run.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import {envBuff, resolveNuviraHome} from '../config/paths';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import { verifyArtifacts } from './artifact-verification.js';

import type { AgentContext, TaskStep } from './agent.js';

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');

function checkpointsDir(): string {
  const base = envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
  return join(base, 'checkpoints');
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Lightweight checkpoint metadata (used for listing). */
export interface CheckpointMeta {
  id: string;
  goal: string;
  workingDirectory: string;
  savedAt: number;
  tasksCompleted: number;
  tasksTotal: number;
}

/** A full checkpoint on disk: metadata + the rehydratable context snapshot. */
export interface CheckpointFile extends CheckpointMeta {
  context: AgentContext;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Deterministic checkpoint id for a goal + working directory. Two runs of the
 * same goal in the same directory map to the same id, so `--resume` without an
 * explicit id finds the latest checkpoint for that goal.
 */
export function checkpointIdFor(goal: string, workingDirectory: string): string {
  const hash = createHash('sha1')
    .update(`${workingDirectory}\u0000${goal}`)
    .digest('hex')
    .slice(0, 12);
  return `cp-${hash}`;
}

/**
 * Save a checkpoint. Returns the checkpoint id, or null if the write failed
 * (best-effort — checkpointing must never break the pipeline, and the caller
 * can log the failure honestly instead of claiming a save that didn't happen).
 *
 * @param context The vault context to snapshot (task plan with statuses, etc.)
 * @param id      Optional explicit id; defaults to a hash of goal + cwd
 */
export function saveCheckpoint(context: AgentContext, id?: string): string | null {
  try {
    const dir = checkpointsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cid = id || checkpointIdFor(context.goal, context.workingDirectory);
    const tasks = context.taskPlan ?? [];
    const file: CheckpointFile = {
      id: cid,
      goal: context.goal,
      workingDirectory: context.workingDirectory,
      savedAt: Date.now(),
      tasksCompleted: tasks.filter((t) => t.status === 'completed').length,
      tasksTotal: tasks.length,
      // JSON round-trip drops function fields (onRateLimit) — safe to persist.
      context,
    };
    writeFileSync(join(dir, `${cid}.json`), JSON.stringify(file, null, 2), 'utf-8');
    return cid;
  } catch {
    // Best-effort — checkpointing must never break the pipeline.
    return null;
  }
}

/** Load a checkpoint by id (null if missing/corrupt). */
export function loadCheckpoint(id: string): CheckpointFile | null {
  try {
    const path = join(checkpointsDir(), `${id}.json`);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf-8')) as CheckpointFile;
    if (!data || typeof data !== 'object' || !data.context) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * The newest checkpoint for this project whose goal is the SAME ASK, possibly
 * worded differently.
 *
 * `checkpointIdFor` hashes `workingDirectory + goal`, so a reworded ask hashes
 * to a different id and finds nothing — which is why "do that addon thing"
 * re-planned from zero while the previous attempt's plan sat on disk.
 *
 * The goal test is deliberately REQUIRED rather than taking the newest
 * checkpoint in the directory. A bare "newest for this project" lookup would
 * hand run B the plan of a completely unrelated run A that merely happened to
 * use the same folder — and it would do so silently, which is worse than the
 * re-plan it replaces. The caller reconciles whatever this returns against the
 * filesystem before trusting a word of it (see `reconcileTaskPlan`).
 *
 * Newest-first among the matching goals, so the most recent attempt wins.
 */
export function findRelatedCheckpointFor(
  workingDirectory: string,
  goal: string,
  options: { excludeId?: string } = {},
): CheckpointFile | null {
  const wanted = normalizeDir(workingDirectory);
  const candidates = listCheckpoints()
    .filter((c) => normalizeDir(c.workingDirectory) === wanted && c.id !== options.excludeId)
    .sort((a, b) => b.savedAt - a.savedAt);
  for (const meta of candidates) {
    if (!goalsLookSame(meta.goal, goal)) continue;
    const file = loadCheckpoint(meta.id);
    if (file) return file;
  }
  return null;
}

/** Compare working directories without caring about a trailing slash. */
function normalizeDir(dir: string): string {
  return (dir || '').replace(/[\\/]+$/, '');
}

/** Words that carry no subject — dropped before comparing two goals. */
const GOAL_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
  'can', 'could', 'would', 'should', 'please', 'you', 'your', 'me', 'my', 'i', 'we', 'it', 'its',
  'is', 'are', 'was', 'be', 'been', 'do', 'does', 'did', 'make', 'made', 'need', 'want', 'get',
  'this', 'that', 'these', 'those', 'there', 'here', 'then', 'than', 'so', 'as', 'by', 'use',
  'using', 'into', 'out', 'up', 'down', 'again', 'also', 'just', 'new', 'now', 'save',
  'folder', 'file', 'path', 'directory', 'dir', 'create', 'build', 'develop', 'write',
]);

/**
 * Subject tokens of a goal. Hyphens and underscores are JOINED, not split, so
 * "add-on" and "addon" are the same token — the exact pair a user is most
 * likely to vary when re-asking.
 */
function goalTokens(text: string): Set<string> {
  const flat = (text || '')
    .toLowerCase()
    .replace(/[-_]+/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  const tokens = new Set<string>();
  for (const raw of flat.split(' ')) {
    const t = raw.trim();
    if (!t || t.length < 3) continue;
    if (GOAL_STOPWORDS.has(t)) continue;
    tokens.add(t);
  }
  return tokens;
}

/** Shared subject tokens needed before two goals are treated as the same ask. */
const MIN_SHARED_TOKENS = 3;
/** Fraction of the SHORTER goal's tokens that must be shared. */
const MIN_SHARED_RATIO = 0.6;

/**
 * Are these two the same ask, worded differently?
 *
 * Both a floor and a ratio are required. The ratio alone passes two long goals
 * that share a boilerplate opening; the floor alone passes two short goals that
 * share one incidental noun. Together they mean "most of the shorter ask's
 * subject matter appears in the other", which is what rewording looks like and
 * what two unrelated asks in one folder do not.
 *
 * The floor is capped at the shorter goal's own token count, so a SHORT ask
 * still matches its own rewording: "Package the add-on" and "package the addon
 * for me" are two tokens each, and demanding three shared tokens would refuse
 * the pair the rule exists for. At two tokens that means both must match — which
 * is still enough to keep "update the readme" and "update the dockerfile"
 * apart.
 */
export function goalsLookSame(a: string, b: string): boolean {
  const ta = goalTokens(a);
  const tb = goalTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const smaller = Math.min(ta.size, tb.size);
  if (shared < Math.min(MIN_SHARED_TOKENS, smaller)) return false;
  return shared / smaller >= MIN_SHARED_RATIO;
}

/** The outcome of checking a saved plan against the filesystem. */
export interface PlanReconciliation {
  /** The context with unverifiable completions demoted back to `pending`. */
  context: AgentContext;
  /** Steps that CLAIMED completion but whose artifacts are not on disk. */
  demoted: Array<{ id: string; reason: string }>;
}

/**
 * Reconcile a saved task plan against what is actually on disk.
 *
 * WHY THIS EXISTS (the live NVDA-addon failure): the checkpoint for that goal
 * said `5/5 tasks completed`, so "resume unless the user asks" looked correct —
 * re-entering a finished plan would skip every task. But three of the five
 * completions were false: the step claimed success, `zip` exited 0 on inputs
 * that did not exist, and the packaged deliverable was a 22-byte empty archive.
 * A checkpoint's statuses are therefore CLAIMS, and the only thing that makes
 * them safe to skip is the artifact behind them.
 *
 * The rule, in one line: a completed step whose DECLARED files are not on disk
 * (or are empty shells) is demoted to `pending`, so a resume re-runs exactly the
 * work that is missing instead of skipping it.
 *
 * Deliberately narrow: only a step's explicit `expectedFiles` is checked. A
 * description like "Delete legacy.js" would look like an unmet deliverable if we
 * inferred artifacts from prose, so prose is never used to decide what re-runs —
 * that stays the planner's declared contract. Steps with nothing declared are
 * left exactly as they are rather than being demoted on a guess.
 *
 * Never throws: reconciliation failure reports, it does not break a resume.
 */
export function reconcileTaskPlan(
  context: AgentContext,
  workingDirectory?: string,
): PlanReconciliation {
  const demoted: PlanReconciliation['demoted'] = [];
  let plan: TaskStep[];
  try {
    plan = structuredClone(context.taskPlan ?? []);
  } catch {
    // An unclonable plan is not a verdict — hand it back untouched.
    return { context, demoted };
  }

  const root = workingDirectory || context.workingDirectory || process.cwd();

  for (const step of plan) {
    if (step.status !== 'completed') continue;
    const declared = (step.expectedFiles ?? []).filter((f) => f && f.trim());
    if (declared.length === 0) continue;
    try {
      const check = verifyArtifacts(declared, root);
      if (check.ok) continue;
      step.status = 'pending';
      step.result =
        `re-opened on resume — the step reported success but its deliverable is not on disk (${check.reason})`;
      demoted.push({ id: step.id, reason: check.reason ?? 'deliverable missing' });
    } catch {
      // Best-effort: a filesystem error must not demote a step on a guess.
    }
  }

  if (demoted.length === 0) return { context, demoted };
  return { context: { ...context, taskPlan: plan }, demoted };
}

/** True when the plan still has work that can be run. */
export function planHasPendingWork(context: AgentContext): boolean {
  return (context.taskPlan ?? []).some((s) => s.status === 'pending');
}

/** List all saved checkpoints, newest first (for `nuvira execute --checkpoint-list`). */
export function listCheckpoints(): CheckpointMeta[] {
  try {
    const dir = checkpointsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const data = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as CheckpointFile;
          return {
            id: data.id,
            goal: data.goal,
            workingDirectory: data.workingDirectory,
            savedAt: data.savedAt,
            tasksCompleted: data.tasksCompleted,
            tasksTotal: data.tasksTotal,
          } as CheckpointMeta;
        } catch {
          return null;
        }
      })
      .filter((c): c is CheckpointMeta => c !== null)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}


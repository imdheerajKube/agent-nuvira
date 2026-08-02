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
 * `~/.buff/memory/checkpoints/` (honors BUFF_MEMORY_DIR). All reads/writes are
 * best-effort — a corrupt or missing checkpoint must never crash a run.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import type { AgentContext } from './agent.js';

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');

function checkpointsDir(): string {
  const base = process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
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

/** List all saved checkpoints, newest first (for `buff execute --checkpoint-list`). */
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


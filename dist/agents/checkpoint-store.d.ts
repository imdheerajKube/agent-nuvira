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
import type { AgentContext } from './agent.js';
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
/**
 * Deterministic checkpoint id for a goal + working directory. Two runs of the
 * same goal in the same directory map to the same id, so `--resume` without an
 * explicit id finds the latest checkpoint for that goal.
 */
export declare function checkpointIdFor(goal: string, workingDirectory: string): string;
/**
 * Save a checkpoint. Returns the checkpoint id, or null if the write failed
 * (best-effort — checkpointing must never break the pipeline, and the caller
 * can log the failure honestly instead of claiming a save that didn't happen).
 *
 * @param context The vault context to snapshot (task plan with statuses, etc.)
 * @param id      Optional explicit id; defaults to a hash of goal + cwd
 */
export declare function saveCheckpoint(context: AgentContext, id?: string): string | null;
/** Load a checkpoint by id (null if missing/corrupt). */
export declare function loadCheckpoint(id: string): CheckpointFile | null;
/** List all saved checkpoints, newest first (for `buff execute --checkpoint-list`). */
export declare function listCheckpoints(): CheckpointMeta[];
//# sourceMappingURL=checkpoint-store.d.ts.map
/**
 * Checkpoint Manager — Save and restore execution state.
 *
 * Hermes equivalent: checkpoint_manager.py (1,953 lines)
 *
 * Provides:
 * - Create checkpoints of execution state
 * - Restore to a previous checkpoint
 * - Checkpoint history and diff
 */
import { EventEmitter } from 'node:events';
export interface Checkpoint {
    id: string;
    name: string;
    description?: string;
    state: Record<string, unknown>;
    metadata: Record<string, unknown>;
    createdAt: number;
    sizeBytes: number;
}
export declare class CheckpointManager extends EventEmitter {
    private checkpoints;
    private checkpointDir;
    private maxCheckpoints;
    constructor();
    private ensureDir;
    private loadCheckpoints;
    /**
     * Create a checkpoint.
     */
    create(name: string, state: Record<string, unknown>, options?: {
        description?: string;
        metadata?: Record<string, unknown>;
    }): Checkpoint;
    /**
     * Restore a checkpoint.
     */
    restore(id: string): Record<string, unknown> | null;
    /**
     * Delete a checkpoint.
     */
    delete(id: string): boolean;
    /**
     * List checkpoints.
     */
    list(options?: {
        name?: string;
        limit?: number;
    }): Checkpoint[];
    /**
     * Get checkpoint.
     */
    get(id: string): Checkpoint | null;
    /**
     * Compare two checkpoints.
     */
    diff(id1: string, id2: string): {
        added: string[];
        removed: string[];
        changed: string[];
    } | null;
    private saveCheckpoint;
    private deleteCheckpointFile;
}
export declare function getCheckpointManager(): CheckpointManager;
export declare function resetCheckpointManager(): void;
//# sourceMappingURL=checkpoint-manager.d.ts.map
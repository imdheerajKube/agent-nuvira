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
import { randomUUID } from 'node:crypto';
import { resolveNuviraHome } from '../config/paths.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';
// ─── Checkpoint Manager ──────────────────────────────────────────────────
export class CheckpointManager extends EventEmitter {
    checkpoints = new Map();
    checkpointDir;
    maxCheckpoints = 50;
    constructor() {
        super();
        this.checkpointDir = join(resolveNuviraHome(), 'cache', 'checkpoints');
        this.ensureDir();
        this.loadCheckpoints();
    }
    ensureDir() {
        if (!existsSync(this.checkpointDir)) {
            mkdirSync(this.checkpointDir, { recursive: true });
        }
    }
    loadCheckpoints() {
        try {
            const files = readdirSync(this.checkpointDir).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const data = readFileSync(join(this.checkpointDir, file), 'utf-8');
                const checkpoint = JSON.parse(data);
                this.checkpoints.set(checkpoint.id, checkpoint);
            }
        }
        catch {
            // Ignore
        }
    }
    /**
     * Create a checkpoint.
     */
    create(name, state, options = {}) {
        const id = randomUUID();
        const stateJson = JSON.stringify(state);
        const checkpoint = {
            id,
            name,
            description: options.description,
            state,
            metadata: options.metadata || {},
            createdAt: Date.now(),
            sizeBytes: Buffer.byteLength(stateJson),
        };
        this.checkpoints.set(id, checkpoint);
        this.saveCheckpoint(checkpoint);
        // Enforce max checkpoints
        if (this.checkpoints.size > this.maxCheckpoints) {
            const oldest = Array.from(this.checkpoints.values())
                .sort((a, b) => a.createdAt - b.createdAt)[0];
            if (oldest) {
                this.checkpoints.delete(oldest.id);
                this.deleteCheckpointFile(oldest.id);
            }
        }
        logger.debug(`[checkpoint] Created ${name} (${checkpoint.sizeBytes} bytes)`);
        this.emit('created', checkpoint);
        return checkpoint;
    }
    /**
     * Restore a checkpoint.
     */
    restore(id) {
        const checkpoint = this.checkpoints.get(id);
        if (!checkpoint)
            return null;
        logger.info(`[checkpoint] Restored ${checkpoint.name}`);
        this.emit('restored', checkpoint);
        return checkpoint.state;
    }
    /**
     * Delete a checkpoint.
     */
    delete(id) {
        const checkpoint = this.checkpoints.get(id);
        if (!checkpoint)
            return false;
        this.checkpoints.delete(id);
        this.deleteCheckpointFile(id);
        return true;
    }
    /**
     * List checkpoints.
     */
    list(options = {}) {
        let results = Array.from(this.checkpoints.values());
        if (options.name)
            results = results.filter((c) => c.name.includes(options.name));
        results.sort((a, b) => b.createdAt - a.createdAt);
        if (options.limit)
            results = results.slice(0, options.limit);
        return results;
    }
    /**
     * Get checkpoint.
     */
    get(id) {
        return this.checkpoints.get(id) || null;
    }
    /**
     * Compare two checkpoints.
     */
    diff(id1, id2) {
        const c1 = this.checkpoints.get(id1);
        const c2 = this.checkpoints.get(id2);
        if (!c1 || !c2)
            return null;
        const keys1 = new Set(Object.keys(c1.state));
        const keys2 = new Set(Object.keys(c2.state));
        const added = [...keys2].filter((k) => !keys1.has(k));
        const removed = [...keys1].filter((k) => !keys2.has(k));
        const changed = [...keys1].filter((k) => keys2.has(k) && JSON.stringify(c1.state[k]) !== JSON.stringify(c2.state[k]));
        return { added, removed, changed };
    }
    saveCheckpoint(checkpoint) {
        const file = join(this.checkpointDir, `${checkpoint.id}.json`);
        writeFileSync(file, JSON.stringify(checkpoint, null, 2), 'utf-8');
    }
    deleteCheckpointFile(id) {
        const file = join(this.checkpointDir, `${id}.json`);
        try {
            unlinkSync(file);
        }
        catch { /* ignore */ }
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _checkpointManager = null;
export function getCheckpointManager() {
    if (!_checkpointManager)
        _checkpointManager = new CheckpointManager();
    return _checkpointManager;
}
export function resetCheckpointManager() {
    _checkpointManager = null;
}
//# sourceMappingURL=checkpoint-manager.js.map
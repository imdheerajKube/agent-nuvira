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
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';

// ─── Types ────────────────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  name: string;
  description?: string;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: number;
  sizeBytes: number;
}

// ─── Checkpoint Manager ──────────────────────────────────────────────────

export class CheckpointManager extends EventEmitter {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private checkpointDir: string;
  private maxCheckpoints: number = 50;

  constructor() {
    super();
    this.checkpointDir = join(homedir(), '.buff', 'cache', 'checkpoints');
    this.ensureDir();
    this.loadCheckpoints();
  }

  private ensureDir(): void {
    if (!existsSync(this.checkpointDir)) {
      mkdirSync(this.checkpointDir, { recursive: true });
    }
  }

  private loadCheckpoints(): void {
    try {
      const files = readdirSync(this.checkpointDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const data = readFileSync(join(this.checkpointDir, file), 'utf-8');
        const checkpoint: Checkpoint = JSON.parse(data);
        this.checkpoints.set(checkpoint.id, checkpoint);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Create a checkpoint.
   */
  create(name: string, state: Record<string, unknown>, options: { description?: string; metadata?: Record<string, unknown> } = {}): Checkpoint {
    const id = randomUUID();
    const stateJson = JSON.stringify(state);
    const checkpoint: Checkpoint = {
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
  restore(id: string): Record<string, unknown> | null {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) return null;

    logger.info(`[checkpoint] Restored ${checkpoint.name}`);
    this.emit('restored', checkpoint);
    return checkpoint.state;
  }

  /**
   * Delete a checkpoint.
   */
  delete(id: string): boolean {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) return false;

    this.checkpoints.delete(id);
    this.deleteCheckpointFile(id);
    return true;
  }

  /**
   * List checkpoints.
   */
  list(options: { name?: string; limit?: number } = {}): Checkpoint[] {
    let results = Array.from(this.checkpoints.values());
    if (options.name) results = results.filter((c) => c.name.includes(options.name!));
    results.sort((a, b) => b.createdAt - a.createdAt);
    if (options.limit) results = results.slice(0, options.limit);
    return results;
  }

  /**
   * Get checkpoint.
   */
  get(id: string): Checkpoint | null {
    return this.checkpoints.get(id) || null;
  }

  /**
   * Compare two checkpoints.
   */
  diff(id1: string, id2: string): { added: string[]; removed: string[]; changed: string[] } | null {
    const c1 = this.checkpoints.get(id1);
    const c2 = this.checkpoints.get(id2);
    if (!c1 || !c2) return null;

    const keys1 = new Set(Object.keys(c1.state));
    const keys2 = new Set(Object.keys(c2.state));

    const added = [...keys2].filter((k) => !keys1.has(k));
    const removed = [...keys1].filter((k) => !keys2.has(k));
    const changed = [...keys1].filter((k) => keys2.has(k) && JSON.stringify(c1.state[k]) !== JSON.stringify(c2.state[k]));

    return { added, removed, changed };
  }

  private saveCheckpoint(checkpoint: Checkpoint): void {
    const file = join(this.checkpointDir, `${checkpoint.id}.json`);
    writeFileSync(file, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  private deleteCheckpointFile(id: string): void {
    const file = join(this.checkpointDir, `${id}.json`);
    try { unlinkSync(file); } catch { /* ignore */ }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _checkpointManager: CheckpointManager | null = null;

export function getCheckpointManager(): CheckpointManager {
  if (!_checkpointManager) _checkpointManager = new CheckpointManager();
  return _checkpointManager;
}

export function resetCheckpointManager(): void {
  _checkpointManager = null;
}

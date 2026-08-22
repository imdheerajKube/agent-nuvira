/**
 * Process Registry — Track all running processes.
 *
 * Hermes equivalent: process_registry.py (2,529 lines)
 *
 * Provides:
 * - Register and track all spawned processes
 * - Process metadata (command, args, cwd, env)
 * - Cleanup on exit
 * - Process tree tracking
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ProcessInfo {
  id: string;
  pid: number;
  command: string;
  args: string[];
  cwd?: string;
  status: 'running' | 'stopped' | 'failed';
  startedAt: number;
  stoppedAt?: number;
  exitCode?: number;
  parent?: string;
  children: string[];
  metadata: Record<string, unknown>;
}

// ─── Process Registry ────────────────────────────────────────────────────

export class ProcessRegistry extends EventEmitter {
  private processes: Map<string, ProcessInfo> = new Map();

  /**
   * Register a process.
   */
  register(pid: number, command: string, args: string[] = [], options: { cwd?: string; parent?: string; metadata?: Record<string, unknown> } = {}): ProcessInfo {
    const id = randomUUID();
    const info: ProcessInfo = {
      id,
      pid,
      command,
      args,
      cwd: options.cwd,
      status: 'running',
      startedAt: Date.now(),
      parent: options.parent,
      children: [],
      metadata: options.metadata || {},
    };

    this.processes.set(id, info);

    // Add to parent's children
    if (options.parent) {
      const parent = this.processes.get(options.parent);
      if (parent) parent.children.push(id);
    }

    logger.debug(`[process] Registered ${command} (pid: ${pid})`);
    this.emit('registered', info);
    return info;
  }

  /**
   * Mark a process as stopped.
   */
  stop(id: string, exitCode?: number): void {
    const info = this.processes.get(id);
    if (!info) return;

    info.status = 'stopped';
    info.stoppedAt = Date.now();
    info.exitCode = exitCode;

    this.emit('stopped', info);
  }

  /**
   * Get process info.
   */
  get(id: string): ProcessInfo | null {
    return this.processes.get(id) || null;
  }

  /**
   * Find by PID.
   */
  findByPid(pid: number): ProcessInfo | null {
    for (const info of this.processes.values()) {
      if (info.pid === pid) return info;
    }
    return null;
  }

  /**
   * List all processes.
   */
  list(options: { status?: string; parent?: string } = {}): ProcessInfo[] {
    let results = Array.from(this.processes.values());
    if (options.status) results = results.filter((p) => p.status === options.status);
    if (options.parent) results = results.filter((p) => p.parent === options.parent);
    return results;
  }

  /**
   * Get process tree for a root process.
   */
  getTree(rootId: string): ProcessInfo[] {
    const tree: ProcessInfo[] = [];
    const visit = (id: string) => {
      const info = this.processes.get(id);
      if (!info) return;
      tree.push(info);
      for (const childId of info.children) {
        visit(childId);
      }
    };
    visit(rootId);
    return tree;
  }

  /**
   * Cleanup stopped processes older than maxAge.
   */
  cleanup(maxAgeMs: number = 3600_000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, info] of this.processes) {
      if (info.status === 'stopped' && info.stoppedAt && (now - info.stoppedAt) > maxAgeMs) {
        this.processes.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Kill a process by ID.
   */
  kill(id: string): boolean {
    const info = this.processes.get(id);
    if (!info || info.status !== 'running') return false;

    try {
      process.kill(info.pid, 'SIGTERM');
      info.status = 'stopped';
      info.stoppedAt = Date.now();
      this.emit('killed', info);
      return true;
    } catch (err) {
      logger.warn(`[process] Failed to kill ${info.pid}: ${err}`);
      return false;
    }
  }

  /**
   * Kill all running processes.
   */
  killAll(): number {
    let killed = 0;
    for (const [id, info] of this.processes) {
      if (info.status === 'running') {
        if (this.kill(id)) killed++;
      }
    }
    return killed;
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; running: number; stopped: number; failed: number } {
    const all = Array.from(this.processes.values());
    return {
      total: all.length,
      running: all.filter((p) => p.status === 'running').length,
      stopped: all.filter((p) => p.status === 'stopped').length,
      failed: all.filter((p) => p.status === 'failed').length,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _processRegistry: ProcessRegistry | null = null;

export function getProcessRegistry(): ProcessRegistry {
  if (!_processRegistry) _processRegistry = new ProcessRegistry();
  return _processRegistry;
}

export function resetProcessRegistry(): void {
  _processRegistry?.killAll();
  _processRegistry = null;
}

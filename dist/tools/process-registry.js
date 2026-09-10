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
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';
// ─── Process Registry ────────────────────────────────────────────────────
export class ProcessRegistry extends EventEmitter {
    processes = new Map();
    /**
     * Register a process.
     */
    register(pid, command, args = [], options = {}) {
        const id = randomUUID();
        const info = {
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
            if (parent)
                parent.children.push(id);
        }
        logger.debug(`[process] Registered ${command} (pid: ${pid})`);
        this.emit('registered', info);
        return info;
    }
    /**
     * Mark a process as stopped.
     */
    stop(id, exitCode) {
        const info = this.processes.get(id);
        if (!info)
            return;
        info.status = 'stopped';
        info.stoppedAt = Date.now();
        info.exitCode = exitCode;
        this.emit('stopped', info);
    }
    /**
     * Get process info.
     */
    get(id) {
        return this.processes.get(id) || null;
    }
    /**
     * Find by PID.
     */
    findByPid(pid) {
        for (const info of this.processes.values()) {
            if (info.pid === pid)
                return info;
        }
        return null;
    }
    /**
     * List all processes.
     */
    list(options = {}) {
        let results = Array.from(this.processes.values());
        if (options.status)
            results = results.filter((p) => p.status === options.status);
        if (options.parent)
            results = results.filter((p) => p.parent === options.parent);
        return results;
    }
    /**
     * Get process tree for a root process.
     */
    getTree(rootId) {
        const tree = [];
        const visit = (id) => {
            const info = this.processes.get(id);
            if (!info)
                return;
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
    cleanup(maxAgeMs = 3600_000) {
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
    kill(id) {
        const info = this.processes.get(id);
        if (!info || info.status !== 'running')
            return false;
        try {
            process.kill(info.pid, 'SIGTERM');
            info.status = 'stopped';
            info.stoppedAt = Date.now();
            this.emit('killed', info);
            return true;
        }
        catch (err) {
            logger.warn(`[process] Failed to kill ${info.pid}: ${err}`);
            return false;
        }
    }
    /**
     * Kill all running processes.
     */
    killAll() {
        let killed = 0;
        for (const [id, info] of this.processes) {
            if (info.status === 'running') {
                if (this.kill(id))
                    killed++;
            }
        }
        return killed;
    }
    /**
     * Get stats.
     */
    getStats() {
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
let _processRegistry = null;
export function getProcessRegistry() {
    if (!_processRegistry)
        _processRegistry = new ProcessRegistry();
    return _processRegistry;
}
export function resetProcessRegistry() {
    _processRegistry?.killAll();
    _processRegistry = null;
}
//# sourceMappingURL=process-registry.js.map
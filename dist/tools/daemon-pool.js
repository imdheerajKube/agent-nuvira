/**
 * Daemon Pool — Background daemon process management.
 *
 * Hermes equivalent: daemon_pool.py (64 lines)
 *
 * Provides:
 * - Spawn and manage background daemon processes
 * - Health monitoring with auto-restart
 * - Graceful shutdown
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';
// ─── Daemon Pool ──────────────────────────────────────────────────────────
export class DaemonPool extends EventEmitter {
    daemons = new Map();
    processes = new Map();
    healthTimers = new Map();
    /**
     * Register a daemon.
     */
    register(config) {
        const id = randomUUID();
        const state = {
            id,
            name: config.name,
            status: 'stopped',
            config,
            startedAt: Date.now(),
            restartCount: 0,
        };
        this.daemons.set(id, state);
        return state;
    }
    /**
     * Start a daemon.
     */
    start(id) {
        const state = this.daemons.get(id);
        if (!state)
            return null;
        const child = spawn(state.config.command, state.config.args || [], {
            cwd: state.config.cwd,
            env: { ...process.env, ...state.config.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        state.pid = child.pid;
        state.status = 'running';
        state.startedAt = Date.now();
        this.processes.set(id, child);
        this.setupHealthCheck(id, child);
        child.on('exit', (code) => {
            logger.warn(`[daemon] ${state.name} exited with code ${code}`);
            state.status = 'stopped';
            state.stoppedAt = Date.now();
            this.processes.delete(id);
            this.clearHealthCheck(id);
            if (state.config.autoRestart && state.restartCount < (state.config.maxRestarts || 3)) {
                state.restartCount++;
                state.status = 'restarting';
                logger.info(`[daemon] Restarting ${state.name} (attempt ${state.restartCount})`);
                setTimeout(() => this.start(id), 1000);
            }
        });
        logger.info(`[daemon] Started ${state.name} (pid: ${child.pid})`);
        this.emit('started', state);
        return state;
    }
    /**
     * Stop a daemon.
     */
    stop(id) {
        const state = this.daemons.get(id);
        const child = this.processes.get(id);
        if (!state || !child)
            return false;
        child.kill('SIGTERM');
        state.status = 'stopped';
        state.stoppedAt = Date.now();
        this.processes.delete(id);
        this.clearHealthCheck(id);
        logger.info(`[daemon] Stopped ${state.name}`);
        this.emit('stopped', state);
        return true;
    }
    /**
     * Stop all daemons.
     */
    stopAll() {
        for (const [id] of this.daemons) {
            this.stop(id);
        }
    }
    /**
     * Get daemon state.
     */
    getState(id) {
        return this.daemons.get(id) || null;
    }
    /**
     * List all daemons.
     */
    list() {
        return Array.from(this.daemons.values());
    }
    /**
     * Health check setup.
     */
    setupHealthCheck(id, child) {
        const state = this.daemons.get(id);
        if (!state || !state.config.healthCheckMs)
            return;
        const timer = setInterval(() => {
            state.lastHealthCheck = Date.now();
            state.healthy = child.exitCode === null;
            if (!state.healthy) {
                logger.warn(`[daemon] ${state.name} unhealthy`);
                this.emit('unhealthy', state);
            }
        }, state.config.healthCheckMs);
        this.healthTimers.set(id, timer);
    }
    clearHealthCheck(id) {
        const timer = this.healthTimers.get(id);
        if (timer) {
            clearInterval(timer);
            this.healthTimers.delete(id);
        }
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _daemonPool = null;
export function getDaemonPool() {
    if (!_daemonPool)
        _daemonPool = new DaemonPool();
    return _daemonPool;
}
export function resetDaemonPool() {
    _daemonPool?.stopAll();
    _daemonPool = null;
}
//# sourceMappingURL=daemon-pool.js.map
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
import { EventEmitter } from 'node:events';
export interface DaemonConfig {
    name: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    autoRestart?: boolean;
    maxRestarts?: number;
    healthCheckMs?: number;
}
export interface DaemonState {
    id: string;
    name: string;
    pid?: number;
    status: 'starting' | 'running' | 'stopped' | 'failed' | 'restarting';
    config: DaemonConfig;
    startedAt: number;
    stoppedAt?: number;
    restartCount: number;
    lastHealthCheck?: number;
    healthy?: boolean;
}
export declare class DaemonPool extends EventEmitter {
    private daemons;
    private processes;
    private healthTimers;
    /**
     * Register a daemon.
     */
    register(config: DaemonConfig): DaemonState;
    /**
     * Start a daemon.
     */
    start(id: string): DaemonState | null;
    /**
     * Stop a daemon.
     */
    stop(id: string): boolean;
    /**
     * Stop all daemons.
     */
    stopAll(): void;
    /**
     * Get daemon state.
     */
    getState(id: string): DaemonState | null;
    /**
     * List all daemons.
     */
    list(): DaemonState[];
    /**
     * Health check setup.
     */
    private setupHealthCheck;
    private clearHealthCheck;
}
export declare function getDaemonPool(): DaemonPool;
export declare function resetDaemonPool(): void;
//# sourceMappingURL=daemon-pool.d.ts.map
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
import { EventEmitter } from 'node:events';
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
export declare class ProcessRegistry extends EventEmitter {
    private processes;
    /**
     * Register a process.
     */
    register(pid: number, command: string, args?: string[], options?: {
        cwd?: string;
        parent?: string;
        metadata?: Record<string, unknown>;
    }): ProcessInfo;
    /**
     * Mark a process as stopped.
     */
    stop(id: string, exitCode?: number): void;
    /**
     * Get process info.
     */
    get(id: string): ProcessInfo | null;
    /**
     * Find by PID.
     */
    findByPid(pid: number): ProcessInfo | null;
    /**
     * List all processes.
     */
    list(options?: {
        status?: string;
        parent?: string;
    }): ProcessInfo[];
    /**
     * Get process tree for a root process.
     */
    getTree(rootId: string): ProcessInfo[];
    /**
     * Cleanup stopped processes older than maxAge.
     */
    cleanup(maxAgeMs?: number): number;
    /**
     * Kill a process by ID.
     */
    kill(id: string): boolean;
    /**
     * Kill all running processes.
     */
    killAll(): number;
    /**
     * Get stats.
     */
    getStats(): {
        total: number;
        running: number;
        stopped: number;
        failed: number;
    };
}
export declare function getProcessRegistry(): ProcessRegistry;
export declare function resetProcessRegistry(): void;
//# sourceMappingURL=process-registry.d.ts.map
/**
 * Terminal Tool — Execute commands in local, Docker, Modal, SSH environments.
 *
 * Hermes equivalent: terminal_tool.py (3,419 lines)
 *
 * Features:
 * - Multiple execution backends (local, docker, modal, ssh)
 * - Background task support
 * - VM/container lifecycle management
 * - Automatic cleanup after inactivity
 * - Interrupt support
 * - Output streaming
 */
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
export type TerminalEnv = 'local' | 'docker' | 'modal' | 'ssh' | 'vercel_sandbox';
export interface TerminalConfig {
    /** Execution environment */
    env?: TerminalEnv;
    /** Working directory */
    cwd?: string;
    /** Timeout in ms */
    timeoutMs?: number;
    /** Environment variables */
    envVars?: Record<string, string>;
    /** Docker image (for docker env) */
    dockerImage?: string;
    /** SSH host (for ssh env) */
    sshHost?: string;
    /** SSH user */
    sshUser?: string;
    /** Run in background */
    background?: boolean;
}
export interface TerminalResult {
    id: string;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    env: TerminalEnv;
    timedOut: boolean;
    background?: boolean;
    pid?: number;
}
export interface TerminalTask {
    id: string;
    command: string;
    process: ChildProcess;
    startedAt: number;
    status: 'running' | 'completed' | 'failed' | 'killed';
}
export declare class TerminalManager extends EventEmitter {
    private tasks;
    private taskDir;
    private defaultEnv;
    private maxConcurrent;
    constructor(config?: {
        defaultEnv?: TerminalEnv;
        maxConcurrent?: number;
    });
    private ensureDir;
    /**
     * Execute a command.
     */
    execute(command: string, config?: TerminalConfig): Promise<TerminalResult>;
    /**
     * Execute locally.
     */
    private executeLocal;
    /**
     * Execute in Docker.
     */
    private executeDocker;
    /**
     * Execute via SSH.
     */
    private executeSSH;
    /**
     * Execute in Modal (placeholder).
     */
    private executeModal;
    /**
     * Kill a running task.
     */
    kill(taskId: string): boolean;
    /**
     * Get task status.
     */
    getTask(taskId: string): TerminalTask | null;
    /**
     * List running tasks.
     */
    listTasks(): TerminalTask[];
    /**
     * Kill all running tasks.
     */
    killAll(): number;
    /**
     * Cleanup old tasks.
     */
    private startCleanupTimer;
}
export declare function getTerminalManager(config?: {
    defaultEnv?: TerminalEnv;
}): TerminalManager;
export declare function resetTerminalManager(): void;
//# sourceMappingURL=terminal-tool.d.ts.map
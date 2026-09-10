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
import { spawn } from 'node:child_process';
import { resolveNuviraHome } from '../config/paths.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';
// ─── Terminal Manager ────────────────────────────────────────────────────
export class TerminalManager extends EventEmitter {
    tasks = new Map();
    taskDir;
    defaultEnv;
    maxConcurrent = 5;
    constructor(config = {}) {
        super();
        this.defaultEnv = config.defaultEnv || process.env.TERMINAL_ENV || 'local';
        this.maxConcurrent = config.maxConcurrent || 5;
        this.taskDir = join(resolveNuviraHome(), 'cache', 'terminal');
        this.ensureDir();
        this.startCleanupTimer();
    }
    ensureDir() {
        if (!existsSync(this.taskDir)) {
            mkdirSync(this.taskDir, { recursive: true });
        }
    }
    /**
     * Execute a command.
     */
    async execute(command, config = {}) {
        const id = randomUUID();
        const env = config.env || this.defaultEnv;
        const startTime = Date.now();
        const timeoutMs = config.timeoutMs || 30_000;
        // Check concurrency
        const running = Array.from(this.tasks.values()).filter((t) => t.status === 'running');
        if (running.length >= this.maxConcurrent) {
            return {
                id,
                command,
                exitCode: 1,
                stdout: '',
                stderr: `Max concurrent tasks (${this.maxConcurrent}) reached`,
                durationMs: 0,
                env,
                timedOut: false,
            };
        }
        logger.debug(`[terminal] Executing: ${command} (env: ${env})`);
        try {
            switch (env) {
                case 'docker':
                    return await this.executeDocker(command, config, id, startTime, timeoutMs);
                case 'ssh':
                    return await this.executeSSH(command, config, id, startTime, timeoutMs);
                case 'modal':
                    return await this.executeModal(command, config, id, startTime, timeoutMs);
                case 'local':
                default:
                    return await this.executeLocal(command, config, id, startTime, timeoutMs);
            }
        }
        catch (err) {
            return {
                id,
                command,
                exitCode: 1,
                stdout: '',
                stderr: String(err),
                durationMs: Date.now() - startTime,
                env,
                timedOut: false,
            };
        }
    }
    /**
     * Execute locally.
     */
    async executeLocal(command, config, id, startTime, timeoutMs) {
        return new Promise((resolve) => {
            const child = spawn('bash', ['-c', command], {
                cwd: config.cwd || process.cwd(),
                env: { ...process.env, ...config.envVars },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, timeoutMs);
            // Track task
            const task = {
                id,
                command,
                process: child,
                startedAt: startTime,
                status: 'running',
            };
            this.tasks.set(id, task);
            child.stdout?.on('data', (data) => { stdout += data.toString(); });
            child.stderr?.on('data', (data) => { stderr += data.toString(); });
            child.on('close', (exitCode) => {
                clearTimeout(timer);
                task.status = exitCode === 0 ? 'completed' : 'failed';
                this.tasks.delete(id);
                resolve({
                    id,
                    command,
                    exitCode: exitCode || 0,
                    stdout,
                    stderr,
                    durationMs: Date.now() - startTime,
                    env: 'local',
                    timedOut,
                });
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                task.status = 'failed';
                this.tasks.delete(id);
                resolve({
                    id,
                    command,
                    exitCode: 1,
                    stdout: '',
                    stderr: err.message,
                    durationMs: Date.now() - startTime,
                    env: 'local',
                    timedOut: false,
                });
            });
        });
    }
    /**
     * Execute in Docker.
     */
    async executeDocker(command, config, id, startTime, timeoutMs) {
        const image = config.dockerImage || 'node:18-alpine';
        const dockerCmd = `docker run --rm ${config.cwd ? `-v ${config.cwd}:/workspace -w /workspace` : ''} ${image} sh -c '${command.replace(/'/g, "'\\''")}'`;
        return this.executeLocal(dockerCmd, { ...config, env: 'docker' }, id, startTime, timeoutMs);
    }
    /**
     * Execute via SSH.
     */
    async executeSSH(command, config, id, startTime, timeoutMs) {
        if (!config.sshHost) {
            return {
                id,
                command,
                exitCode: 1,
                stdout: '',
                stderr: 'sshHost required for SSH execution',
                durationMs: 0,
                env: 'ssh',
                timedOut: false,
            };
        }
        const user = config.sshUser || 'root';
        const sshCmd = `ssh ${user}@${config.sshHost} '${command.replace(/'/g, "'\\''")}'`;
        return this.executeLocal(sshCmd, { ...config, env: 'ssh' }, id, startTime, timeoutMs);
    }
    /**
     * Execute in Modal (placeholder).
     */
    async executeModal(command, config, id, startTime, timeoutMs) {
        // Modal execution would require Modal SDK
        // For now, fall back to local
        logger.warn('[terminal] Modal execution not implemented, falling back to local');
        return this.executeLocal(command, { ...config, env: 'local' }, id, startTime, timeoutMs);
    }
    /**
     * Kill a running task.
     */
    kill(taskId) {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'running')
            return false;
        task.process.kill('SIGTERM');
        task.status = 'killed';
        this.tasks.delete(taskId);
        return true;
    }
    /**
     * Get task status.
     */
    getTask(taskId) {
        return this.tasks.get(taskId) || null;
    }
    /**
     * List running tasks.
     */
    listTasks() {
        return Array.from(this.tasks.values());
    }
    /**
     * Kill all running tasks.
     */
    killAll() {
        let killed = 0;
        for (const [id] of this.tasks) {
            if (this.kill(id))
                killed++;
        }
        return killed;
    }
    /**
     * Cleanup old tasks.
     */
    startCleanupTimer() {
        setInterval(() => {
            const now = Date.now();
            for (const [id, task] of this.tasks) {
                if (task.status !== 'running' && (now - task.startedAt) > 3600_000) {
                    this.tasks.delete(id);
                }
            }
        }, 60_000);
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _terminalManager = null;
export function getTerminalManager(config) {
    if (!_terminalManager || config)
        _terminalManager = new TerminalManager(config);
    return _terminalManager;
}
export function resetTerminalManager() {
    _terminalManager?.killAll();
    _terminalManager = null;
}
//# sourceMappingURL=terminal-tool.js.map
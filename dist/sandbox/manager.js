/**
 * SandboxManager — Docker-based sandbox isolation for code execution.
 *
 * Provides:
 * - Container lifecycle management (create, exec, destroy)
 * - Resource limits (CPU, memory, disk, PIDs, network)
 * - Volume/project mounting
 * - Command execution with timeout enforcement
 * - Non-root user execution
 *
 * Usage:
 * ```ts
 * const manager = new SandboxManager();
 *
 * // Check if Docker is available
 * const available = await manager.isDockerAvailable();
 *
 * // Create a sandbox
 * const containerId = await manager.createContainer('node:20-slim', {
 *   memoryLimit: '512m',
 *   cpuLimit: 1,
 *   networkAccess: false,
 * });
 *
 * // Copy project, run commands
 * await manager.copyProjectToContainer(containerId, '/path/to/project');
 * const result = await manager.runCommand(containerId, 'npm test');
 *
 * // Always clean up
 * await manager.destroyContainer(containerId);
 * ```
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readdirSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { getHostShell } from '../utils/shell.js';
import { DEFAULT_RESOURCE_LIMITS, getSandboxConfig, } from './types.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Maximum number of managed containers to track */
const MAX_CONTAINERS = 20;
/** Temporary directory for building context before copying to container */
const BUFF_TMP_PREFIX = 'buff-docker-';
// ─── SandboxManager ─────────────────────────────────────────────────────────
export class SandboxManager {
    config;
    /** Managed containers tracked by this manager instance */
    containers = new Map();
    /** Whether Docker availability has been checked */
    dockerChecked = false;
    /** Cached result of Docker availability check */
    dockerAvailable = false;
    /** Cached error message from Docker check */
    dockerError = '';
    constructor(config = getSandboxConfig()) {
        this.config = config;
    }
    // ─── Docker Availability ──────────────────────────────────────────────────
    /**
     * Check if Docker is installed and the daemon is running.
     * Caches the result so repeated calls are instant.
     */
    async isDockerAvailable() {
        if (this.dockerChecked)
            return this.dockerAvailable;
        try {
            const result = await this.execHostCommand('docker info --format "{{.ServerVersion}}"');
            this.dockerAvailable = result.exitCode === 0 && result.stdout.trim().length > 0;
            this.dockerError = result.stderr;
        }
        catch (err) {
            this.dockerAvailable = false;
            this.dockerError = err instanceof Error ? err.message : String(err);
        }
        this.dockerChecked = true;
        return this.dockerAvailable;
    }
    /**
     * Get the error message from the last Docker availability check.
     */
    getDockerError() {
        return this.dockerError;
    }
    /**
     * Force re-check Docker availability on the next call.
     */
    resetDockerCheck() {
        this.dockerChecked = false;
    }
    // ─── Container Lifecycle ─────────────────────────────────────────────────
    /**
     * Create a Docker sandbox container with the given image and resource limits.
     *
     * @param image - Docker image to use (e.g., 'node:20-slim')
     * @param limits - Resource limit overrides
     * @param workDir - Working directory inside the container
     * @returns The container ID
     */
    async createContainer(image, limits, workDir) {
        if (!(await this.isDockerAvailable())) {
            throw new Error('Docker is not available. ' + (this.dockerError || 'Is Docker installed and running?'));
        }
        // Enforce max container limit
        if (this.containers.size >= MAX_CONTAINERS) {
            // Clean up stale containers (created > 30 min ago)
            await this.cleanupStaleContainers();
            if (this.containers.size >= MAX_CONTAINERS) {
                throw new Error(`Maximum of ${MAX_CONTAINERS} sandbox containers reached. ` +
                    'Please destroy unused containers with destroyContainer().');
            }
        }
        const resolvedImage = image || this.config.image.image;
        const resolvedLimits = { ...DEFAULT_RESOURCE_LIMITS, ...limits };
        const resolvedWorkDir = workDir || this.config.workDir;
        // Generate unique container name
        const name = 'buff-sandbox-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        // Build docker run arguments
        const args = [
            'run',
            '--detach', // Run in background
            '--name', name, // Assign a name for easy reference
            '--workdir', resolvedWorkDir, // Set working directory
            '--init', // Use tini as init for proper signal handling
            '--stop-timeout', String(Math.floor(this.config.stopTimeoutMs / 1000)),
        ];
        // Resource limits
        args.push('--memory', resolvedLimits.memoryLimit);
        args.push('--memory-swap', resolvedLimits.memoryLimit); // No swap
        args.push('--cpus', String(resolvedLimits.cpuLimit));
        args.push('--pids-limit', String(resolvedLimits.pidsLimit));
        // Disk / storage limit (via size quota if available)
        try {
            args.push('--storage-opt', `size=${resolvedLimits.diskLimit}`);
        }
        catch {
            // storage-opt may not be supported on all Docker configurations
        }
        // Network access
        if (!resolvedLimits.networkAccess) {
            args.push('--network', 'none');
        }
        // Security: read-only root filesystem, drop capabilities, non-root user
        args.push('--read-only'); // Read-only root filesystem
        args.push('--cap-drop', 'ALL'); // Drop all Linux capabilities
        args.push('--security-opt', 'no-new-privileges:true'); // No privilege escalation
        args.push('--user', this.config.containerUser);
        // Create a writable tmp directory for the workspace
        args.push('--tmpfs', '/tmp:noexec,nosuid,size=64m');
        // Mount a temp directory for workspace (rw since / is read-only)
        const hostTmpDir = mkdtempSync(join(tmpdir(), BUFF_TMP_PREFIX));
        args.push('--mount', `type=bind,source=${hostTmpDir},target=${resolvedWorkDir}`);
        args.push('--env', `BUFF_WORKSPACE=${resolvedWorkDir}`);
        // The image
        args.push(resolvedImage);
        // Keep the container alive
        args.push('tail', '-f', '/dev/null');
        // Run the container
        const runResult = await this.execHostCommand(`docker ${args.join(' ')}`, 120_000);
        if (runResult.exitCode !== 0) {
            throw new Error(`Failed to create sandbox container: ${runResult.stderr || runResult.stdout}`);
        }
        const containerId = runResult.stdout.trim();
        const managed = {
            containerId,
            name,
            createdAt: Date.now(),
            status: 'created',
            limits: resolvedLimits,
            image: resolvedImage,
        };
        this.containers.set(containerId, managed);
        logger.debug(`Created sandbox container: ${name} (${containerId.slice(0, 12)}...)`);
        return containerId;
    }
    /**
     * Copy project files (or a specific directory) into the sandbox container.
     *
     * Uses `docker cp` to copy files into the container's working directory.
     *
     * @param containerId - Container ID
     * @param sourceDir - Source directory on the host
     * @param targetDir - Target directory inside container (defaults to workDir)
     */
    async copyProjectToContainer(containerId, sourceDir, targetDir) {
        const container = this.ensureContainer(containerId);
        const resolvedTarget = targetDir || this.config.workDir;
        if (!existsSync(sourceDir)) {
            throw new Error(`Source directory does not exist: ${sourceDir}`);
        }
        // Use docker cp to copy the project
        // We need to ensure the target directory exists first
        await this.execInContainer(containerId, `mkdir -p "${resolvedTarget}"`);
        // Copy each top-level entry (excluding node_modules, .git, etc.)
        const entries = readdirSync(sourceDir);
        // Use tar for efficient copying (docker cp supports piping via tar)
        const excluded = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.cache', '__pycache__']);
        const visibleEntries = entries.filter((e) => !e.startsWith('.') && !excluded.has(e));
        if (visibleEntries.length === 0) {
            // Just cop an empty directory structure
            return;
        }
        // Use a tar pipe for efficient bulk copy
        const tarArgs = visibleEntries.map((e) => `"${join(sourceDir, e)}"`).join(' ');
        const copyCmd = `tar cf - ${tarArgs} | docker exec -i "${containerId}" tar xf - -C "${resolvedTarget}"`;
        const result = await this.execHostCommand(copyCmd, 120_000);
        if (result.exitCode !== 0) {
            // Fall back to individual copies
            for (const entry of visibleEntries) {
                try {
                    await this.execHostCommand(`docker cp "${join(sourceDir, entry)}" "${containerId}:${resolvedTarget}/"`, 60_000);
                }
                catch {
                    // Skip files that fail to copy
                    logger.debug(`Failed to copy ${entry} to sandbox`);
                }
            }
        }
        logger.debug(`Copied ${visibleEntries.length} entries to sandbox container: ${container.name}`);
    }
    /**
     * Execute a command inside the sandbox container with timeout enforcement.
     *
     * @param containerId - Container ID
     * @param command - Command to execute (as a string, passed to /bin/sh -c)
     * @param timeoutMs - Timeout in milliseconds (default: config timeout)
     * @returns Execution result with stdout, stderr, exit code
     */
    async runCommand(containerId, command, timeoutMs) {
        const container = this.ensureContainer(containerId);
        const resolvedTimeout = timeoutMs || this.config.limits.timeoutMs;
        // Escape the command for safe shell execution
        const escapedCommand = command.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        const shell = this.config.image.shell || '/bin/bash';
        const execCmd = `docker exec -i "${container.containerId}" ${shell} -c "${escapedCommand}"`;
        const startTime = Date.now();
        let timedOut = false;
        // Use a timeout wrapper
        const timeoutCmd = `timeout ${Math.floor(resolvedTimeout / 1000)} ${execCmd}`;
        try {
            const result = await this.execHostCommand(timeoutCmd, resolvedTimeout + 10_000);
            if (result.exitCode === 124) {
                // Exit code 124 means 'timeout' command killed the process
                timedOut = true;
            }
            return {
                success: result.exitCode === 0,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: timedOut ? 124 : result.exitCode,
                durationMs: Date.now() - startTime,
                timedOut,
            };
        }
        catch (err) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: -1,
                durationMs: Date.now() - startTime,
                timedOut,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    /**
     * Run a command and stream its stdout output (for long-running commands).
     * Calls onChunk for each line of stdout.
     */
    async runCommandWithOutput(containerId, command, onChunk, timeoutMs) {
        const container = this.ensureContainer(containerId);
        const resolvedTimeout = timeoutMs || this.config.limits.timeoutMs;
        return new Promise((resolvePromise) => {
            const startTime = Date.now();
            const escapedCommand = command.replace(/"/g, '\\"').replace(/`/g, '\\`');
            const shell = this.config.image.shell || '/bin/bash';
            const fullCommand = `docker exec -i "${container.containerId}" ${shell} -c "${escapedCommand}"`;
            const childProcess = spawn(fullCommand, [], {
                shell: getHostShell(),
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: resolvedTimeout,
            });
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                childProcess.kill('SIGTERM');
                // Give it a moment to exit, then SIGKILL
                setTimeout(() => {
                    try {
                        childProcess.kill('SIGKILL');
                    }
                    catch { /* already dead */ }
                }, 2000);
            }, resolvedTimeout);
            childProcess.stdout?.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                onChunk?.(chunk);
            });
            childProcess.stderr?.on('data', (data) => {
                stderr += data.toString();
            });
            childProcess.on('close', (exitCode) => {
                clearTimeout(timer);
                const duration = Date.now() - startTime;
                resolvePromise({
                    success: exitCode === 0,
                    stdout,
                    stderr,
                    exitCode: timedOut ? 124 : (exitCode ?? -1),
                    durationMs: duration,
                    timedOut,
                });
            });
            childProcess.on('error', (err) => {
                clearTimeout(timer);
                resolvePromise({
                    success: false,
                    stdout,
                    stderr: stderr || err.message,
                    exitCode: -1,
                    durationMs: Date.now() - startTime,
                    timedOut: false,
                    error: err.message,
                });
            });
        });
    }
    /**
     * Get the status of a managed container.
     */
    async getContainerStatus(containerId) {
        const container = this.ensureContainer(containerId);
        try {
            const result = await this.execHostCommand(`docker inspect --format "{{.State.Status}}" "${containerId}"`);
            if (result.exitCode === 0) {
                const status = result.stdout.trim();
                container.status = status;
                return status;
            }
        }
        catch {
            // Container might not exist
        }
        container.status = 'removed';
        return 'removed';
    }
    /**
     * Stop and remove a sandbox container.
     */
    async destroyContainer(containerId) {
        const container = this.ensureContainer(containerId);
        try {
            // Stop the container gracefully first
            await this.execHostCommand(`docker stop --time ${Math.floor(this.config.stopTimeoutMs / 1000)} "${containerId}" 2>/dev/null`, 30_000);
        }
        catch {
            // Ignore stop errors
        }
        try {
            // Remove the container
            await this.execHostCommand(`docker rm -f "${containerId}" 2>/dev/null`, 30_000);
        }
        catch {
            // Ignore removal errors
        }
        container.status = 'removed';
        this.containers.delete(containerId);
        logger.debug(`Destroyed sandbox container: ${container.name}`);
    }
    /**
     * Destroy all managed containers.
     */
    async destroyAll() {
        const ids = [...this.containers.keys()];
        await Promise.all(ids.map((id) => this.destroyContainer(id).catch(() => { })));
        this.containers.clear();
    }
    /**
     * Get information about all managed containers.
     */
    getManagedContainers() {
        return [...this.containers.values()];
    }
    // ─── Private Helpers ─────────────────────────────────────────────────────
    /**
     * Ensure a container ID is tracked and still exists.
     */
    ensureContainer(containerId) {
        const container = this.containers.get(containerId);
        if (!container) {
            throw new Error(`Container not managed by this SandboxManager: ${containerId.slice(0, 12)}...`);
        }
        return container;
    }
    /**
     * Run a command on the host machine (not inside a container).
     * Used for docker CLI operations.
     */
    async execHostCommand(command, timeoutMs = 60_000) {
        return new Promise((resolve) => {
            try {
                const output = execSync(command, {
                    timeout: timeoutMs,
                    stdio: 'pipe',
                    encoding: 'utf-8',
                    shell: getHostShell(),
                    maxBuffer: 10 * 1024 * 1024, // 10 MB
                });
                resolve({
                    exitCode: 0,
                    stdout: output.trim(),
                    stderr: '',
                });
            }
            catch (err) {
                const error = err;
                resolve({
                    exitCode: error.status ?? 1,
                    stdout: (typeof error.stdout === 'string' ? error.stdout : String(error.stdout || '')).trim(),
                    stderr: (typeof error.stderr === 'string' ? error.stderr : String(error.stderr || '')).trim(),
                });
            }
        });
    }
    /**
     * Execute a command inside a container using docker exec.
     * Used internally for setup operations like mkdir.
     */
    async execInContainer(containerId, command) {
        const shell = this.config.image.shell || '/bin/bash';
        const escaped = command.replace(/"/g, '\\"');
        return this.execHostCommand(`docker exec "${containerId}" ${shell} -c "${escaped}"`, 30_000);
    }
    /**
     * Remove containers that have been managed for more than 30 minutes.
     */
    async cleanupStaleContainers() {
        const staleTime = Date.now() - 30 * 60 * 1000;
        const stale = [...this.containers.entries()].filter(([_, c]) => c.createdAt < staleTime);
        for (const [id] of stale) {
            try {
                await this.destroyContainer(id);
            }
            catch {
                // Best-effort cleanup
            }
        }
    }
}
// ─── Singleton / Convenience API ────────────────────────────────────────────
let defaultManager = null;
/**
 * Get or create the default SandboxManager singleton.
 */
export function getSandboxManager() {
    if (!defaultManager) {
        defaultManager = new SandboxManager();
    }
    return defaultManager;
}
/**
 * Reset the default SandboxManager singleton (useful for testing).
 */
export function resetSandboxManager() {
    defaultManager = null;
}
//# sourceMappingURL=manager.js.map
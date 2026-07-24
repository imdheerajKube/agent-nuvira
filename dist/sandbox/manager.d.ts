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
import type { ResourceLimits, SandboxConfig, SandboxExecResult, ManagedContainer, ContainerStatus } from './types.js';
export declare class SandboxManager {
    private config;
    /** Managed containers tracked by this manager instance */
    private containers;
    /** Whether Docker availability has been checked */
    private dockerChecked;
    /** Cached result of Docker availability check */
    private dockerAvailable;
    /** Cached error message from Docker check */
    private dockerError;
    constructor(config?: SandboxConfig);
    /**
     * Check if Docker is installed and the daemon is running.
     * Caches the result so repeated calls are instant.
     */
    isDockerAvailable(): Promise<boolean>;
    /**
     * Get the error message from the last Docker availability check.
     */
    getDockerError(): string;
    /**
     * Force re-check Docker availability on the next call.
     */
    resetDockerCheck(): void;
    /**
     * Create a Docker sandbox container with the given image and resource limits.
     *
     * @param image - Docker image to use (e.g., 'node:20-slim')
     * @param limits - Resource limit overrides
     * @param workDir - Working directory inside the container
     * @returns The container ID
     */
    createContainer(image?: string, limits?: Partial<ResourceLimits>, workDir?: string): Promise<string>;
    /**
     * Copy project files (or a specific directory) into the sandbox container.
     *
     * Uses `docker cp` to copy files into the container's working directory.
     *
     * @param containerId - Container ID
     * @param sourceDir - Source directory on the host
     * @param targetDir - Target directory inside container (defaults to workDir)
     */
    copyProjectToContainer(containerId: string, sourceDir: string, targetDir?: string): Promise<void>;
    /**
     * Execute a command inside the sandbox container with timeout enforcement.
     *
     * @param containerId - Container ID
     * @param command - Command to execute (as a string, passed to /bin/sh -c)
     * @param timeoutMs - Timeout in milliseconds (default: config timeout)
     * @returns Execution result with stdout, stderr, exit code
     */
    runCommand(containerId: string, command: string, timeoutMs?: number): Promise<SandboxExecResult>;
    /**
     * Run a command and stream its stdout output (for long-running commands).
     * Calls onChunk for each line of stdout.
     */
    runCommandWithOutput(containerId: string, command: string, onChunk?: (chunk: string) => void, timeoutMs?: number): Promise<SandboxExecResult>;
    /**
     * Get the status of a managed container.
     */
    getContainerStatus(containerId: string): Promise<ContainerStatus>;
    /**
     * Stop and remove a sandbox container.
     */
    destroyContainer(containerId: string): Promise<void>;
    /**
     * Destroy all managed containers.
     */
    destroyAll(): Promise<void>;
    /**
     * Get information about all managed containers.
     */
    getManagedContainers(): ManagedContainer[];
    /**
     * Ensure a container ID is tracked and still exists.
     */
    private ensureContainer;
    /**
     * Run a command on the host machine (not inside a container).
     * Used for docker CLI operations.
     */
    private execHostCommand;
    /**
     * Execute a command inside a container using docker exec.
     * Used internally for setup operations like mkdir.
     */
    private execInContainer;
    /**
     * Remove containers that have been managed for more than 30 minutes.
     */
    private cleanupStaleContainers;
}
/**
 * Get or create the default SandboxManager singleton.
 */
export declare function getSandboxManager(): SandboxManager;
/**
 * Reset the default SandboxManager singleton (useful for testing).
 */
export declare function resetSandboxManager(): void;
//# sourceMappingURL=manager.d.ts.map
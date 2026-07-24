/**
 * Sandbox types — Configuration types for Docker-based sandbox isolation.
 *
 * The sandbox system provides process-level isolation for running generated
 * code and tests inside Docker containers with configurable resource limits.
 *
 * Basic usage:
 * ```ts
 * const manager = new SandboxManager({ memoryLimit: '512m', cpuLimit: 1 });
 * const id = await manager.createContainer();
 * await manager.copyProject(id, '/path/to/project');
 * const result = await manager.runCommand(id, 'npm test');
 * await manager.destroyContainer(id);
 * ```
 */
/** Resource limit constraints for a sandbox container */
export interface ResourceLimits {
    /** Max memory (e.g., '512m', '2g'). Default: '1g' */
    memoryLimit?: string;
    /** Max CPU cores (e.g., 0.5, 1, 2). Default: 1 */
    cpuLimit?: number;
    /** Max disk space (e.g., '1g', '10g'). Default: '2g' */
    diskLimit?: string;
    /** Max PIDs inside container. Default: 100 */
    pidsLimit?: number;
    /** Whether to enable network access. Default: false */
    networkAccess?: boolean;
    /** Max duration in ms before container is killed. Default: 600000 (10 min) */
    timeoutMs?: number;
}
/** A pre-defined or custom Docker image for sandbox containers */
export interface SandboxImage {
    /** Image name (e.g., 'node:20-slim') */
    image: string;
    /** Human-readable label (e.g., 'Node.js 20') */
    label: string;
    /** Package manager / runtime details */
    runtimes: string[];
    /** Install command prefix (e.g., 'npm install') */
    installCommand?: string;
    /** Test command prefix (e.g., 'npm test') */
    testCommand?: string;
    /** Shell to use inside container */
    shell?: string;
}
/** Complete sandbox configuration */
export interface SandboxConfig {
    /** Whether Docker sandbox is enabled */
    enabled: boolean;
    /** Resource limits */
    limits: Required<ResourceLimits>;
    /** Image to use for sandbox containers */
    image: SandboxImage;
    /** Container working directory */
    workDir: string;
    /** Non-root user to run as */
    containerUser: string;
    /** Timeout for stopping a container gracefully (ms) */
    stopTimeoutMs: number;
}
/** Lifecycle state of a managed container */
export type ContainerStatus = 'created' | 'running' | 'stopped' | 'removed';
/** Track a managed sandbox container */
export interface ManagedContainer {
    /** Container ID (Docker container hash) */
    containerId: string;
    /** Human-readable name (e.g., 'buff-sandbox-abc123') */
    name: string;
    /** Creation timestamp */
    createdAt: number;
    /** Current status */
    status: ContainerStatus;
    /** Resource limits applied */
    limits: ResourceLimits;
    /** Image used */
    image: string;
}
/** Result of executing a command inside a sandbox container */
export interface SandboxExecResult {
    /** Whether the command exited with code 0 */
    success: boolean;
    /** Standard output */
    stdout: string;
    /** Standard error */
    stderr: string;
    /** Exit code */
    exitCode: number;
    /** Execution duration in ms */
    durationMs: number;
    /** Whether the container was killed due to timeout */
    timedOut: boolean;
    /** Error message if execution failed entirely */
    error?: string;
}
export declare const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits>;
export declare const DEFAULT_SANDBOX_CONFIG: SandboxConfig;
/**
 * Get the current sandbox configuration.
 * Reads from ~/.buff/sandbox-config.json (if exists), falls back to defaults.
 */
export declare function getSandboxConfig(): SandboxConfig;
/**
 * Update the sandbox configuration and persist to disk.
 */
/**
 * Reset the sandbox config cache. Useful for testing.
 */
export declare function resetSandboxConfigCache(): void;
/**
 * Update the sandbox configuration and persist to disk.
 */
export declare function setSandboxConfig(config: Partial<SandboxConfig>): SandboxConfig;
//# sourceMappingURL=types.d.ts.map
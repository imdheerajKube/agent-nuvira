/**
 * Sandbox Executor — Runs skills in Docker containers for isolation.
 *
 * This provides the same security model as Hermes' `environments/docker.py`:
 * - Untrusted skills run in isolated containers
 * - Network access is restricted (no host access)
 * - Filesystem is read-only except for /tmp
 * - Resource limits (CPU, memory, disk)
 * - Automatic cleanup after execution
 *
 * Flow:
 * 1. Create a temporary Docker container from a minimal image
 * 2. Mount the skill script into the container
 * 3. Inject environment variables (API keys)
 * 4. Execute the script with timeout
 * 5. Capture output and cleanup
 */
export interface SandboxConfig {
    /** Docker image to use (default: node:20-slim) */
    image?: string;
    /** CPU limit (default: 1) */
    cpuLimit?: number;
    /** Memory limit in MB (default: 512) */
    memoryLimitMb?: number;
    /** Disk limit in MB (default: 100) */
    diskLimitMb?: number;
    /** Network mode (default: none for untrusted) */
    networkMode?: 'none' | 'bridge' | 'host';
    /** Timeout in milliseconds (default: 30000) */
    timeoutMs?: number;
    /** Additional volumes to mount */
    volumes?: Array<{
        host: string;
        container: string;
        readonly?: boolean;
    }>;
    /** Additional capabilities to grant */
    capAdd?: string[];
    /** Capabilities to drop */
    capDrop?: string[];
}
export interface SandboxExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    containerId?: string;
}
/**
 * Execute a skill in a Docker sandbox.
 *
 * @param scriptContent - The script content to execute
 * @param scriptPath - Original file path (for runtime detection)
 * @param env - Environment variables to inject
 * @param args - Arguments to pass to the script
 * @param config - Sandbox configuration
 * @returns Execution result
 */
export declare function executeInSandbox(scriptContent: string, scriptPath: string, env?: Record<string, string>, args?: string[], config?: Partial<SandboxConfig>): Promise<SandboxExecutionResult>;
/**
 * Check if Docker is available and running.
 */
export declare function checkDockerAvailable(): Promise<{
    available: boolean;
    version?: string;
    error?: string;
}>;
/**
 * Check if a Docker image exists locally.
 */
export declare function checkImageExists(image: string): Promise<boolean>;
/**
 * Pull a Docker image if it doesn't exist locally.
 */
export declare function pullImageIfNeeded(image: string): Promise<void>;
//# sourceMappingURL=sandbox-executor.d.ts.map
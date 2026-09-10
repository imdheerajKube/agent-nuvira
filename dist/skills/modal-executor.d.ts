/**
 * Modal Cloud Executor — Runs skills in Modal cloud sandboxes.
 *
 * This provides enterprise-grade execution:
 * - Persistent sandboxes across sessions
 * - Custom Docker images
 * - GPU support for ML workloads
 * - File sync between local and cloud
 * - Automatic scaling
 *
 * Flow:
 * 1. Create or resume a Modal sandbox
 * 2. Sync skill files to the sandbox
 * 3. Execute the skill in the cloud
 * 4. Capture output and sync results back
 * 5. Optionally persist the sandbox for reuse
 */
export interface ModalConfig {
    /** Modal image (default: python:3.11) */
    image?: string;
    /** CPU count (default: 1) */
    cpu?: number;
    /** Memory in MB (default: 1024) */
    memoryMb?: number;
    /** GPU type (e.g., 'A10G', 'T4', 'A100') */
    gpu?: string;
    /** Timeout in milliseconds (default: 60000) */
    timeoutMs?: number;
    /** Whether to persist the sandbox */
    persistent?: boolean;
    /** Sandbox name for persistence */
    sandboxName?: string;
    /** Working directory in sandbox */
    cwd?: string;
    /** Secrets to mount */
    secrets?: Record<string, string>;
}
export interface ModalExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    sandboxId?: string;
}
/**
 * Execute a skill in a Modal cloud sandbox.
 *
 * @param scriptContent - The script content to execute
 * @param scriptPath - Original file path (for runtime detection)
 * @param env - Environment variables to inject
 * @param args - Arguments to pass to the script
 * @param config - Modal configuration
 * @returns Execution result
 */
export declare function executeInModal(scriptContent: string, scriptPath: string, env?: Record<string, string>, args?: string[], config?: Partial<ModalConfig>): Promise<ModalExecutionResult>;
/**
 * Check if Modal CLI is available and configured.
 */
export declare function checkModalAvailable(): Promise<{
    available: boolean;
    version?: string;
    error?: string;
}>;
/**
 * List available Modal images.
 */
export declare function listModalImages(): Promise<string[]>;
/**
 * List running Modal sandboxes.
 */
export declare function listModalSandboxes(): Promise<Array<{
    id: string;
    name: string;
    status: string;
}>>;
/**
 * Stop a Modal sandbox.
 */
export declare function stopModalSandbox(sandboxId: string): Promise<boolean>;
//# sourceMappingURL=modal-executor.d.ts.map
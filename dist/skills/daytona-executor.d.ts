/**
 * Daytona Cloud Executor — Runs skills in Daytona cloud sandboxes.
 *
 * This provides enterprise-grade execution with:
 * - Persistent sandboxes across sessions
 * - Resource limits (CPU, memory, disk)
 * - Sandbox lifecycle management (start, stop, resume)
 * - File sync between local and cloud
 *
 * Flow:
 * 1. Create or resume a Daytona sandbox
 * 2. Sync skill files to the sandbox
 * 3. Execute the skill in the cloud
 * 4. Capture output and sync results back
 * 5. Optionally persist the sandbox for reuse
 */
export interface DaytonaConfig {
    /** Daytona image (default: ubuntu:22.04) */
    image?: string;
    /** CPU count (default: 1) */
    cpu?: number;
    /** Memory in MB (default: 5120) */
    memoryMb?: number;
    /** Disk in MB (default: 10240) */
    diskMb?: number;
    /** Timeout in milliseconds (default: 60000) */
    timeoutMs?: number;
    /** Whether to persist the sandbox */
    persistent?: boolean;
    /** Sandbox name for persistence */
    sandboxName?: string;
    /** Working directory in sandbox */
    cwd?: string;
}
export interface DaytonaExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    sandboxId?: string;
}
/**
 * Execute a skill in a Daytona cloud sandbox.
 *
 * @param scriptContent - The script content to execute
 * @param scriptPath - Original file path (for runtime detection)
 * @param env - Environment variables to inject
 * @param args - Arguments to pass to the script
 * @param config - Daytona configuration
 * @returns Execution result
 */
export declare function executeInDaytona(scriptContent: string, scriptPath: string, env?: Record<string, string>, args?: string[], config?: Partial<DaytonaConfig>): Promise<DaytonaExecutionResult>;
/**
 * Check if Daytona CLI is available and configured.
 */
export declare function checkDaytonaAvailable(): Promise<{
    available: boolean;
    version?: string;
    error?: string;
}>;
/**
 * List Daytona sandboxes.
 */
export declare function listDaytonaSandboxes(): Promise<Array<{
    id: string;
    name: string;
    status: string;
}>>;
/**
 * Stop a Daytona sandbox.
 */
export declare function stopDaytonaSandbox(sandboxId: string): Promise<boolean>;
/**
 * Delete a Daytona sandbox.
 */
export declare function deleteDaytonaSandbox(sandboxId: string): Promise<boolean>;
//# sourceMappingURL=daytona-executor.d.ts.map
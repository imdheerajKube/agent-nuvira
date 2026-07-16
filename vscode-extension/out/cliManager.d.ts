/**
 * CLI Manager — Spawns the agent-nuvira CLI as a child process and
 * handles bidirectional communication for agent tasks.
 *
 * Features:
 * - Spawn CLI with proper arguments for each task type
 * - Stream stdout/stderr in real-time
 * - Parse structured output (JSON chunks) from CLI
 * - Handle errors, timeouts, and cleanup
 * - Provide progress callbacks for the webview panel
 */
import type { CLIResult, ExtensionConfig } from './types.js';
/**
 * Manages the lifecycle of a CLI subprocess for agent tasks.
 * Each task gets its own subprocess instance.
 */
export declare class CLIManager {
    private process;
    private config;
    private workspaceRoot;
    private onProgress?;
    private onLog?;
    private abortController;
    constructor(config: ExtensionConfig);
    /**
     * Set progress and log callbacks for real-time updates.
     */
    setCallbacks(opts: {
        onProgress?: (phase: string, detail?: string) => void;
        onLog?: (line: string) => void;
    }): void;
    /**
     * Cancel the currently running task.
     */
    cancel(): void;
    /**
     * Check if a task is currently running.
     */
    get isRunning(): boolean;
    /**
     * Execute a general goal via the multi-agent pipeline.
     * Corresponds to: buff execute <goal>
     */
    executeGoal(goal: string): Promise<CLIResult>;
    /**
     * Quick fix for the current file.
     * Corresponds to: buff edit <file>
     */
    quickFix(filePath: string): Promise<CLIResult>;
    /**
     * Review a file for bugs and improvements.
     * Corresponds to: buff execute "review <file>"
     */
    reviewFile(filePath: string): Promise<CLIResult>;
    /**
     * Explain selected code.
     * Uses a simple chat prompt.
     */
    explainCode(code: string, fileExtension?: string): Promise<CLIResult>;
    /**
     * Generate tests for a file.
     * Corresponds to: buff execute "generate tests for <file>"
     */
    generateTests(filePath: string): Promise<CLIResult>;
    /**
     * Run a workflow template.
     * Corresponds to: buff workflow run <template> <goal>
     */
    runWorkflow(template: string, goal: string): Promise<CLIResult>;
    /**
     * Build CLI arguments with common options.
     */
    private buildArgs;
    /**
     * Get the relative path from workspace root.
     */
    private relativePath;
    /**
     * Run the CLI command and capture output with progress tracking.
     */
    private runCommand;
    /**
     * Report progress update to the registered callback.
     */
    private reportProgress;
    /**
     * Resolve the CLI command and arguments.
     * Returns [command, ...args] for use with spawn().
     */
    private resolveCliCommand;
    /**
     * Clean up resources.
     */
    dispose(): void;
}
//# sourceMappingURL=cliManager.d.ts.map
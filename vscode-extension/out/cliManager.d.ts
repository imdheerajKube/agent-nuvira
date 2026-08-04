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
import type { ActiveModelInfo, CLIResult, ExtensionConfig, ProviderInfo, ProviderModelInfo, QuotaStatusInfo } from './types.js';
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
    private onStreamChunk?;
    private abortController;
    constructor(config: ExtensionConfig);
    /**
     * Set progress, log, and streaming callbacks for real-time updates.
     */
    setCallbacks(opts: {
        onProgress?: (phase: string, detail?: string) => void;
        onLog?: (line: string) => void;
        onStreamChunk?: (chunk: string, isCodeBlock: boolean) => void;
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
     * List all providers with their availability status.
     * Corresponds to: buff model list --all --json
     */
    listModels(): Promise<ProviderInfo[]>;
    /**
     * List the actual models available from a specific provider.
     * Corresponds to: buff models -p <provider> --json
     */
    listProviderModels(provider: string): Promise<ProviderModelInfo[]>;
    /**
     * Switch the active provider/model.
     * Pass 'auto' as provider to enable Auto model routing.
     * Corresponds to: buff model switch <provider>[/<model>] or buff model switch auto
     */
    switchModel(provider: string, model?: string): Promise<CLIResult>;
    /**
     * Read the active model state from ~/.buff/active-model.json.
     * Returns null if no active model has been set yet.
     */
    getActiveModel(): Promise<ActiveModelInfo | null>;
    /**
     * Run a health check for the active (or specified) provider.
     * Corresponds to: buff model health [-p <provider>]
     */
    checkModelHealth(provider?: string): Promise<CLIResult>;
    /**
     * Resolve the CLI's memory dir (`BUFF_MEMORY_DIR` override, else
     * `~/.buff/memory`). Public so the quota panel can watch the same directory
     * the reader uses for live updates.
     */
    getMemoryDir(): string;
    /**
     * Read the central quota ledger + failover timeline directly from the CLI's
     * memory dir (`~/.buff/memory/quota-ledger.json` + `quota-events.jsonl`,
     * honoring BUFF_MEMORY_DIR like the dashboard does).
     *
     * Returns a fully-shaped (possibly empty) QuotaStatusInfo — never throws, so
     * the extension's quota view always has data to render even on a fresh
     * install where the ledger doesn't exist yet.
     */
    getQuotaStatus(): Promise<QuotaStatusInfo>;
    /**
     * Build CLI arguments with common options.
     *
     * When Auto model routing is enabled:
     * - chat commands get `--model auto` (the CLI detects auto mode)
     * - execute commands get `--auto-route` (per-task AutoModelRouter)
     * Otherwise the configured provider/model are passed through.
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
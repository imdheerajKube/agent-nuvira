"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLIManager = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vscode = __importStar(require("vscode"));
// ─── Constants ──────────────────────────────────────────────────────────────
/** Default timeout for CLI commands (5 minutes) */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Timeout for quick operations (e.g., explain, quick fix) */
const QUICK_TIMEOUT_MS = 60_000;
// ─── CLIManager ─────────────────────────────────────────────────────────────
/**
 * Manages the lifecycle of a CLI subprocess for agent tasks.
 * Each task gets its own subprocess instance.
 */
class CLIManager {
    process = null;
    config;
    workspaceRoot;
    onProgress;
    onLog;
    onStreamChunk;
    abortController;
    constructor(config) {
        this.config = config;
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
        this.abortController = new AbortController();
    }
    /**
     * Set progress, log, and streaming callbacks for real-time updates.
     */
    setCallbacks(opts) {
        this.onProgress = opts.onProgress;
        this.onLog = opts.onLog;
        this.onStreamChunk = opts.onStreamChunk;
    }
    /**
     * Cancel the currently running task.
     */
    cancel() {
        this.abortController.abort();
        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
            // Force kill after 3 seconds if not stopped
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGKILL');
                }
            }, 3000);
        }
    }
    /**
     * Check if a task is currently running.
     */
    get isRunning() {
        return this.process !== null && !this.process.killed && this.process.exitCode === null;
    }
    // ── Task Methods ──────────────────────────────────────────────────────────
    /**
     * Execute a general goal via the multi-agent pipeline.
     * Corresponds to: buff execute <goal>
     */
    async executeGoal(goal) {
        const args = this.buildArgs(['execute', goal]);
        return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
            phaseLabels: ['Planning', 'Gathering context', 'Writing code', 'Reviewing', 'Applying'],
        });
    }
    /**
     * Quick fix for the current file.
     * Corresponds to: buff edit <file>
     */
    async quickFix(filePath) {
        const relativePath = this.relativePath(filePath);
        const args = this.buildArgs(['edit', relativePath, '--quick']);
        return this.runCommand(args, QUICK_TIMEOUT_MS, {
            phaseLabels: ['Analyzing file', 'Generating fix', 'Applying fix'],
        });
    }
    /**
     * Review a file for bugs and improvements.
     * Corresponds to: buff execute "review <file>"
     */
    async reviewFile(filePath) {
        const relativePath = this.relativePath(filePath);
        const goal = `Review the file ${relativePath} for bugs, security issues, and improvements. Provide a detailed report.`;
        const args = this.buildArgs(['execute', goal]);
        return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
            phaseLabels: ['Analyzing file', 'Checking for issues', 'Generating report'],
        });
    }
    /**
     * Explain selected code.
     * Uses a simple chat prompt.
     */
    async explainCode(code, fileExtension) {
        const prompt = `Explain the following ${fileExtension || 'code'} in detail:\n\n${code}`;
        const args = this.buildArgs(['chat', prompt, '--stream']);
        return this.runCommand(args, QUICK_TIMEOUT_MS, {
            phaseLabels: ['Analyzing code', 'Generating explanation'],
        });
    }
    /**
     * Generate tests for a file.
     * Corresponds to: buff execute "generate tests for <file>"
     */
    async generateTests(filePath) {
        const relativePath = this.relativePath(filePath);
        const goal = `Generate comprehensive unit tests for the code in ${relativePath}. Include edge cases and mock external dependencies.`;
        const args = this.buildArgs(['execute', goal]);
        return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
            phaseLabels: ['Analyzing code', 'Designing tests', 'Writing tests'],
        });
    }
    /**
     * Run a workflow template.
     * Corresponds to: buff workflow run <template> <goal>
     */
    async runWorkflow(template, goal) {
        const args = this.buildArgs(['workflow', 'run', template, goal]);
        return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
            phaseLabels: [`Running workflow: ${template}`],
        });
    }
    // ── Model & Provider Management ─────────────────────────────────────────
    /**
     * List all providers with their availability status.
     * Corresponds to: buff model list --all --json
     */
    async listModels() {
        const args = ['model', 'list', '--all', '--json'];
        // Provider availability checks hit the network — allow ample time
        const result = await this.runCommand(args, DEFAULT_TIMEOUT_MS, {
            phaseLabels: ['Listing providers'],
        });
        if (!result.success || !result.stdout)
            return [];
        try {
            const parsed = JSON.parse(result.stdout);
            return Array.isArray(parsed.providers) ? parsed.providers : [];
        }
        catch {
            return [];
        }
    }
    /**
     * List the actual models available from a specific provider.
     * Corresponds to: buff models -p <provider> --json
     */
    async listProviderModels(provider) {
        const args = ['models', '-p', provider, '--json'];
        // Model listing hits the provider API — allow ample time
        const result = await this.runCommand(args, DEFAULT_TIMEOUT_MS, {
            phaseLabels: [`Listing ${provider} models`],
        });
        if (!result.success || !result.stdout)
            return [];
        // Only pass provider types seen in `buff model list` — unknown types make
        // the CLI warn to stdout, which would corrupt the JSON and fall back to [].
        try {
            const parsed = JSON.parse(result.stdout);
            return Array.isArray(parsed.models) ? parsed.models : [];
        }
        catch {
            return [];
        }
    }
    /**
     * Switch the active provider/model.
     * Pass 'auto' as provider to enable Auto model routing.
     * Corresponds to: buff model switch <provider>[/<model>] or buff model switch auto
     */
    async switchModel(provider, model) {
        const spec = provider === 'auto' ? 'auto' : model ? `${provider}/${model}` : provider;
        const args = ['model', 'switch', spec];
        return this.runCommand(args, QUICK_TIMEOUT_MS, {
            phaseLabels: ['Switching model'],
        });
    }
    /**
     * Read the active model state from ~/.buff/active-model.json.
     * Returns null if no active model has been set yet.
     */
    async getActiveModel() {
        const overridePath = process.env.BUFF_ACTIVE_MODEL_PATH;
        const statePath = overridePath || (0, node_path_1.join)((0, node_os_1.homedir)(), '.buff', 'active-model.json');
        try {
            if (!(0, node_fs_1.existsSync)(statePath))
                return null;
            return JSON.parse((0, node_fs_1.readFileSync)(statePath, 'utf-8'));
        }
        catch {
            return null;
        }
    }
    /**
     * Run a health check for the active (or specified) provider.
     * Corresponds to: buff model health [-p <provider>]
     */
    async checkModelHealth(provider) {
        const args = provider && provider !== 'auto'
            ? ['model', 'health', '-p', provider]
            : ['model', 'health'];
        // Health checks probe the provider endpoint — allow ample time
        return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
            phaseLabels: ['Checking provider health'],
        });
    }
    /**
     * Resolve the CLI's memory dir (`BUFF_MEMORY_DIR` override, else
     * `~/.buff/memory`). Public so the quota panel can watch the same directory
     * the reader uses for live updates.
     */
    getMemoryDir() {
        return process.env.BUFF_MEMORY_DIR || (0, node_path_1.join)((0, node_os_1.homedir)(), '.buff', 'memory');
    }
    /**
     * Read the central quota ledger + failover timeline directly from the CLI's
     * memory dir (`~/.buff/memory/quota-ledger.json` + `quota-events.jsonl`,
     * honoring BUFF_MEMORY_DIR like the dashboard does).
     *
     * Returns a fully-shaped (possibly empty) QuotaStatusInfo — never throws, so
     * the extension's quota view always has data to render even on a fresh
     * install where the ledger doesn't exist yet.
     */
    async getQuotaStatus() {
        const memoryDir = this.getMemoryDir();
        const empty = {
            enabled: false,
            entries: [],
            events: [],
            freeTokens: 0,
            freeRequests: 0,
            paidTokens: 0,
            paidRequests: 0,
            estimatedSavedUsd: 0,
        };
        try {
            const ledgerPath = (0, node_path_1.join)(memoryDir, 'quota-ledger.json');
            const eventsPath = (0, node_path_1.join)(memoryDir, 'quota-events.jsonl');
            if (!(0, node_fs_1.existsSync)(ledgerPath) && !(0, node_fs_1.existsSync)(eventsPath))
                return empty;
            const now = Date.now();
            // ── Ledger entries ────────────────────────────────────────────────
            const entries = [];
            let freeTokens = 0;
            let freeRequests = 0;
            let paidTokens = 0;
            let paidRequests = 0;
            // Free/local-first cost optics (mirrors the CLI + dashboard): local
            // Ollama + Gemini free tier count as FREE (savings); everything else is
            // PAID (actual spend).
            const FREE_PROVIDERS = new Set(['local', 'gemini']);
            const AVG_PAID_RATE_PER_1K = 0.0005;
            if ((0, node_fs_1.existsSync)(ledgerPath)) {
                const raw = JSON.parse((0, node_fs_1.readFileSync)(ledgerPath, 'utf-8'));
                for (const e of Object.values(raw.entries || {})) {
                    const windowEnd = e.windowStart + (e.windowLengthMs || 24 * 60 * 60 * 1000);
                    const cooldownRemaining = Math.max(0, e.cooldownUntil - now);
                    const entry = {
                        provider: e.provider,
                        model: e.model,
                        tokensConsumed: e.tokensConsumed,
                        requests: e.requests,
                        windowLengthMs: e.windowLengthMs,
                        resetsInMs: Math.max(0, windowEnd - now),
                        parked: cooldownRemaining > 0,
                        cooldownRemaining,
                    };
                    entries.push(entry);
                    if (FREE_PROVIDERS.has(e.provider)) {
                        freeTokens += e.tokensConsumed;
                        freeRequests += e.requests;
                    }
                    else {
                        paidTokens += e.tokensConsumed;
                        paidRequests += e.requests;
                    }
                }
            }
            // ── Failover timeline (quota-events.jsonl, newest first) ──────────
            const events = [];
            if ((0, node_fs_1.existsSync)(eventsPath)) {
                const lines = (0, node_fs_1.readFileSync)(eventsPath, 'utf-8').split('\n').filter((l) => l.trim());
                for (const line of lines.slice(-50).reverse()) {
                    try {
                        const e = JSON.parse(line);
                        if (e && typeof e === 'object' && e.type && e.provider)
                            events.push(e);
                    }
                    catch {
                        // Skip corrupt lines — best-effort read.
                    }
                }
            }
            const estimatedSavedUsd = Math.round((freeTokens / 1000) * AVG_PAID_RATE_PER_1K * 100000) / 100000;
            return {
                enabled: entries.length > 0 || events.length > 0,
                entries: entries.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
                events,
                freeTokens,
                freeRequests,
                paidTokens,
                paidRequests,
                estimatedSavedUsd,
            };
        }
        catch {
            // Best-effort — the quota view must never crash on a corrupt ledger.
            return empty;
        }
    }
    // ── Private ──────────────────────────────────────────────────────────────
    /**
     * Build CLI arguments with common options.
     *
     * When Auto model routing is enabled:
     * - chat commands get `--model auto` (the CLI detects auto mode)
     * - execute commands get `--auto-route` (per-task AutoModelRouter)
     * Otherwise the configured provider/model are passed through.
     */
    buildArgs(customArgs) {
        const args = [...customArgs];
        const command = customArgs[0] || '';
        // Auto model routing: let the agent pick provider/model per task
        if (this.config.useAutoRouting) {
            if (command === 'chat') {
                args.push('--model', 'auto');
            }
            else if (command === 'execute') {
                args.push('--auto-route');
            }
            return args;
        }
        // Add provider/model if configured
        if (this.config.defaultProvider) {
            args.push('--provider', this.config.defaultProvider);
        }
        if (this.config.defaultModel) {
            args.push('--model', this.config.defaultModel);
        }
        return args;
    }
    /**
     * Get the relative path from workspace root.
     */
    relativePath(absolutePath) {
        const rel = vscode.workspace.asRelativePath(absolutePath);
        // Wrap in quotes if it contains spaces
        return rel.includes(' ') ? `"${rel}"` : rel;
    }
    /**
     * Run the CLI command and capture output with progress tracking.
     */
    runCommand(args, timeoutMs, options) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const { command: cliCmd, spawnArgs } = this.resolveCliCommand();
            const allArgs = [...spawnArgs, ...args];
            let stdout = '';
            let stderr = '';
            let phaseIndex = 0;
            const phaseLabels = options?.phaseLabels || ['Running'];
            // Report initial progress
            this.reportProgress(phaseLabels[0]);
            // Spawn process
            this.abortController = new AbortController();
            this.process = (0, node_child_process_1.spawn)(cliCmd, allArgs, {
                cwd: this.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                signal: this.abortController.signal,
                env: { ...process.env, FORCE_COLOR: '0' }, // Disable color for parsing
            });
            // Handle stdout
            this.process.stdout?.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                // Emit streaming chunks for real-time token display
                const isCodeBlock = text.includes('```');
                this.onStreamChunk?.(text, isCodeBlock);
                // Process lines for progress updates and logging
                const lines = text.split('\n').filter((l) => l.trim());
                for (const line of lines) {
                    this.onLog?.(line);
                    // Detect phase changes from CLI output patterns
                    const phaseMatch = line.match(/^[📋📂✏️🔍🧪📦🏗️📝🔄]\s+(.+?)$/);
                    if (phaseMatch) {
                        const newPhase = phaseMatch[1].trim();
                        if (newPhase.length > 5 && newPhase.length < 80) {
                            this.reportProgress(newPhase);
                        }
                    }
                    // Detect error/warning patterns
                    if (line.includes('✖') || line.includes('Error:')) {
                        this.reportProgress('Error encountered', line);
                    }
                }
                // Update progress through phases
                if (stdout.length > 100 * (phaseIndex + 1) && phaseIndex < phaseLabels.length - 1) {
                    phaseIndex++;
                    this.reportProgress(phaseLabels[phaseIndex]);
                }
            });
            // Handle stderr
            this.process.stderr?.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                this.onLog?.(`[stderr] ${text}`);
                if (text.includes('error') || text.includes('Error')) {
                    this.reportProgress('Error', text.slice(0, 200));
                }
            });
            // Handle errors
            this.process.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    reject(new Error(`CLI '${cliCmd}' not found. Install agent-nuvira or configure 'agent-nuvira.cliPath'.\n` +
                        `  Run: npm install -g agent-nuvira\n` +
                        `  Or set path in VS Code settings.`));
                }
                else if (err.name === 'AbortError') {
                    reject(new Error('Task was cancelled.'));
                }
                else {
                    reject(new Error(`CLI process error: ${err.message}`));
                }
            });
            // Handle process exit
            this.process.on('close', (exitCode) => {
                const durationMs = Date.now() - startTime;
                const result = {
                    stdout,
                    stderr,
                    exitCode,
                    success: exitCode === 0,
                    durationMs,
                };
                this.process = null;
                if (exitCode === 0) {
                    resolve(result);
                }
                else {
                    // Non-zero exit is still resolved (not rejected) so caller can handle partial results
                    resolve(result);
                }
            });
            // Timeout handling
            const timeout = setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.reportProgress('Timeout', `Task timed out after ${(timeoutMs / 1000).toFixed(0)}s`);
                    this.process.kill('SIGTERM');
                }
            }, timeoutMs);
            // Clear timeout on process exit
            this.process.on('close', () => clearTimeout(timeout));
        });
    }
    /**
     * Report progress update to the registered callback.
     */
    reportProgress(phase, detail) {
        this.onProgress?.(phase, detail);
    }
    /**
     * Resolve the CLI command and arguments.
     * Returns [command, ...args] for use with spawn().
     */
    resolveCliCommand() {
        const configuredPath = this.config.cliPath;
        if (configuredPath && configuredPath !== 'buff') {
            // Support both simple commands and paths with spaces
            const parts = configuredPath.split(' ');
            return {
                command: parts[0],
                spawnArgs: parts.slice(1),
            };
        }
        // Default: try to use 'buff' directly (on PATH)
        return {
            command: 'buff',
            spawnArgs: [],
        };
    }
    /**
     * Clean up resources.
     */
    dispose() {
        this.cancel();
    }
}
exports.CLIManager = CLIManager;
//# sourceMappingURL=cliManager.js.map
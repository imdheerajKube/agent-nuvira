/**
 * SafeExecutionLayer — Unified safety and sandboxing wrapper.
 *
 * Phase 9 of the architecture migration. Combines:
 * - File operations (atomic writes, rollback, size guard, .gitignore compliance)
 * - Code execution (Docker sandbox via SandboxManager, resource limits, timeout)
 * - LLM call safety (injection guardrail from security scanner, retry with backoff, circuit breaker)
 *
 * @see ARCHITECTURE.md §4.3 — Safe Execution Layer specification
 */
import type { EventBus } from '../observability/event-bus.js';
import { SandboxManager } from '../sandbox/manager.js';
/** Severity of a safety check result */
export type SafetySeverity = 'blocking' | 'warning' | 'info';
/** Result of an individual safety check */
export interface SafetyCheck {
    /** Name of the check performed */
    name: string;
    /** Whether the check passed */
    passed: boolean;
    /** Human-readable details */
    details: string;
    /** Severity level */
    severity: SafetySeverity;
}
/** Overall result of a safety validation */
export interface SafetyResult {
    /** Whether all blocking checks passed */
    passed: boolean;
    /** All individual check results */
    checks: SafetyCheck[];
    /** List of blocking issues */
    blockers: string[];
    /** Non-blocking warnings */
    warnings: string[];
}
/** Parameters for validating file operations */
export interface FileSafetyParams {
    /** File path to validate */
    path: string;
    /** Content to write */
    content?: string;
    /** Max file size in bytes (default: 100KB) */
    maxSize?: number;
    /** Whether to check .gitignore compliance */
    checkGitignore?: boolean;
}
/** Result of a sandboxed execution */
export interface SandboxExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
    error?: string;
}
/** Parameters for sandboxed execution */
export interface SandboxExecutionParams {
    /** Command to execute */
    command: string;
    /** Working directory to copy into sandbox */
    workingDirectory?: string;
    /** Resource limits */
    limits?: {
        memory?: string;
        cpu?: number;
        timeoutMs?: number;
    };
}
/** Parameters for an LLM call with safety checks */
export interface LLMCallParams {
    /** The LLM call function */
    callLLM: (prompt: string) => Promise<string>;
    /** The prompt to send */
    prompt: string;
    /** Max prompt length in chars (default: 128K) */
    maxPromptLength?: number;
    /** Number of retries on failure (default: 3) */
    maxRetries?: number;
}
/**
 * SafeExecutionLayer — Unified safety wrapper for all operations.
 *
 * @example
 * ```typescript
 * const layer = new DefaultSafeExecutionLayer();
 *
 * // Validate a file before writing
 * const result = layer.validateFile({ path: 'src/index.ts', content: newCode });
 *
 * // Execute a command safely in sandbox
 * const execResult = await layer.executeInSandbox({ command: 'npm test' });
 *
 * // Make a safe LLM call
 * const response = await layer.safeLLMCall({ callLLM, prompt, maxRetries: 3 });
 * ```
 */
export interface SafeExecutionLayer {
    /** Validate a file operation before proceeding */
    validateFile(params: FileSafetyParams): SafetyResult;
    /** Execute a command in a Docker sandbox */
    executeInSandbox(params: SandboxExecutionParams): Promise<SandboxExecutionResult>;
    /** Make an LLM call with safety guardrails */
    safeLLMCall(params: LLMCallParams): Promise<{
        success: boolean;
        response?: string;
        error?: string;
    }>;
}
/**
 * DefaultSafeExecutionLayer — Built-in safety wrapper.
 *
 * Provides validation for three domains:
 * 1. File operations — size guards, .gitignore compliance, syntax validation
 * 2. Sandboxed execution — Docker isolation via SandboxManager
 * 3. LLM calls — injection scanning, length caps, retry with backoff
 */
export declare class DefaultSafeExecutionLayer implements SafeExecutionLayer {
    private eventBus;
    private sandboxManager;
    constructor(eventBus?: EventBus, sandboxManager?: SandboxManager);
    /**
     * Validate a file operation before proceeding.
     *
     * Checks performed:
     * - Max file size guard
     * - Gitignore compliance (warns for tracking ignored files)
     * - Syntax validation (for .ts, .js, .py, .go, .rs files)
     * - Security scan of content
     */
    validateFile(params: FileSafetyParams): SafetyResult;
    /**
     * Execute a command in a Docker sandbox with resource limits.
     *
     * Creates a sandbox container, copies the project (if specified),
     * runs the command with timeout enforcement, and destroys the container.
     */
    executeInSandbox(params: SandboxExecutionParams): Promise<SandboxExecutionResult>;
    /**
     * Make an LLM call with comprehensive safety checks.
     *
     * Safety measures:
     * - Injection guardrail — scans prompt for injection attempts before sending
     * - Prompt length cap — truncates prompts that exceed the limit
     * - Retry with backoff — retries on transient failures (up to maxRetries)
     * - Content length cap — caps response length to prevent memory issues
     */
    safeLLMCall(params: LLMCallParams): Promise<{
        success: boolean;
        response?: string;
        error?: string;
    }>;
}
//# sourceMappingURL=safe-execution-layer.d.ts.map
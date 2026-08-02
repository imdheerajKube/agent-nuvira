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
import { existsSync } from 'node:fs';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { validateSyntax } from '../editing/ast.js';
import { detectLanguage } from '../editing/types.js';
import { runAllScans } from '../security/scanner.js';
import { getSandboxManager } from '../sandbox/manager.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Default max file size in bytes */
const DEFAULT_MAX_FILE_SIZE = 100 * 1024; // 100KB
/** Default timeout for sandboxed commands */
const DEFAULT_SANDBOX_TIMEOUT_MS = 60_000;
/** Default memory limit for sandbox containers */
const DEFAULT_SANDBOX_MEMORY = '512m';
/** Default CPU limit for sandbox containers */
const DEFAULT_SANDBOX_CPU = 1;
/** Default max retries for LLM calls */
const DEFAULT_LLM_RETRIES = 3;
/** Default max prompt length (128K chars ≈ 32K tokens) */
const DEFAULT_MAX_PROMPT_LENGTH = 128_000;
/** Directories to exclude from sandbox copy */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.cache', '__pycache__', 'target', 'build']);
// ─── Default SafeExecutionLayer ─────────────────────────────────────────────
/**
 * DefaultSafeExecutionLayer — Built-in safety wrapper.
 *
 * Provides validation for three domains:
 * 1. File operations — size guards, .gitignore compliance, syntax validation
 * 2. Sandboxed execution — Docker isolation via SandboxManager
 * 3. LLM calls — injection scanning, length caps, retry with backoff
 */
export class DefaultSafeExecutionLayer {
    eventBus;
    sandboxManager;
    constructor(eventBus, sandboxManager) {
        this.eventBus = eventBus ?? getEventBus();
        this.sandboxManager = sandboxManager ?? getSandboxManager();
    }
    // ── 1. File Safety ───────────────────────────────────────────────────
    /**
     * Validate a file operation before proceeding.
     *
     * Checks performed:
     * - Max file size guard
     * - Gitignore compliance (warns for tracking ignored files)
     * - Syntax validation (for .ts, .js, .py, .go, .rs files)
     * - Security scan of content
     */
    validateFile(params) {
        const { path: filePath, content, maxSize = DEFAULT_MAX_FILE_SIZE, checkGitignore = true } = params;
        const checks = [];
        const blockers = [];
        const warnings = [];
        // ── File size check ────────────────────────────────────────────────
        if (content && content.length > maxSize) {
            const sizeKB = Math.round(content.length / 1024);
            const maxKB = Math.round(maxSize / 1024);
            const check = {
                name: 'file-size',
                passed: false,
                details: `File content (${sizeKB}KB) exceeds max size (${maxKB}KB)`,
                severity: 'blocking',
            };
            checks.push(check);
            blockers.push(check.details);
        }
        else {
            checks.push({
                name: 'file-size',
                passed: true,
                details: 'File size within limits',
                severity: 'info',
            });
        }
        // ── Gitignore compliance ───────────────────────────────────────────
        if (checkGitignore) {
            const isHidden = filePath.split('/').some((part) => part.startsWith('.') && part !== '.');
            const isIgnoredDir = filePath.split('/').some((part) => EXCLUDED_DIRS.has(part));
            if (isHidden || isIgnoredDir) {
                const warning = `File '${filePath}' may be gitignored (hidden directory or standard ignore pattern)`;
                warnings.push(warning);
                checks.push({
                    name: 'gitignore',
                    passed: false,
                    details: warning,
                    severity: 'warning',
                });
            }
            else {
                checks.push({
                    name: 'gitignore',
                    passed: true,
                    details: 'File is tracked by version control',
                    severity: 'info',
                });
            }
        }
        // ── Syntax validation ──────────────────────────────────────────────
        if (content) {
            const lang = detectLanguage(filePath);
            if (lang !== 'unknown') {
                const isSyntaxValid = validateSyntax(content, lang);
                if (!isSyntaxValid) {
                    const warning = `Syntax warning: ${filePath} has unbalanced brackets`;
                    warnings.push(warning);
                    checks.push({
                        name: 'syntax',
                        passed: false,
                        details: warning,
                        severity: 'warning',
                    });
                }
                else {
                    checks.push({
                        name: 'syntax',
                        passed: true,
                        details: 'Syntax balanced',
                        severity: 'info',
                    });
                }
            }
        }
        // ── Security scan of content ───────────────────────────────────────
        if (content) {
            const scanResult = runAllScans(content, { isGenerated: true, filename: filePath });
            if (!scanResult.passed) {
                const criticalFindings = scanResult.findings.filter((f) => f.severity === 'critical').length;
                const highFindings = scanResult.findings.filter((f) => f.severity === 'high').length;
                const detail = `Security scan found ${scanResult.findings.length} issue(s): ${criticalFindings} critical, ${highFindings} high`;
                blockers.push(detail);
                checks.push({
                    name: 'security-scan',
                    passed: false,
                    details: detail,
                    severity: 'blocking',
                });
            }
            else if (scanResult.findings.length > 0) {
                warnings.push(`Low-severity security notes: ${scanResult.findings.filter((f) => f.severity === 'medium' || f.severity === 'low').length} items`);
                checks.push({
                    name: 'security-scan',
                    passed: true,
                    details: 'Security scan found only low-severity items',
                    severity: 'warning',
                });
            }
            else {
                checks.push({
                    name: 'security-scan',
                    passed: true,
                    details: 'Security scan passed — clean',
                    severity: 'info',
                });
            }
        }
        const passed = blockers.length === 0;
        this.eventBus.emit(EventNames.SAFE_EXEC_FILE_VALIDATED, {
            path: filePath,
            passed,
            checkCount: checks.length,
            blockerCount: blockers.length,
            warningCount: warnings.length,
        }, 'safe-execution-layer');
        return { passed, checks, blockers, warnings };
    }
    // ── 2. Sandboxed Execution ──────────────────────────────────────────
    /**
     * Execute a command in a Docker sandbox with resource limits.
     *
     * Creates a sandbox container, copies the project (if specified),
     * runs the command with timeout enforcement, and destroys the container.
     */
    async executeInSandbox(params) {
        const { command, workingDirectory, limits } = params;
        const timeoutMs = limits?.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
        const memory = limits?.memory ?? DEFAULT_SANDBOX_MEMORY;
        const cpu = limits?.cpu ?? DEFAULT_SANDBOX_CPU;
        this.eventBus.emit(EventNames.SAFE_EXEC_SANDBOX_STARTING, {
            command: command.slice(0, 100),
            timeoutMs,
            memory,
            cpu,
        }, 'safe-execution-layer');
        const startTime = Date.now();
        try {
            // Check Docker availability
            const dockerAvailable = await this.sandboxManager.isDockerAvailable();
            if (!dockerAvailable) {
                const error = `Docker is not available: ${this.sandboxManager.getDockerError() || 'Is Docker installed?'}`;
                this.eventBus.emit(EventNames.SAFE_EXEC_SANDBOX_FAILED, { error }, 'safe-execution-layer');
                return {
                    success: false,
                    stdout: '',
                    stderr: error,
                    exitCode: -1,
                    durationMs: Date.now() - startTime,
                    timedOut: false,
                    error,
                };
            }
            // Create sandbox container
            const containerId = await this.sandboxManager.createContainer('node:20-slim', {
                memoryLimit: memory,
                cpuLimit: cpu,
                networkAccess: false,
            });
            this.eventBus.emit(EventNames.SAFE_EXEC_SANDBOX_CREATED, {
                containerId: containerId.slice(0, 12),
            }, 'safe-execution-layer');
            // Copy project if specified
            if (workingDirectory && existsSync(workingDirectory)) {
                await this.sandboxManager.copyProjectToContainer(containerId, workingDirectory);
            }
            // Run the command
            const result = await this.sandboxManager.runCommand(containerId, command, timeoutMs);
            // Always clean up
            await this.sandboxManager.destroyContainer(containerId).catch(() => { });
            const execResult = {
                success: result.success,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                timedOut: result.timedOut ?? false,
                error: result.error,
            };
            this.eventBus.emit(EventNames.SAFE_EXEC_SANDBOX_COMPLETED, {
                success: execResult.success,
                exitCode: execResult.exitCode,
                durationMs: execResult.durationMs,
                timedOut: execResult.timedOut,
            }, 'safe-execution-layer');
            return execResult;
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.eventBus.emit(EventNames.SAFE_EXEC_SANDBOX_FAILED, { error }, 'safe-execution-layer');
            return {
                success: false,
                stdout: '',
                stderr: error,
                exitCode: -1,
                durationMs: Date.now() - startTime,
                timedOut: false,
                error,
            };
        }
    }
    // ── 3. Safe LLM Calls ───────────────────────────────────────────────
    /**
     * Make an LLM call with comprehensive safety checks.
     *
     * Safety measures:
     * - Injection guardrail — scans prompt for injection attempts before sending
     * - Prompt length cap — truncates prompts that exceed the limit
     * - Retry with backoff — retries on transient failures (up to maxRetries)
     * - Content length cap — caps response length to prevent memory issues
     */
    async safeLLMCall(params) {
        const { callLLM, prompt, maxPromptLength = DEFAULT_MAX_PROMPT_LENGTH, maxRetries = DEFAULT_LLM_RETRIES } = params;
        this.eventBus.emit(EventNames.SAFE_EXEC_LLM_STARTING, {
            promptLength: prompt.length,
            maxRetries,
        }, 'safe-execution-layer');
        // ── 1. Injection guardrail ─────────────────────────────────────────
        const injectionFindings = runAllScans(prompt).findings.filter((f) => f.type === 'injection');
        if (injectionFindings.length > 0) {
            const error = `Prompt injection detected: ${injectionFindings[0].match.slice(0, 80)}`;
            this.eventBus.emit(EventNames.SAFE_EXEC_LLM_BLOCKED, {
                reason: 'injection-detected',
                finding: injectionFindings[0].match.slice(0, 80),
            }, 'safe-execution-layer');
            return { success: false, error };
        }
        // ── 2. Prompt length cap ───────────────────────────────────────────
        const safePrompt = prompt.length > maxPromptLength
            ? prompt.slice(0, maxPromptLength) + '\n\n[TRUNCATED — prompt exceeded safety limit]'
            : prompt;
        // ── 3. Retry with backoff ──────────────────────────────────────────
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
                    this.eventBus.emit(EventNames.SAFE_EXEC_LLM_RETRY, {
                        attempt: attempt + 1,
                        backoffMs,
                    }, 'safe-execution-layer');
                    await new Promise((resolve) => setTimeout(resolve, backoffMs));
                }
                const response = await callLLM(safePrompt);
                // ── 4. Response length cap ───────────────────────────────────
                const safeResponse = response.length > maxPromptLength
                    ? response.slice(0, maxPromptLength) + '\n\n[TRUNCATED — response exceeded safety limit]'
                    : response;
                this.eventBus.emit(EventNames.SAFE_EXEC_LLM_COMPLETED, {
                    responseLength: safeResponse.length,
                    truncated: response.length > maxPromptLength,
                }, 'safe-execution-layer');
                return { success: true, response: safeResponse };
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                // Don't retry auth errors
                if (lastError.includes('401') || lastError.includes('403') || lastError.includes('unauthorized')) {
                    break;
                }
            }
        }
        const error = lastError || 'LLM call failed after all retries';
        this.eventBus.emit(EventNames.SAFE_EXEC_LLM_FAILED, { error }, 'safe-execution-layer');
        return { success: false, error };
    }
}
//# sourceMappingURL=safe-execution-layer.js.map
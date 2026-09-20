/**
 * Skill Executor — Runs skills as scripts in any language.
 *
 * This is the core capability that agent-nuvira was missing vs Hermes.
 * Hermes can execute Python, JS, shell scripts from the marketplace.
 * This module provides the same capability.
 *
 * Flow:
 * 1. Skill declares `runtime` in frontmatter (python, node, shell, auto)
 * 2. Executor detects language from runtime or file extension
 * 3. Spawns a sandboxed process with API keys injected
 * 4. Captures output and returns it to the agent
 */
import { PROVIDER_ENV_BLOCKLIST } from '../config/provider-env.js';
export { PROVIDER_ENV_BLOCKLIST };
export type SkillRuntime = 'python' | 'node' | 'shell' | 'ruby' | 'go' | 'rust' | 'auto';
export interface SkillExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    runtime: SkillRuntime;
    durationMs: number;
}
export interface SkillExecutionContext {
    /** Working directory for the execution */
    cwd: string;
    /** Environment variables to inject (API keys, etc.) */
    env?: Record<string, string>;
    /** Arguments to pass to the script */
    args?: string[];
    /** Timeout in milliseconds (default: 30s) */
    timeoutMs?: number;
    /** Maximum output size in bytes (default: 1MB) */
    maxOutputBytes?: number;
    /** Whether to use sandboxed execution (Docker/Modal) */
    sandboxed?: boolean;
}
/**
 * Detect the runtime for a skill based on its content or file extension.
 */
export declare function detectRuntime(skillContent: string, filePath?: string): SkillRuntime;
/**
 * Execute a skill script in the appropriate runtime.
 *
 * @param scriptContent - The script content to execute
 * @param context - Execution context (cwd, env, timeout, etc.)
 * @param filePath - Optional file path hint for runtime detection
 * @returns Execution result with stdout, stderr, exit code
 */
export declare function executeSkill(scriptContent: string, context: SkillExecutionContext, filePath?: string): Promise<SkillExecutionResult>;
/**
 * Register env vars for passthrough (called when a skill is loaded).
 */
export declare function registerEnvPassthrough(varNames: string[]): void;
/**
 * Get the filtered env vars that should be passed to skill execution.
 */
export declare function getFilteredEnvPassthrough(skillEnvVars: string[]): Record<string, string>;
/**
 * Clear the session allowlist (call at session end).
 */
export declare function clearEnvPassthrough(): void;
/**
 * Check if an env var is allowed for passthrough.
 */
export declare function isEnvPassthroughAllowed(name: string): boolean;
/**
 * Execute a marketplace skill.
 *
 * This is the main entry point for executing skills from the marketplace.
 * It handles:
 * 1. Reading the skill file
 * 2. Detecting the runtime
 * 3. Injecting API keys
 * 4. Executing the script
 * 5. Returning the result
 */
export declare function executeMarketplaceSkill(skillPath: string, context: SkillExecutionContext): Promise<SkillExecutionResult>;
//# sourceMappingURL=skill-executor.d.ts.map
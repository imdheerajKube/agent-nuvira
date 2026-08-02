/**
 * VerifyModule — Explicit verification pipeline extracted from ReviewerAgent
 * and SecurityAgent. Phase 6 of the architecture migration.
 *
 * Combines LLM-based code review with automated security scans to produce
 * a structured VerificationResult with per-check pass/fail, overall score,
 * blockers, and suggestions.
 *
 * @see ARCHITECTURE.md §3.6 — Verify Module specification
 */
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn } from './agent.js';
import type { FileChange } from './agent.js';
/** Type of verification check performed */
export type CheckType = 'tests' | 'security' | 'goal-alignment' | 'code-quality';
/** Severity of a verification check result */
export type CheckSeverity = 'blocking' | 'warning' | 'info';
/** Result of a single verification check */
export interface VerificationCheck {
    /** Type of check performed */
    type: CheckType;
    /** Whether the check passed */
    passed: boolean;
    /** Human-readable details about the check result */
    details: string;
    /** Severity level */
    severity: CheckSeverity;
}
/** Overall result of a verification run */
export interface VerificationResult {
    /** Whether all blocking checks passed */
    passed: boolean;
    /** All individual check results */
    checks: VerificationCheck[];
    /** Normalized score from 0.0 to 1.0 */
    overallScore: number;
    /** List of blocking issues that must be resolved */
    blockers: string[];
    /** Non-blocking improvement suggestions */
    suggestions: string[];
}
/** Parameters for the VerifyModule.verify() method */
export interface VerifyParams {
    /** File changes to verify */
    changes: FileChange[];
    /** The original user goal */
    goal: string;
    /** Optional test results summary */
    testResults?: {
        passed: number;
        failed: number;
        total: number;
    };
    /** Optional runner output */
    runOutput?: string;
    /** Optional strictness level (default: 'medium') */
    strictness?: 'low' | 'medium' | 'high';
    /** Optional LLM call function for review-based checks */
    callLLM?: LLMCallFn;
    /** Optional working directory for syntax checks */
    workingDirectory?: string;
}
/**
 * VerifyModule — Validate that changes meet quality standards before proceeding.
 *
 * @example
 * ```typescript
 * const module = new DefaultVerifyModule();
 * const result = await module.verify({
 *   changes: fileChanges,
 *   goal: 'Add JWT auth',
 *   strictness: 'high',
 * });
 * console.log(result.passed, result.overallScore);
 * ```
 */
export interface VerifyModule {
    /**
     * Run verification checks on the given changes.
     */
    verify(params: VerifyParams): Promise<VerificationResult>;
}
/**
 * DefaultVerifyModule — Built-in verification module implementation.
 *
 * Runs a pipeline of checks:
 * 1. Security scan — automated regex-based scan of all file changes
 * 2. Goal-alignment review — LLM-based check (if callLLM provided)
 * 3. Test result check — if test results provided
 * 4. Run output check — if runner output provided
 */
export declare class DefaultVerifyModule implements VerifyModule {
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Run all verification checks and produce a structured result.
     */
    verify(params: VerifyParams): Promise<VerificationResult>;
    /** Run automated security scan on all file changes */
    private runSecurityCheck;
    /** Use LLM to verify changes align with the user's goal */
    private runGoalAlignmentCheck;
    /** Check test results for failures */
    private runTestCheck;
    /** Check runner output for errors, respecting strictness level */
    private runOutputCheck;
    /** Build the prompt for LLM-based goal alignment check */
    private buildAlignmentPrompt;
}
//# sourceMappingURL=verify-module.d.ts.map
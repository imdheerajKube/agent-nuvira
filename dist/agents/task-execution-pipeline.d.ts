/**
 * TaskExecutionPipeline — Structured 6-step task execution pipeline.
 *
 * Enforces a deterministic execution order with automatic data flow between steps:
 *
 *   plan → inspect → edit → test → verify → summarize
 *
 * Each step feeds its output directly into the next step. The pipeline supports
 * retry loops: if verification fails, the pipeline loops back to edit with
 * failure context. Every action is logged to an audit trail for replay/debugging.
 *
 * @see ARCHITECTURE.md §3 — Module Specifications
 * @see ARCHITECTURE.md §4.4 — Data Flow
 *
 * Phase 7 of the architecture migration — replaces ad-hoc agent dispatch with
 * a structured, enforceable pipeline.
 */
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn } from './agent.js';
import type { InspectModule, InspectionResult } from './inspect-module.js';
import type { VerifyModule, VerificationResult } from './verify-module.js';
import type { ReportModule, ExecutionReport } from './report-module.js';
import type { AuditTrail } from './pipeline-audit.js';
/** Configuration for a pipeline execution */
export interface PipelineConfig {
    /** The LLM call function */
    callLLM: LLMCallFn;
    /** Working directory for file operations */
    workingDirectory: string;
    /** Maximum retry attempts for the edit→verify loop (default: 1) */
    maxVerifyRetries?: number;
    /** Verification strictness (default: 'medium') */
    strictness?: 'low' | 'medium' | 'high';
    /** Whether to enable dry-run mode (no disk writes, default: false) */
    dryRun?: boolean;
    /** Whether to enable verbose logging (default: false) */
    verbose?: boolean;
    /** Custom event bus (defaults to global) */
    eventBus?: EventBus;
    /** Custom inspect module (defaults to DefaultInspectModule) */
    inspectModule?: InspectModule;
    /** Custom verify module (defaults to DefaultVerifyModule) */
    verifyModule?: VerifyModule;
    /** Custom report module (defaults to DefaultReportModule) */
    reportModule?: ReportModule;
}
/** Result of a single pipeline step */
export interface StepResult<T = unknown> {
    /** Whether the step completed successfully */
    success: boolean;
    /** Human-readable summary of what happened */
    summary: string;
    /** Step output data */
    data?: T;
    /** Error message if the step failed */
    error?: string;
    /** Duration in milliseconds */
    durationMs: number;
}
/** The complete output of the plan step */
export interface PlanOutput {
    /** The user's goal */
    goal: string;
    /** Decomposed task descriptions */
    tasks: string[];
    /** Estimated complexity */
    complexity: 'simple' | 'moderate' | 'complex';
}
/** The complete output of the edit step */
export interface EditOutput {
    /** File changes that were generated */
    changes: Array<{
        path: string;
        status: 'created' | 'modified' | 'deleted' | 'unchanged';
        newContent?: string;
        originalContent?: string;
    }>;
    /** Warnings generated during editing */
    warnings: string[];
}
/** The complete output of the test step */
export interface TestOutput {
    /** Whether all tests passed */
    passed: boolean;
    /** Number of tests that passed */
    passedCount: number;
    /** Number of tests that failed */
    failedCount: number;
    /** Total tests run */
    totalCount: number;
    /** Test output / log */
    output?: string;
}
/** The final result of the entire pipeline */
export interface PipelineResult {
    /** Overall success */
    success: boolean;
    /** The user's goal */
    goal: string;
    /** Per-step results */
    steps: {
        plan: StepResult<PlanOutput>;
        inspect: StepResult<InspectionResult>;
        edit: StepResult<EditOutput>;
        test: StepResult<TestOutput>;
        verify: StepResult<VerificationResult>;
        summarize: StepResult<ExecutionReport>;
    };
    /** Full audit trail */
    audit: AuditTrail;
    /** Total duration in milliseconds */
    totalDurationMs: number;
    /** Whether the pipeline was retried (edit→verify loop) */
    wasRetried: boolean;
    /** Number of verify→edit retry cycles */
    retryCount: number;
}
/**
 * TaskExecutionPipeline — Structured 6-step execution pipeline.
 *
 * Usage:
 * ```typescript
 * const pipeline = new TaskExecutionPipeline();
 * const result = await pipeline.execute('Add JWT auth', {
 *   callLLM,
 *   workingDirectory: process.cwd(),
 *   verbose: true,
 * });
 * console.log(result.success);
 * console.log(result.audit.replay()); // Full audit log
 * ```
 */
export declare class TaskExecutionPipeline {
    private eventBus;
    private inspectModule;
    private verifyModule;
    private reportModule;
    constructor(config?: {
        eventBus?: EventBus;
        inspectModule?: InspectModule;
        verifyModule?: VerifyModule;
        reportModule?: ReportModule;
    });
    /**
     * Execute the full 6-step pipeline.
     *
     * Steps:
     * 1. Plan — Decompose the goal into a structured plan
     * 2. Inspect — Scan codebase for relevant files
     * 3. Edit — Generate code changes
     * 4. Test — Run tests and capture results
     * 5. Verify — Validate changes against quality gates
     * 6. Summarize — Produce final structured report
     */
    execute(goal: string, config: PipelineConfig): Promise<PipelineResult>;
    /**
     * Step 1: Plan — Decompose the user's goal into a structured execution plan.
     *
     * Uses the LLM to produce a list of task descriptions that guide the
     * subsequent inspect and edit steps.
     */
    private stepPlan;
    /**
     * Step 2: Inspect — Scan the codebase for files relevant to the goal.
     *
     * Delegates to the InspectModule (Phase 5/6) which uses LLM-based
     * file classification with keyword-scanning fallback.
     */
    private stepInspect;
    /**
     * Step 3: Edit — Generate code changes based on the plan and inspection results.
     *
     * Uses the LLM to produce file changes. Each change includes before/after
     * content for auditability.
     */
    private stepEdit;
    /**
     * Step 4: Test — Run tests and capture results.
     *
     * Uses the LLM to determine the test command or falls back to npm test.
     */
    private stepTest;
    /**
     * Step 5: Verify — Validate changes against quality gates.
     *
     * Checks: security, goal-alignment, test results, code quality.
     * If verification fails, the pipeline can retry the edit step.
     */
    private stepVerify;
    /**
     * Step 6: Summarize — Produce a final structured report.
     *
     * Delegates to the ReportModule which supports multiple output formats.
     */
    private stepSummarize;
    /**
     * Build the prompt for the Plan step.
     */
    private buildPlanPrompt;
    /**
     * Build the prompt for the Edit step.
     */
    private buildEditPrompt;
    /**
     * Parse the LLM plan response into a list of task strings.
     */
    private parsePlanResponse;
    /**
     * Parse the LLM edit response into file changes.
     */
    private parseEditResponse;
    /**
     * Parse test output to extract pass/fail counts.
     */
    private parseTestOutput;
    /**
     * Detect the best test command for the project.
     */
    private detectTestCommand;
    /**
     * Apply file changes to disk with atomic writes.
     */
    private applyChanges;
    /**
     * Emit an event on the event bus.
     */
    private emitEvent;
    /**
     * Format elapsed time as human-readable string.
     */
    private formatElapsed;
    /**
     * Build the final PipelineResult from all step results.
     */
    private buildResult;
}
//# sourceMappingURL=task-execution-pipeline.d.ts.map
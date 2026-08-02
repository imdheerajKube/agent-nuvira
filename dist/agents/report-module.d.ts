/**
 * ReportModule — Produces structured summaries of what happened, what changed,
 * and what's next. Phase 4 of the architecture migration: extract from
 * Orchestrator's buildResult() into a pluggable module with multiple output formats.
 *
 * @see ARCHITECTURE.md §3.7 — Report Module specification
 */
import type { EventBus } from '../observability/event-bus.js';
/** Summary of a single agent's execution */
export interface AgentResultSummary {
    /** Agent type (e.g. 'planner', 'writer', 'runner') */
    agent: string;
    /** Execution status */
    status: 'passed' | 'failed' | 'skipped';
    /** Summary of what the agent did */
    summary: string;
}
/** A file change entry for the report */
export interface ReportFileChange {
    /** Relative path to the file */
    path: string;
    /** Change status */
    status: 'created' | 'modified' | 'deleted' | 'unchanged';
}
/** Execution report — the final output of an orchestration pipeline */
export interface ExecutionReport {
    /** Overall success */
    success: boolean;
    /** Human-readable summary */
    summary: string;
    /** Structured details */
    details: {
        /** Original user goal */
        goal: string;
        /** Tasks completed vs total */
        tasksCompleted: number;
        tasksTotal: number;
        /** Wall-clock duration (human-readable string) */
        duration: string;
        /** Per-agent breakdown */
        agentBreakdown: AgentResultSummary[];
        /** File changes summary */
        fileChanges: ReportFileChange[];
        /** Optional test summary */
        testSummary?: string;
        /** Optional verification score (0.0 – 1.0) */
        verificationScore?: number;
        /** Error message if the pipeline failed */
        error?: string;
    };
    /** Follow-up suggestions for the user */
    followUp?: {
        /** Suggested next actions */
        suggestedActions: string[];
        /** Confidence in the suggestions */
        confidence: 'high' | 'medium' | 'low';
    };
    /** Metadata */
    meta?: {
        /** Duration in milliseconds */
        durationMs: number;
        /** Memory trajectory ID if stored */
        trajectoryId?: string;
        /** Review bundle ID if review mode was enabled */
        reviewId?: string;
        /** Runner output if available */
        runOutput?: string;
    };
}
/** Parameters for the ReportModule.generate() method */
export interface ReportParams {
    /** Original user goal */
    goal: string;
    /** Per-agent execution results */
    agentResults: Array<{
        agent: string;
        success: boolean;
        summary: string;
    }>;
    /** Raw file changes from the vault */
    fileChanges: Array<{
        path: string;
        status: string;
    }>;
    /** Whether the pipeline had failures */
    hasFailures: boolean;
    /** Duration in milliseconds */
    durationMs: number;
    /** Optional test result summary */
    testSummary?: string;
    /** Optional runner output */
    runOutput?: string;
    /** Optional error message */
    error?: string;
    /** Optional memory trajectory ID */
    trajectoryId?: string;
    /** Optional review bundle ID */
    reviewId?: string;
    /** Optional verification score */
    verificationScore?: number;
}
/** Supported output formats */
export type ReportFormat = 'text' | 'json' | 'markdown' | 'github-annotation';
/**
 * ReportModule — Produce structured summaries of pipeline execution.
 *
 * Each implementation owns the logic to:
 * 1. Collect and structure execution data into an ExecutionReport
 * 2. Format the report into one or more output formats
 *
 * @example
 * ```typescript
 * const module = new DefaultReportModule();
 * const report = await module.generate(params);
 * const text = module.format(report, 'text');
 * const json = module.format(report, 'json');
 * ```
 */
export interface ReportModule {
    /**
     * Generate an ExecutionReport from pipeline execution data.
     */
    generate(params: ReportParams): Promise<ExecutionReport>;
    /**
     * Format an ExecutionReport into a string in the requested format.
     */
    format(report: ExecutionReport, format: ReportFormat): string;
}
/**
 * DefaultReportModule — Built-in report module implementation.
 *
 * Transforms pipeline execution data into structured ExecutionReport and
 * supports multiple output formats (text, json, markdown, github-annotation).
 */
export declare class DefaultReportModule implements ReportModule {
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Generate an ExecutionReport from pipeline execution data.
     */
    generate(params: ReportParams): Promise<ExecutionReport>;
    /**
     * Format an ExecutionReport into the requested output format.
     */
    format(report: ExecutionReport, format: ReportFormat): string;
    /**
     * Generate follow-up suggestions based on the report content.
     */
    private generateFollowUp;
}
//# sourceMappingURL=report-module.d.ts.map
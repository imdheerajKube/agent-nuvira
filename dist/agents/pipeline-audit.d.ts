/**
 * PipelineAudit — Deterministic action audit trail for the task execution pipeline.
 *
 * Records every action taken during pipeline execution so that:
 * 1. The entire execution can be replayed for debugging
 * 2. Each step has a complete before/after snapshot
 * 3. Failed executions can be analyzed step-by-step
 * 4. The audit log can be serialized to JSON for persistence
 *
 * @see ARCHITECTURE.md §4.3 — Safe Execution Layer
 */
/** Severity level for an audit entry */
export type AuditSeverity = 'info' | 'warning' | 'error' | 'success';
/** A single entry in the audit trail */
export interface AuditEntry {
    /** Unique entry ID (monotonic counter) */
    id: number;
    /** Timestamp when the action occurred */
    timestamp: string;
    /** Which pipeline step produced this entry */
    step: string;
    /** Short action label (e.g. 'plan:started', 'edit:file-written') */
    action: string;
    /** Severity level */
    severity: AuditSeverity;
    /** Human-readable message */
    message: string;
    /** Optional structured metadata for replay */
    metadata?: Record<string, unknown>;
}
/** Snapshot of state at a given point in the pipeline */
export interface PipelineSnapshot {
    /** Step number (0-based) */
    stepIndex: number;
    /** Step name */
    stepName: string;
    /** When the snapshot was taken */
    timestamp: string;
    /** Number of file changes so far */
    fileChangeCount: number;
    /** Key metrics at this point */
    metrics: {
        artifactsCollected: number;
        filesChanged: number;
        testsPassed: number;
        testsFailed: number;
        durationMs: number;
    };
}
/** Full audit trail for a single pipeline execution */
export interface AuditTrail {
    /** Pipeline execution ID */
    pipelineId: string;
    /** The user's goal */
    goal: string;
    /** When the pipeline started */
    startedAt: string;
    /** All audit entries in chronological order */
    entries: AuditEntry[];
    /** State snapshots taken at each step boundary */
    snapshots: PipelineSnapshot[];
    /** Whether the pipeline completed successfully */
    success: boolean;
    /** When the pipeline ended */
    endedAt?: string;
}
/**
 * PipelineAudit — Records every action during task execution.
 *
 * Usage:
 * ```typescript
 * const audit = new PipelineAudit('exec-001', 'Add JWT auth');
 * audit.log('plan', 'plan:started', 'info', 'Decomposing goal...');
 * // ... later
 * const trail = audit.snapshot('plan', { artifactsCollected: 5, ... });
 * audit.complete(true);
 * const json = audit.serialize();
 * ```
 */
export declare class PipelineAudit {
    private entryId;
    private startTime;
    private trail;
    constructor(pipelineId: string, goal: string);
    /**
     * Log an action to the audit trail.
     */
    log(step: string, action: string, severity: AuditSeverity, message: string, metadata?: Record<string, unknown>): void;
    /**
     * Record a pipeline state snapshot at a step boundary.
     */
    snapshot(stepIndex: number, stepName: string, metrics: {
        artifactsCollected: number;
        filesChanged: number;
        testsPassed: number;
        testsFailed: number;
    }): PipelineSnapshot;
    /**
     * Mark the pipeline as completed (success or failure).
     */
    complete(success: boolean): void;
    /**
     * Get the full audit trail.
     */
    getTrail(): AuditTrail;
    /**
     * Get entries filtered by step name.
     */
    getEntriesByStep(step: string): AuditEntry[];
    /**
     * Get entries with error severity.
     */
    getErrors(): AuditEntry[];
    /**
     * Serialize the audit trail to a JSON string.
     */
    serialize(): string;
    /**
     * Replay the audit entries as a human-readable log.
     * Useful for debugging or post-mortem analysis.
     */
    replay(): string;
    /**
     * Get the elapsed time as a human-readable string.
     */
    private elapsed;
}
//# sourceMappingURL=pipeline-audit.d.ts.map
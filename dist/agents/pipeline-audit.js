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
// ─── PipelineAudit ──────────────────────────────────────────────────────────
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
export class PipelineAudit {
    entryId = 0;
    startTime;
    trail;
    constructor(pipelineId, goal) {
        this.startTime = Date.now();
        this.trail = {
            pipelineId,
            goal,
            startedAt: new Date().toISOString(),
            entries: [],
            snapshots: [],
            success: false,
        };
    }
    /**
     * Log an action to the audit trail.
     */
    log(step, action, severity, message, metadata) {
        this.trail.entries.push({
            id: this.entryId++,
            timestamp: new Date().toISOString(),
            step,
            action,
            severity,
            message,
            metadata,
        });
    }
    /**
     * Record a pipeline state snapshot at a step boundary.
     */
    snapshot(stepIndex, stepName, metrics) {
        const snap = {
            stepIndex,
            stepName,
            timestamp: new Date().toISOString(),
            fileChangeCount: metrics.filesChanged,
            metrics: {
                ...metrics,
                durationMs: Date.now() - this.startTime,
            },
        };
        this.trail.snapshots.push(snap);
        return snap;
    }
    /**
     * Mark the pipeline as completed (success or failure).
     */
    complete(success) {
        this.trail.success = success;
        this.trail.endedAt = new Date().toISOString();
        this.log('pipeline', success ? 'pipeline:completed' : 'pipeline:failed', success ? 'success' : 'error', success
            ? `Pipeline completed successfully in ${this.elapsed()}`
            : `Pipeline failed after ${this.elapsed()}`, { durationMs: Date.now() - this.startTime });
    }
    /**
     * Get the full audit trail.
     */
    getTrail() {
        return this.trail;
    }
    /**
     * Get entries filtered by step name.
     */
    getEntriesByStep(step) {
        return this.trail.entries.filter((e) => e.step === step);
    }
    /**
     * Get entries with error severity.
     */
    getErrors() {
        return this.trail.entries.filter((e) => e.severity === 'error');
    }
    /**
     * Serialize the audit trail to a JSON string.
     */
    serialize() {
        return JSON.stringify(this.trail, null, 2);
    }
    /**
     * Replay the audit entries as a human-readable log.
     * Useful for debugging or post-mortem analysis.
     */
    replay() {
        const lines = [];
        lines.push(`Pipeline: ${this.trail.pipelineId}`);
        lines.push(`Goal: ${this.trail.goal}`);
        lines.push(`Started: ${this.trail.startedAt}`);
        lines.push(`Status: ${this.trail.success ? '✅ Success' : '❌ Failed'}`);
        lines.push(`Duration: ${this.elapsed()}`);
        lines.push('');
        lines.push('── Audit Log ──');
        lines.push('');
        for (const entry of this.trail.entries) {
            const icon = entry.severity === 'error' ? '❌'
                : entry.severity === 'warning' ? '⚠️'
                    : entry.severity === 'success' ? '✅'
                        : 'ℹ️';
            const time = new Date(entry.timestamp).toLocaleTimeString();
            lines.push(`  ${icon} [${time}] [${entry.step}] ${entry.message}`);
        }
        lines.push('');
        lines.push('── Snapshots ──');
        lines.push('');
        for (const snap of this.trail.snapshots) {
            lines.push(`  Step ${snap.stepIndex}: ${snap.stepName}` +
                ` — artifacts: ${snap.metrics.artifactsCollected}` +
                `, changes: ${snap.metrics.filesChanged}` +
                `, tests: ${snap.metrics.testsPassed}/${snap.metrics.testsPassed + snap.metrics.testsFailed}` +
                `, elapsed: ${formatMs(snap.metrics.durationMs)}`);
        }
        return lines.join('\n');
    }
    /**
     * Get the elapsed time as a human-readable string.
     */
    elapsed() {
        return formatMs(Date.now() - this.startTime);
    }
}
// ─── Helpers ────────────────────────────────────────────────────────────────
/**
 * Format milliseconds to a human-readable duration string.
 */
function formatMs(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    if (seconds > 0) {
        return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
    }
    return `${ms}ms`;
}
//# sourceMappingURL=pipeline-audit.js.map
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

// ─── Types ──────────────────────────────────────────────────────────────────

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
  private entryId = 0;
  private startTime: number;
  private trail: AuditTrail;

  constructor(pipelineId: string, goal: string) {
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
  log(
    step: string,
    action: string,
    severity: AuditSeverity,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
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
  snapshot(
    stepIndex: number,
    stepName: string,
    metrics: {
      artifactsCollected: number;
      filesChanged: number;
      testsPassed: number;
      testsFailed: number;
    },
  ): PipelineSnapshot {
    const snap: PipelineSnapshot = {
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
  complete(success: boolean): void {
    this.trail.success = success;
    this.trail.endedAt = new Date().toISOString();
    this.log(
      'pipeline',
      success ? 'pipeline:completed' : 'pipeline:failed',
      success ? 'success' : 'error',
      success
        ? `Pipeline completed successfully in ${this.elapsed()}`
        : `Pipeline failed after ${this.elapsed()}`,
      { durationMs: Date.now() - this.startTime },
    );
  }

  /**
   * Get the full audit trail.
   */
  getTrail(): AuditTrail {
    return this.trail;
  }

  /**
   * Get entries filtered by step name.
   */
  getEntriesByStep(step: string): AuditEntry[] {
    return this.trail.entries.filter((e) => e.step === step);
  }

  /**
   * Get entries with error severity.
   */
  getErrors(): AuditEntry[] {
    return this.trail.entries.filter((e) => e.severity === 'error');
  }

  /**
   * Serialize the audit trail to a JSON string.
   */
  serialize(): string {
    return JSON.stringify(this.trail, null, 2);
  }

  /**
   * Replay the audit entries as a human-readable log.
   * Useful for debugging or post-mortem analysis.
   */
  replay(): string {
    const lines: string[] = [];
    lines.push(`Pipeline: ${this.trail.pipelineId}`);
    lines.push(`Goal: ${this.trail.goal}`);
    lines.push(`Started: ${this.trail.startedAt}`);
    lines.push(`Status: ${this.trail.success ? '✅ Success' : '❌ Failed'}`);
    lines.push(`Duration: ${this.elapsed()}`);
    lines.push('');
    lines.push('── Audit Log ──');
    lines.push('');

    for (const entry of this.trail.entries) {
      const icon =
        entry.severity === 'error' ? '❌'
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
      lines.push(
        `  Step ${snap.stepIndex}: ${snap.stepName}` +
        ` — artifacts: ${snap.metrics.artifactsCollected}` +
        `, changes: ${snap.metrics.filesChanged}` +
        `, tests: ${snap.metrics.testsPassed}/${snap.metrics.testsPassed + snap.metrics.testsFailed}` +
        `, elapsed: ${formatMs(snap.metrics.durationMs)}`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Get the elapsed time as a human-readable string.
   */
  private elapsed(): string {
    return formatMs(Date.now() - this.startTime);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format milliseconds to a human-readable duration string.
 */
function formatMs(ms: number): string {
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

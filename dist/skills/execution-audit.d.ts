/**
 * Execution Audit — Logs all skill executions for security and compliance.
 *
 * This provides an audit trail for:
 * - Security monitoring
 * - Compliance requirements
 * - Debugging and troubleshooting
 * - Usage analytics
 *
 * Logs include:
 * - Skill name and version
 * - Execution timestamp
 * - User/session ID
 * - Execution result (success/failure)
 * - Duration
 * - Environment variables used (masked)
 * - Any errors or warnings
 */
export type ExecutionStatus = 'success' | 'failure' | 'timeout' | 'rejected' | 'error';
export interface AuditEntry {
    /** Unique entry ID */
    id: string;
    /** Skill name */
    skillName: string;
    /** Skill version (if known) */
    skillVersion?: string;
    /** Skill source (bundled, marketplace, local) */
    skillSource: string;
    /** Execution runtime (python, node, shell) */
    runtime: string;
    /** Execution status */
    status: ExecutionStatus;
    /** Timestamp */
    timestamp: number;
    /** Session ID */
    sessionId: string;
    /** User ID (if known) */
    userId?: string;
    /** Execution duration in milliseconds */
    durationMs: number;
    /** Exit code (for shell execution) */
    exitCode?: number;
    /** Environment variables used (masked) */
    envVarsUsed?: string[];
    /** Error message (if failed) */
    error?: string;
    /** Command executed */
    command?: string;
    /** Output size in bytes */
    outputSizeBytes?: number;
}
export interface AuditConfig {
    /** Enable audit logging */
    enabled: boolean;
    /** Audit log directory */
    logDir?: string;
    /** Audit log file name */
    logFile?: string;
    /** Maximum log file size in bytes (default: 10MB) */
    maxLogSizeBytes?: number;
    /** Retention period in days (default: 30) */
    retentionDays?: number;
    /** Mask sensitive values */
    maskSensitive: boolean;
}
/**
 * Log a skill execution.
 */
export declare function logExecution(params: {
    skillName: string;
    skillVersion?: string;
    skillSource: string;
    runtime: string;
    status: ExecutionStatus;
    sessionId: string;
    userId?: string;
    durationMs: number;
    exitCode?: number;
    envVarsUsed?: string[];
    error?: string;
    command?: string;
    outputSizeBytes?: number;
}, config?: Partial<AuditConfig>): Promise<void>;
/**
 * Query audit entries (for dashboard or CLI).
 */
export declare function queryAuditEntries(filters: {
    skillName?: string;
    status?: ExecutionStatus;
    sessionId?: string;
    startDate?: number;
    endDate?: number;
    limit?: number;
}, config?: Partial<AuditConfig>): Promise<AuditEntry[]>;
/**
 * Get audit statistics.
 */
export declare function getAuditStats(config?: Partial<AuditConfig>): Promise<{
    total: number;
    success: number;
    failure: number;
    timeout: number;
    rejected: number;
    error: number;
    bySkill: Record<string, number>;
    byRuntime: Record<string, number>;
    averageDurationMs: number;
}>;
/**
 * Clean up old audit entries.
 */
export declare function cleanupAuditLog(config?: Partial<AuditConfig>): Promise<number>;
/**
 * Export audit entries for analysis.
 */
export declare function exportAuditEntries(format?: 'json' | 'csv', config?: Partial<AuditConfig>): Promise<string>;
//# sourceMappingURL=execution-audit.d.ts.map
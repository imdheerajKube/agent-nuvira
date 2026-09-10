/**
 * write_approval — Write-approval gate for memory and skill writes.
 *
 * Provides a safety mechanism for memory and skill modifications:
 * - Approval workflow for destructive writes
 * - Pending store for queued writes
 * - Rollback capability
 * - Audit logging
 */
type WriteAction = 'memory.add' | 'memory.update' | 'memory.delete' | 'skill.add' | 'skill.update' | 'skill.delete';
interface PendingWrite {
    id: string;
    action: WriteAction;
    target: string;
    data: any;
    requestedAt: number;
    status: 'pending' | 'approved' | 'denied' | 'completed' | 'failed';
    approvedAt?: number;
    completedAt?: number;
    reason?: string;
}
interface ApprovalPolicy {
    autoApprove: WriteAction[];
    requireApproval: WriteAction[];
    deny: WriteAction[];
}
declare class WriteApprovalManager {
    private pendingWrites;
    private completedWrites;
    private policy;
    private auditLog;
    constructor(policy?: Partial<ApprovalPolicy>);
    /**
     * Request approval for a write operation.
     */
    requestApproval(params: {
        action: WriteAction;
        target: string;
        data: any;
    }): {
        id: string;
        requiresApproval: boolean;
        autoApproved: boolean;
    };
    /**
     * Approve a pending write.
     */
    approve(id: string, reason?: string): boolean;
    /**
     * Deny a pending write.
     */
    deny(id: string, reason?: string): boolean;
    /**
     * Complete a write operation.
     */
    complete(id: string): boolean;
    /**
     * Mark a write as failed.
     */
    fail(id: string, reason?: string): boolean;
    /**
     * Get pending writes.
     */
    getPending(): PendingWrite[];
    /**
     * Get completed writes.
     */
    getCompleted(limit?: number): PendingWrite[];
    /**
     * Get audit log.
     */
    getAuditLog(limit?: number): typeof this.auditLog;
    /**
     * Update policy.
     */
    setPolicy(policy: Partial<ApprovalPolicy>): void;
    /**
     * Get current policy.
     */
    getPolicy(): ApprovalPolicy;
    /**
     * Clear completed writes older than retention period.
     */
    clearOlderThan(retentionMs: number): number;
}
export declare function getWriteApprovalManager(): WriteApprovalManager;
export { WriteApprovalManager };
//# sourceMappingURL=write-approval.d.ts.map
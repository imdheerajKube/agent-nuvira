/**
 * Delegation State — SQLite-backed state for crash recovery.
 *
 * Unlike in-memory state, this survives process restarts.
 * Uses better-sqlite3 for synchronous, fast operations.
 *
 * Hermes equivalent: async_delegation.py's SQLite persistence
 */
export interface DelegationRecord {
    id: string;
    delegationId: string;
    goal: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    result?: string;
    error?: string;
    pid?: number;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    retryCount: number;
    maxRetries: number;
}
export interface CompletionRecord {
    id: string;
    delegationId: string;
    success: boolean;
    result: string;
    error?: string;
    durationMs: number;
    acknowledged: boolean;
    createdAt: number;
}
export declare class DelegationStateStore {
    private db;
    constructor();
    private ensureDirectory;
    private initDatabase;
    /**
     * Create a new delegation record.
     */
    createDelegation(goal: string, delegationId?: string): DelegationRecord;
    /**
     * Update delegation status.
     */
    updateDelegation(id: string, updates: Partial<DelegationRecord>): boolean;
    /**
     * Get a delegation by ID.
     */
    getDelegation(id: string): DelegationRecord | null;
    /**
     * Get pending delegations (for recovery).
     */
    getPendingDelegations(): DelegationRecord[];
    /**
     * Get delegations by delegation_id.
     */
    getDelegationsByGroup(delegationId: string): DelegationRecord[];
    /**
     * Add a completion to the queue.
     */
    addCompletion(record: CompletionRecord): void;
    /**
     * Get unacknowledged completions.
     */
    getUnacknowledgedCompletions(): CompletionRecord[];
    /**
     * Acknowledge a completion.
     */
    acknowledgeCompletion(id: string): boolean;
    /**
     * Drain all unacknowledged completions.
     */
    drainCompletions(): CompletionRecord[];
    /**
     * Recover pending delegations after crash.
     */
    recoverPendingDelegations(): DelegationRecord[];
    private rowToDelegation;
    private rowToCompletion;
    /**
     * Close the database.
     */
    close(): void;
}
export declare function getDelegationStateStore(): DelegationStateStore;
export declare function resetDelegationStateStore(): void;
//# sourceMappingURL=delegation-state.d.ts.map
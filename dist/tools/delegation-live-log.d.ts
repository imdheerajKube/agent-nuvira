/**
 * delegation_live_log — Live tail-able transcripts for delegated subagents.
 *
 * Creates append-only, human-readable logs for each delegated task.
 * Logs stream while the subagent runs, enabling real-time monitoring.
 *
 * Features:
 * - Append-only logs (no seeks, no corruption)
 * - Auto-pruning of stale logs
 * - Credential redaction
 * - Manifest tracking
 * - Status updates
 */
declare class LiveTranscriptWriter {
    private delegationId;
    private taskIndex;
    private goal;
    private rootDir?;
    private filePath;
    private ok;
    constructor(delegationId: string, taskIndex: number, goal: string, rootDir?: string | undefined);
    /**
     * Append an event to the log.
     */
    event(role: string, content: string): void;
    /**
     * Log assistant text.
     */
    assistantText(text: string): void;
    /**
     * Log thinking.
     */
    thinking(text: string): void;
    /**
     * Log tool start.
     */
    toolStart(name: string, args?: any): void;
    /**
     * Log tool result.
     */
    toolResult(name: string, result?: any, duration?: number, isError?: boolean): void;
    /**
     * Log lifecycle marker.
     */
    marker(text: string): void;
    /**
     * Finalize the transcript.
     */
    finalize(entry: {
        status: string;
        exitReason?: string;
        error?: string;
    }): void;
    /**
     * One-line truncation.
     */
    private oneLine;
    /**
     * Redact credentials.
     */
    private redact;
}
declare class DelegationLiveLogManager {
    private transcripts;
    private rootDir;
    constructor(rootDir?: string);
    /**
     * Create live transcripts for a batch of tasks.
     */
    createTranscripts(tasks: {
        goal: string;
        context?: string;
    }[], delegationId?: string): {
        delegationId: string;
        paths: string[];
    };
    /**
     * Get writer for a specific task.
     */
    getWriter(delegationId: string, taskIndex: number): LiveTranscriptWriter | null;
    /**
     * Update manifest status.
     */
    updateStatus(delegationId: string, results: {
        taskIndex: number;
        status: string;
        exitReason?: string;
    }[]): void;
    /**
     * Prune stale live directories.
     */
    pruneStale(): number;
    /**
     * Write manifest for a delegation batch.
     */
    private writeManifest;
}
export declare function getDelegationLiveLogManager(): DelegationLiveLogManager;
export { DelegationLiveLogManager, LiveTranscriptWriter };
//# sourceMappingURL=delegation-live-log.d.ts.map
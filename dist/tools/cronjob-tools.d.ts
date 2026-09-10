/**
 * Cronjob Tools — Cron job management with heartbeat, timeout, and run history.
 *
 * Hermes equivalent: cronjob_tools.py
 *
 * Features:
 * - Cron job creation and management
 * - Heartbeat for inactivity watchdog
 * - Timeout management
 * - Run history tracking
 * - Scheduling with cron expressions
 * - Job groups and categories
 */
export type CronStatus = 'active' | 'paused' | 'completed' | 'failed' | 'timeout';
export interface CronJob {
    id: string;
    name: string;
    description?: string;
    schedule: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    status: CronStatus;
    group?: string;
    timeoutMs: number;
    maxRetries: number;
    retryCount: number;
    lastRun?: number;
    nextRun?: number;
    lastResult?: CronRunResult;
    createdAt: number;
    updatedAt: number;
}
export interface CronRunResult {
    jobId: string;
    runId: string;
    status: 'success' | 'error' | 'timeout';
    output: string;
    error?: string;
    durationMs: number;
    startedAt: number;
    completedAt: number;
}
export interface CronJobStats {
    totalJobs: number;
    activeJobs: number;
    pausedJobs: number;
    failedJobs: number;
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    averageDuration: number;
}
export declare class CronParser {
    /**
     * Parse a cron expression and get the next run time.
     */
    static parseNextRun(expression: string, from?: Date): Date;
    private static matchesField;
    /**
     * Get a human-readable description of a cron expression.
     */
    static describe(expression: string): string;
}
export declare class CronJobManager {
    private jobs;
    private runHistory;
    private timers;
    private heartbeats;
    private lastHeartbeat;
    constructor();
    /**
     * Create a cron job.
     */
    create(name: string, schedule: string, command: string, options?: Partial<Omit<CronJob, 'id' | 'name' | 'schedule' | 'command' | 'status' | 'createdAt' | 'updatedAt'>>): CronJob;
    /**
     * Get a job by ID.
     */
    getJob(jobId: string): CronJob | null;
    /**
     * Get all jobs.
     */
    getAllJobs(): CronJob[];
    /**
     * Get jobs by group.
     */
    getJobsByGroup(group: string): CronJob[];
    /**
     * Update a job.
     */
    updateJob(jobId: string, updates: Partial<Pick<CronJob, 'name' | 'description' | 'schedule' | 'command' | 'args' | 'env' | 'group' | 'timeoutMs' | 'maxRetries'>>): boolean;
    /**
     * Delete a job.
     */
    deleteJob(jobId: string): boolean;
    /**
     * Enable a job.
     */
    enableJob(jobId: string): boolean;
    /**
     * Pause a job.
     */
    pauseJob(jobId: string): boolean;
    /**
     * Run a job immediately.
     */
    runJob(jobId: string): Promise<CronRunResult | null>;
    /**
     * Start heartbeat for a job.
     */
    private startHeartbeat;
    /**
     * Stop heartbeat for a job.
     */
    private stopHeartbeat;
    /**
     * Get last heartbeat time.
     */
    getLastHeartbeat(jobId: string): number | undefined;
    /**
     * Get run history for a job.
     */
    getRunHistory(jobId: string, limit?: number): CronRunResult[];
    /**
     * Get all run history.
     */
    getAllRunHistory(): CronRunResult[];
    /**
     * Get job statistics.
     */
    getStats(): CronJobStats;
    /**
     * Get next N jobs to run.
     */
    getNextJobs(count?: number): CronJob[];
    private stopTimer;
    private load;
    private save;
}
export declare function getCronJobManager(): CronJobManager;
export declare function resetCronJobManager(): void;
//# sourceMappingURL=cronjob-tools.d.ts.map
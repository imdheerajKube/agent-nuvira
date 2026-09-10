/**
 * J2 — Scheduled jobs (`src/gateway/cron.ts`).
 *
 * Jobs are scheduled tool invocations (H1 registry tools — e.g. `build`,
 * `test`, `code_search`) with delivery to a channel (J1, not landed) or a CLI
 * notification. This module provides the SCHEDULER CORE: job persistence,
 * schedule validation (node-cron), next-run computation, and dry-run.
 *
 * Design (matches the project's J-series rules):
 * - Jobs persist to `~/.nuvira/cron/jobs.json` — readable, inspectable JSON.
 * - Schedule validation uses **node-cron** (MIT, pure JS — decision 12-safe).
 * - `runJobNow(job)` invokes the registered H1 tool via the tool registry and
 *   emits `cron:run/result/error` events on the EventBus, so a future gateway
 *   (J1) or the dashboard can render live lanes — the same event pattern as
 *   E2/H2.
 * - `dryRunJob(job)` validates the schedule + tool WITHOUT executing anything.
 *
 * CLI surface lives in `src/cli/admin.ts` (`nuvira admin cron add/list/remove`).
 */
import { EventNames } from '../observability/event-bus.js';
/** A scheduled job: a tool invocation on a cron schedule. */
export interface CronJob {
    /** Unique id (slugified name + timestamp). */
    id: string;
    /** Human name (e.g. "nightly-build"). */
    name: string;
    /** 5-field cron expression (e.g. "0 3 * * *"). */
    schedule: string;
    /** H1 registry tool to invoke (e.g. "build", "test", "code_search"). */
    tool: string;
    /** Tool args as a JSON object (validated against the tool's schema). */
    args: Record<string, unknown>;
    /** When the job was created. */
    createdAt: number;
    /** When the job last ran (0 = never). */
    lastRunAt: number;
    /** Whether the job is enabled. */
    enabled: boolean;
    /**
     * Optional channel alias (or platform:channelId) to deliver the result to
     * via the J1 gateway (e.g. "ops"). Empty = CLI notification only.
     */
    deliverTo?: string;
}
/** List all cron jobs. */
export declare function listCronJobs(): CronJob[];
/**
 * Add a cron job. Validates the cron expression and (unless `allowUnknownTool`)
 * that the tool is registered. Returns the created job or an error string.
 */
export declare function addCronJob(name: string, schedule: string, tool: string, args?: Record<string, unknown>, deliverTo?: string): {
    ok: true;
    job: CronJob;
} | {
    ok: false;
    error: string;
};
/** Remove a cron job by name. Returns true if removed. */
export declare function removeCronJob(name: string): boolean;
/**
 * Dry-run: validate schedule + tool WITHOUT executing. Returns a description
 * of what would run (or an error string). The plan's test surface.
 */
export declare function dryRunCronJob(name: string, schedule: string, tool: string, args?: Record<string, unknown>): {
    ok: true;
    description: string;
    nextRun: string;
} | {
    ok: false;
    error: string;
};
/**
 * Compute the next run time for a job WITHOUT scheduling it. Pure helper for
 * `nuvira admin cron list` and tests. (node-cron v4's getNextRun() is always
 * relative to now, so no `from` parameter is exposed.)
 */
export declare function nextRunAt(schedule: string): Date | null;
/**
 * Run a job NOW: validate args against the tool schema, invoke the tool with
 * a minimal ToolContext, and emit cron:run/result/error events. Returns the
 * tool's output string (or an error). Never throws.
 */
export declare function runJobNow(job: CronJob): Promise<{
    ok: boolean;
    output: string;
}>;
/** Get the list of registered H1 tool names (for CLI help). */
export declare function getToolNames(): string[];
/** Re-export EventNames so the gateway surfaces share one vocabulary. */
export { EventNames };
//# sourceMappingURL=cron.d.ts.map
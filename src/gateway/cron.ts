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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import cron from 'node-cron';
import { resolveNuviraHome } from '../config/paths.js';

import { getTool, listTools } from '../tools/registry.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Constants ──────────────────────────────────────────────────────────────

const CRON_DIR = join(resolveNuviraHome(), 'cron');
const JOBS_PATH = join(CRON_DIR, 'jobs.json');

// ─── Store ──────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(CRON_DIR)) {
    try { mkdirSync(CRON_DIR, { recursive: true }); } catch { /* best-effort */ }
  }
}

function readJobs(): CronJob[] {
  try {
    ensureDir();
    if (!existsSync(JOBS_PATH)) return [];
    const parsed = JSON.parse(readFileSync(JOBS_PATH, 'utf-8')) as { jobs: CronJob[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs: CronJob[]): void {
  try {
    ensureDir();
    writeFileSync(JOBS_PATH, JSON.stringify({ version: 1, jobs }, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

// ─── API ────────────────────────────────────────────────────────────────────

/** List all cron jobs. */
export function listCronJobs(): CronJob[] {
  return [...readJobs()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Add a cron job. Validates the cron expression and (unless `allowUnknownTool`)
 * that the tool is registered. Returns the created job or an error string.
 */
export function addCronJob(
  name: string,
  schedule: string,
  tool: string,
  args: Record<string, unknown> = {},
  deliverTo?: string,
): { ok: true; job: CronJob } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(trimmed)) {
    return { ok: false, error: `Job name must be lowercase alphanumeric with hyphens (got '${name}')` };
  }
  if (!cron.validate(schedule)) {
    return { ok: false, error: `Invalid cron expression: '${schedule}' (expected 5 fields, e.g. '0 3 * * *')` };
  }
  const registered = getTool(tool);
  if (!registered) {
    const available = getToolNames();
    return { ok: false, error: `Unknown tool '${tool}'. Available: ${available.join(', ')}` };
  }
  // Validate explicitly-provided args against the tool's zod schema AT ADD
  // TIME — a typo surfaces in `nuvira admin cron add`, not silently at 3am
  // (in-tool .parse() already prevents crashes). Empty args are allowed: the
  // tool's defaults apply, and the plan's canonical example (`add nightly
  // "0 3 * * *" test`) passes none.
  if (Object.keys(args).length > 0) {
    const argsCheck = registered.inputSchema.safeParse(args);
    if (!argsCheck.success) {
      const issue = argsCheck.error.issues[0];
      return {
        ok: false,
        error: `Invalid args for tool '${tool}': ${issue.path.join('.') || '(root)'} ${issue.message}`,
      };
    }
  }

  const jobs = readJobs();
  if (jobs.some((j) => j.name === trimmed)) {
    return { ok: false, error: `A job named '${trimmed}' already exists.` };
  }

  const job: CronJob = {
    id: `cron-${trimmed}-${Date.now().toString(36)}`,
    name: trimmed,
    schedule,
    tool,
    args,
    createdAt: Date.now(),
    lastRunAt: 0,
    enabled: true,
    deliverTo: deliverTo?.trim() ? deliverTo.trim() : undefined,
  };
  jobs.push(job);
  writeJobs(jobs);
  return { ok: true, job };
}

/** Remove a cron job by name. Returns true if removed. */
export function removeCronJob(name: string): boolean {
  const jobs = readJobs();
  const before = jobs.length;
  const remaining = jobs.filter((j) => j.name !== name);
  if (remaining.length === before) return false;
  writeJobs(remaining);
  return true;
}

/**
 * Dry-run: validate schedule + tool WITHOUT executing. Returns a description
 * of what would run (or an error string). The plan's test surface.
 */
export function dryRunCronJob(
  name: string,
  schedule: string,
  tool: string,
  args: Record<string, unknown> = {},
): { ok: true; description: string; nextRun: string } | { ok: false; error: string } {
  if (!cron.validate(schedule)) {
    return { ok: false, error: `Invalid cron expression: '${schedule}'` };
  }
  const registered = getTool(tool);
  if (!registered) {
    return { ok: false, error: `Unknown tool '${tool}'` };
  }
  if (Object.keys(args).length > 0) {
    const argsCheck = registered.inputSchema.safeParse(args);
    if (!argsCheck.success) {
      const issue = argsCheck.error.issues[0];
      return {
        ok: false,
        error: `Invalid args for tool '${tool}': ${issue.path.join('.') || '(root)'} ${issue.message}`,
      };
    }
  }
  // node-cron v4: schedule() starts a timer, but destroy() (called right
  // after, synchronously) cancels it — so computing a next-run never leaks a
  // live task. Do NOT stop() first: getNextRun() returns null in the stopped
  // state (v4 quirk — see node-cron.js getNextRun).
  const task = cron.schedule(schedule, () => { /* no-op — compute next run only */ });
  const nextDate = task.getNextRun();
  task.destroy();
  return {
    ok: true,
    description: `Would run tool '${tool}' every '${schedule}'${Object.keys(args).length ? ` with args ${JSON.stringify(args)}` : ''}`,
    nextRun: nextDate ? nextDate.toISOString() : 'never',
  };
}

/**
 * Compute the next run time for a job WITHOUT scheduling it. Pure helper for
 * `nuvira admin cron list` and tests. (node-cron v4's getNextRun() is always
 * relative to now, so no `from` parameter is exposed.)
 */
export function nextRunAt(schedule: string): Date | null {
  if (!cron.validate(schedule)) return null;
  const task = cron.schedule(schedule, () => { /* no-op */ });
  const next = task.getNextRun();
  task.destroy(); // cancels the timer synchronously (see dryRunCronJob)
  return next;
}

/**
 * Run a job NOW: validate args against the tool schema, invoke the tool with
 * a minimal ToolContext, and emit cron:run/result/error events. Returns the
 * tool's output string (or an error). Never throws.
 */
export async function runJobNow(job: CronJob): Promise<{ ok: boolean; output: string }> {
  const tool = getTool(job.tool);
  const bus = getEventBus();
  if (!tool) {
    bus.emit(EventNames.CRON_ERROR, { jobId: job.id, name: job.name, error: `Unknown tool '${job.tool}'` }, 'cron');
    return { ok: false, output: `Unknown tool '${job.tool}'` };
  }
  bus.emit(EventNames.CRON_RUN, { jobId: job.id, name: job.name, tool: job.tool, at: new Date().toISOString() }, 'cron');
  try {
    // Pipeline tools (build/resume/repair/document/...) resolve providers and
    // the workspace through ctx.configManager — a cron run has no calling
    // command, so construct a fresh manager (it auto-opens the secret vault,
    // matching every other runtime entry point; see config/manager.ts).
    const output = await tool.run(job.args, { configManager: new ConfigManager() });
    // Mark lastRunAt on success.
    const jobs = readJobs();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      jobs[idx].lastRunAt = Date.now();
      writeJobs(jobs);
    }
    bus.emit(EventNames.CRON_RESULT, { jobId: job.id, name: job.name, output }, 'cron');
    // J1 delivery — when the job declares a channel alias, forward the result
    // through the gateway. Best-effort: a missing/unconfigured channel must
    // never fail the run.
    if (job.deliverTo) {
      try {
        await deliverToChannel(job, output);
      } catch { /* best-effort delivery */ }
    }
    return { ok: true, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bus.emit(EventNames.CRON_ERROR, { jobId: job.id, name: job.name, error: message }, 'cron');
    return { ok: false, output: message };
  }
}

/**
 * J1 — deliver a cron result to a channel via the gateway registry.
 * Builds a fresh registry with the env-configured adapters; resolves the
 * alias (or platform:channelId) and sends a compact status line.
 */
async function deliverToChannel(job: CronJob, output: string): Promise<void> {
  const { GatewayRegistry } = await import('./registry.js');
  const { createConfiguredAdapters } = await import('./adapters.js');
  const registry = new GatewayRegistry({ streamEvents: false });
  for (const adapter of createConfiguredAdapters()) registry.register(adapter);
  const ref = registry.directory.resolve(job.deliverTo!);
  if (!ref) {
    logger.warn(`cron '${job.name}': unknown delivery channel '${job.deliverTo}' — add it with \`nuvira gateway alias add\``);
    return;
  }
  const ok = await registry.sendToRef(ref, `⏰ cron '${job.name}' → ${String(output).slice(0, 500)}`);
  if (!ok) {
    logger.warn(`cron '${job.name}': delivery to ${job.deliverTo} failed (adapter not configured)`);
  }
}

/** Get the list of registered H1 tool names (for CLI help). */
export function getToolNames(): string[] {
  return listTools().map((t) => t.name);
}

/** Re-export EventNames so the gateway surfaces share one vocabulary. */
export { EventNames };


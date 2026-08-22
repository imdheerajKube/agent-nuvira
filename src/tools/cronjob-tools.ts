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

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type CronStatus = 'active' | 'paused' | 'completed' | 'failed' | 'timeout';

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  schedule: string; // cron expression
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

// ─── Cron Expression Parser ───────────────────────────────────────────────

export class CronParser {
  /**
   * Parse a cron expression and get the next run time.
   */
  static parseNextRun(expression: string, from: Date = new Date()): Date {
    const parts = expression.split(' ');
    if (parts.length < 5) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const next = new Date(from);

    // Simple next-run calculation (next matching time)
    next.setSeconds(0);
    next.setMilliseconds(0);
    next.setMinutes(next.getMinutes() + 1);

    for (let i = 0; i < 366 * 24 * 60; i++) {
      if (this.matchesField(next.getMinutes(), minute) &&
          this.matchesField(next.getHours(), hour) &&
          this.matchesField(next.getDate(), dayOfMonth) &&
          this.matchesField(next.getMonth() + 1, month) &&
          this.matchesField(next.getDay(), dayOfWeek)) {
        return next;
      }
      next.setMinutes(next.getMinutes() + 1);
    }

    throw new Error(`Could not find next run time for expression: ${expression}`);
  }

  private static matchesField(value: number, field: string): boolean {
    if (field === '*') return true;
    if (field.includes(',')) {
      return field.split(',').some((f) => this.matchesField(value, f.trim()));
    }
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      return value >= start && value <= end;
    }
    if (field.includes('/')) {
      const [start, step] = field.split('/').map(Number);
      return (value - start) % step === 0;
    }
    return value === parseInt(field, 10);
  }

  /**
   * Get a human-readable description of a cron expression.
   */
  static describe(expression: string): string {
    const parts = expression.split(' ');
    if (parts.length < 5) return 'Invalid expression';

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    if (minute === '*' && hour === '*') return 'Every minute';
    if (hour === '*' && minute !== '*') return `At minute ${minute} every hour`;
    if (minute === '0' && hour !== '*') return `Every day at ${hour}:00`;
    if (dayOfMonth === '*' && month === '*') {
      if (dayOfWeek === '*') return `Every day at ${hour}:${minute.padStart(2, '0')}`;
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `Every ${days[parseInt(dayOfWeek)]} at ${hour}:${minute.padStart(2, '0')}`;
    }
    return expression;
  }
}

// ─── Cronjob Manager ──────────────────────────────────────────────────────

const CRON_DIR = join(homedir(), '.buff', 'memory', 'cronjobs');
const HEARTBEAT_INTERVAL = 10_000; // 10 seconds
const HEARTBEAT_CEILING = 6 * 3600_000; // 6 hours

export class CronJobManager {
  private jobs: Map<string, CronJob> = new Map();
  private runHistory: Map<string, CronRunResult[]> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private heartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastHeartbeat: Map<string, number> = new Map();

  constructor() {
    this.load();
  }

  // ─── Job Operations ────────────────────────────────────────────────

  /**
   * Create a cron job.
   */
  create(
    name: string,
    schedule: string,
    command: string,
    options: Partial<Omit<CronJob, 'id' | 'name' | 'schedule' | 'command' | 'status' | 'createdAt' | 'updatedAt'>> = {},
  ): CronJob {
    const nextRun = CronParser.parseNextRun(schedule);

    const job: CronJob = {
      id: randomUUID(),
      name,
      description: options.description,
      schedule,
      command,
      args: options.args,
      env: options.env,
      status: 'active',
      group: options.group,
      timeoutMs: options.timeoutMs || 300_000, // 5 min default
      maxRetries: options.maxRetries || 3,
      retryCount: 0,
      nextRun: nextRun.getTime(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.jobs.set(job.id, job);
    this.save();
    logger.debug(`Cron: Created job '${name}' with schedule '${schedule}'`);
    return job;
  }

  /**
   * Get a job by ID.
   */
  getJob(jobId: string): CronJob | null {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Get all jobs.
   */
  getAllJobs(): CronJob[] {
    return [...this.jobs.values()].sort((a, b) => (a.nextRun || 0) - (b.nextRun || 0));
  }

  /**
   * Get jobs by group.
   */
  getJobsByGroup(group: string): CronJob[] {
    return this.getAllJobs().filter((j) => j.group === group);
  }

  /**
   * Update a job.
   */
  updateJob(jobId: string, updates: Partial<Pick<CronJob, 'name' | 'description' | 'schedule' | 'command' | 'args' | 'env' | 'group' | 'timeoutMs' | 'maxRetries'>>): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    Object.assign(job, updates, { updatedAt: Date.now() });

    if (updates.schedule) {
      try {
        job.nextRun = CronParser.parseNextRun(updates.schedule).getTime();
      } catch { /* ignore */ }
    }

    this.save();
    return true;
  }

  /**
   * Delete a job.
   */
  deleteJob(jobId: string): boolean {
    this.stopTimer(jobId);
    this.stopHeartbeat(jobId);
    const existed = this.jobs.delete(jobId);
    if (existed) this.save();
    return existed;
  }

  // ─── Job Control ──────────────────────────────────────────────────

  /**
   * Enable a job.
   */
  enableJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.status = 'active';
    job.updatedAt = Date.now();
    this.save();
    return true;
  }

  /**
   * Pause a job.
   */
  pauseJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.status = 'paused';
    job.updatedAt = Date.now();
    this.save();
    return true;
  }

  /**
   * Run a job immediately.
   */
  async runJob(jobId: string): Promise<CronRunResult | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const runId = randomUUID();
    const startedAt = Date.now();

    const result: CronRunResult = {
      jobId,
      runId,
      status: 'success',
      output: '',
      durationMs: 0,
      startedAt,
      completedAt: startedAt,
    };

    try {
      // Start heartbeat
      this.startHeartbeat(jobId);

      // Execute the command
      const { spawn } = await import('node:child_process');
      const proc = spawn(job.command, job.args || [], {
        env: { ...process.env, ...job.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      const exitCode = await new Promise<number>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGTERM');
          result.status = 'timeout';
          result.error = `Job timed out after ${job.timeoutMs}ms`;
          resolve(1);
        }, job.timeoutMs);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          resolve(code ?? 1);
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          result.status = 'error';
          result.error = String(err);
          resolve(1);
        });
      });

      result.output = stdout;
      result.status = exitCode === 0 ? 'success' : 'error';
      if (stderr) result.error = stderr;

      // Stop heartbeat
      this.stopHeartbeat(jobId);

      // Update job
      job.lastRun = Date.now();
      job.lastResult = result;
      job.retryCount = 0;
      job.nextRun = CronParser.parseNextRun(job.schedule).getTime();
      job.updatedAt = Date.now();

    } catch (err) {
      result.status = 'error';
      result.error = String(err);
      this.stopHeartbeat(jobId);

      job.retryCount++;
      if (job.retryCount >= job.maxRetries) {
        job.status = 'failed';
      }
    }

    result.durationMs = Date.now() - startedAt;
    result.completedAt = Date.now();

    // Store run history
    if (!this.runHistory.has(jobId)) this.runHistory.set(jobId, []);
    this.runHistory.get(jobId)!.push(result);

    this.save();
    return result;
  }

  // ─── Heartbeat ────────────────────────────────────────────────────

  /**
   * Start heartbeat for a job.
   */
  private startHeartbeat(jobId: string): void {
    this.stopHeartbeat(jobId);
    const startTime = Date.now();

    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed > HEARTBEAT_CEILING) {
        this.stopHeartbeat(jobId);
        return;
      }
      this.lastHeartbeat.set(jobId, Date.now());
      logger.debug(`Cron: Heartbeat for job ${jobId}`);
    }, HEARTBEAT_INTERVAL);

    this.heartbeats.set(jobId, timer);
  }

  /**
   * Stop heartbeat for a job.
   */
  private stopHeartbeat(jobId: string): void {
    const timer = this.heartbeats.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(jobId);
    }
  }

  /**
   * Get last heartbeat time.
   */
  getLastHeartbeat(jobId: string): number | undefined {
    return this.lastHeartbeat.get(jobId);
  }

  // ─── Run History ──────────────────────────────────────────────────

  /**
   * Get run history for a job.
   */
  getRunHistory(jobId: string, limit: number = 10): CronRunResult[] {
    return (this.runHistory.get(jobId) || []).slice(-limit);
  }

  /**
   * Get all run history.
   */
  getAllRunHistory(): CronRunResult[] {
    const all: CronRunResult[] = [];
    for (const runs of this.runHistory.values()) {
      all.push(...runs);
    }
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  // ─── Statistics ────────────────────────────────────────────────────

  /**
   * Get job statistics.
   */
  getStats(): CronJobStats {
    const jobs = [...this.jobs.values()];
    const allRuns = this.getAllRunHistory();

    return {
      totalJobs: jobs.length,
      activeJobs: jobs.filter((j) => j.status === 'active').length,
      pausedJobs: jobs.filter((j) => j.status === 'paused').length,
      failedJobs: jobs.filter((j) => j.status === 'failed').length,
      totalRuns: allRuns.length,
      successfulRuns: allRuns.filter((r) => r.status === 'success').length,
      failedRuns: allRuns.filter((r) => r.status === 'error' || r.status === 'timeout').length,
      averageDuration: allRuns.length > 0
        ? allRuns.reduce((sum, r) => sum + r.durationMs, 0) / allRuns.length
        : 0,
    };
  }

  /**
   * Get next N jobs to run.
   */
  getNextJobs(count: number = 5): CronJob[] {
    return this.getAllJobs()
      .filter((j) => j.status === 'active' && j.nextRun)
      .slice(0, count);
  }

  // ─── Timer Management ────────────────────────────────────────────

  private stopTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(jobId);
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(CRON_DIR)) return;
      const files = readdirSync(CRON_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = readFileSync(join(CRON_DIR, file), 'utf-8');
          const parsed = JSON.parse(data);
          if (parsed.schedule) {
            this.jobs.set(parsed.id, parsed);
          }
        } catch { /* skip invalid files */ }
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true });
      for (const [id, job] of this.jobs) {
        writeFileSync(join(CRON_DIR, `${id}.json`), JSON.stringify(job, null, 2));
      }
    } catch (err) {
      logger.warn(`CronJobManager: Failed to save: ${err}`);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: CronJobManager | null = null;

export function getCronJobManager(): CronJobManager {
  if (!_instance) _instance = new CronJobManager();
  return _instance;
}

export function resetCronJobManager(): void {
  _instance = null;
}

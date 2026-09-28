/**
 * Delegation System — Full subagent architecture.
 *
 * Hermes equivalent: delegate_tool.py (3931 lines) + delegation_live_log.py (424 lines)
 *                     + async_delegation.py (1515 lines) + managed_tool_gateway.py (452 lines)
 *
 * Features:
 * - Spawns child AI agent instances with isolated context
 * - Inherits parent toolsets with child-only blocked tools stripped
 * - Fresh conversation per child (no parent history)
 * - Own task_id (own terminal session, file ops cache)
 * - Live log streaming to parent/user
 * - Background (async) delegation with completion events
 * - Batch (parallel) delegation mode
 * - Managed tool gateway for vendor passthroughs
 */

import { randomUUID } from 'node:crypto';
import { resolveNuviraHome } from '../config/paths';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { refusalFields, type ToolRefusalCode } from './tool-refusal.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type DelegationMode = 'sync' | 'async' | 'batch';
export type DelegationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export type LogEntryType = 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'lifecycle' | 'error';

export interface DelegationTask {
  id: string;
  delegationId: string;
  goal: string;
  status: DelegationStatus;
  mode: DelegationMode;
  agentType: string;
  context: DelegationContext;
  result?: string;
  error?: string;
  progress: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  retryCount: number;
  maxRetries: number;
  /** Typed reason the task could not run (see tool-refusal.ts). */
  code?: ToolRefusalCode;
  /** What to do instead when the task could not run. */
  alternatives?: string[];
}

export interface DelegationContext {
  parentTaskId?: string;
  toolsets: string[];
  blockedTools: string[];
  systemPrompt?: string;
  metadata: Record<string, unknown>;
}

export interface DelegationResult {
  taskId: string;
  delegationId: string;
  success: boolean;
  result?: string;
  error?: string;
  durationMs: number;
  toolCalls: number;
  summary: string;
  /** Typed reason when `success` is false (see tool-refusal.ts). */
  code?: ToolRefusalCode;
  alternatives?: string[];
}

export interface LogEntry {
  taskId: string;
  type: LogEntryType;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ManagedToolConfig {
  name: string;
  endpoint: string;
  apiKey?: string;
  timeout?: number;
  retries?: number;
}

// ─── Delegation Manager ───────────────────────────────────────────────────

const DELEGATION_DIR = join(resolveNuviraHome(), 'cache', 'delegation');
const LIVE_LOG_DIR = join(DELEGATION_DIR, 'live');
const COMPLETION_QUEUE_DIR = join(DELEGATION_DIR, 'completions');

/** Configuration for delegation behavior. */
export interface DelegationConfig {
  /** Maximum concurrent child agents (default: 3). */
  maxConcurrentChildren: number;
  /** Maximum spawn depth — 1 means parent->child only (default: 1). */
  maxSpawnDepth: number;
  /** Stall timeout — if a child produces no output for this long, it's marked stalled (default: 120s). */
  stallTimeoutMs: number;
  /** Global kill switch — when true, no new children can be spawned. */
  killSwitch: boolean;
  /** Inherit parent toolsets to children (default: true). */
  inheritToolsets: boolean;
  /** Inherit MCP toolsets to children (default: true). */
  inheritMcpToolsets: boolean;
}

const DEFAULT_CONFIG: DelegationConfig = {
  maxConcurrentChildren: 3,
  maxSpawnDepth: 1,
  stallTimeoutMs: 120_000,
  killSwitch: false,
  inheritToolsets: true,
  inheritMcpToolsets: true,
};

export class DelegationManager extends EventEmitter {
  private tasks: Map<string, DelegationTask> = new Map();
  private delegations: Map<string, DelegationTask[]> = new Map();
  private completionQueue: DelegationResult[] = [];
  private logStreams: Map<string, NodeJS.WriteStream> = new Map();
  private config: DelegationConfig = { ...DEFAULT_CONFIG };
  private activeChildren: Set<string> = new Set();
  private stallTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * The real child-task executor — an LLM-backed child agent that takes a task and
   * returns its result text.
   *
   * Deliberately has NO built-in fallback. `executeTask` used to settle every task
   * as `completed` with `result = 'Task completed: <goal>'` and never call a model,
   * so a parent agent summarised a child's "result" that was only its own
   * instructions echoed back — success reported for work that never ran. Without an
   * executor wired in, delegation now refuses with `not_configured` and names the
   * working path (`delegate`, which requires a resolved LLM in the loop).
   *
   * See TOOL_TRUTHFULNESS_TRACKER.md finding #4.
   */
  private executor: ((task: DelegationTask) => Promise<string>) | null = null;

  constructor() {
    super();
    this.ensureDirectories();
    this.loadPendingTasks();
    this.startStallMonitor();
    this.recoverCompletionQueue();
  }

  // ─── Executor wiring ────────────────────────────────────────────

  /**
   * Wire a real child executor. Until one is set, every task fails fast with a
   * typed `not_configured` result instead of a fabricated completion.
   */
  setExecutor(fn: (task: DelegationTask) => Promise<string>): void {
    this.executor = fn;
  }

  /** Whether a real child executor is wired (surfaced in the tool description). */
  hasExecutor(): boolean {
    return this.executor !== null;
  }

  /** Clear the executor — delegation goes back to refusing rather than simulating. */
  clearExecutor(): void {
    this.executor = null;
  }

  // ─── Configuration ──────────────────────────────────────────────

  /** Update delegation configuration. */
  configure(config: Partial<DelegationConfig>): void {
    Object.assign(this.config, config);
    logger.info(`DelegationManager: Config updated — maxConcurrent=${this.config.maxConcurrentChildren}, maxDepth=${this.config.maxSpawnDepth}`);
    this.emit('config-updated', this.config);
  }

  /** Get current configuration. */
  getConfig(): DelegationConfig {
    return { ...this.config };
  }

  /** Toggle the global kill switch. */
  toggleKillSwitch(enabled: boolean): void {
    this.config.killSwitch = enabled;
    logger.info(`DelegationManager: Kill switch ${enabled ? 'ENABLED' : 'DISABLED'}`);
    this.emit('kill-switch', enabled);
    if (enabled) {
      // Cancel all pending tasks
      for (const [id, task] of this.tasks) {
        if (task.status === 'pending') {
          task.status = 'cancelled';
          this.logEntry(id, 'lifecycle', 'Cancelled by kill switch');
        }
      }
    }
  }

  /** Check if a task can be spawned (respects kill switch, depth, concurrency). */
  canSpawn(parentTaskId?: string): { allowed: boolean; reason?: string } {
    // Kill switch check
    if (this.config.killSwitch) {
      return { allowed: false, reason: 'Kill switch is enabled' };
    }
    // Concurrency check
    if (this.activeChildren.size >= this.config.maxConcurrentChildren) {
      return { allowed: false, reason: `Max concurrent children (${this.config.maxConcurrentChildren}) reached` };
    }
    // Depth check
    if (parentTaskId) {
      const depth = this.getSpawnDepth(parentTaskId);
      if (depth >= this.config.maxSpawnDepth) {
        return { allowed: false, reason: `Max spawn depth (${this.config.maxSpawnDepth}) reached at depth ${depth}` };
      }
    }
    return { allowed: true };
  }

  /** Calculate spawn depth for a task. */
  private getSpawnDepth(taskId: string): number {
    let depth = 0;
    let current = taskId;
    while (current) {
      const task = this.tasks.get(current);
      if (!task?.context.parentTaskId) break;
      current = task.context.parentTaskId;
      depth++;
    }
    return depth;
  }

  /** Interrupt a running subagent gracefully. */
  interrupt(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== 'running' && task.status !== 'pending')) {
      return false;
    }
    // Set interrupt flag — the child checks this periodically
    task.context.metadata['interrupted'] = true;
    this.logEntry(taskId, 'lifecycle', 'Interrupt requested — will stop after current operation');
    this.emit('interrupt', taskId);
    return true;
  }

  /** Check if a task has been interrupted. */
  isInterrupted(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return !!task?.context.metadata['interrupted'];
  }

  // ─── Stall Monitoring ────────────────────────────────────────────

  private startStallMonitor(): void {
    // Check for stalled children every 30s
    setInterval(() => {
      const now = Date.now();
      for (const [id, task] of this.tasks) {
        if (task.status !== 'running') continue;
        const lastActivity = task.completedAt || task.startedAt || task.createdAt;
        if (now - lastActivity > this.config.stallTimeoutMs) {
          task.status = 'timeout';
          task.error = `Stalled for ${(now - lastActivity) / 1000}s — no activity`;
          this.logEntry(id, 'lifecycle', task.error);
          this.activeChildren.delete(id);
          this.emit('stalled', id, task.error);
        }
      }
    }, 30_000);
  }

  /** Get the number of active children. */
  getActiveChildCount(): number {
    return this.activeChildren.size;
  }

  /** Get spawn tree for a task (shows parent-child chain). */
  getSpawnTree(taskId: string): Array<{ id: string; goal: string; depth: number }> {
    const tree: Array<{ id: string; goal: string; depth: number }> = [];
    let current = taskId;
    let depth = 0;
    while (current) {
      const task = this.tasks.get(current);
      if (!task) break;
      tree.unshift({ id: task.id, goal: task.goal, depth });
      current = task.context.parentTaskId || '';
      depth++;
    }
    return tree;
  }

  // ─── Core Delegation ──────────────────────────────────────────────

  /**
   * Delegate a task to a subagent.
   */
  async delegate(
    goal: string,
    options: {
      mode?: DelegationMode;
      agentType?: string;
      parentTaskId?: string;
      toolsets?: string[];
      blockedTools?: string[];
      systemPrompt?: string;
      metadata?: Record<string, unknown>;
      timeout?: number;
      maxRetries?: number;
    } = {},
  ): Promise<DelegationTask> {
    // Check spawn permissions (kill switch, depth, concurrency)
    const spawnCheck = this.canSpawn(options.parentTaskId);
    if (!spawnCheck.allowed) {
      throw new Error(`Cannot spawn: ${spawnCheck.reason}`);
    }

    const delegationId = randomUUID();
    const taskId = randomUUID();

    const task: DelegationTask = {
      id: taskId,
      delegationId,
      goal,
      status: 'pending',
      mode: options.mode || 'sync',
      agentType: options.agentType || 'default',
      context: {
        parentTaskId: options.parentTaskId,
        toolsets: options.toolsets || ['*'],
        blockedTools: options.blockedTools || [],
        systemPrompt: options.systemPrompt,
        metadata: options.metadata || {},
      },
      progress: [],
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries: options.maxRetries || 3,
    };

    this.tasks.set(taskId, task);
    this.createLiveLog(taskId);

    // Create delegation entry
    if (!this.delegations.has(delegationId)) {
      this.delegations.set(delegationId, []);
    }
    this.delegations.get(delegationId)!.push(task);

    this.logEntry(taskId, 'lifecycle', `Task created: ${goal}`);

    // Start execution for EVERY mode. `async` returns immediately (the caller polls
    // or drains); sync/batch callers await the result through waitForCompletion().
    //
    // Only `async` used to start the task, so `delegate_system` action:"delegate"
    // returned a task stuck at `pending` that never ran — an agent reading that JSON
    // saw a delegation that had been accepted, while nothing was ever executed.
    this.executeTask(taskId).catch((err) => {
      logger.error(`Delegation: Task ${taskId} failed: ${err}`);
    });

    return task;
  }

  /**
   * Delegate a batch of tasks in parallel.
   */
  async delegateBatch(
    goals: string[],
    options: {
      agentType?: string;
      maxConcurrency?: number;
      timeout?: number;
    } = {},
  ): Promise<DelegationTask[]> {
    const tasks: DelegationTask[] = [];
    const maxConcurrency = options.maxConcurrency || 5;

    for (const goal of goals) {
      const task = await this.delegate(goal, {
        mode: 'batch',
        agentType: options.agentType,
        timeout: options.timeout,
      });
      tasks.push(task);
    }

    // Execute in parallel with concurrency limit
    const executing = tasks.map((task) => this.executeTask(task.id));

    // Wait for all to complete (with concurrency limit)
    const batches = [];
    for (let i = 0; i < executing.length; i += maxConcurrency) {
      batches.push(Promise.allSettled(executing.slice(i, i + maxConcurrency)));
    }

    await Promise.all(batches);
    return tasks;
  }

  /**
   * Get task status.
   */
  getTask(taskId: string): DelegationTask | null {
    return this.tasks.get(taskId) || null;
  }

  /**
   * Get all tasks for a delegation.
   */
  getDelegationTasks(delegationId: string): DelegationTask[] {
    return this.delegations.get(delegationId) || [];
  }

  /**
   * Cancel a task.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'completed' || task.status === 'failed') return false;

    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.logEntry(taskId, 'lifecycle', 'Task cancelled');
    return true;
  }

  /**
   * Wait for a task to complete.
   */
  async waitForCompletion(taskId: string, timeoutMs: number = 300_000): Promise<DelegationResult> {
    return new Promise((resolve, reject) => {
      const task = this.tasks.get(taskId);
      if (!task) {
        reject(new Error('Task not found'));
        return;
      }

      if (task.status === 'completed' || task.status === 'failed') {
        resolve(this.buildResult(task));
        return;
      }

      const timeout = setTimeout(() => {
        this.removeListener(`completed:${taskId}`, onComplete);
        reject(new Error('Timeout waiting for completion'));
      }, timeoutMs);

      const onComplete = (result: DelegationResult) => {
        clearTimeout(timeout);
        resolve(result);
      };

      this.once(`completed:${taskId}`, onComplete);
    });
  }

  // ─── Live Log ──────────────────────────────────────────────────────

  /**
   * Get live log for a task.
   */
  getLiveLog(taskId: string): LogEntry[] {
    const logFile = join(LIVE_LOG_DIR, `${taskId}.log`);
    if (!existsSync(logFile)) return [];

    try {
      const content = readFileSync(logFile, 'utf-8');
      return content.split('\n').filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean) as LogEntry[];
    } catch {
      return [];
    }
  }

  /**
   * Subscribe to live log updates.
   */
  subscribeToLog(taskId: string, callback: (entry: LogEntry) => void): () => void {
    const handler = (entry: LogEntry) => {
      if (entry.taskId === taskId) callback(entry);
    };
    this.on('log', handler);
    return () => this.removeListener('log', handler);
  }

  /**
   * Tail log for a task (returns async iterator).
   */
  tailLog(taskId: string): AsyncGenerator<LogEntry> {
    const logFile = join(LIVE_LOG_DIR, `${taskId}.log`);
    const entries: LogEntry[] = [];
    let index = 0;

    async function* generator() {
      while (true) {
        while (index >= entries.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (existsSync(logFile)) {
            const content = readFileSync(logFile, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            while (entries.length < lines.length) {
              try {
                entries.push(JSON.parse(lines[entries.length]));
              } catch {
                break;
              }
            }
          }
        }
        yield entries[index++];
      }
    }

    return generator();
  }

  // ─── Completion Queue ──────────────────────────────────────────────

  /**
   * Get pending completions.
   */
  getPendingCompletions(): DelegationResult[] {
    return [...this.completionQueue];
  }

  /**
   * Acknowledge a completion.
   */
  acknowledgeCompletion(taskId: string): boolean {
    const idx = this.completionQueue.findIndex((c) => c.taskId === taskId);
    if (idx === -1) return false;
    this.completionQueue.splice(idx, 1);
    this.saveCompletionQueue();
    return true;
  }

  /**
   * Drain completion queue (get all and clear).
   */
  drainCompletions(): DelegationResult[] {
    const completions = [...this.completionQueue];
    this.completionQueue = [];
    this.saveCompletionQueue();
    return completions;
  }

  // ─── Managed Tool Gateway ──────────────────────────────────────────

  private managedTools: Map<string, ManagedToolConfig> = new Map();

  /**
   * Register a managed tool.
   */
  registerManagedTool(config: ManagedToolConfig): void {
    this.managedTools.set(config.name, config);
  }

  /**
   * Call a managed tool.
   */
  async callManagedTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const config = this.managedTools.get(toolName);
    if (!config) {
      return { success: false, error: `Managed tool '${toolName}' not found` };
    }

    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(config.timeout || 30_000),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${await response.text()}` };
      }

      const result = await response.json();
      return { success: true, result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * List managed tools.
   */
  listManagedTools(): ManagedToolConfig[] {
    return [...this.managedTools.values()];
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'running';
    task.startedAt = Date.now();
    this.activeChildren.add(taskId);
    this.logEntry(taskId, 'lifecycle', 'Task started');

    // No executor → refuse before spending the retry budget. A retry cannot fix a
    // missing executor, and reporting `completed` for it is the defect being fixed.
    if (!this.executor) {
      task.status = 'failed';
      task.error =
        'No child executor is wired into DelegationManager, so this task did NOT run. ' +
        'Use the `delegate` tool — it spawns a real sub-agent through the resolved LLM in the loop.';
      // Both alternatives RUN; that is the only reason either is named. `subagent`
      // was removed here when P4.1 showed its spawn path could not execute at all
      // (a refusal pointing at a path that performs no work is the defect this
      // whole method exists to report) and is back now that it forks a real
      // process, resolves a real provider and refuses instead of faking output.
      Object.assign(task, refusalFields('not_configured', [
        'delegate — spawns a real sub-agent (requires a resolved LLM in the tool loop)',
        'subagent — spawns a real child process that resolves its own provider (requires a configured provider)',
      ]));
      task.completedAt = Date.now();
      task.durationMs = task.completedAt - (task.startedAt || task.createdAt);
      this.activeChildren.delete(taskId);
      this.logEntry(taskId, 'error', `Task refused: ${task.error}`);
      this.emit(`completed:${taskId}`, this.buildResult(task));
      return;
    }

    try {
      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(task);
      void systemPrompt;

      // Execute with retry
      let lastError: string | undefined;
      for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
        // Check for interrupt before each attempt
        if (this.isInterrupted(taskId)) {
          task.status = 'cancelled';
          task.error = 'Interrupted by parent';
          task.completedAt = Date.now();
          this.activeChildren.delete(taskId);
          this.logEntry(taskId, 'lifecycle', 'Task interrupted by parent');
          this.emit(`completed:${taskId}`, this.buildResult(task));
          return;
        }
        try {
          this.logEntry(taskId, 'thinking', `Executing goal: ${task.goal}`);

          // Real execution: the injected executor owns the LLM call. Its own output
          // is the result — never a string we synthesise from the goal.
          const output = await this.executor(task);

          task.status = 'completed';
          task.result = output;
          task.completedAt = Date.now();
          task.durationMs = task.completedAt - (task.startedAt || task.createdAt);
          this.activeChildren.delete(taskId);

          this.logEntry(taskId, 'lifecycle', 'Task completed');
          this.emit(`completed:${taskId}`, this.buildResult(task));

          // Add to completion queue
          this.completionQueue.push(this.buildResult(task));
          this.saveCompletionQueue();
          return;
        } catch (err) {
          lastError = String(err);
          task.retryCount++;
          this.logEntry(taskId, 'error', `Attempt ${attempt + 1} failed: ${lastError}`);

          if (attempt < task.maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
      }

      // All retries exhausted
      task.status = 'failed';
      task.error = `Failed after ${task.maxRetries} retries: ${lastError}`;
      task.completedAt = Date.now();
      this.activeChildren.delete(taskId);
      this.logEntry(taskId, 'lifecycle', `Task failed: ${task.error}`);
      this.emit(`completed:${taskId}`, this.buildResult(task));

    } catch (err) {
      task.status = 'failed';
      task.error = String(err);
      task.completedAt = Date.now();
      this.activeChildren.delete(taskId);
      this.logEntry(taskId, 'error', `Fatal error: ${err}`);
      this.emit(`completed:${taskId}`, this.buildResult(task));
    }
  }

  private buildSystemPrompt(task: DelegationTask): string {
    const parts = [
      `You are a subagent tasked with: ${task.goal}`,
      '',
      `Agent type: ${task.agentType}`,
      `Toolsets: ${task.context.toolsets.join(', ')}`,
      task.context.blockedTools.length > 0 ? `Blocked tools: ${task.context.blockedTools.join(', ')}` : '',
      task.context.systemPrompt ? `\nAdditional context:\n${task.context.systemPrompt}` : '',
    ].filter(Boolean);

    return parts.join('\n');
  }

  private buildResult(task: DelegationTask): DelegationResult {
    return {
      taskId: task.id,
      delegationId: task.delegationId,
      success: task.status === 'completed',
      result: task.result,
      error: task.error,
      durationMs: task.durationMs || 0,
      toolCalls: 0,
      summary: task.result || task.error || 'No result',
      ...(task.code ? { code: task.code } : {}),
      ...(task.alternatives ? { alternatives: task.alternatives } : {}),
    };
  }

  private logEntry(taskId: string, type: LogEntryType, content: string, metadata?: Record<string, unknown>): void {
    const entry: LogEntry = {
      taskId,
      type,
      content,
      timestamp: Date.now(),
      metadata,
    };

    // Write to log file
    const logFile = join(LIVE_LOG_DIR, `${taskId}.log`);
    try {
      appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch { /* ignore */ }

    this.emit('log', entry);
  }

  private createLiveLog(taskId: string): void {
    const logFile = join(LIVE_LOG_DIR, `${taskId}.log`);
    try {
      if (!existsSync(LIVE_LOG_DIR)) mkdirSync(LIVE_LOG_DIR, { recursive: true });
      writeFileSync(logFile, '');
    } catch { /* ignore */ }
  }

  private ensureDirectories(): void {
    for (const dir of [DELEGATION_DIR, LIVE_LOG_DIR, COMPLETION_QUEUE_DIR]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  private loadPendingTasks(): void {
    try {
      if (!existsSync(COMPLETION_QUEUE_DIR)) return;
      const files = readdirSync(COMPLETION_QUEUE_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = readFileSync(join(COMPLETION_QUEUE_DIR, file), 'utf-8');
          const result = JSON.parse(data) as DelegationResult;
          this.completionQueue.push(result);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  private saveCompletionQueue(): void {
    try {
      // Clear old entries
      if (existsSync(COMPLETION_QUEUE_DIR)) {
        const files = readdirSync(COMPLETION_QUEUE_DIR).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          try {
            require('node:fs').unlinkSync(join(COMPLETION_QUEUE_DIR, file));
          } catch { /* ignore */ }
        }
      }

      // Save current queue
      for (const completion of this.completionQueue) {
        const filePath = join(COMPLETION_QUEUE_DIR, `${completion.taskId}.json`);
        writeFileSync(filePath, JSON.stringify(completion, null, 2));
      }
    } catch { /* ignore */ }
  }

  private recoverCompletionQueue(): void {
    // Load any completions that were saved but not yet processed
    this.loadPendingTasks();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: DelegationManager | null = null;

export function getDelegationManager(): DelegationManager {
  if (!_instance) _instance = new DelegationManager();
  return _instance;
}

export function resetDelegationManager(): void {
  if (_instance) {
    _instance.removeAllListeners();
    _instance = null;
  }
}

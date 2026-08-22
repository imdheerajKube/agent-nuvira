/**
 * Delegate Tool — Async task delegation to sub-agents.
 *
 * Allows the main agent to delegate tasks to background sub-agents
 * and monitor their progress. Supports:
 * - Fire-and-forget delegation
 * - Async completion with delivery
 * - Progress monitoring
 * - Live log streaming
 *
 * Hermes equivalent: delegate_tool.py + delegation_live_log.py + async_delegation.py + managed_tool_gateway.py
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type DelegationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DelegationTask {
  /** Unique task ID */
  id: string;
  /** Task goal/description */
  goal: string;
  /** Task status */
  status: DelegationStatus;
  /** Assigned agent type */
  agentType?: string;
  /** Task result (when completed) */
  result?: string;
  /** Error message (when failed) */
  error?: string;
  /** Progress updates */
  progress: string[];
  /** When the task was created */
  createdAt: number;
  /** When the task started running */
  startedAt?: number;
  /** When the task completed */
  completedAt?: number;
  /** Parent task ID (for nested delegations) */
  parentId?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

export interface DelegationOptions {
  /** Agent type to delegate to */
  agentType?: string;
  /** Timeout in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Parent task ID */
  parentId?: string;
  /** Metadata to attach */
  metadata?: Record<string, unknown>;
  /** Callback when task completes */
  onComplete?: (task: DelegationTask) => void;
  /** Callback on progress update */
  onProgress?: (task: DelegationTask, message: string) => void;
}

export interface DelegationResult {
  /** Task ID */
  taskId: string;
  /** Whether delegation was successful */
  success: boolean;
  /** Task result (if completed) */
  result?: string;
  /** Error message (if failed) */
  error?: string;
}

// ─── Delegation Manager ───────────────────────────────────────────────────

export class DelegationManager {
  private tasks: Map<string, DelegationTask> = new Map();
  private handlers: Map<string, (goal: string, options: DelegationOptions) => Promise<string>> = new Map();
  private eventHandlers: Array<(event: string, task: DelegationTask) => void> = [];

  // ─── Task Management ─────────────────────────────────────────────────

  /**
   * Delegate a task to a sub-agent.
   */
  async delegate(
    goal: string,
    options: DelegationOptions = {},
  ): Promise<DelegationResult> {
    const taskId = randomUUID();
    const task: DelegationTask = {
      id: taskId,
      goal,
      status: 'pending',
      agentType: options.agentType,
      progress: [],
      createdAt: Date.now(),
      parentId: options.parentId,
      metadata: options.metadata,
    };

    this.tasks.set(taskId, task);
    this.emit('created', task);

    // Start execution asynchronously
    this.executeTask(taskId, options).catch((err) => {
      logger.error(`Delegation: Task '${taskId}' execution error: ${err}`);
    });

    return {
      taskId,
      success: true,
    };
  }

  /**
   * Get task status.
   */
  getTask(taskId: string): DelegationTask | null {
    return this.tasks.get(taskId) || null;
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): DelegationTask[] {
    return [...this.tasks.values()];
  }

  /**
   * Get tasks by status.
   */
  getTasksByStatus(status: DelegationStatus): DelegationTask[] {
    return [...this.tasks.values()].filter((t) => t.status === status);
  }

  /**
   * Cancel a task.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'completed' || task.status === 'failed') {
      return false;
    }

    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.emit('cancelled', task);
    return true;
  }

  // ─── Handler Registration ────────────────────────────────────────────

  /**
   * Register a handler for a specific agent type.
   */
  registerHandler(
    agentType: string,
    handler: (goal: string, options: DelegationOptions) => Promise<string>,
  ): void {
    this.handlers.set(agentType, handler);
  }

  /**
   * Register an event handler.
   */
  onEvent(handler: (event: string, task: DelegationTask) => void): void {
    this.eventHandlers.push(handler);
  }

  // ─── Live Log ────────────────────────────────────────────────────────

  /**
   * Get live log for a task.
   */
  getLiveLog(taskId: string): string[] {
    const task = this.tasks.get(taskId);
    return task?.progress || [];
  }

  /**
   * Subscribe to live log updates.
   */
  subscribeToLog(
    taskId: string,
    callback: (message: string) => void,
  ): () => void {
    const task = this.tasks.get(taskId);
    if (!task) return () => {};

    const handler = (event: string, t: DelegationTask) => {
      if (t.id === taskId && event === 'progress') {
        const lastMessage = t.progress[t.progress.length - 1];
        if (lastMessage) callback(lastMessage);
      }
    };

    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) this.eventHandlers.splice(idx, 1);
    };
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async executeTask(
    taskId: string,
    options: DelegationOptions,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'running';
    task.startedAt = Date.now();
    this.emit('started', task);

    try {
      // Find handler
      const agentType = task.agentType || 'default';
      const handler = this.handlers.get(agentType);

      if (!handler) {
        throw new Error(`No handler registered for agent type '${agentType}'`);
      }

      // Execute with timeout
      const timeoutMs = options.timeoutMs || 300_000;
      const result = await Promise.race([
        handler(task.goal, {
          ...options,
          onProgress: (_task: DelegationTask, message: string) => {
            task.progress.push(message);
            this.emit('progress', task);
            options.onProgress?.(task, message);
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      task.status = 'completed';
      task.result = result;
      task.completedAt = Date.now();
      this.emit('completed', task);
      options.onComplete?.(task);
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();
      this.emit('failed', task);
    }
  }

  private emit(event: string, task: DelegationTask): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event, task);
      } catch {
        // Ignore handler errors
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: DelegationManager | null = null;

export function getDelegationManager(): DelegationManager {
  if (!_instance) {
    _instance = new DelegationManager();
  }
  return _instance;
}

export function resetDelegationManager(): void {
  _instance = null;
}

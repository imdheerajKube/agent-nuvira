/**
 * Subagent Spawner — Real subagent spawning with LLM calls.
 *
 * Unlike our previous placeholder, this actually spawns child processes
 * that make their own LLM calls and return results.
 *
 * Architecture:
 * - Parent spawns child process via fork()
 * - Child has its own LLM client and tool registry
 * - Child makes its own LLM calls (no parent blocking)
 * - Child writes results to shared file/pipe
 * - Parent reads results asynchronously
 *
 * Hermes equivalent: delegate_tool.py (3931 lines) — actual agent spawning
 */

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type SubagentStatus = 'spawning' | 'running' | 'completed' | 'failed' | 'timeout' | 'killed';

export interface SubagentConfig {
  /** Goal for the subagent */
  goal: string;
  /** System prompt override */
  systemPrompt?: string;
  /** LLM provider to use */
  provider?: string;
  /** LLM model to use */
  model?: string;
  /** Tools available to the subagent */
  tools?: string[];
  /** Tools blocked from the subagent */
  blockedTools?: string[];
  /** Max LLM calls */
  maxLlmCalls?: number;
  /** Max tokens */
  maxTokens?: number;
  /** Timeout in ms */
  timeoutMs?: number;
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
}

export interface SubagentState {
  /** Subagent ID */
  id: string;
  /** Process ID */
  pid?: number;
  /** Status */
  status: SubagentStatus;
  /** Goal */
  goal: string;
  /** Result */
  result?: string;
  /** Error */
  error?: string;
  /** LLM calls made */
  llmCalls: number;
  /** Tokens used */
  tokensUsed: number;
  /** Tool calls made */
  toolCalls: number;
  /** Start time */
  startedAt: number;
  /** End time */
  endedAt?: number;
  /** Duration in ms */
  durationMs?: number;
}

export interface SubagentResult {
  /** Subagent ID */
  id: string;
  /** Success */
  success: boolean;
  /** Result text */
  result: string;
  /** Error if failed */
  error?: string;
  /** LLM calls made */
  llmCalls: number;
  /** Tokens used */
  tokensUsed: number;
  /** Tool calls made */
  toolCalls: number;
  /** Duration in ms */
  durationMs: number;
  /** Full log */
  log: string[];
}

// ─── Subagent Manager ─────────────────────────────────────────────────────

const SUBAGENT_DIR = join(homedir(), '.buff', 'cache', 'subagents');
const STATE_DIR = join(SUBAGENT_DIR, 'state');
const LOG_DIR = join(SUBAGENT_DIR, 'logs');
const RESULT_DIR = join(SUBAGENT_DIR, 'results');

export class SubagentManager extends EventEmitter {
  private subagents: Map<string, SubagentState> = new Map();
  private processes: Map<string, ChildProcess> = new Map();

  constructor() {
    super();
    this.ensureDirectories();
    this.recoverState();
  }

  /**
   * Spawn a subagent.
   */
  async spawn(config: SubagentConfig): Promise<SubagentState> {
    const id = randomUUID();
    const state: SubagentState = {
      id,
      status: 'spawning',
      goal: config.goal,
      llmCalls: 0,
      tokensUsed: 0,
      toolCalls: 0,
      startedAt: Date.now(),
    };

    this.subagents.set(id, state);
    this.saveState(state);

    try {
      // Spawn child process
      const child = fork(join(import.meta.dirname, 'child-agent-entry.js'), [], {
        cwd: config.cwd || process.cwd(),
        env: {
          ...process.env,
          ...config.env,
          SUBAGENT_ID: id,
          SUBAGENT_GOAL: config.goal,
          SUBAGENT_PROVIDER: config.provider || 'auto',
          SUBAGENT_MODEL: config.model || 'auto',
          SUBAGENT_MAX_LLM_CALLS: String(config.maxLlmCalls || 50),
          SUBAGENT_MAX_TOKENS: String(config.maxTokens || 100_000),
          SUBAGENT_TOOLS: JSON.stringify(config.tools || []),
          SUBAGENT_BLOCKED_TOOLS: JSON.stringify(config.blockedTools || []),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      state.pid = child.pid;
      state.status = 'running';
      this.processes.set(id, child);

      // Set up log file
      const logFile = join(LOG_DIR, `${id}.log`);
      const logStream = require('node:fs').createWriteStream(logFile, { flags: 'a' });

      // Pipe stdout/stderr to log file
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);

      // Handle IPC messages
      child.on('message', (msg: any) => {
        this.handleMessage(id, msg);
      });

      // Handle process exit
      child.on('exit', (code, signal) => {
        this.handleExit(id, code, signal);
      });

      // Handle errors
      child.on('error', (err) => {
        state.status = 'failed';
        state.error = String(err);
        state.endedAt = Date.now();
        state.durationMs = state.endedAt - state.startedAt;
        this.saveState(state);
        this.emit('failed', id, err);
      });

      // Set timeout
      if (config.timeoutMs) {
        setTimeout(() => {
          if (state.status === 'running') {
            this.kill(id, 'timeout');
          }
        }, config.timeoutMs);
      }

      this.saveState(state);
      logger.info(`Subagent: Spawned ${id} (pid: ${child.pid}) for goal: ${config.goal.slice(0, 50)}...`);

      return state;
    } catch (err) {
      state.status = 'failed';
      state.error = String(err);
      state.endedAt = Date.now();
      state.durationMs = state.endedAt - state.startedAt;
      this.saveState(state);
      throw err;
    }
  }

  /**
   * Get subagent state.
   */
  getState(id: string): SubagentState | null {
    return this.subagents.get(id) || null;
  }

  /**
   * Get all subagents.
   */
  getAll(): SubagentState[] {
    return [...this.subagents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Kill a subagent.
   */
  kill(id: string, reason: string = 'killed'): boolean {
    const child = this.processes.get(id);
    const state = this.subagents.get(id);
    if (!child || !state) return false;

    child.kill('SIGTERM');
    state.status = 'killed';
    state.error = `Killed: ${reason}`;
    state.endedAt = Date.now();
    state.durationMs = state.endedAt - state.startedAt;
    this.saveState(state);
    this.emit('killed', id, reason);
    return true;
  }

  /**
   * Wait for a subagent to complete.
   */
  async waitForCompletion(id: string, timeoutMs: number = 300_000): Promise<SubagentResult> {
    return new Promise((resolve, reject) => {
      const state = this.subagents.get(id);
      if (!state) {
        reject(new Error('Subagent not found'));
        return;
      }

      if (state.status === 'completed' || state.status === 'failed' || state.status === 'killed') {
        resolve(this.buildResult(state));
        return;
      }

      const timeout = setTimeout(() => {
        this.removeListener(`completed:${id}`, onComplete);
        this.removeListener(`failed:${id}`, onFail);
        reject(new Error('Timeout waiting for completion'));
      }, timeoutMs);

      const onComplete = (result: SubagentResult) => {
        clearTimeout(timeout);
        resolve(result);
      };

      const onFail = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };

      this.once(`completed:${id}`, onComplete);
      this.once(`failed:${id}`, onFail);
    });
  }

  /**
   * Get log for a subagent.
   */
  getLog(id: string): string[] {
    const logFile = join(LOG_DIR, `${id}.log`);
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  }

  /**
   * Read result file.
   */
  readResult(id: string): SubagentResult | null {
    const resultFile = join(RESULT_DIR, `${id}.json`);
    if (!existsSync(resultFile)) return null;
    try {
      return JSON.parse(readFileSync(resultFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private handleMessage(id: string, msg: any): void {
    const state = this.subagents.get(id);
    if (!state) return;

    switch (msg.type) {
      case 'progress':
        state.llmCalls = msg.llmCalls || state.llmCalls;
        state.tokensUsed = msg.tokensUsed || state.tokensUsed;
        state.toolCalls = msg.toolCalls || state.toolCalls;
        this.saveState(state);
        this.emit('progress', id, msg);
        break;
      case 'result':
        state.result = msg.result;
        state.llmCalls = msg.llmCalls || state.llmCalls;
        state.tokensUsed = msg.tokensUsed || state.tokensUsed;
        state.toolCalls = msg.toolCalls || state.toolCalls;
        break;
    }
  }

  private handleExit(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const state = this.subagents.get(id);
    if (!state) return;

    state.endedAt = Date.now();
    state.durationMs = state.endedAt - state.startedAt;

    if (state.result) {
      state.status = 'completed';
    } else if (code === 0) {
      state.status = 'completed';
      state.result = 'Task completed successfully';
    } else {
      state.status = 'failed';
      state.error = signal ? `Killed by ${signal}` : `Exit code ${code}`;
    }

    this.saveState(state);
    this.processes.delete(id);

    const result = this.buildResult(state);
    writeFileSync(join(RESULT_DIR, `${id}.json`), JSON.stringify(result, null, 2));

    if (state.status === 'completed') {
      this.emit('completed', id, result);
      this.emit(`completed:${id}`, result);
    } else {
      this.emit('failed', id, new Error(state.error));
      this.emit(`failed:${id}`, new Error(state.error));
    }
  }

  private buildResult(state: SubagentState): SubagentResult {
    return {
      id: state.id,
      success: state.status === 'completed',
      result: state.result || '',
      error: state.error,
      llmCalls: state.llmCalls,
      tokensUsed: state.tokensUsed,
      toolCalls: state.toolCalls,
      durationMs: state.durationMs || 0,
      log: this.getLog(state.id),
    };
  }

  private saveState(state: SubagentState): void {
    try {
      writeFileSync(join(STATE_DIR, `${state.id}.json`), JSON.stringify(state, null, 2));
    } catch { /* ignore */ }
  }

  private recoverState(): void {
    try {
      if (!existsSync(STATE_DIR)) return;
      const files = readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const state = JSON.parse(readFileSync(join(STATE_DIR, file), 'utf-8'));
          if (state.status === 'running' || state.status === 'spawning') {
            state.status = 'failed';
            state.error = 'Process lost during recovery';
            state.endedAt = Date.now();
          }
          this.subagents.set(state.id, state);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  private ensureDirectories(): void {
    for (const dir of [SUBAGENT_DIR, STATE_DIR, LOG_DIR, RESULT_DIR]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: SubagentManager | null = null;

export function getSubagentManager(): SubagentManager {
  if (!_instance) _instance = new SubagentManager();
  return _instance;
}

export function resetSubagentManager(): void {
  if (_instance) {
    _instance.removeAllListeners();
    _instance = null;
  }
}

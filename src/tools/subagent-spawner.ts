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
import { resolveNuviraDataPath } from '../config/paths';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
// WS3 (#25) — the W3C parent this child should continue, read from the ACTIVE
// span (the tool call that spawned it), plus the env key it travels in.
import { childTraceEnv, TRACEPARENT_ENV } from '../observability/otel.js';
// WS5 (#27) — the env key the child resolves its resume request from.
import { RESUME_ENABLE_ENV } from '../learning/step-checkpoint.js';
// WS5 (#27) — delegation-level isolation: the parent makes the worktree, forks
// INTO it, and measures the diff itself (see SubagentConfig.worktree).
import {
  createIsolatedWorktree,
  discardWorktree,
  worktreeDiff,
  worktreeEnv,
  worktreeRefusal,
  type IsolatedWorktree,
} from './worktree.js';

/**
 * How long the exit path may spend on git.
 *
 * Deliberately far below the creation budget: this runs inside the child's exit
 * handler, so every millisecond here is a millisecond the manager's own event
 * loop is blocked. A diff that cannot be produced in five seconds is reported as
 * "no changes could be measured", which is honest, rather than stalling a
 * server that may be answering other sessions.
 */
const WORKTREE_EXIT_TIMEOUT_MS = 5_000;

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
  /**
   * WS5 (#27) — run this child in its OWN git worktree of `cwd`, and return the
   * diff against the commit it started from.
   *
   * The isolation is made by the PARENT, not asked of the child: the child is a
   * separate process that resolves its own config and could decline, and a child
   * that quietly declined would be the worst outcome — a parent that believes the
   * work happened in a worktree while it happened in the real tree. So the parent
   * creates the worktree, forks INTO it, and measures the diff itself.
   */
  worktree?: boolean;
  /** Keep the worktree after the run instead of removing it (default: remove). */
  keepWorktree?: boolean;
}

/**
 * WS5 (#27) — how the resume request reaches the child: the inherited
 * `NUVIRA_RESUME` (see `SubagentRuntimeConfig.resume`). The child resolves it from
 * its own environment, exactly as an in-process surface does, so one request
 * means the same thing on both sides of the fork.
 */
export const SUBAGENT_RESUME_ENV = RESUME_ENABLE_ENV;

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
  /**
   * Typed refusal code when the child refused (see `tool-refusal.ts`), carried
   * across the process boundary so the caller sees WHY, not just an exit code.
   */
  refusalCode?: string;
  /** Provider that actually served the run (reported by the child). */
  provider?: string;
  /** Model that actually served the run, when the child named one. */
  model?: string;
  /** How tool calls travelled: `native`, `json` (fallback) or `none`. */
  transport?: string;
  /**
   * WS1 — the findings the child recorded, in call order, with the gate's
   * verdict. Accumulated from its `finding` progress frames so a subagent run
   * reports the same wire shape every other surface reports.
   */
  findings?: import('../findings/verdicts.js').WireFinding[];
  /** WS5 (#27) — the isolated worktree this run used, when it was isolated. */
  worktree?: string;
  /** WS5 (#27) — the commit the isolated run's diff is measured against. */
  worktreeBase?: string;
  /** WS5 (#27) — what the isolated run changed (filled in when it ends). */
  worktreeDiff?: import('./worktree.js').WorktreeDiff;
  /** WS5 (#27) — true when the worktree was removed after the run. */
  worktreeRemoved?: boolean;
  /** WS5 (#27) — the child's own resume report, when it was asked to resume. */
  resume?: import('../learning/step-checkpoint.js').ResumeOutcome;
  /**
   * G1 — the child's own verification verdict: it mutated the workspace and
   * nothing observed the result. Recorded from the child's result frame, so a
   * delegated run's unverified edit is visible to the parent's dashboard, CLI and
   * findings the same way an in-process turn's is.
   */
  unverifiedEdit?: boolean;
  /** G1/G2 — the child's answer claimed a code change no verification backed. */
  unverifiedEditClaim?: boolean;
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

/**
 * Decide a child's terminal state from what it actually reported.
 *
 * `handleExit` used to synthesise a success here — a child that exited 0 having
 * sent no `result` message was marked `completed` with
 * `result: 'Task completed successfully'`, so `subagent wait` returned success
 * for a run whose output never existed. That is the fabricated-success defect of
 * TOOL_TRUTHFULNESS_TRACKER finding #4, and it is the reason this decision is a
 * separate, exported, tested function rather than three inline branches: no
 * result means the child reported nothing, which is a failure, never a success.
 */
export function classifyChildExit(
  result: string | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
): { status: SubagentStatus; error?: string } {
  if (result) return { status: 'completed' };
  if (code === 0) return { status: 'failed', error: 'Subagent exited without reporting a result' };
  return { status: 'failed', error: signal ? `Killed by ${signal}` : `Exit code ${code}` };
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
  /** Typed refusal code when the child refused, when it reported one. */
  refusalCode?: string;
  /** Provider that served the run. */
  provider?: string;
  /** Model that served the run, when the child reported one. */
  model?: string;
  /** Tool transport the run used: `native`, `json` or `none`. */
  transport?: string;
  /**
   * WS1 — the findings this run recorded, in call order, with the gate's
   * verdict — the child's own report, carried across the process boundary.
   */
  findings?: import('../findings/verdicts.js').WireFinding[];
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
  /**
   * WS5 (#27) — the isolation this run had, and what it changed. Present only
   * when isolation was asked for; `removed` says whether the directory is still
   * on disk, so a caller can point at it or say it is gone.
   */
  worktree?: { dir: string; base: string; diff: import('./worktree.js').WorktreeDiff; removed: boolean };
  /**
   * WS5 (#27) — what the CHILD's resume replayed, and what it saved. Present only
   * when a resume was asked for; read from the frame the child sent, so it is the
   * child's own count rather than something the parent inferred.
   */
  resume?: import('../learning/step-checkpoint.js').ResumeOutcome;
  /**
   * G1 — the child's own verification verdict, carried across the fork. Present
   * (and `true`) only when the child reported it: like `findings`, an absent flag
   * means the child did not claim it, never that the edit was verified.
   */
  unverifiedEdit?: boolean;
  /** G1/G2 — the child's answer claimed a code change no verification backed. */
  unverifiedEditClaim?: boolean;
}

// ─── Subagent Manager ─────────────────────────────────────────────────────

// `resolveNuviraDataPath` (not `resolveNuviraHome`) so a process pointed at an
// isolated config dir writes its subagent state there too — every other state file
// the agent persists resolves through it, and a test can then inspect a run without
// touching the developer's real ~/.nuvira.
const SUBAGENT_DIR = resolveNuviraDataPath('cache', 'subagents');
const STATE_DIR = join(SUBAGENT_DIR, 'state');
const LOG_DIR = join(SUBAGENT_DIR, 'logs');
const RESULT_DIR = join(SUBAGENT_DIR, 'results');

/**
 * The file to fork.
 *
 * A compiled build has `dist/tools/child-agent-entry.js` beside this module and
 * plain `node` runs it. A source run (tsx/vitest) has the TypeScript original
 * instead, which node cannot parse — it is forked through the tsx loader. The two
 * layouts used to be handled by one hardcoded `.js` path, which failed BOTH ways:
 * compiled, the build never emitted that file (allowJs is false, so `fork()` threw
 * ENOENT); from source, it was a CommonJS file inside a `"type": "module"`
 * package and died on `require is not defined`. That is why no subagent ever ran.
 */
function resolveChildEntry(): { entry: string; execArgv?: string[] } {
  const dir = import.meta.dirname;
  const compiled = join(dir, 'child-agent-entry.js');
  if (existsSync(compiled)) return { entry: compiled };
  const source = join(dir, 'child-agent-entry.ts');
  if (existsSync(source)) return { entry: source, execArgv: ['--import', 'tsx'] };
  throw new Error(
    `subagent entry not found beside ${dir} (expected child-agent-entry.js or .ts) — the build is incomplete`,
  );
}

export class SubagentManager extends EventEmitter {
  private subagents: Map<string, SubagentState> = new Map();
  /** WS5 (#27) — the live worktree of each isolated run, keyed by subagent id. */
  private worktrees: Map<string, { handle: IsolatedWorktree; keep: boolean }> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private maxConcurrent: number = 3;
  private maxDepth: number = 1;
  private killSwitch: boolean = false;

  constructor() {
    super();
    this.ensureDirectories();
    this.recoverState();
  }

  /** Configure spawn limits. */
  configure(options: { maxConcurrent?: number; maxDepth?: number; killSwitch?: boolean }): void {
    if (options.maxConcurrent !== undefined) this.maxConcurrent = options.maxConcurrent;
    if (options.maxDepth !== undefined) this.maxDepth = options.maxDepth;
    if (options.killSwitch !== undefined) this.killSwitch = options.killSwitch;
  }

  /** Check if spawning is allowed. */
  canSpawn(): { allowed: boolean; reason?: string } {
    if (this.killSwitch) return { allowed: false, reason: 'Kill switch enabled' };
    const running = Array.from(this.subagents.values()).filter((s) => s.status === 'running' || s.status === 'spawning');
    if (running.length >= this.maxConcurrent) return { allowed: false, reason: `Max concurrent (${this.maxConcurrent}) reached` };
    return { allowed: true };
  }

  /**
   * Spawn a subagent.
   */
  async spawn(config: SubagentConfig): Promise<SubagentState> {
    // Check spawn permissions
    const check = this.canSpawn();
    if (!check.allowed) throw new Error(check.reason);
    /** WS5 — the worktree this run is isolated in, when one was asked for. */
    let worktree: IsolatedWorktree | null = null;

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
      // WS5 (#27) — isolation, made by the parent BEFORE the fork. A refusal is a
      // FAILED spawn rather than an unisolated run: the caller asked for isolation
      // on purpose, and a run that silently happened in the real tree is the exact
      // outcome this capability exists to prevent.
      if (config.worktree) {
        const repoCwd = config.cwd || process.cwd();
        worktree = createIsolatedWorktree({ repoCwd, label: config.goal });
        if (!worktree) {
          const why = worktreeRefusal(repoCwd) ?? 'the worktree could not be created';
          throw new Error(`Cannot isolate this subagent: ${why}`);
        }
        state.worktree = worktree.dir;
        state.worktreeBase = worktree.base;
        this.worktrees.set(id, { handle: worktree, keep: config.keepWorktree === true });
        this.emit('progress', id, {
          phase: 'worktree',
          dir: worktree.dir,
          base: worktree.base,
          sourceDirty: worktree.sourceDirty,
        });
      }
      // Spawn child process
      const { entry, execArgv } = resolveChildEntry();
      // WS3 (#25) — hand the child the trace it belongs to. The loop makes the
      // tool span ACTIVE around this call, so `childTraceEnv()` reads the real
      // parent out of the active context (never out of module state, which two
      // interleaved turns in one server would share). It is set or DELETED
      // explicitly rather than merged: a `TRACEPARENT` inherited from this
      // process's own environment is not the child's parent, and a stale one
      // would graft the child onto a trace nobody is running.
      const traceEnv = childTraceEnv();
      const childEnv: NodeJS.ProcessEnv = {
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
      };
      const traceparent = traceEnv[TRACEPARENT_ENV];
      if (traceparent) childEnv[TRACEPARENT_ENV] = traceparent;
      else delete childEnv[TRACEPARENT_ENV];
      // WS5 — the resume request travels as the environment the child resolves it
      // from. INHERITED when the caller does not name one (unlike the traceparent
      // above, which is explicitly cleared): a parent run that was asked to resume
      // is asking for its children's model calls to be replayed too, and a child
      // with no record of its own simply records a fresh one. An explicit
      // `false` is how a caller opts a child out of that.
      // WS5 — the child's cwd IS the isolation, and it is told so in its
      // environment: a tool inside the run can then report which worktree it is
      // working in instead of guessing, and a nested spawn can isolate from it.
      if (worktree) Object.assign(childEnv, worktreeEnv(worktree));
      const child = fork(entry, [], {
        cwd: worktree?.dir ?? config.cwd ?? process.cwd(),
        ...(execArgv ? { execArgv } : {}),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      logger.info(`Subagent: forked ${entry}${execArgv ? ` (via ${execArgv.join(' ')})` : ''}`);

      state.pid = child.pid;
      state.status = 'running';
      this.processes.set(id, child);

      // Set up log file. This used to be `require('node:fs')` INSIDE an ESM
      // module, so it threw `require is not defined` immediately after the fork
      // and `spawn()` rejected before the child was ever tracked.
      const logFile = join(LOG_DIR, `${id}.log`);
      const logStream = createWriteStream(logFile, { flags: 'a' });

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
      // A spawn that failed AFTER the worktree was made leaves nothing behind:
      // the run never happened, so neither should its directory.
      if (worktree) {
        const kept = this.worktrees.get(id)?.keep === true;
        if (!kept) discardWorktree(worktree, { timeoutMs: WORKTREE_EXIT_TIMEOUT_MS });
        if (!kept) this.worktrees.delete(id);
      }
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
        // WS1 — a finding the child recorded. Appended, never replaced: a run
        // can record several, and the order is part of what it did.
        if (msg.finding && typeof msg.finding === 'object') {
          state.findings = [...(state.findings ?? []), msg.finding];
        }
        // WS5 (#27) — the child's own resume report. A frame, not a return value:
        // the child is a separate process, and this is its only channel back.
        if (msg.resume && typeof msg.resume === 'object') {
          state.resume = msg.resume as import('../learning/step-checkpoint.js').ResumeOutcome;
        }
        this.recordIdentity(state, msg);
        this.saveState(state);
        this.emit('progress', id, msg);
        break;
      case 'result':
        state.result = msg.result;
        state.llmCalls = msg.llmCalls || state.llmCalls;
        state.tokensUsed = msg.tokensUsed || state.tokensUsed;
        state.toolCalls = msg.toolCalls || state.toolCalls;
        // G1 — the child's verification verdict, read off its result frame. Only
        // a truthy flag is recorded: the child omits it when the edit WAS verified,
        // so `undefined` here means "not claimed", and never `false`.
        if (msg.unverifiedEdit === true) state.unverifiedEdit = true;
        if (msg.unverifiedEditClaim === true) state.unverifiedEditClaim = true;
        this.recordIdentity(state, msg);
        this.saveState(state);
        break;
      case 'error':
        // The child's OWN reason. Without this the message was dropped and the
        // parent could only report "Exit code 1".
        state.error = msg.error || 'Subagent reported an error';
        if (msg.code) state.refusalCode = msg.code;
        this.recordIdentity(state, msg);
        this.saveState(state);
        break;
    }
  }

  /**
   * Record which provider/model/transport the child is serving this run with.
   *
   * The child announces them on its FIRST frame — before it can fail — and repeats
   * them on the result and error frames. Recording from every frame (not just the
   * result) is what makes a FAILED run attributable: a subagent that its provider
   * rejected used to land as a bare error with no provider, model or transport, so
   * the dashboard showed a failure with nothing to debug it by — exactly backwards,
   * since a run that produced no output is the one that needs the attribution.
   */
  private recordIdentity(state: SubagentState, msg: any): void {
    if (msg.provider) state.provider = String(msg.provider);
    if (msg.model) state.model = String(msg.model);
    if (msg.transport) state.transport = String(msg.transport);
  }

  private handleExit(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const state = this.subagents.get(id);
    if (!state) return;

    state.endedAt = Date.now();
    state.durationMs = state.endedAt - state.startedAt;

    if (state.status === 'killed' || state.status === 'timeout') {
      // The killer already recorded why; do not overwrite it with an exit code.
    } else if (state.error) {
      // The child said why it failed — that reason outranks its exit code.
      state.status = 'failed';
    } else {
      const outcome = classifyChildExit(state.result, code, signal);
      state.status = outcome.status;
      if (outcome.error) state.error = outcome.error;
    }

    // WS5 (#27) — what an isolated run changed, measured from the parent, and the
    // teardown. Both happen BEFORE the result is built and emitted, so the diff
    // rides on the result its caller is waiting for: a diff reported later (or by
    // a separate command) is a diff most callers never see. A KILLED run is
    // measured too — "what had it changed when you stopped it" is exactly the
    // question a teardown needs answered.
    const isolated = this.worktrees.get(id);
    if (isolated) {
      state.worktreeDiff = worktreeDiff(isolated.handle, { timeoutMs: WORKTREE_EXIT_TIMEOUT_MS });
      if (isolated.keep) {
        state.worktreeRemoved = false;
      } else {
        state.worktreeRemoved = discardWorktree(isolated.handle, { timeoutMs: WORKTREE_EXIT_TIMEOUT_MS });
      }
      this.worktrees.delete(id);
    }

    this.saveState(state);
    this.processes.delete(id);

    const result = this.buildResult(state);
    writeFileSync(join(RESULT_DIR, `${id}.json`), JSON.stringify(result, null, 2));

    if (state.status === 'completed') {
      this.emit('completed', id, result);
      this.emit(`completed:${id}`, result);
    } else {
      // The child's typed refusal (when it reported one) rides on the error, so
      // `waitForCompletion`'s rejection is actionable instead of a bare message.
      const failure = new Error(state.error);
      if (state.refusalCode) (failure as Error & { code?: string }).code = state.refusalCode;
      this.emit('failed', id, failure);
      this.emit(`failed:${id}`, failure);
    }
  }

  private buildResult(state: SubagentState): SubagentResult {
    return {
      id: state.id,
      success: state.status === 'completed',
      result: state.result || '',
      error: state.error,
      ...(state.refusalCode ? { refusalCode: state.refusalCode } : {}),
      ...(state.provider ? { provider: state.provider } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.transport ? { transport: state.transport } : {}),
      ...(state.findings && state.findings.length > 0 ? { findings: state.findings } : {}),
      ...(state.resume ? { resume: state.resume } : {}),
      ...(state.unverifiedEdit ? { unverifiedEdit: true } : {}),
      ...(state.unverifiedEditClaim ? { unverifiedEditClaim: true } : {}),
      ...(state.worktree && state.worktreeBase && state.worktreeDiff
        ? {
            worktree: {
              dir: state.worktree,
              base: state.worktreeBase,
              diff: state.worktreeDiff,
              removed: state.worktreeRemoved === true,
            },
          }
        : {}),
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

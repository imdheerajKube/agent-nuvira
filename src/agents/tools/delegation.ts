/**
 * H2 — Sub-agent registry + live delegation (`src/agents/tools/delegation.ts`).
 *
 * The second half of the "missing Freebuff/Hermes core" (capability gap #2):
 * a parent task — or the chat model via the `delegate` tool — can spawn
 * specialized agents (context-gatherer, reviewer, security, tester, ...) as
 * sub-tasks, each with a FRESH, isolated context. Mirrors Hermes
 * `tools/delegate_tool.py`: the child gets a fresh conversation, isolated
 * context, its own task id, and a focused system prompt — the parent only ever
 * sees the delegation call + summary result, never the child's intermediate
 * turns.
 *
 * Design:
 * - Agent lookup through the SAME ModuleRegistry the orchestrator uses — the
 *   registry is the only place agents are declared (H2 acceptance).
 * - `spawnSubagent()` runs one sub-agent; `spawnSubagents()` fans out in
 *   parallel and aggregates (the orchestrator's Promise.all pattern).
 * - Budget/loop guards: max sub-agents per turn, per-sub-agent timeout, and an
 *   AbortSignal kill-switch.
 * - Every spawn/result/error streams `delegation:*` events on the EventBus so
 *   the E2 board renders live lanes (and the NDJSON stream + web dashboard
 *   reuse the same source of truth).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getModuleRegistry, type ModuleRegistry } from '../module-registry.js';
import { getEventBus, EventNames } from '../../observability/event-bus.js';
import type { AgentContext, LLMCallFn, TaskDelegation } from '../agent.js';
import { logger } from '../../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single sub-agent request. Alias of the shared `TaskDelegation` shape so a
 * delegate plan step and a direct spawnSubagent call speak ONE vocabulary
 * (the SAME shape flows taskStep.delegation → spawnSubagents).
 */
export type SubagentRequest = TaskDelegation;

/** Options for spawning one or many sub-agents. */
export interface SpawnSubagentOptions {
  /** The LLM function the sub-agent uses (the parent's resolved provider). */
  callLLM: LLMCallFn;
  /** Working directory for the sub-agent context (default: process.cwd()). */
  cwd?: string;
  /** Agent registry (default: the global ModuleRegistry with builtins). */
  registry?: ModuleRegistry;
  /** Event sink (default: the global EventBus emit). Injectable for tests. */
  emit?: (event: string, data: unknown, source?: string) => void;
  /** Per-sub-agent timeout in ms (default: 120_000). */
  timeoutMs?: number;
  /** Max sub-agents per fan-out (default: 4). Extra requests are skipped. */
  maxSubagents?: number;
  /** External kill-switch — aborting the signal kills in-flight sub-agents. */
  signal?: AbortSignal;
}

/** The result of one sub-agent run — a SUMMARY, never the child's transcript. */
export interface SubagentResult {
  id: string;
  agentType: string;
  success: boolean;
  summary: string;
  durationMs: number;
  error?: string;
  timedOut?: boolean;
  killed?: boolean;
  skipped?: boolean;
}

// ─── Sentinel errors (distinguish timeout / kill from agent failures) ───────

class SubagentTimeout extends Error {
  constructor() {
    super('sub-agent timed out');
    this.name = 'SubagentTimeoutError';
  }
}

class SubagentKilled extends Error {
  constructor() {
    super('sub-agent killed');
    this.name = 'SubagentKilledError';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let subagentSeq = 0;
function nextSubagentId(): string {
  subagentSeq += 1;
  return `sub-${subagentSeq}`;
}

/**
 * Run a task under a timeout + optional AbortSignal kill. Whichever guard fires
 * first wins; the underlying task keeps running but its result is discarded
 * (the parent already moved on — Hermes delegate_tool semantics).
 */
function runWithGuards<T>(fn: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SubagentTimeout());
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal!.removeEventListener('abort', onAbort);
      reject(new SubagentKilled());
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    fn().then(
      (v) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      },
    );
  });
}

/** Max chars of a delegated file read into the sub-agent context. */
const MAX_DELEGATED_FILE_CHARS = 16_000;

/** Build a FRESH, isolated context for the sub-agent (never shares the parent's). */
function buildSubagentContext(
  request: SubagentRequest,
  opts: SpawnSubagentOptions,
  id: string,
): AgentContext {
  const cwd = opts.cwd ?? process.cwd();
  const artifacts = (request.files ?? []).map((f) => {
    try {
      const content = readFileSync(join(cwd, f), 'utf-8');
      // Cap oversized delegated files (lockfiles, minified bundles) so a huge
      // file can't blow the sub-agent's context — mirrors the orchestrator's
      // file-tree truncation pattern.
      const truncated = content.length > MAX_DELEGATED_FILE_CHARS;
      return {
        path: f,
        content: truncated
          ? content.slice(0, MAX_DELEGATED_FILE_CHARS) +
            `\n… [truncated: ${content.length - MAX_DELEGATED_FILE_CHARS} chars omitted]`
          : content,
        description: truncated ? `Delegated file (truncated): ${f}` : `Delegated file: ${f}`,
      };
    } catch {
      return { path: f, content: '', description: `Delegated file (unreadable): ${f}` };
    }
  });
  const emit = opts.emit ?? ((event: string, data: unknown, source?: string) => {
    getEventBus().emit(event as never, data, source);
  });

  return {
    goal: request.prompt,
    workingDirectory: cwd,
    taskPlan: [],
    artifacts,
    conversations: [],
    fileChanges: [],
    metadata: { isSubagent: true, delegationId: id },
    // Stream the child's own "thinking" updates to the bus so the parent's
    // board can show what the sub-agent is doing (tagged with the child's
    // agentType — untethered updates render as the board's activity line).
    onAgentUpdate: (update) => {
      try {
        emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
          agentType: update.agentType,
          stage: update.stage,
          message: update.message,
          taskId: update.taskId,
        }, 'delegation');
      } catch {
        /* best-effort */
      }
    },
  };
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Spawn ONE sub-agent with a fresh, isolated context and a summary result.
 *
 * Streams `delegation:spawn` → `delegation:result` (or `delegation:error`) on
 * the event bus so the live board renders a lane. Never throws: failures,
 * timeouts, and kills all resolve to a `SubagentResult` with `success: false`.
 */
export async function spawnSubagent(
  request: SubagentRequest,
  opts: SpawnSubagentOptions,
): Promise<SubagentResult> {
  const registry = opts.registry ?? getModuleRegistry();
  const emit = opts.emit ?? ((event: string, data: unknown, source?: string) => {
    getEventBus().emit(event as never, data, source);
  });
  const id = nextSubagentId();
  const startedAt = Date.now();

  if (opts.signal?.aborted) {
    return {
      id,
      agentType: request.agentType,
      success: false,
      summary: 'Killed before start',
      durationMs: 0,
      killed: true,
    };
  }

  emit(EventNames.DELEGATION_SPAWN, {
    id,
    agentType: request.agentType,
    prompt: request.prompt,
    files: request.files ?? [],
  }, 'delegation');

  // Lookup throws ModuleNotFoundError for unknown agent types — catch it and
  // resolve to an error result (the tool loop feeds it back to the model).
  let agent;
  try {
    agent = registry.getModule(request.agentType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    emit(EventNames.DELEGATION_ERROR, {
      id,
      agentType: request.agentType,
      error: message,
    }, 'delegation');
    return {
      id,
      agentType: request.agentType,
      success: false,
      summary: message,
      durationMs,
      error: message,
    };
  }

  const context = buildSubagentContext(request, opts, id);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  try {
    const result = await runWithGuards(
      () => agent.execute(context, opts.callLLM),
      timeoutMs,
      opts.signal,
    );
    const durationMs = Date.now() - startedAt;
    emit(EventNames.DELEGATION_RESULT, {
      id,
      agentType: request.agentType,
      success: result.success,
      summary: result.summary,
      durationMs,
    }, 'delegation');
    return {
      id,
      agentType: request.agentType,
      success: result.success,
      summary: result.summary,
      durationMs,
      error: result.error,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const timedOut = err instanceof SubagentTimeout;
    const killed = err instanceof SubagentKilled;
    const message = err instanceof Error ? err.message : String(err);
    emit(EventNames.DELEGATION_ERROR, {
      id,
      agentType: request.agentType,
      error: message,
      timedOut,
      killed,
    }, 'delegation');
    return {
      id,
      agentType: request.agentType,
      success: false,
      summary: killed ? 'Killed by parent' : timedOut ? 'Timed out' : message,
      durationMs,
      error: message,
      timedOut,
      killed,
    };
  }
}

/**
 * Spawn N sub-agents in PARALLEL and aggregate their summary results
 * (Freebuff `spawn_agents` / orchestrator Promise.all pattern).
 *
 * Budget guard: requests beyond `maxSubagents` (default 4) are NOT spawned —
 * they resolve as `skipped` results so the caller/model sees the truncation.
 */
export async function spawnSubagents(
  requests: SubagentRequest[],
  opts: SpawnSubagentOptions,
): Promise<SubagentResult[]> {
  const max = opts.maxSubagents ?? 4;
  if (requests.length > max) {
    logger.warn(
      `   ⚠️ Sub-agent budget exceeded: ${requests.length} requested, max ${max} — spawning the first ${max}`,
    );
  }
  const accepted = requests.slice(0, max);
  const results = await Promise.all(accepted.map((r) => spawnSubagent(r, opts)));
  const skipped = requests.slice(max).map((r) => ({
    id: 'skipped',
    agentType: r.agentType,
    success: false,
    summary: 'Skipped — sub-agent budget exceeded',
    durationMs: 0,
    skipped: true,
  }));
  return [...results, ...skipped];
}

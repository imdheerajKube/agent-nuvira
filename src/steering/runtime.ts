/**
 * The in-process steering runtime: the bridge between surfaces and the executor.
 *
 * WHY ALS. The dashboard, CLI and loop all call into the same process, but the
 * loop's call signature is shared by many callers. Threading a new option through
 * every one would be invasive and easy to miss. `AsyncLocalStorage` scopes a
 * steering run to the async work that started it, so a turn opened by the
 * dashboard carries its run id into the loop without changing the engine's public
 * contract. A CLI run that did not wrap itself still gets a run, keyed by its trace
 * id, so `nuvira steer` can find and join it.
 *
 * FEATURE FLAG. Off by default (`steering.enabled = false`), as the safety
 * checklist requires. A single flag turns the whole feature off: no plans are
 * mutated, no inbox is read, and a turn is byte-identical to one from before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { ConfigManager } from '../config/manager.js';
import { contentHash } from './ids.js';
import { appendJournal, ensureRun, listRuns, patchRun, readRun, releaseLease } from './store.js';
import { submitGuidance, type SubmitGuidanceInput, type SubmitGuidanceResult } from './inbox.js';
import { triagePending, runSafePoint } from './scheduler.js';
import { projectRun } from './projection.js';
import { LoopPlanAdapter, PipelinePlanAdapter, type LoopPlanStoreLike, type PipelineVaultLike } from './adapters.js';
import type { StewardGenerate } from './steward.js';
import type {
  ChangeSource,
  SteeringEngine,
  SteeringPlanAdapter,
  SteeringProjection,
  SteeringTickResult,
} from './types.js';

/** Words treated as OFF by the process-env vocabulary. */
const OFF_WORDS = new Set(['0', 'false', 'off', 'no', 'disabled']);
const ON_WORDS = new Set(['1', 'true', 'on', 'yes', 'enabled']);

/** Read once per process: the loop checks this before every model call. */
let configuredFlag: boolean | undefined;

/**
 * Resolve the feature flag. An explicit environment value wins (so an operator can
 * disable a broken deployment without editing config); otherwise config; otherwise
 * OFF. Defaulting off is the documented rollback contract.
 */
export function steeringEnabled(configManager?: { getAll(): { steering?: { enabled?: boolean } } } | null): boolean {
  const raw = process.env.NUVIRA_STEERING;
  if (typeof raw === 'string' && raw.trim()) {
    const value = raw.trim().toLowerCase();
    if (OFF_WORDS.has(value)) return false;
    if (ON_WORDS.has(value)) return true;
    return true;
  }
  try {
    // No caller-supplied manager means "read the real config once". The loop's
    // safe point is exactly that caller: an operator who enabled steering in
    // config (rather than the env override) must have guidance APPLIED, not
    // merely accepted by the dashboard. Caching matters here because the check
    // runs before every model call; an explicit manager is still read live.
    if (configManager) return configManager.getAll()?.steering?.enabled === true;
    if (configuredFlag === undefined) {
      configuredFlag = new ConfigManager().getAll()?.steering?.enabled === true;
    }
    return configuredFlag;
  } catch {
    configuredFlag = false;
    return false;
  }
}

/** The handle a surface registers and the loop consumes at safe points. */
export class SteeringRunHandle {
  adapter?: SteeringPlanAdapter;
  generate?: StewardGenerate;

  constructor(
    readonly runId: string,
    readonly engine: SteeringEngine,
  ) {}

  attachAdapter(adapter: SteeringPlanAdapter): this {
    this.adapter = adapter;
    return this;
  }

  attachGenerate(generate: StewardGenerate | undefined): this {
    if (generate) this.generate = generate;
    return this;
  }

  /** One safe point. No adapter means the engine has not attached yet — no-op. */
  async tick(): Promise<SteeringTickResult> {
    if (!this.adapter) {
      return { stop: false, pause: false, directive: null, appliedChangeIds: [], changedIds: [] };
    }
    return runSafePoint({ runId: this.runId, adapter: this.adapter, generate: this.generate });
  }
}

const HANDLES = new Map<string, SteeringRunHandle>();
const STORAGE = new AsyncLocalStorage<SteeringRunHandle>();

export interface OpenSteeringRunInput {
  runId: string;
  goal: string;
  cwd: string;
  engine?: SteeringEngine;
  surface?: ChangeSource;
  sessionId?: string;
  adapter?: SteeringPlanAdapter;
  /** Set only by a surface starting a NEW turn, never by a safe-point tick. */
  resume?: boolean;
}

/**
 * Open or attach to a run. Idempotent: the same run id returns the same handle, so
 * the dashboard can open it on submission and the loop can pick it up later.
 */
export function openSteeringRun(input: OpenSteeringRunInput): SteeringRunHandle {
  const existing = HANDLES.get(input.runId);
  const run = ensureRun({
    runId: input.runId,
    goal: input.goal,
    cwd: input.cwd,
    engine: input.engine ?? existing?.engine ?? 'loop',
    surface: input.surface ?? 'cli',
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  // A new turn for a run that finished, paused or stopped is an explicit resume.
  // A safe-point tick also calls this function for the SAME live turn, so it must
  // not pass `resume` or a pause would be cleared before the loop ever sees it.
  if (
    input.resume &&
    (run.status === 'completed' || run.status === 'failed' || run.status === 'paused' || run.status === 'stopped')
  ) {
    patchRun(input.runId, { status: 'running', stopRequested: false, pauseRequested: false });
  }
  const handle = existing ?? new SteeringRunHandle(run.runId, run.engine);
  if (input.adapter) handle.attachAdapter(input.adapter);
  HANDLES.set(input.runId, handle);
  return handle;
}

export function getSteeringRun(runId: string): SteeringRunHandle | null {
  return HANDLES.get(runId) ?? null;
}

export function currentSteeringRun(): SteeringRunHandle | null {
  return STORAGE.getStore() ?? null;
}

/** Scope a turn to a steering run without changing the engine's signature. */
export function withSteeringRun<T>(handle: SteeringRunHandle, fn: () => Promise<T>): Promise<T> {
  return STORAGE.run(handle, fn);
}

function fallbackRunId(goal: string, cwd: string): string {
  return `run-${contentHash(`${cwd}::${goal}`).replace(':', '-')}`;
}

/**
 * The loop's safe point. Called before each model call. It is a no-op when the
 * feature is off, when no guidance exists, or when the run has no plan adapter.
 * Never throws: a steering failure must not break the turn it is steering.
 */
export async function steeringSafePointForLoop(input: {
  runId?: string;
  goal: string;
  cwd: string;
  planStore: LoopPlanStoreLike;
  generate?: StewardGenerate;
  enabled?: boolean;
}): Promise<SteeringTickResult> {
  if (!steeringEnabled()) {
    return { stop: false, pause: false, directive: null, appliedChangeIds: [], changedIds: [] };
  }
  try {
    const handle =
      currentSteeringRun() ??
      openSteeringRun({
        runId: input.runId?.trim() || fallbackRunId(input.goal, input.cwd),
        goal: input.goal,
        cwd: input.cwd,
        engine: 'loop',
        surface: 'cli',
      });
    if (handle.engine !== 'loop') return { stop: false, pause: false, directive: null, appliedChangeIds: [], changedIds: [] };
    handle.attachAdapter(new LoopPlanAdapter(input.planStore, input.goal));
    handle.attachGenerate(input.generate);
    return await handle.tick();
  } catch {
    return { stop: false, pause: false, directive: null, appliedChangeIds: [], changedIds: [] };
  }
}

/** The pipeline's safe point, called between task batches. */
export async function steeringSafePointForPipeline(input: {
  runId?: string;
  goal: string;
  cwd: string;
  vault: PipelineVaultLike;
  generate?: StewardGenerate;
}): Promise<SteeringTickResult> {
  if (!steeringEnabled()) {
    return { stop: false, pause: false, directive: null, appliedChangeIds: [], changedIds: [] };
  }
  try {
    const handle =
      currentSteeringRun() ??
      openSteeringRun({
        runId: input.runId?.trim() || fallbackRunId(input.goal, input.cwd),
        goal: input.goal,
        cwd: input.cwd,
        engine: 'pipeline',
        surface: 'cli',
      });
    if (handle.engine !== 'pipeline') {
      return { stop: false, pause: false, directive: null, appliedChangeIds: [], changedIds: [] };
    }
    handle.attachAdapter(new PipelinePlanAdapter(input.vault));
    handle.attachGenerate(input.generate);
    return await handle.tick();
  } catch {
    return { stop: false, pause: false, directive: null, appliedChangeIds: [], changedIds: [] };
  }
}

/**
 * Submit guidance from any surface. The receipt is returned immediately; triage is
 * kicked off asynchronously when a model is attached, so a slow provider cannot
 * delay the acknowledgement the user sees.
 */
export function submitSteeringGuidance(
  input: SubmitGuidanceInput & { triage?: boolean },
): SubmitGuidanceResult {
  const result = submitGuidance(input);
  const handle = getSteeringRun(input.runId) ?? currentSteeringRun();
  if (result.ok && result.change && input.triage !== false) {
    void triagePending({
      runId: input.runId,
      ...(handle?.generate ? { generate: handle.generate } : {}),
    }).catch(() => {
      // Triage failure is a visible `needs_review`, never a lost submission.
    });
  }
  return result;
}

/** The projection a surface polls. `enabled` is the deployment flag, not run state. */
export function steeringProjection(runId: string, configManager?: Parameters<typeof steeringEnabled>[0]): SteeringProjection {
  return projectRun(runId, { enabled: steeringEnabled(configManager) });
}

/** Every active run, for a picker or `nuvira steer --list`. */
/**
 * Mark a run finished and release its lease. A run the user stopped or paused is
 * LEFT in that terminal-control state: the durable plan and queue must survive for
 * the resume that follows, and calling a paused run "completed" would hide it from
 * the very `steer --list` surface that should offer to resume it.
 */
export function completeSteeringRun(
  runId: string,
  status: 'completed' | 'failed' = 'completed',
): void {
  const run = readRun(runId);
  if (!run) return;
  releaseLease(runId);
  if (run.status === 'stopped' || run.status === 'paused') return;
  if (run.status === status) return;
  patchRun(runId, { status, stopRequested: false, pauseRequested: false });
  appendJournal(runId, {
    type: status === 'completed' ? 'run.completed' : 'run.failed',
    actor: 'system',
    data: { planVersion: run.planVersion },
  });
}

export function listSteeringRuns(activeOnly = false) {
  const runs = listRuns();
  return activeOnly ? runs.filter((run) => run.status === 'running' || run.status === 'paused') : runs;
}

/** Find a run by id, newest active run for a cwd, or newest active run. */
export function resolveSteeringRun(runId?: string, cwd?: string) {
  if (runId?.trim()) return readRun(runId.trim());
  const wanted = cwd ? cwd.replace(/[\\/]+$/, '') : null;
  const active = listRuns().filter((run) => run.status === 'running' || run.status === 'paused');
  if (wanted) {
    const match = active.find((run) => run.cwd.replace(/[\\/]+$/, '') === wanted);
    if (match) return match;
  }
  return active[0] ?? listRuns()[0] ?? null;
}

/** Register a run opened by a surface without an adapter (the loop attaches it). */
export function ensureSteeringHandle(input: OpenSteeringRunInput): SteeringRunHandle {
  return openSteeringRun(input);
}

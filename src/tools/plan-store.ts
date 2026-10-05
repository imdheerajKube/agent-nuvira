/**
 * P0.7 — Plan store (creating AND tracking plans).
 *
 * The chat agent's plan/todo capability: the model declares ordered steps
 * (id + description), updates their status as work progresses
 * (pending → running → done/blocked), and can reference the plan on a LATER
 * turn ("step 3 is done" — the store outlives a single tool call).
 *
 * The store is deliberately tiny and dependency-free. The orchestrator's
 * internal planner stays untouched — this is the CHAT-loop surface (the
 * dashboard chat renders it as a live checklist card).
 *
 * THE PROGRESS HAS TO BE VISIBLE, NOT JUST STORED. A plan that is created and
 * then never advanced is worse than no plan: it reads as tracking while saying
 * nothing. So the store carries a TABULAR renderer (`toTable`) that every
 * surface shows — a goal, a done/total progress count, one row per step, and a
 * plain-English note per row once the step reports one. `toText()` returns that
 * table while work is happening, and swaps to an ACHIEVED summary
 * (`summary()`) once every step has reached a terminal state, so a plan that
 * spans several turns can be closed out with "what actually got done".
 *
 * PERSISTENCE — the plan is the thing a multi-session project needs to keep.
 * The store itself stays in-memory and dependency-free, but it accepts an
 * `onChange` sink (called on every mutation AND on hydrate) plus a `hydrate`
 * entry point, and this module ships the file helpers (`planFilePath` /
 * `readPlanFile` / `writePlanFile`) the callers wire it to. One file per SCOPE
 * (a dashboard session id, or a CLI project path) so a plan follows the scope
 * it was created in and never leaks into an unrelated conversation.
 *
 * Lifecycle: the ToolContext carries an OPTIONAL `planStore`; chat.ts owns
 * one per ChatCommand instance (default) and the dashboard console injects a
 * per-session store so plans never leak across conversations. A tool run
 * without a store falls back to a shared module-level store (best-effort —
 * the tool must never throw on a missing store).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';

/** Step statuses the model can set (pending is the default on create). */
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'blocked';

/** One ordered step in a plan. */
export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  /**
   * P0.7 — plain-English progress note for this step ("reproduced with a
   * minimal test", "blocked on the missing API key"). Written when the model
   * reports an update, and rendered verbatim in the table's Notes column, so
   * the summary can say what each achieved step actually did.
   */
  note?: string;
}

/** The whole plan — goal + ordered steps. */
export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** Monotonic revision so the GUI can order plan:changed events. */
  revision: number;
  updatedAt: number;
}

/** The structured payload the GUI renders (SSE `plan` event / chat-console). */
export interface PlanSnapshot {
  goal: string;
  steps: PlanStep[];
  revision: number;
}

/** How far along a plan is. `complete` means every step reached done. */
export interface PlanProgress {
  done: number;
  blocked: number;
  total: number;
  percent: number;
  /** Every step is done. The plan is finished and can be summarised. */
  complete: boolean;
  /** Every step is done or blocked — no work is left outstanding. */
  settled: boolean;
}

/** A store must be able to hand back its current state (or undefined). */
export interface PlanStoreLike {
  snapshot(): Plan | null;
  create(goal: string, steps: Array<{ id: string; description: string }>): Plan;
  update(id: string, status: PlanStepStatus, note?: string): Plan | null;
  /** Structured GUI snapshot (plan_todo emits it via plan:changed). */
  toGUI?(): PlanSnapshot | null;
  /** Human-readable checklist text (the model's tool result). */
  toText?(): string;
  /** Tabular render with a progress count (the shared progress view). */
  toTable?(): string;
  /** Achieved summary — shown once the plan settles. */
  summary?(): string;
  /** Restore a previously persisted plan (no-op on null). */
  hydrate?(plan: Plan | null): void;
}

const VALID_STATUSES: PlanStepStatus[] = ['pending', 'running', 'done', 'blocked'];

/** A step that no longer needs work. */
function isTerminal(status: PlanStepStatus): boolean {
  return status === 'done' || status === 'blocked';
}

/** The one status glyph, shared by every renderer so they cannot drift. */
function statusIcon(status: PlanStepStatus): string {
  if (status === 'done') return '✅';
  if (status === 'running') return '🔄';
  if (status === 'blocked') return '⛔';
  return '⬜';
}

/** A short human word for a status (the table's Status cell). */
function statusWord(status: PlanStepStatus): string {
  if (status === 'done') return 'done';
  if (status === 'running') return 'in progress';
  if (status === 'blocked') return 'blocked';
  return 'pending';
}

/** The stored shape is read back from disk, so validate before trusting it. */
function normalizeStep(raw: unknown, index: number): PlanStep | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as { id?: unknown; description?: unknown; status?: unknown; note?: unknown };
  const description = String(record.description ?? '').trim();
  if (!description) return null;
  const status = VALID_STATUSES.includes(record.status as PlanStepStatus)
    ? (record.status as PlanStepStatus)
    : 'pending';
  const note = typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined;
  return {
    id: String(record.id ?? `step-${index + 1}`),
    description,
    status,
    ...(note ? { note } : {}),
  };
}

/** Validate a persisted plan (or reject it wholesale). */
export function normalizePlan(raw: unknown): Plan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as { goal?: unknown; steps?: unknown; revision?: unknown; updatedAt?: unknown };
  if (!Array.isArray(record.steps)) return null;
  const steps = record.steps
    .map((s, i) => normalizeStep(s, i))
    .filter((s): s is PlanStep => s !== null);
  if (steps.length === 0) return null;
  return {
    goal: String(record.goal ?? '').trim() || '(untitled plan)',
    steps,
    revision: Number(record.revision) || 0,
    updatedAt: Number(record.updatedAt) || Date.now(),
  };
}

export interface PlanStoreOptions {
  /**
   * Called after every mutation AND on `hydrate`, with the current plan (null
   * when there is none). This is the persistence/notification seam — the store
   * stays dependency-free and the caller decides whether that means writing a
   * file, emitting a GUI event, or both.
   */
  onChange?: (plan: Plan | null) => void;
}

export class PlanStore implements PlanStoreLike {
  private plan: Plan | null = null;
  private readonly onChange?: (plan: Plan | null) => void;

  constructor(options: PlanStoreOptions = {}) {
    this.onChange = options.onChange;
  }

  /** The current plan (null when none was created yet). */
  snapshot(): Plan | null {
    return this.plan ? { ...this.plan, steps: this.plan.steps.map((s) => ({ ...s })) } : null;
  }

  /** A GUI-friendly snapshot (same shape, no internals). */
  toGUI(): PlanSnapshot | null {
    const p = this.snapshot();
    return p ? { goal: p.goal, steps: p.steps, revision: p.revision } : null;
  }

  /**
   * Restore a persisted plan. Used once, when a scope is first opened, so a
   * plan created in an earlier session appears again (and is announced through
   * `onChange`, so the GUI redraws its checklist).
   */
  hydrate(plan: Plan | null): void {
    const normalized = plan ? normalizePlan(plan) : null;
    this.plan = normalized;
    this.onChange?.(this.snapshot());
  }

  /**
   * Create (or REPLACE) the plan. Idempotent: re-declaring steps is the
   * model's way to correct course — a fresh declaration supersedes the old.
   */
  create(goal: string, steps: Array<{ id: string; description: string }>): Plan {
    const cleanSteps = (steps ?? []).map((s, i) => ({
      id: String(s?.id ?? `step-${i + 1}`),
      description: String(s?.description ?? '').trim(),
      status: 'pending' as PlanStepStatus,
    })).filter((s) => s.description.length > 0);
    this.plan = {
      goal: String(goal ?? '').trim() || '(untitled plan)',
      steps: cleanSteps,
      revision: (this.plan?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    this.onChange?.(this.snapshot());
    return this.snapshot()!;
  }

  /**
   * Mark one step's status (and optionally record a plain-English note about
   * it). Unknown id → no-op (returns the unchanged plan).
   */
  update(id: string, status: PlanStepStatus, note?: string): Plan | null {
    if (!this.plan) return null;
    if (!VALID_STATUSES.includes(status)) return this.snapshot();
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim() : undefined;
    let changed = false;
    for (const step of this.plan.steps) {
      if (step.id === id) {
        if (step.status !== status) changed = true;
        step.status = status;
        if (cleanNote !== undefined && step.note !== cleanNote) {
          step.note = cleanNote;
          changed = true;
        }
      }
    }
    if (changed) {
      this.plan.revision += 1;
      this.plan.updatedAt = Date.now();
      this.onChange?.(this.snapshot());
    }
    return this.snapshot();
  }

  /** A single, shared progress computation for every renderer. */
  progress(): PlanProgress {
    const steps = this.plan?.steps ?? [];
    const done = steps.filter((s) => s.status === 'done').length;
    const blocked = steps.filter((s) => s.status === 'blocked').length;
    const total = steps.length;
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    return {
      done,
      blocked,
      total,
      percent,
      complete: total > 0 && done === total,
      settled: total > 0 && steps.every((s) => isTerminal(s.status)),
    };
  }

  /** The step being worked right now (the first `running` one), or null. */
  currentStep(): PlanStep | null {
    return this.plan?.steps.find((s) => s.status === 'running') ?? null;
  }

  /**
   * The tabular progress view — the ONE rendering every surface shows.
   *
   * A markdown table, deliberately, because it reads in a terminal, in a
   * transcript, and in the dashboard card without three formatters drifting.
   * Columns: #, Step, Status, and Notes (only when a step has reported one, so
   * an early plan is not padded with empty cells).
   */
  toTable(): string {
    const p = this.plan;
    if (!p) return 'No plan yet — call plan_todo with action "create" and the steps to start one.';
    const prog = this.progress();
    const hasNotes = p.steps.some((s) => s.note);
    const head = hasNotes
      ? '| # | Step | Status | Notes |\n|---|------|--------|-------|'
      : '| # | Step | Status |\n|---|------|--------|';
    const rows = p.steps.map((s, i) => {
      const n = `${i + 1}`;
      const desc = s.description.replace(/\|/g, '\\|');
      const cell = `${statusIcon(s.status)} ${statusWord(s.status)}`;
      if (!hasNotes) return `| ${n} | ${desc} | ${cell} |`;
      const note = (s.note ?? '').replace(/\|/g, '\\|');
      return `| ${n} | ${desc} | ${cell} | ${note} |`;
    });
    return [`🗂️ Plan: ${p.goal} — ${prog.done}/${prog.total} done (${prog.percent}%)`, head, ...rows].join('\n');
  }

  /**
   * The achieved summary — what the plan actually got done. Shown once the plan
   * settles (every step done or blocked), so a multi-session project ends with
   * a list of outcomes instead of a dangling checklist.
   */
  summary(): string {
    const p = this.plan;
    if (!p) return 'No plan to summarise.';
    const prog = this.progress();
    if (prog.complete) {
      return [
        `✅ Plan complete — ${prog.done}/${prog.total} steps achieved (100%)`,
        this.toTable(),
      ].join('\n');
    }
    const outstanding = p.steps.filter((s) => !isTerminal(s.status)).length;
    return [
      `📋 Plan settled — ${prog.done}/${prog.total} achieved, ${outstanding} outstanding, ${prog.blocked} blocked`,
      this.toTable(),
    ].join('\n');
  }

  /** Human-readable text the model sees as the tool result. */
  toText(): string {
    const p = this.plan;
    if (!p) return 'No plan yet — call plan_todo with action "create" and the steps to start one.';
    const table = this.toTable();
    const prog = this.progress();
    // While work is happening, name the step in flight in plain English so a
    // reader who only sees the tool result knows where the plan stands.
    if (!prog.settled) {
      const current = this.currentStep();
      const line = current
        ? `   🔄 Working on step ${p.steps.indexOf(current) + 1}/${prog.total}: ${current.description}`
        : `   ⬜ No step in progress — mark the next one "running" when you start it.`;
      return `${table}\n${line}`;
    }
    return this.summary();
  }
}

/**
 * Shared fallback store — used when a tool runs without an injected store
 * (never throws). The dashboard console injects per-session stores, so this
 * is only the CLI/execute default path.
 */
const sharedStore = new PlanStore();

export function defaultPlanStore(): PlanStoreLike {
  return sharedStore;
}

// ─── Persistence (file-per-scope) ────────────────────────────────────────────

/**
 * Sanitize a scope id (a session id or a project path) into a filename. A hash
 * is appended so two scopes that sanitize to the same readable prefix (two
 * paths differing only in a separator) can never share a plan file.
 */
function scopeSlug(scopeId: string): string {
  const readable = scopeId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const hash = createHash('sha1').update(scopeId).digest('hex').slice(0, 10);
  return `${readable || 'scope'}-${hash}`;
}

/**
 * The plan file for one scope, under the standard memory dir.
 *
 * Resolved LAZILY through the same `NUVIRA_MEMORY_DIR` override every other
 * persisted store honours (`cost-tracker.ts`'s `memoryDir()`), so a hermetic
 * run (test, sandbox, isolated profile) never writes a plan into the real
 * profile — the hazard the test harness documents for the registry mirror.
 */
export function planFilePath(scopeId: string): string {
  const memoryDir = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
  return join(memoryDir, 'plans', `${scopeSlug(scopeId)}.json`);
}

/** Read + validate a persisted plan (best-effort: any failure = no plan). */
export function readPlanFile(path: string): Plan | null {
  try {
    if (!existsSync(path)) return null;
    return normalizePlan(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

/** Write a plan to disk (best-effort: a failed write must never break a turn). */
export function writePlanFile(path: string, plan: Plan | null): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(plan, null, 2));
  } catch {
    /* persistence is a convenience, never a requirement */
  }
}

/**
 * A file-backed store for one scope: hydrates from `path` on construction, and
 * writes back on every change. The convenience wrapper the CLI and dashboard
 * both use instead of re-implementing the wiring.
 */
export function createPersistentPlanStore(scopeId: string): PlanStore {
  const path = planFilePath(scopeId);
  const store = new PlanStore({
    onChange: (plan) => writePlanFile(path, plan),
  });
  const restored = readPlanFile(path);
  if (restored) store.hydrate(restored);
  return store;
}

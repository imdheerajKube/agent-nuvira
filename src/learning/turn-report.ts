/**
 * TURN REPORT (Workstream E) — the plan → track → verify → report contract.
 *
 * The harness already records everything a developer needs to judge whether a
 * turn can be trusted: the plan (`plan_todo` + plan store), what tools ran
 * (tool-loop), and whether the result was actually VERIFIED (the honesty flags
 * `unverifiedEdit` / `unverifiedEditClaim` / `unverifiedBuildClaim` /
 * `undeliveredArtifact` / `noActionTaken`). What was missing is one artifact
 * that assembles them so the trust verdict is visible instead of inferred from
 * four separate places.
 *
 * This module is PURE and DERIVED FROM RECORDED EVIDENCE — never from the
 * model's self-narration. That is the whole point: a report built from the
 * trace cannot be talked into saying "done" about work the run did not verify.
 */

import type { Plan, PlanStepStatus } from '../tools/plan-store.js';

/** The honesty verdict for a turn's outcome. */
export type TurnVerification = 'verified' | 'unverified' | 'blocked' | 'not-applicable';

/** Tools whose success is evidence that a change was OBSERVED. */
const VERIFICATION_TOOLS = new Set(['run_terminal', 'test', 'browser', 'run_cli', 'run_tests']);
/** Tools that MUTATE the workspace. */
const MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'multi_edit']);

/** The run's honesty flags, carried so the report can never hide one. */
export interface TurnReportFlags {
  unverifiedActionClaim?: boolean;
  unverifiedEdit?: boolean;
  unverifiedEditClaim?: boolean;
  unverifiedBuildClaim?: boolean;
  undeliveredArtifact?: boolean;
  unfulfilledPromise?: boolean;
  noActionTaken?: boolean;
}

/** One step, with the evidence that its status is honest. */
export interface TurnReportStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  note?: string;
  /** Why this status can be trusted (e.g. "no observation followed the edit"). */
  evidence?: string;
}

export interface TurnReportStepCounts {
  done: number;
  blocked: number;
  pending: number;
  running: number;
  total: number;
}

export interface TurnReport {
  goal: string;
  /** Did the turn declare a plan at all? */
  planned: boolean;
  steps: TurnReportStep[];
  stepCounts: TurnReportStepCounts;
  toolCalls: string[];
  successfulToolCalls: string[];
  mutations: number;
  changedPaths: string[];
  verification: TurnVerification;
  flags: TurnReportFlags;
  /** One deterministic sentence for the console/trace, or null when trivial. */
  summary: string | null;
}

export interface BuildTurnReportInput {
  goal: string;
  plan?: Plan | null;
  toolCalls?: readonly string[];
  successfulToolCalls?: readonly string[];
  /** Count of workspace mutations observed this turn (from the run trace). */
  mutations?: number;
  /** Distinct files changed this turn (from the run trace). */
  changedPaths?: readonly string[];
  flags?: TurnReportFlags;
}

function hasAnyFlag(flags: TurnReportFlags): boolean {
  return Boolean(
    flags.unverifiedActionClaim ||
      flags.unverifiedEdit ||
      flags.unverifiedEditClaim ||
      flags.unverifiedBuildClaim ||
      flags.undeliveredArtifact ||
      flags.unfulfilledPromise ||
      flags.noActionTaken,
  );
}

/**
 * Build the report from recorded evidence. Never throws; unknown inputs are
 * treated as absent rather than guessed.
 */
export function buildTurnReport(input: BuildTurnReportInput): TurnReport {
  const flags: TurnReportFlags = { ...(input.flags ?? {}) };
  const toolCalls = [...(input.toolCalls ?? [])];
  const successfulToolCalls = [...(input.successfulToolCalls ?? [])];
  const changedPaths = [...new Set(input.changedPaths ?? [])];

  const plan = input.plan ?? null;
  const steps: TurnReportStep[] = plan
    ? plan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        status: s.status,
        ...(s.note ? { note: s.note } : {}),
      }))
    : [];

  const stepCounts: TurnReportStepCounts = {
    done: steps.filter((s) => s.status === 'done').length,
    blocked: steps.filter((s) => s.status === 'blocked').length,
    pending: steps.filter((s) => s.status === 'pending').length,
    running: steps.filter((s) => s.status === 'running').length,
    total: steps.length,
  };

  const mutated = (input.mutations ?? 0) > 0 || successfulToolCalls.some((t) => MUTATION_TOOLS.has(t));
  const observed = successfulToolCalls.some((t) => VERIFICATION_TOOLS.has(t));
  const flagsSet = hasAnyFlag(flags);

  let verification: TurnVerification;
  if (stepCounts.blocked > 0) {
    verification = 'blocked';
  } else if (flagsSet) {
    // A single honesty flag is enough: the run said something its evidence did
    // not support, so the whole turn is UNVERIFIED rather than "mostly fine".
    verification = 'unverified';
  } else if (mutated && !observed) {
    verification = 'unverified';
  } else if (mutated && observed) {
    verification = 'verified';
  } else {
    verification = 'not-applicable';
  }

  // E4 — bind each step's status to the turn's verification evidence. A step
  // marked done while the turn itself is unverified/blocked is annotated, so
  // the report cannot read as a clean checklist over unverified work.
  if (verification === 'unverified' || verification === 'blocked') {
    for (const s of steps) {
      if (s.status === 'done') {
        s.evidence = verification === 'blocked'
          ? 'marked done, but the turn has a blocked step'
          : 'marked done, but the turn is unverified';
      }
    }
  }

  const summary = buildSummary({ planned: Boolean(plan), stepCounts, verification, mutations: input.mutations ?? 0, changedPaths });

  return {
    goal: input.goal,
    planned: Boolean(plan),
    steps,
    stepCounts,
    toolCalls,
    successfulToolCalls,
    mutations: input.mutations ?? 0,
    changedPaths,
    verification,
    flags,
    summary,
  };
}

function buildSummary(input: {
  planned: boolean;
  stepCounts: TurnReportStepCounts;
  verification: TurnVerification;
  mutations: number;
  changedPaths: string[];
}): string | null {
  const parts: string[] = [];
  if (input.planned) {
    parts.push(`${input.stepCounts.done}/${input.stepCounts.total} steps done`);
    if (input.stepCounts.blocked > 0) parts.push(`${input.stepCounts.blocked} blocked`);
  }
  if (input.changedPaths.length > 0) {
    parts.push(`${input.changedPaths.length} file(s) changed`);
  } else if (input.mutations > 0) {
    parts.push(`${input.mutations} change(s)`);
  }
  parts.push(`verification: ${input.verification}`);
  // Nothing informative at all (a plain answer with no plan and no changes).
  if (!input.planned && input.mutations === 0 && input.verification === 'not-applicable') {
    return null;
  }
  return parts.join(' · ');
}

/** A compact, human-readable close-out block for the console / chat surface. */
export function formatTurnReport(report: TurnReport): string {
  const lines: string[] = [];
  const header =
    `📋 Turn report — ${report.goal.slice(0, 100)}` +
    (report.summary ? `\n   ${report.summary}` : '');
  lines.push(header);
  for (const s of report.steps.slice(0, 20)) {
    const icon = s.status === 'done' ? '✅' : s.status === 'running' ? '🔄' : s.status === 'blocked' ? '⛔' : '⬜';
    lines.push(`   ${icon} ${s.description}${s.note ? ` — ${s.note}` : ''}${s.evidence ? ` (${s.evidence})` : ''}`);
  }
  if (report.verification === 'unverified') {
    lines.push('   ⚠️ UNVERIFIED — a change or claim was not confirmed by any observation.');
  } else if (report.verification === 'blocked') {
    lines.push('   ⛔ BLOCKED — at least one step could not complete.');
  }
  return lines.join('\n');
}

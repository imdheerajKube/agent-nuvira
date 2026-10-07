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
  /**
   * Tools that were ATTEMPTED and did not succeed — a refusal, an unknown tool, a
   * failed run. Derived as `toolCalls − successfulToolCalls`, so it costs no extra
   * plumbing and cannot drift from either list.
   */
  failedToolCalls: string[];
  /**
   * ACCURACY EVIDENCE (B2/B3 wiring) — did the turn's own CHECKS pass?
   *
   * `undefined` when NO verification tool ran, and that distinction is the whole
   * reason this is tri-state rather than a boolean: "nobody checked" is not "the
   * check failed". Booking the former as a failure would penalise a turn that was
   * never asked to prove anything, which is the same kind of invented signal this
   * programme exists to remove — a plain question and a failing test suite must not
   * teach the router the same lesson.
   */
  checksPassed?: boolean;
  mutations: number;
  changedPaths: string[];
  verification: TurnVerification;
  flags: TurnReportFlags;
  /**
   * E1 — decisions the run took ON THE USER'S BEHALF because nobody was
   * reachable (an unattended `ask_user` default), one line each. Recorded
   * evidence, never the model's narration: a turn may not read as a decision the
   * user made when the harness made it for them.
   */
  assumptions: string[];
  /**
   * C6 — what the turn COST, from the persisted cost ledger (tokens, USD, calls).
   *
   * The programme's measured run A spent **1,192,115 input tokens in 82 steps** and
   * the turn reported none of it: the only economy figure anywhere was a session
   * total, so a single expensive turn was invisible and the ratio that mattered
   * (484 input tokens per output token) could not be seen at all. A cost you have
   * to go and compute is a cost nobody watches.
   *
   * Read from the LEDGER, not from a counter: a continuation or a resumed turn runs
   * in a fresh process, and only a timestamp window survives that. Absent when no
   * call was recorded at all (a turn that never reached a provider has no cost to
   * report — `0` would read as "it was free").
   */
  cost?: { usd: number; tokens: number; calls: number };
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
  /** E1 — recorded decisions taken on the user's behalf (see TurnReport). */
  assumptions?: readonly string[];
  /** C6 — the turn's measured cost from the ledger (see `TurnReport.cost`). */
  cost?: { usd: number; tokens: number; calls: number };
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
  const assumptions = [...new Set(input.assumptions ?? [])];

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

  // A tool counts as failed when it was attempted and is not in the success list.
  // Multiset-safe: a call that appears once in each (ran twice, failed once) is a
  // failure, because something the run tried DID fail.
  const attemptedCounts = new Map<string, number>();
  for (const name of toolCalls) attemptedCounts.set(name, (attemptedCounts.get(name) ?? 0) + 1);
  for (const name of successfulToolCalls) {
    attemptedCounts.set(name, (attemptedCounts.get(name) ?? 0) - 1);
  }
  const failedToolCalls: string[] = [];
  for (const [name, remaining] of attemptedCounts) {
    if (remaining > 0) failedToolCalls.push(name);
  }

  // Only CHECKS decide this, and only when at least one ran (see `checksPassed`).
  const checksRan = observed || failedToolCalls.some((t) => VERIFICATION_TOOLS.has(t));
  const checksBroke = failedToolCalls.some((t) => VERIFICATION_TOOLS.has(t));
  const checksPassed = checksRan ? observed && !checksBroke : undefined;

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

  const summary = buildSummary({
    planned: Boolean(plan),
    stepCounts,
    verification,
    mutations: input.mutations ?? 0,
    changedPaths,
    assumptions,
    cost: input.cost,
  });

  return {
    goal: input.goal,
    planned: Boolean(plan),
    steps,
    stepCounts,
    toolCalls,
    successfulToolCalls,
    failedToolCalls,
    ...(checksPassed === undefined ? {} : { checksPassed }),
    mutations: input.mutations ?? 0,
    changedPaths,
    verification,
    flags,
    assumptions,
    // C6 — carried only when the ledger had something to report (absence is not
    // "free", it is "nothing recorded": see the field's doc).
    ...(input.cost ? { cost: input.cost } : {}),
    summary,
  };
}

function buildSummary(input: {
  planned: boolean;
  stepCounts: TurnReportStepCounts;
  verification: TurnVerification;
  mutations: number;
  changedPaths: string[];
  assumptions: string[];
  cost?: { usd: number; tokens: number; calls: number };
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
  // E1 — an assumption is always worth saying: it is a decision the USER did not
  // make, and it must not be silent even on a turn that changed nothing.
  if (input.assumptions.length > 0) {
    parts.push(`${input.assumptions.length} decision(s) made for you`);
  }
  parts.push(`verification: ${input.verification}`);
  // Nothing informative at all (a plain answer with no plan and no changes).
  if (
    !input.planned &&
    input.mutations === 0 &&
    input.verification === 'not-applicable' &&
    input.assumptions.length === 0
  ) {
    // C6 — except when the turn actually SPENT something. The cost is the one
    // thing a trivial-looking turn can still be wrong about (a long prompt on an
    // expensive model), and it is exactly the number run A had no way to see.
    return input.cost && input.cost.usd >= COST_NOTICE_USD ? formatCost(input.cost) : null;
  }
  if (input.cost) parts.push(formatCost(input.cost));
  return parts.join(' · ');
}

/**
 * C6 — the spend at which a turn's cost is worth saying out loud on its own.
 *
 * A cent: below it, a chat answer's cost is noise; at or above it, the turn bought
 * something real and the user should see the price without asking. Stated here
 * rather than inline so the threshold is a decision, not a magic number.
 */
export const COST_NOTICE_USD = 0.01;

/** `$0.0042 / 12.3K tok (3 calls)` — the turn's measured spend, one line. */
export function formatCost(cost: { usd: number; tokens: number; calls: number }): string {
  const usd = cost.usd >= 0.01 ? `$${cost.usd.toFixed(4)}` : `$${cost.usd.toFixed(6)}`;
  // Millions are the scale that matters here: the measured run A burned 1,192,115
  // input tokens, and `1192.1K` reads as noise where `1.19M` reads as a number.
  const tokens =
    cost.tokens >= 1_000_000
      ? `${(cost.tokens / 1_000_000).toFixed(2)}M tok`
      : cost.tokens >= 1000
        ? `${(cost.tokens / 1000).toFixed(1)}K tok`
        : `${cost.tokens} tok`;
  return `cost: ${usd} / ${tokens} (${cost.calls} call${cost.calls === 1 ? '' : 's'})`;
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
  // E1 — disclose every decision taken on the user's behalf, from the recorded
  // assumptions. Printed even when the report has no summary parts of its own.
  if (report.assumptions.length > 0) {
    lines.push('   🤝 decided for you — nobody was reachable to answer:');
    for (const a of report.assumptions.slice(0, 10)) lines.push(`      • ${a}`);
    if (report.assumptions.length > 10) lines.push(`      • …and ${report.assumptions.length - 10} more`);
  }
  // C6 — the price of the turn, from the ledger. Printed after the work, because
  // "what it did" and "what it cost" are the two things a user judges a turn on.
  if (report.cost) lines.push(`   💰 ${formatCost(report.cost)}`);
  if (report.verification === 'unverified') {
    lines.push('   ⚠️ UNVERIFIED — a change or claim was not confirmed by any observation.');
  } else if (report.verification === 'blocked') {
    lines.push('   ⛔ BLOCKED — at least one step could not complete.');
  }
  return lines.join('\n');
}

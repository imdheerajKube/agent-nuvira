/**
 * Change Policy — the deterministic authority over what may happen.
 *
 * The Steward proposes; this module disposes. Every rule here is a pure function
 * of state, so a misclassification cannot become an unauthorized scope change and
 * an injected message cannot talk its way past a gate.
 *
 * ESCALATION IS ONE-WAY. The model's `requiresApproval` flag can only raise the
 * bar. Deterministic facts — high impact, conflict, superseding an approved
 * requirement, irreversible work, removing completed work — always require a human.
 *
 * The exact rule order matters and is pinned by tests/steering/policy.test.ts.
 */

import { DEFAULT_STEERING_POLICY } from './types.js';
import { prefilterGuidance } from './prefilter.js';
import type {
  ChangeAssessment,
  ChangeRequestRecord,
  Disposition,
  PlanOp,
  RunRecord,
  SteeringDecision,
  SteeringPlan,
  SteeringPolicy,
} from './types.js';

export interface DecideInput {
  change: ChangeRequestRecord;
  assessment: ChangeAssessment;
  run: RunRecord;
  plan: SteeringPlan | null;
  /** Open (unapplied, non-terminal) changes in this run, including this one. */
  openChanges?: number;
  /** Changes already applied in this run. */
  appliedChanges?: number;
  policy?: Partial<SteeringPolicy>;
}

/**
 * Human labels for the deterministic escalation codes. The UI and CLI render
 * these instead of the raw code, so "why do I have to approve this?" has an
 * answer that names the actual rule (P2.3).
 */
export const ESCALATION_LABELS: Record<string, string> = {
  high_impact: 'high impact — it can change material work',
  conflict: 'conflicts with an existing requirement',
  supersedes_approved_requirement: 'supersedes an approved requirement',
  irreversible: 'not automatically reversible',
  removes_completed_work: 'touches work that is already complete',
  steward_requested: 'the assessor flagged it as material',
  policy_override_attempt: 'attempts to change the run’s safety policy',
};

export function escalationLabel(code: string): string {
  return ESCALATION_LABELS[code] ?? code.replace(/_/g, ' ');
}

export function describeEscalations(codes: string[]): string[] {
  return codes.map(escalationLabel);
}

/**
 * Say what an approval will do, in the terms the user is deciding about. This is
 * attached to the decision when policy escalates, so approval never looks like a
 * generic "allow?" prompt (P2.3).
 */
export function approvalEffectFor(assessment: ChangeAssessment): string {
  const ops = assessment.proposedOps;
  const count = (kind: PlanOp['op']): number => ops.filter((op) => op.op === kind).length;
  const parts: string[] = [];
  if (count('add_step')) parts.push(`add ${count('add_step')} step(s)`);
  if (count('update_step')) parts.push(`update ${count('update_step')} step(s)`);
  if (count('remove_step')) parts.push(`remove ${count('remove_step')} step(s) from future work`);
  if (count('cancel_pending_after')) parts.push('cancel pending steps after the named one');
  if (count('add_constraint')) parts.push(`record ${count('add_constraint')} new constraint(s)`);
  if (count('set_priority')) parts.push('change step priority');
  if (count('reorder')) parts.push('reorder future steps');
  const summary = parts.length ? parts.join(', ') : 'apply the proposed plan change';
  const safeguards: string[] = [];
  if (assessment.impact === 'high') safeguards.push('a workspace checkpoint is taken first');
  if (ops.some((op) => op.op === 'remove_step' || op.op === 'cancel_pending_after')) {
    safeguards.push('completed work is never rewritten');
  }
  return `Approving at the next safe point will ${summary}${
    safeguards.length ? ` (${safeguards.join('; ')})` : ''
  }. It becomes a new immutable plan version with its diff, and the executor receives only that bounded directive.`;
}

function isControl(assessment: ChangeAssessment): boolean {
  return assessment.relation === 'control' || assessment.kind === 'stop' || assessment.kind === 'pause';
}

/** Does any proposed op remove or invalidate a step that is already done? */
export function removesCompletedWork(plan: SteeringPlan | null, ops: PlanOp[]): boolean {
  if (!plan || ops.length === 0) return false;
  const done = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
  if (done.size === 0) return false;
  for (const op of ops) {
    if (op.op === 'remove_step' && done.has(op.stepId)) return true;
    if (op.op === 'update_step' && done.has(op.stepId)) {
      const patch = op.patch;
      // Rewriting a completed step's meaning invalidates the work behind it.
      if (patch.description !== undefined) return true;
      if (patch.status !== undefined && patch.status !== 'done') return true;
    }
    if (op.op === 'cancel_pending_after') {
      const index = plan.steps.findIndex((s) => s.id === op.stepId);
      if (index >= 0 && plan.steps.slice(index + 1).some((s) => s.status === 'done')) return true;
    }
  }
  return false;
}

/** Does this change replace/remove something that already exists? */
export function isIrreversible(plan: SteeringPlan | null, assessment: ChangeAssessment): boolean {
  if (assessment.kind === 'remove') return true;
  if (assessment.impact === 'high' && assessment.kind === 'modify') return true;
  const ops = assessment.proposedOps;
  if (ops.some((op) => op.op === 'remove_step')) return true;
  if (ops.some((op) => op.op === 'cancel_pending_after')) return true;
  if (plan && ops.some((op) => op.op === 'update_step' && plan.steps.some((s) => s.id === op.stepId && s.status === 'done'))) {
    return true;
  }
  return false;
}

/**
 * Pure additions cannot invalidate anything: no step is removed, rewritten or
 * cancelled, and no completed work is touched. A user who submits an additive
 * request in the active objective is the author of that change, so the Steward's
 * ADVISORY `requiresApproval` must not override them (measured 2026-11-09: the
 * Steward flagged "add one deliverable" for approval, so a benchmark scope
 * change that Freebuff/Claude applied became a dead `needs_approval` item).
 *
 * This does NOT weaken a real gate: high impact, conflicts, supersession,
 * irreversibility and completed-work edits still escalate below, and a
 * destructive op is never purely additive.
 */
export function isPurelyAdditive(assessment: ChangeAssessment): boolean {
  return (
    assessment.relation === 'on_task' &&
    assessment.proposedOps.length > 0 &&
    assessment.proposedOps.every((op) => op.op === 'add_step' || op.op === 'add_constraint')
  );
}

/**
 * A guardrail is a NARROWING. "Do not touch payments" can only remove future
 * freedom, never add work, so it is safe to accept even though it is high impact.
 * A change that adds both a constraint and new steps is NOT constraint-only.
 */
function isConstraintOnly(assessment: ChangeAssessment): boolean {
  if (assessment.kind !== 'constraint') return false;
  const ops = assessment.proposedOps;
  return ops.length > 0 && ops.every((op) => op.op === 'add_constraint');
}

function withinBudget(
  input: DecideInput,
  policy: SteeringPolicy,
): { ok: boolean; reason?: string } {
  if ((input.openChanges ?? 0) > policy.maxOpenChanges) {
    return { ok: false, reason: `too many open guidance items (${input.openChanges}/${policy.maxOpenChanges})` };
  }
  if ((input.appliedChanges ?? 0) >= policy.maxAppliedChanges) {
    return { ok: false, reason: `this run has reached its change budget (${policy.maxAppliedChanges} applied)` };
  }
  return { ok: true };
}

/** The decision matrix. Pure, deterministic, and exhaustively tested. */
export function decide(input: DecideInput): SteeringDecision {
  const policy: SteeringPolicy = { ...DEFAULT_STEERING_POLICY, ...(input.policy ?? {}) };
  const { assessment, change, plan } = input;

  // 1. A message that tries to change policy or extract a secret is refused before
  //    any semantic rule can excuse it. This is the injection floor.
  const injection = prefilterGuidance(change.rawText);
  if (injection.malicious) {
    return {
      action: 'reject',
      reason:
        'Guidance cannot change the run’s approval policy, safety rules, or system prompt, and cannot extract secrets. No plan change was made.',
      escalations: ['policy_override_attempt'],
    };
  }

  // 2. Explicit controls are immediate and do not need approval.
  if (assessment.kind === 'stop') {
    return {
      action: 'stop',
      reason: 'Stop requested by the user. No further plan work will be admitted.',
      at: 'immediate',
    };
  }
  if (assessment.kind === 'pause') {
    return {
      action: 'pause',
      reason: 'Pause requested by the user. The run will stop at the next safe point.',
      at: 'next_safe_point',
    };
  }

  // 3. Separate work never enters the active run.
  if (assessment.relation === 'new_task') {
    return {
      action: 'backlog',
      reason: 'This is separate work, so it goes to the run backlog rather than the active objective. The current run is unchanged.',
    };
  }

  // 4. A question or a purely meta message is answered, never planned.
  if (assessment.relation === 'meta' || assessment.kind === 'question') {
    return {
      action: 'answer_only',
      reason: assessment.rationale || 'This asks about the run rather than changing it.',
    };
  }

  // 5. Low confidence asks the user to confirm the interpretation. This happens
  //    before impact escalation so an ambiguous high-impact guess cannot act.
  if (!isControl(assessment) && assessment.confidence < policy.minConfidence) {
    return {
      action: 'confirm_interpretation',
      reason: `The intent is ambiguous (confidence ${assessment.confidence.toFixed(2)}). Confirm how this should be treated before it changes the plan.`,
      options: [
        'Treat it as a change to the current task',
        'Treat it as a separate new task',
        'It was only a question — answer it',
      ],
    };
  }

  // 6. A guardrail narrows future freedom; it cannot add work. Accept it as a
  //    contract amendment without approval (the user is the authority here).
  if (isConstraintOnly(assessment)) {
    return {
      action: 'accept',
      reason: `Accepted as a guardrail: ${assessment.rationale || 'future work will respect this constraint.'}`,
      at: 'next_safe_point',
    };
  }

  // 7. Deterministic escalation. None of these can be waived by the model.
  const escalations: string[] = [];
  if (assessment.impact === 'high') escalations.push('high_impact');
  if (assessment.conflictsWith.length > 0 || assessment.conflict === 'contradicts') {
    escalations.push('conflict');
  }
  if (assessment.supersedes.length > 0 || assessment.conflict === 'supersedes') {
    escalations.push('supersedes_approved_requirement');
  }
  if (isIrreversible(plan, assessment)) escalations.push('irreversible');
  if (removesCompletedWork(plan, assessment.proposedOps)) escalations.push('removes_completed_work');
  // Advisory only: a purely additive on-task change is authorized by the user
  // who submitted it. Destructive/replacing work is not purely additive.
  if (assessment.requiresApproval && !isPurelyAdditive(assessment)) {
    escalations.push('steward_requested');
  }

  if (escalations.length > 0) {
    return {
      action: 'needs_approval',
      reason: `Needs your approval: ${assessment.rationale || 'this is a material change to the run.'}`,
      at: 'next_safe_point',
      escalations,
      approvalEffect: approvalEffectFor(assessment),
    };
  }

  // 8. Timing decisions, separate from kind.
  if (assessment.timing === 'next_phase') {
    return {
      action: 'defer',
      reason: 'Queued for the next phase boundary so the current phase can finish coherently.',
      until: 'phase_boundary',
    };
  }
  if (assessment.timing === 'after_run') {
    return {
      action: 'backlog',
      reason: 'This belongs after the current run, so it was captured in the backlog instead of changing the active plan.',
      until: 'after_run',
    };
  }

  // 9. Bounded acceptance: only additive work inside the contract, at safe points,
  //    within the run's change budget.
  const budget = withinBudget(input, policy);
  if (!budget.ok) {
    return {
      action: 'defer',
      reason: `Deferred: ${budget.reason}. Apply or withdraw existing guidance before adding more.`,
      until: 'phase_boundary',
    };
  }

  if (
    assessment.relation === 'on_task' &&
    (assessment.impact === 'low' || assessment.impact === 'medium') &&
    policy.autoAcceptLowMedium &&
    assessment.proposedOps.length > 0
  ) {
    return {
      action: 'accept',
      reason: assessment.rationale || 'Accepted as additive work inside the active objective.',
      at: 'next_safe_point',
    };
  }

  // An observation with no operations is an assessment, not a plan change.
  if (assessment.proposedOps.length === 0) {
    return {
      action: 'answer_only',
      reason:
        assessment.rationale ||
        'Recorded as feedback; no concrete plan change was proposed. Add a specific instruction to change the plan.',
    };
  }

  return {
    action: 'needs_review',
    reason:
      assessment.rationale ||
      'This could not be classified confidently enough to apply automatically. It is queued for review and the run is unchanged.',
  };
}

/** Map a disposition onto the durable status it produces. */
export function statusForDecision(action: Disposition): ChangeRequestRecord['status'] {
  switch (action) {
    case 'accept':
      return 'accepted';
    case 'needs_approval':
      return 'needs_approval';
    case 'answer_only':
      return 'answer_only';
    case 'backlog':
      return 'backlog';
    case 'defer':
      return 'deferred';
    case 'reject':
      return 'rejected';
    case 'stop':
    case 'pause':
    case 'confirm_interpretation':
    case 'needs_review':
      return 'triaged';
    default:
      return 'triaged';
  }
}

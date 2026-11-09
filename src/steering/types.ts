/**
 * Mid-run steering — the data contracts of the control plane.
 *
 * WHY THIS MODULE IS SEPARATE FROM THE ENGINE. A long autonomous run cannot take a
 * second user message: the composer is locked while a turn is in flight, and
 * injecting raw text into the live thread is a prompt-injection path with no
 * audit trail. Steering therefore models a change REQUEST, an ASSESSMENT of what
 * it means, a deterministic DECISION about what may happen, and an immutable PLAN
 * VERSION produced when it is applied. The executor only ever receives a bounded
 * directive derived from an applied version — never the raw input.
 *
 * The dimensions are deliberately orthogonal (relation / kind / timing / impact /
 * conflict / authority / disposition). The earlier Category A–E proposal folded
 * them into one list, which made "deferred" and "conflict" hide the thing that
 * actually happened. See docs/ADR-steering-control-plane.md.
 */

/** Which engine owns the plan a change applies to. */
export type SteeringEngine = 'loop' | 'pipeline';

/** Which surface the guidance arrived from. */
export type ChangeSource = 'dashboard' | 'cli' | 'gateway';

/** An explicit user tag that can bypass semantic triage (Phase 1 contract). */
export type ChangeIntentHint = 'guidance' | 'question' | 'new_task';

/**
 * The lifecycle of one guidance item. Every state is durable and visible: the
 * product risk is not a wrong classification, it is a user who cannot tell
 * whether their input was understood, applied, deferred or ignored.
 */
export type ChangeStatus =
  | 'received'
  | 'triaging'
  | 'triaged'
  | 'needs_approval'
  | 'accepted'
  | 'scheduled'
  | 'applied'
  | 'deferred'
  | 'answer_only'
  | 'backlog'
  | 'rejected'
  | 'stale'
  | 'failed'
  | 'withdrawn';

/** How the guidance relates to the active objective. */
export type ChangeRelation = 'on_task' | 'adjacent' | 'new_task' | 'meta' | 'control';

/** What kind of change the user is asking for. */
export type ChangeKind =
  | 'add'
  | 'modify'
  | 'remove'
  | 'constraint'
  | 'priority'
  | 'clarification'
  | 'correction'
  | 'quality_feedback'
  | 'observation'
  | 'question'
  | 'pause'
  | 'stop';

/** When the change may take effect. "now" is reserved for control. */
export type ChangeTiming = 'now' | 'next_safe_point' | 'next_phase' | 'after_run';

/** How much of the run the change can affect. */
export type ChangeImpact = 'low' | 'medium' | 'high';

/** The relationship between this change and existing requirements/steps. */
export type ChangeConflict = 'none' | 'supersedes' | 'contradicts' | 'duplicates';

/** Who may apply it. Policy may always escalate upward, never downward. */
export type ChangeAuthority = 'auto_accept' | 'needs_approval' | 'human_only';

/** The deterministic outcome the policy engine chose. */
export type Disposition =
  | 'accept'
  | 'defer'
  | 'answer_only'
  | 'needs_approval'
  | 'backlog'
  | 'reject'
  | 'pause'
  | 'stop'
  | 'confirm_interpretation'
  | 'needs_review';

/** One typed plan mutation. The only way a plan version changes. */
export type PlanOp =
  | {
      op: 'add_step';
      after?: string;
      step: {
        id?: string;
        description: string;
        dependsOn?: string[];
        acceptanceCriteria?: string[];
        priority?: StepPriority;
        agentType?: string;
      };
    }
  | {
      op: 'update_step';
      stepId: string;
      patch: {
        description?: string;
        dependsOn?: string[];
        acceptanceCriteria?: string[];
        priority?: StepPriority;
        status?: SteeringStepStatus;
        note?: string;
      };
    }
  | { op: 'remove_step'; stepId: string }
  | { op: 'reorder'; stepIds: string[] }
  | { op: 'add_constraint'; constraint: string }
  | { op: 'cancel_pending_after'; stepId: string }
  | { op: 'set_priority'; stepIds: string[]; priority: StepPriority };

export type StepPriority = 'low' | 'normal' | 'high';

export type SteeringStepStatus = 'pending' | 'running' | 'done' | 'blocked' | 'cancelled';

/** One executable step in a steering plan version. */
export interface SteeringPlanStep {
  id: string;
  description: string;
  status: SteeringStepStatus;
  dependsOn: string[];
  acceptanceCriteria: string[];
  priority: StepPriority;
  /** Pipeline parity: the original agent type, preserved across versions. */
  agentType?: string;
  note?: string;
}

/** The structured, validated output of the Change Steward (never authoritative). */
export interface ChangeAssessment {
  relation: ChangeRelation;
  kind: ChangeKind;
  timing: ChangeTiming;
  impact: ChangeImpact;
  confidence: number;
  affectedStepIds: string[];
  conflictsWith: string[];
  supersedes: string[];
  requiresApproval: boolean;
  rationale: string;
  proposedOps: PlanOp[];
  conflict: ChangeConflict;
  newTask?: { title: string; description: string; reason: string };
}

/** The policy engine's decision. */
export interface SteeringDecision {
  action: Disposition;
  /** Plain-English reason shown to the user, including for rejections. */
  reason: string;
  /** Set for `defer`. */
  until?: 'phase_boundary' | 'after_run';
  /** Set for `confirm_interpretation`: the interpretations the user may pick. */
  options?: string[];
  /** Deterministic escalation reasons (high impact, conflict, completed work). */
  escalations?: string[];
  /** Plain-English statement of what approving this change will actually do. */
  approvalEffect?: string;
  at?: 'next_safe_point' | 'immediate';
}

/** A guidance item as it is durably recorded. */
export interface ChangeRequestRecord {
  id: string;
  runId: string;
  sessionId?: string;
  source: ChangeSource;
  author: string;
  rawText: string;
  intentHint?: ChangeIntentHint;
  targetStepId?: string;
  submittedAt: string;
  planVersionAtSubmit: number;
  idempotencyKey: string;
  contentHash: string;
  status: ChangeStatus;
  assessment?: ChangeAssessment;
  decision?: SteeringDecision;
  /** The plan version this change produced (or last targeted). */
  planVersion?: number;
  planDiff?: PlanDiff;
  appliedAt?: string;
  /**
   * The EXACT bounded directive the executor received for this change. Derived
   * from the applied plan version, never from raw guidance, and stored so the
   * user can audit what the model was actually told (P2.1 steer-with-proof).
   */
  directive?: string;
  failure?: string;
  /** True when an identical submission inside the dedupe window was collapsed. */
  deduped?: boolean;
  /** Set while the Steward is running; used to recover an interrupted triage. */
  triagingAt?: string;
  triagedAt?: string;
  triageLatencyMs?: number;
  /** Pre-change workspace checkpoint, taken before a high-impact apply. */
  workspaceCheckpointId?: string;
}

/** Before/after of one immutable plan version. */
export interface PlanDiff {
  added: string[];
  updated: string[];
  removed: string[];
  cancelled: string[];
  constraintsAdded: string[];
  reordered: boolean;
}

/** An immutable plan version. The run process is the only writer. */
export interface SteeringPlan {
  runId: string;
  version: number;
  parentVersion: number;
  contractVersion: number;
  goal: string;
  steps: SteeringPlanStep[];
  constraints: string[];
  createdAt: string;
  createdBy: string;
  reason: string;
  changeIds: string[];
  diff: PlanDiff;
}

/** The immutable original task contract, plus append-only amendments. */
export interface TaskContract {
  runId: string;
  goal: string;
  cwd: string;
  createdAt: string;
  deliverables: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  amendments: Array<{
    at: string;
    changeId: string;
    kind: ChangeKind;
    text: string;
  }>;
}

/** Durable run journal event. Append-only, sequence-numbered. */
export interface JournalEvent {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: string;
  actor: 'user' | 'system' | 'model' | 'policy';
  correlationId?: string;
  causationId?: string;
  planVersion?: number;
  changeId?: string;
  data?: Record<string, unknown>;
}

/** The durable run manifest. One writer per run, guarded by a lease. */
export interface RunRecord {
  runId: string;
  goal: string;
  cwd: string;
  engine: SteeringEngine;
  surface: ChangeSource;
  sessionId?: string;
  status: 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  planVersion: number;
  contractVersion: number;
  stopRequested: boolean;
  pauseRequested: boolean;
  /** Last journal sequence written, so a reader does not rescan the file. */
  sequence: number;
  lease?: { pid: number; hostname: string; acquiredAt: string; expiresAt: string };
}

/** A user-initiated approval request (distinct from an agent `ask_user`). */
export interface ApprovalRecord {
  changeId: string;
  runId: string;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: string;
  decidedAt?: string;
  actor?: string;
  note?: string;
}

/** A new-task idea kept out of the active run. */
export interface BacklogItem {
  id: string;
  runId: string;
  changeId: string;
  text: string;
  title: string;
  description: string;
  reason: string;
  priority: StepPriority;
  status: 'open' | 'scheduled' | 'dismissed';
  createdAt: string;
}

/** Policy thresholds. All of them may be overridden by the run owner. */
export interface SteeringPolicy {
  /** Below this, the user is asked to confirm the interpretation. */
  minConfidence: number;
  /** Bounded open work: a run cannot be steered forever. */
  maxOpenChanges: number;
  /** Bounded applied work per run. */
  maxAppliedChanges: number;
  /** Low/medium additive work inside the contract may apply without approval. */
  autoAcceptLowMedium: boolean;
  /** Approval requests expire after this long. */
  approvalTtlMs: number;
  /** Content-dedupe window for a resubmitted message. */
  dedupeWindowMs: number;
  /** Maximum changes coalesced into one plan version. */
  maxChangesPerPlan: number;
}

export const DEFAULT_STEERING_POLICY: SteeringPolicy = {
  minConfidence: 0.55,
  maxOpenChanges: 20,
  maxAppliedChanges: 40,
  autoAcceptLowMedium: true,
  approvalTtlMs: 24 * 60 * 60 * 1000,
  dedupeWindowMs: 60_000,
  maxChangesPerPlan: 5,
};

/**
 * The run as a surface sees it: the durable manifest plus derived freshness.
 *
 * `stale` is never written to run.json — it is a fact about the lease at read
 * time (see `runStaleness`), so it lives only in the read model.
 */
export type SteeringRunView = RunRecord & { stale?: boolean; staleSince?: string };

/** The read model every surface renders. */
export interface SteeringProjection {
  enabled: boolean;
  run: SteeringRunView | null;
  plan: SteeringPlan | null;
  contract: TaskContract | null;
  changes: ChangeRequestRecord[];
  approvals: ApprovalRecord[];
  backlog: BacklogItem[];
  recentEvents: JournalEvent[];
  counts: {
    received: number;
    triaged: number;
    needsApproval: number;
    accepted: number;
    applied: number;
    deferred: number;
    answerOnly: number;
    backlog: number;
    rejected: number;
    stale: number;
    failed: number;
    withdrawn: number;
    open: number;
  };
  metrics: SteeringMetrics;
}

/** Operational counters, derived rather than separately maintained where possible. */
export interface SteeringMetrics {
  guidanceReceived: number;
  applied: number;
  rejected: number;
  deferred: number;
  backlogged: number;
  needsApproval: number;
  planVersions: number;
  avgTriageLatencyMs: number;
  p95TriageLatencyMs: number;
  /** Submission → apply latency, from durable timestamps. */
  avgTimeToApplyMs: number;
  /** Fraction of all guidance that went stale because the plan moved first. */
  staleRate: number;
  /** Approval decision latency, from request to decision. */
  avgApprovalLatencyMs: number;
  /** Approvals that expired without a user decision. */
  abandonedApprovals: number;
  /** Assessments below the policy confidence threshold. */
  lowConfidenceCount: number;
  /** Plan versions created per applied change (excluding the baseline v1). */
  replansPerAppliedChange: number;
  /** The metric that matters most: high-impact work that applied without approval. */
  highImpactFalseAccepts: number;
  lastTriageAt?: string;
}

/** The result the executor receives after a safe point. */
export interface SteeringTickResult {
  stop: boolean;
  pause: boolean;
  /** A bounded `[Steering]` directive, or null when nothing was applied. */
  directive: string | null;
  /** Stable dedupe key for the directive. */
  key?: string;
  appliedChangeIds: string[];
  /** Changes that changed state this tick (for the surface to re-read). */
  changedIds: string[];
}

/** A typed reply to a discuss-mode question. Never mutates the plan. */
export interface DiscussAnswer {
  answer: string;
  context: string;
  promotedPrompt?: string;
  /** Whether a model produced the answer or the durable record did. */
  source: 'model' | 'deterministic';
}

/** The engine-neutral plan contract. Policy and UI never know the engine. */
export interface SteeringPlanAdapter {
  readonly engine: SteeringEngine;
  getVersion(): number;
  getGoal(): string;
  getSteps(): SteeringPlanStep[];
  /** Apply a committed steering version into the engine's own plan. */
  applyPlanVersion(plan: SteeringPlan): void | Promise<void>;
  /** The bounded directive the executor reads. */
  projectForExecutor(plan: SteeringPlan, changes: ChangeRequestRecord[]): string;
}

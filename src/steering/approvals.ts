/**
 * User-initiated approvals — distinct from an agent's `ask_user`.
 *
 * `ask_user` means the AGENT is blocked and needs an answer. A steering approval
 * means the RUN may continue on unaffected work while the user decides whether a
 * material change is allowed. Keeping them separate is why an approval card never
 * looks like a question the agent asked itself.
 *
 * Approval is also the only path that can authorize a high-impact change. The
 * executor never approves its own scope change, and the Steward never approves
 * anything: only this module, called by a user surface, can move a change from
 * `needs_approval` to `accepted`.
 */

import {
  appendJournal,
  approvalPath,
  readApproval,
  readRun,
  writeJson,
} from './store.js';
import { getGuidance, setStatus, withdrawGuidance } from './inbox.js';
import type { ApprovalRecord, ChangeRequestRecord } from './types.js';

export function requestApproval(
  runId: string,
  changeId: string,
  now = Date.now(),
): ApprovalRecord | null {
  const change = getGuidance(runId, changeId);
  if (!change) return null;
  const existing = readApproval(runId, changeId);
  if (existing && existing.state === 'pending') return existing;
  const record: ApprovalRecord = {
    changeId,
    runId,
    state: 'pending',
    requestedAt: new Date(now).toISOString(),
  };
  if (!writeJson(approvalPath(runId, changeId), record)) return null;
  appendJournal(runId, {
    type: 'change.needs_approval',
    actor: 'policy',
    changeId,
    data: {
      reason: change.decision?.reason ?? 'material change',
      escalations: change.decision?.escalations ?? [],
    },
  });
  return record;
}

export type ApprovalAction = 'approve' | 'reject' | 'defer' | 'withdraw' | 'expire';

export interface ApprovalResult {
  ok: boolean;
  error?: string;
  change?: ChangeRequestRecord;
  approval?: ApprovalRecord;
}

/**
 * Decide one approval. Every outcome is journaled and visible, including a
 * rejection: "no silent rejection" is the trust rule the whole channel rests on.
 */
export function decideApproval(input: {
  runId: string;
  changeId: string;
  action: ApprovalAction;
  actor?: string;
  note?: string;
  now?: number;
}): ApprovalResult {
  const now = input.now ?? Date.now();
  const change = getGuidance(input.runId, input.changeId);
  if (!change) return { ok: false, error: `No guidance item ${input.changeId} in this run.` };
  if (change.status === 'applied') {
    return { ok: false, error: 'This change was already applied. Submit new guidance to revise it.' };
  }
  if (change.status === 'withdrawn') {
    return { ok: false, error: 'This change was withdrawn.' };
  }

  if (input.action === 'withdraw') {
    const next = withdrawGuidance(input.runId, input.changeId);
    return next ? { ok: true, change: next } : { ok: false, error: 'Could not withdraw the change.' };
  }

  const previous = readApproval(input.runId, input.changeId);
  const state: ApprovalRecord['state'] =
    input.action === 'approve' ? 'approved' : input.action === 'expire' ? 'expired' : 'rejected';
  const approval: ApprovalRecord = {
    changeId: input.changeId,
    runId: input.runId,
    state,
    requestedAt: previous?.requestedAt ?? new Date(now).toISOString(),
    decidedAt: new Date(now).toISOString(),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  if (!writeJson(approvalPath(input.runId, input.changeId), approval)) {
    return { ok: false, error: 'Could not persist the approval decision.' };
  }

  if (input.action === 'approve') {
    const next = setStatus(input.runId, input.changeId, 'accepted', {
      decision: {
        action: 'accept',
        reason: 'Approved by the user. It will apply at the next safe point.',
        at: 'next_safe_point',
      },
    });
    appendJournal(input.runId, {
      type: 'change.approved',
      actor: 'user',
      changeId: input.changeId,
      data: { actor: input.actor ?? 'user' },
    });
    return next ? { ok: true, change: next, approval } : { ok: false, error: 'Could not accept the change.' };
  }

  if (input.action === 'defer') {
    const next = setStatus(input.runId, input.changeId, 'deferred', {
      decision: {
        action: 'defer',
        reason: input.note?.trim() || 'Deferred by the user. It remains visible and can be approved later.',
        until: 'phase_boundary',
      },
    });
    return next ? { ok: true, change: next, approval } : { ok: false, error: 'Could not defer the change.' };
  }

  const reason =
    input.action === 'expire'
      ? 'The approval request expired without a decision. The run is unchanged.'
      : input.note?.trim() || 'Rejected by the user. The run is unchanged.';
  const next = setStatus(input.runId, input.changeId, input.action === 'expire' ? 'deferred' : 'rejected', {
    decision: {
      action: input.action === 'expire' ? 'defer' : 'reject',
      reason,
      ...(input.action === 'expire' ? { until: 'phase_boundary' as const } : {}),
    },
  });
  appendJournal(input.runId, {
    type: input.action === 'expire' ? 'change.expired' : 'change.rejected',
    actor: input.action === 'expire' ? 'system' : 'user',
    changeId: input.changeId,
    data: { reason, actor: input.actor ?? 'user' },
  });
  return next ? { ok: true, change: next, approval } : { ok: false, error: 'Could not reject the change.' };
}

/** Expire pending approvals older than the policy TTL. */
export function expireApprovals(
  runId: string,
  approvals: ApprovalRecord[],
  ttlMs: number,
  now = Date.now(),
): ApprovalRecord[] {
  const expired: ApprovalRecord[] = [];
  for (const approval of approvals) {
    if (approval.state !== 'pending') continue;
    const requested = Date.parse(approval.requestedAt);
    if (!Number.isFinite(requested) || now - requested < ttlMs) continue;
    const result = decideApproval({
      runId,
      changeId: approval.changeId,
      action: 'expire',
      actor: 'system',
      now,
    });
    if (result.ok && result.approval) expired.push(result.approval);
  }
  return expired;
}

/** True when the run's goal exists but its manifest was deleted. */
export function runMissing(runId: string): boolean {
  return readRun(runId) === null;
}

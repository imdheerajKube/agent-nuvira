/**
 * The Guidance Inbox — the only entry point for mid-run user input.
 *
 * A submission is persisted BEFORE it is acknowledged, so a crash cannot lose
 * feedback that the user believes was received. The inbox never touches the plan:
 * it records a request with an identity, an author, a content hash and a status,
 * and lets the run process pick it up at a safe point.
 *
 * IDEMPOTENCY. Double-clicks and HTTP retries are normal. Two mechanisms:
 *   1. an explicit `idempotencyKey` (the surface's request id) returns the original
 *      record instead of creating a second one;
 *   2. an identical content hash inside the dedupe window returns the original
 *      record with `deduped: true`.
 * Neither can duplicate a step in a plan.
 */

import { randomUUID } from 'node:crypto';

import { contentHash } from './ids.js';
import { prefilterGuidance } from './prefilter.js';
import {
  appendJournal,
  changePath,
  claimLease,
  ensureRun,
  listRuns,
  readChanges,
  readJson,
  readRun,
  runExists,
  uniqueChangeId,
  writeJson,
} from './store.js';
import type {
  ChangeIntentHint,
  ChangeRequestRecord,
  ChangeSource,
  ChangeStatus,
  RunRecord,
  SteeringEngine,
} from './types.js';

export interface SubmitGuidanceInput {
  runId: string;
  text: string;
  source?: ChangeSource;
  author?: string;
  intentHint?: ChangeIntentHint;
  targetStepId?: string;
  idempotencyKey?: string;
  sessionId?: string;
  /** Used when the run does not exist yet (a surface submitting early). */
  goal?: string;
  cwd?: string;
  engine?: SteeringEngine;
  dedupeWindowMs?: number;
  now?: number;
}

export interface SubmitGuidanceResult {
  ok: boolean;
  error?: string;
  change?: ChangeRequestRecord;
  /** True when the run manifest was created by this submission. */
  createdRun?: boolean;
  /** True when the submission was collapsed into an existing record. */
  deduped?: boolean;
}

/** The full set of records for a run (oldest first). */
export function listGuidance(runId: string): ChangeRequestRecord[] {
  return readChanges(runId);
}

export function getGuidance(runId: string, changeId: string): ChangeRequestRecord | null {
  return readJson<ChangeRequestRecord>(changePath(runId, changeId));
}

/**
 * Persist one guidance item and return its receipt.
 *
 * The order is load-bearing: validate → persist → journal → return. A receipt is
 * never issued for a record that did not reach the disk.
 */
export function submitGuidance(input: SubmitGuidanceInput): SubmitGuidanceResult {
  const now = input.now ?? Date.now();
  const runId = String(input.runId ?? '').trim();
  if (!runId) return { ok: false, error: 'A runId is required.' };

  const gate = prefilterGuidance(input.text);
  if (!gate.ok) {
    // A refused injection is a SECURITY EVENT. Log it on an existing run without
    // storing the raw text (the journal is an audit trail, not a transcript), so
    // an operator can see that an attempt was made. A first message has no run
    // yet; creating one just to hold an attack would be worse than dropping it.
    if (gate.malicious && runExists(runId)) {
      appendJournal(runId, {
        type: 'guidance.rejected',
        actor: 'policy',
        data: { malicious: true, reason: gate.reason ?? 'policy override attempt' },
      });
    }
    return { ok: false, error: gate.reason ?? 'Guidance was refused.' };
  }

  const createdRun = !runExists(runId);
  const run = ensureRun({
    runId,
    goal: input.goal?.trim() || gate.text.slice(0, 200),
    cwd: input.cwd || process.cwd(),
    engine: input.engine ?? 'loop',
    surface: input.source ?? 'dashboard',
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    now,
  });

  // The run process is the plan writer; the inbox only needs a lease to keep two
  // surfaces from clobbering the same stale approval, and a short one is enough.
  if (!createdRun) {
    const claim = claimLease(runId, { ttlMs: 30_000, now });
    if (!claim.ok) {
      // A live run owns the lease. It still reads the inbox — writing a change is
      // safe and is exactly how guidance crosses the process boundary.
      // The only unsafe case would be two PLAN writers, which never happens here.
      void claim.reason;
    }
  }

  const existing = readChanges(runId);
  const idempotencyKey = (input.idempotencyKey ?? '').trim();
  if (idempotencyKey) {
    const same = existing.find((c) => c.idempotencyKey === idempotencyKey);
    if (same) return { ok: true, change: same, createdRun, deduped: true };
  }
  const window = input.dedupeWindowMs ?? 60_000;
  const duplicate = [...existing]
    .reverse()
    .find(
      (c) =>
        c.contentHash === gate.contentHash &&
        c.status !== 'withdrawn' &&
        now - Date.parse(c.submittedAt) >= 0 &&
        now - Date.parse(c.submittedAt) <= window,
    );
  if (duplicate) {
    const updated: ChangeRequestRecord = { ...duplicate, deduped: true };
    writeJson(changePath(runId, duplicate.id), updated);
    return { ok: true, change: updated, createdRun, deduped: true };
  }

  const change: ChangeRequestRecord = {
    id: uniqueChangeId(runId),
    runId,
    ...(input.sessionId || run.sessionId ? { sessionId: input.sessionId ?? run.sessionId } : {}),
    source: input.source ?? 'dashboard',
    author: (input.author ?? 'user').slice(0, 120),
    rawText: gate.text,
    ...(input.intentHint ? { intentHint: input.intentHint } : {}),
    ...(input.targetStepId ? { targetStepId: input.targetStepId } : {}),
    submittedAt: new Date(now).toISOString(),
    planVersionAtSubmit: run.planVersion,
    idempotencyKey: idempotencyKey || `auto-${randomUUID()}`,
    contentHash: gate.contentHash,
    status: 'received',
  };

  if (!writeJson(changePath(runId, change.id), change)) {
    return { ok: false, error: 'Could not persist guidance — the run was not changed.' };
  }
  appendJournal(runId, {
    type: 'guidance.received',
    actor: 'user',
    changeId: change.id,
    data: {
      source: change.source,
      intentHint: change.intentHint ?? null,
      chars: change.rawText.length,
    },
  });
  return { ok: true, change, createdRun };
}

/** Persist a state transition for one change (read-modify-write, atomic). */
export function updateGuidance(
  runId: string,
  changeId: string,
  patch: Partial<ChangeRequestRecord>,
): ChangeRequestRecord | null {
  const current = getGuidance(runId, changeId);
  if (!current) return null;
  const next: ChangeRequestRecord = { ...current, ...patch, id: current.id, runId: current.runId };
  if (!writeJson(changePath(runId, changeId), next)) return null;
  return next;
}

/** Transition status and journal it in one place, so every surface agrees. */
export function setStatus(
  runId: string,
  changeId: string,
  status: ChangeStatus,
  extra: Partial<ChangeRequestRecord> = {},
): ChangeRequestRecord | null {
  const next = updateGuidance(runId, changeId, { ...extra, status });
  if (!next) return null;
  appendJournal(runId, {
    type: `change.${status}`,
    actor: 'policy',
    changeId,
    ...(next.planVersion !== undefined ? { planVersion: next.planVersion } : {}),
    data: {
      ...(next.decision?.reason ? { reason: next.decision.reason } : {}),
      ...(extra.failure ? { failure: extra.failure } : {}),
    },
  });
  return next;
}

/** Withdraw a change the user no longer wants. Terminal and visible. */
export function withdrawGuidance(runId: string, changeId: string): ChangeRequestRecord | null {
  const current = getGuidance(runId, changeId);
  if (!current) return null;
  if (current.status === 'applied') {
    return updateGuidance(runId, changeId, {
      failure: 'This change was already applied; submit a new guidance item to revise it.',
    });
  }
  return setStatus(runId, changeId, 'withdrawn', {
    decision: { action: 'reject', reason: 'Withdrawn by the user.' },
  });
}

export type InterpretationChoice = 'guidance' | 'new_task' | 'question';

/**
 * Resolve a low-confidence classification with the user's own interpretation.
 * This only re-opens the item as `received` with an explicit intent hint; the
 * normal triage path still decides, and the user can still change their mind.
 */
export function confirmInterpretation(input: {
  runId: string;
  changeId: string;
  choice: InterpretationChoice;
}): ChangeRequestRecord | null {
  const current = getGuidance(input.runId, input.changeId);
  if (!current) return null;
  const intentHint: ChangeIntentHint =
    input.choice === 'new_task' ? 'new_task' : input.choice === 'question' ? 'question' : 'guidance';
  return updateGuidance(input.runId, input.changeId, {
    status: 'received',
    intentHint,
    decision: undefined,
    assessment: undefined,
    triagedAt: undefined,
    triageLatencyMs: undefined,
  });
}

/** The newest active run for a directory, used by `nuvira steer` with no id. */
export function findActiveRun(cwd?: string): RunRecord | null {
  const wanted = cwd ? cwd.replace(/[\\/]+$/, '') : null;
  const active = listRuns().filter((r) => r.status === 'running' || r.status === 'paused');
  const match = wanted
    ? active.find((r) => r.cwd.replace(/[\\/]+$/, '') === wanted)
    : active[0];
  return match ?? active[0] ?? null;
}

/** The content hash a surface can use to pre-dedupe a retry. */
export function guidanceHash(text: string): string {
  return contentHash(String(text ?? '').trim());
}

/** Whether this run is currently owned by another process's lease. */
export function runIsLeasedElsewhere(runId: string, now = Date.now()): boolean {
  const run = readRun(runId);
  const lease = run?.lease;
  if (!lease || lease.pid === process.pid) return false;
  const expires = Date.parse(lease.expiresAt);
  return Number.isFinite(expires) && expires > now;
}

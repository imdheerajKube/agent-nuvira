/**
 * Durable, file-based storage for one run's steering state.
 *
 * LAYOUT (per run, under the configured memory home):
 *
 *   steering/runs/<runId>/
 *     run.json          manifest + lease + stop/pause flags
 *     contract.json     immutable original contract + append-only amendments
 *     events.jsonl      append-only journal
 *     changes/<id>.json one guidance item with its assessment/decision/outcome
 *     approvals/<id>.json one user-initiated approval request
 *     plans/v<N>.json   immutable plan versions
 *     backlog.json      separated new-task ideas
 *     metrics.json      cache of derived counters
 *
 * RULES:
 *  - Every write is atomic (temp file + rename) so a crash leaves either the old
 *    record or the new one, never a half-written JSON file.
 *  - The run process is the only writer of plan versions. Surfaces write changes
 *    and approvals only.
 *  - A corrupt record is a MISS, never a crash.
 *  - A lease prevents two run processes from mutating the same run. The lease is
 *    advisory and expires: a killed process must not make the run unrecoverable.
 *
 * WHY FILES AND NOT SQLITE/REDIS. The project already persists JSON/JSONL and the
 * real scale is one local run at a time. SQLite WAL is the documented next step
 * when concurrent writers become real; adding a broker for a single-user agent
 * would buy operational cost and none of the needed semantics.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { newChangeId, runSlug } from './ids.js';
import type {
  ApprovalRecord,
  BacklogItem,
  ChangeRequestRecord,
  JournalEvent,
  RunRecord,
  SteeringEngine,
  TaskContract,
} from './types.js';

/** Root of all steering state. `NUVIRA_STEERING_DIR` wins for hermetic tests. */
export function steeringRoot(): string {
  const explicit = envBuff('STEERING_DIR');
  if (explicit) return explicit;
  const memory = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
  return join(memory, 'steering');
}

export function runsDir(): string {
  return join(steeringRoot(), 'runs');
}

export function runDir(runId: string): string {
  return join(runsDir(), runSlug(runId));
}

export function changesDir(runId: string): string {
  return join(runDir(runId), 'changes');
}

export function approvalsDir(runId: string): string {
  return join(runDir(runId), 'approvals');
}

export function plansDir(runId: string): string {
  return join(runDir(runId), 'plans');
}

export function contractPath(runId: string): string {
  return join(runDir(runId), 'contract.json');
}

export function backlogPath(runId: string): string {
  return join(runDir(runId), 'backlog.json');
}

export function journalPath(runId: string): string {
  return join(runDir(runId), 'events.jsonl');
}

export function runPath(runId: string): string {
  return join(runDir(runId), 'run.json');
}

/** Recursive mkdir that never throws on a read-only home. */
export function ensureDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Atomic JSON write: temp + rename, best-effort. */
export function writeJson(path: string, value: unknown): boolean {
  try {
    ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Read and parse JSON; any failure is a miss. */
export function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as T;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** Append one JSONL record. Best-effort, but reports whether it landed. */
export function appendJsonl(path: string, value: unknown): boolean {
  try {
    ensureDir(dirname(path));
    writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf-8', flag: 'a' });
    return true;
  } catch {
    return false;
  }
}

/** Read a JSONL file, skipping corrupt lines (a dataset must not be a landmine). */
export function readJsonl<T>(path: string, limit = 5000): T[] {
  try {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        // Corrupt line — skip.
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** One filename-safe change id. */
export function changePath(runId: string, changeId: string): string {
  return join(changesDir(runId), `${changeId}.json`);
}

export function approvalPath(runId: string, changeId: string): string {
  return join(approvalsDir(runId), `${changeId}.json`);
}

export function planPath(runId: string, version: number): string {
  return join(plansDir(runId), `v${version}.json`);
}

/** Every change record on disk, oldest first (by submission time). */
export function readChanges(runId: string): ChangeRequestRecord[] {
  const dir = changesDir(runId);
  if (!existsSync(dir)) return [];
  const out: ChangeRequestRecord[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const record = readJson<ChangeRequestRecord>(join(dir, name));
      if (record && typeof record.id === 'string' && typeof record.rawText === 'string') out.push(record);
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
}

/** One approval record, or null. */
export function readApproval(runId: string, changeId: string): ApprovalRecord | null {
  return readJson<ApprovalRecord>(approvalPath(runId, changeId));
}

export function readApprovals(runId: string): ApprovalRecord[] {
  const dir = approvalsDir(runId);
  if (!existsSync(dir)) return [];
  const out: ApprovalRecord[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const record = readJson<ApprovalRecord>(join(dir, name));
      if (record && typeof record.changeId === 'string') out.push(record);
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function readBacklog(runId: string): BacklogItem[] {
  return readJson<BacklogItem[]>(backlogPath(runId)) ?? [];
}

export function writeBacklog(runId: string, items: BacklogItem[]): boolean {
  return writeJson(backlogPath(runId), items);
}

/** A run with no live lease and no manifest write in this long is a ghost. */
export const STALE_RUN_AFTER_MS = 10 * 60 * 1000;

/**
 * Is this manifest a dead `running` run?
 *
 * Measured 2026-11-09: a one-shot CLI exited 0 while `run.json` stayed
 * `running`, so `steer --list` offered a dead run as active. The exit hook
 * closes the runs this process knows about, but a SIGKILL, a crash or an old
 * version leaves a lease that will never be released. A lease past its expiry —
 * or no lease at all with an old `updatedAt` — is stale, and the surface says so
 * instead of inviting guidance into a process that no longer exists.
 *
 * Paused/stopped runs are NOT stale: they are deliberately resumable.
 */
export function runStaleness(
  run: RunRecord | null,
  now = Date.now(),
): { stale: boolean; staleSince?: string; reason: string } {
  if (!run) return { stale: false, reason: 'run not found' };
  if (run.status !== 'running') return { stale: false, reason: `run is ${run.status}` };
  if (run.lease) {
    const expires = Date.parse(run.lease.expiresAt);
    if (Number.isFinite(expires)) {
      return expires <= now
        ? {
            stale: true,
            staleSince: new Date(expires).toISOString(),
            reason: `lease held by pid ${run.lease.pid} expired at ${run.lease.expiresAt}`,
          }
        : { stale: false, reason: 'lease is live' };
    }
  }
  const updated = Date.parse(run.updatedAt);
  if (Number.isFinite(updated) && now - updated > STALE_RUN_AFTER_MS) {
    return {
      stale: true,
      staleSince: run.updatedAt,
      reason: 'no live lease and the manifest has not changed',
    };
  }
  return { stale: false, reason: 'recent activity' };
}

/** Every run manifest on disk, newest first. */
export function listRuns(): RunRecord[] {
  const dir = runsDir();
  if (!existsSync(dir)) return [];
  const out: RunRecord[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const record = readJson<RunRecord>(join(dir, name, 'run.json'));
      if (record && typeof record.runId === 'string') out.push(record);
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readRun(runId: string): RunRecord | null {
  return readJson<RunRecord>(runPath(runId));
}

/** True when the run directory exists (a cheap existence check for surfaces). */
export function runExists(runId: string): boolean {
  return existsSync(runPath(runId));
}

/**
 * Create the run's directory, manifest and contract when absent; otherwise return
 * the existing manifest. Re-opening is how a surface attaches to a run a previous
 * process started.
 */
export function ensureRun(input: {
  runId: string;
  goal: string;
  cwd: string;
  engine: SteeringEngine;
  surface: ChangeRequestRecord['source'];
  sessionId?: string;
  now?: number;
}): RunRecord {
  const now = input.now ?? Date.now();
  const at = new Date(now).toISOString();
  ensureDir(runDir(input.runId));
  ensureDir(changesDir(input.runId));
  ensureDir(approvalsDir(input.runId));
  ensureDir(plansDir(input.runId));

  const existing = readRun(input.runId);
  if (existing) {
    const merged: RunRecord = {
      ...existing,
      // A re-opened run refreshes its goal/cwd only when it had none; the
      // original contract stays immutable.
      ...(existing.goal ? {} : { goal: input.goal }),
      ...(existing.cwd ? {} : { cwd: input.cwd }),
      updatedAt: at,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    writeJson(runPath(input.runId), merged);
    return merged;
  }

  const record: RunRecord = {
    runId: input.runId,
    goal: input.goal,
    cwd: input.cwd,
    engine: input.engine,
    surface: input.surface,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    status: 'running',
    createdAt: at,
    updatedAt: at,
    planVersion: 0,
    contractVersion: 1,
    stopRequested: false,
    pauseRequested: false,
    sequence: 0,
  };
  writeJson(runPath(input.runId), record);
  const contract: TaskContract = {
    runId: input.runId,
    goal: input.goal,
    cwd: input.cwd,
    createdAt: at,
    deliverables: [],
    nonGoals: [],
    acceptanceCriteria: [],
    amendments: [],
  };
  if (!existsSync(contractPath(input.runId))) writeJson(contractPath(input.runId), contract);
  return record;
}

/** Patch the manifest. Never used to write a plan version. */
export function patchRun(
  runId: string,
  patch: Partial<RunRecord>,
  now: number = Date.now(),
): RunRecord | null {
  const current = readRun(runId);
  if (!current) return null;
  const next: RunRecord = { ...current, ...patch, updatedAt: new Date(now).toISOString() };
  writeJson(runPath(runId), next);
  return next;
}

/** Read the immutable contract (with its append-only amendments). */
export function readContract(runId: string): TaskContract | null {
  return readJson<TaskContract>(contractPath(runId));
}

/** Append one approved amendment. The original contract is never rewritten. */
export function appendAmendment(
  runId: string,
  amendment: TaskContract['amendments'][number],
): TaskContract | null {
  const contract = readContract(runId);
  if (!contract) return null;
  if (contract.amendments.some((a) => a.changeId === amendment.changeId && a.text === amendment.text)) {
    return contract;
  }
  const next: TaskContract = {
    ...contract,
    amendments: [...contract.amendments, amendment].slice(-200),
  };
  writeJson(contractPath(runId), next);
  const run = readRun(runId);
  if (run) patchRun(runId, { contractVersion: run.contractVersion + 1 });
  return next;
}

/** A monotonic journal sequence. Reads the manifest, not the whole log. */
export function nextSequence(runId: string): number {
  const run = readRun(runId);
  if (!run) return 1;
  const next = (run.sequence ?? 0) + 1;
  patchRun(runId, { sequence: next });
  return next;
}

/** Append one journal event. Best-effort: logging must never break a run. */
export function appendJournal(
  runId: string,
  event: Omit<JournalEvent, 'eventId' | 'runId' | 'sequence' | 'timestamp'> & {
    timestamp?: string;
  },
): JournalEvent | null {
  const sequence = nextSequence(runId);
  const record: JournalEvent = {
    eventId: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    runId,
    sequence,
    timestamp: event.timestamp ?? new Date().toISOString(),
    type: event.type,
    actor: event.actor,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.causationId ? { causationId: event.causationId } : {}),
    ...(event.planVersion !== undefined ? { planVersion: event.planVersion } : {}),
    ...(event.changeId ? { changeId: event.changeId } : {}),
    ...(event.data ? { data: event.data } : {}),
  };
  appendJsonl(journalPath(runId), record);
  return record;
}

export function readJournal(runId: string, limit = 200): JournalEvent[] {
  return readJsonl<JournalEvent>(journalPath(runId), limit);
}

/**
 * Claim the run for this process. Succeeds when the run is unclaimed, the lease
 * is ours, or the lease has expired. A non-expired lease held by another live
 * process is a refusal (two writers would corrupt the plan).
 */
export function claimLease(
  runId: string,
  options: { pid?: number; ttlMs?: number; now?: number } = {},
): { ok: boolean; reason?: string } {
  const now = options.now ?? Date.now();
  const pid = options.pid ?? process.pid;
  const ttl = options.ttlMs ?? 10 * 60 * 1000;
  const run = readRun(runId);
  if (!run) return { ok: false, reason: 'run not found' };
  const lease = run.lease;
  if (lease && lease.pid !== pid) {
    const expires = Date.parse(lease.expiresAt);
    if (Number.isFinite(expires) && expires > now) {
      return { ok: false, reason: `run is leased by pid ${lease.pid} until ${lease.expiresAt}` };
    }
  }
  patchRun(
    runId,
    {
      lease: {
        pid,
        hostname: hostname(),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttl).toISOString(),
      },
    },
    now,
  );
  return { ok: true };
}

/** Refresh the lease so a long turn is not mistaken for a dead process. */
export function heartbeatLease(runId: string, ttlMs = 10 * 60 * 1000, now = Date.now()): void {
  const run = readRun(runId);
  if (!run?.lease || run.lease.pid !== process.pid) return;
  patchRun(
    runId,
    {
      lease: {
        ...run.lease,
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      },
    },
    now,
  );
}

export function releaseLease(runId: string, pid = process.pid): void {
  const run = readRun(runId);
  if (!run?.lease || run.lease.pid !== pid) return;
  const { lease: _lease, ...rest } = run;
  writeJson(runPath(runId), rest);
}

/** Remove a run directory entirely (an explicit user action, never automatic). */
export function deleteRun(runId: string): boolean {
  try {
    rmSync(runDir(runId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** A fresh change id unique within this run. */
export function uniqueChangeId(runId: string): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = newChangeId();
    if (!existsSync(changePath(runId, id))) return id;
  }
  return newChangeId(Date.now() + Math.floor(Math.random() * 1000));
}

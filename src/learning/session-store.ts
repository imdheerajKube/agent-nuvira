/**
 * WS5 (#27) — Phase 4b/4c: the PERSISTENT SESSION STORE (the L2 layer).
 *
 * WHY THIS EXISTS. The resume ledger (`step-checkpoint.ts`) makes a re-run cheap
 * by replaying unchanged MODEL CALLS, and the task checkpoints
 * (`agents/checkpoint-store.ts`) skip COMPLETED pipeline tasks. Both are keyed by
 * what a run FINISHED. Neither survives the one failure a long-running agent
 * actually hits: the PROCESS dies mid-turn (a closed laptop, a killed terminal,
 * a quota-killed provider). At that instant the conversation lived only in
 * memory, and the next process starts cold — it re-derives the whole context and
 * re-pays for the steps that were already done.
 *
 * WHAT IT STORES, AND WHAT IT REFUSES TO STORE. At every step boundary the loop
 * hands over its live `ToolMessage[]` thread plus a small accumulator (steps,
 * successful tools, mutated paths). The store keeps a bounded, REDACTED copy on
 * disk. It is a transcript — nothing more. It does NOT record a completion
 * state, an outcome, or any verdict: completion is still derived from the
 * filesystem and the run's own facts (see the Part 1/Part 2 lesson). Re-importing
 * the transcript gives the next process the CONVERSATION, not a claim that the
 * work is done.
 *
 * WHY THE HEAD IS REPLACED ON REHYDRATION. The first messages of a loop thread
 * are the system prompt (tool contract) and the `[Project context]` block. Those
 * are reconstructible, and they DRIFT between runs (the file tree, the git
 * digest). Persisting them would both age and bloat the record. So the store
 * counts the leading head messages at save time (`headLength`) and the caller
 * re-injects a FRESH head over the stored conversation tail on resume: the
 * contract is current, the history is intact.
 *
 * WHY A COMPLETED SESSION IS NOT RESUMABLE. If a turn ran to a clean end, its
 * transcript is history — re-feeding a finished conversation would have the model
 * continue a conversation that is over, and risk narrating a stale "done". So
 * `finish()` marks a snapshot closed, and the resumable lookup skips closed
 * snapshots. The transcript is still kept (bounded) for a human to read; it is
 * simply not replayed.
 *
 * WHY NOTHING HAPPENS WITHOUT A REQUEST. Opening the store is the ONLY thing that
 * reads or writes the session directory. An ordinary run never touches it, pays
 * no filesystem cost, and cannot inherit another run's conversation.
 *
 * Everything here is best-effort: a corrupt record is a MISS, never a crash, and
 * a failed write reports (or stays silent) without breaking the turn that asked.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkpointIdFor, goalsLookSame } from '../agents/checkpoint-store.js';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { redact } from '../enterprise/secrets.js';
import type { ToolMessage } from '../inference/interface.js';

/** The environment key a deployment uses to turn session persistence OFF. */
export const SESSION_ENABLE_ENV = 'NUVIRA_SESSION_STORE';

/** Words a reader treats as OFF (same vocabulary the process-env page uses). */
const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/**
 * Is session persistence on? DEFAULT ON — like checkpointing, a fresh install
 * gets continuity and an operator can turn it off. `0`/`false`/`off`/`no` turn
 * it off; unset (or any other value) leaves it ON.
 */
export function sessionStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SESSION_ENABLE_ENV];
  if (typeof raw !== 'string') return true;
  return !OFF_WORDS.has(raw.trim().toLowerCase());
}

/** The config/env shape a resolver reads (structural, so no import cycle). */
export interface StoreConfigSource {
  getAll(): { memory?: { sessionStore?: boolean } };
}

/**
 * Resolve whether session persistence is on, with the repo's precedence: an
 * explicit FLAG wins, then the environment, then config, then the default (ON).
 * One place decides, so the CLI, the loop and the dashboard cannot disagree.
 */
export function resolveSessionStore(
  input: { flag?: boolean; configManager?: StoreConfigSource | null } = {},
): boolean {
  if (input.flag !== undefined) return input.flag;
  const viaEnv = envBuff('SESSION_STORE');
  if (typeof viaEnv === 'string') return !OFF_WORDS.has(viaEnv.trim().toLowerCase());
  return input.configManager?.getAll().memory?.sessionStore !== false;
}

/** Bound on stored conversation messages — the most recent N are kept. */
export const MAX_SESSION_MESSAGES = 48;
/** Bound on a single stored message's content (the rest is clipped). */
export const MAX_MESSAGE_CHARS = 8000;

/** The accumulators the loop reports at a step boundary. */
export interface SessionAccumulators {
  /** Steps completed so far this turn. */
  steps: number;
  /** Tool names that ran successfully (in order). */
  successfulTools: string[];
  /** Paths mutated successfully (in order). */
  mutatedPaths: string[];
  /** Tool names that errored, when the caller tracks them. */
  erroredTools?: string[];
}

/** A persisted session snapshot: the conversation tail plus the accumulators. */
export interface SessionSnapshot {
  id: string;
  goal: string;
  cwd: string;
  savedAt: number;
  /** Monotonic save counter, so a reader can tell updates apart. */
  revision: number;
  /** False once the turn ran to a clean end (and is therefore not resumable). */
  open: boolean;
  /** Leading thread messages that are reconstructible and must be replaced. */
  headLength: number;
  messages: ToolMessage[];
  accumulators: SessionAccumulators;
}

// ─── Storage ────────────────────────────────────────────────────────────────

function sessionsDir(): string {
  const base = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
  return join(base, 'sessions');
}

function snapshotPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/** Read a snapshot, best-effort. A corrupt record is a miss, never a crash. */
export function loadSessionSnapshot(id: string): SessionSnapshot | null {
  try {
    const path = snapshotPath(id);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SessionSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || !Array.isArray(parsed.messages)) return null;
    if (typeof parsed.goal !== 'string' || typeof parsed.cwd !== 'string') return null;
    return {
      id: parsed.id,
      goal: parsed.goal,
      cwd: parsed.cwd,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      open: parsed.open !== false,
      headLength: typeof parsed.headLength === 'number' ? parsed.headLength : 0,
      messages: parsed.messages.filter(isToolMessage),
      accumulators: normalizeAccumulators(parsed.accumulators),
    };
  } catch {
    return null;
  }
}

function isToolMessage(value: unknown): value is ToolMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<ToolMessage>;
  return (
    (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool') &&
    typeof m.content === 'string'
  );
}

function normalizeAccumulators(value: unknown): SessionAccumulators {
  const a = (value ?? {}) as Partial<SessionAccumulators>;
  return {
    steps: typeof a.steps === 'number' ? a.steps : 0,
    successfulTools: Array.isArray(a.successfulTools) ? a.successfulTools.filter((t) => typeof t === 'string') : [],
    mutatedPaths: Array.isArray(a.mutatedPaths) ? a.mutatedPaths.filter((t) => typeof t === 'string') : [],
    ...(Array.isArray(a.erroredTools)
      ? { erroredTools: a.erroredTools.filter((t) => typeof t === 'string') }
      : {}),
  };
}

/** Write a snapshot, best-effort. Returns whether it reached the disk. */
function writeSnapshot(snapshot: SessionSnapshot): boolean {
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(snapshotPath(snapshot.id), JSON.stringify(snapshot, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ─── Bounds ─────────────────────────────────────────────────────────────────

/**
 * Bound and redact a thread for storage.
 *
 * The TAIL is kept (the last `MAX_SESSION_MESSAGES` messages): the most recent
 * tool results and the current question are what a resuming model needs, while
 * the opening context is reconstructible. Every content string is clipped to
 * `MAX_MESSAGE_CHARS` and run through the shared `redact` — a transcript that
 * leaks a key is not worth the continuity it buys.
 *
 * Tool-call arguments and `providerMeta` are preserved verbatim only when they
 * survive JSON (they are structured data the provider may need) and are never
 * trusted to be secret-free, so they are redacted through a JSON round-trip.
 */
function boundMessages(messages: readonly ToolMessage[]): { messages: ToolMessage[]; headLength: number } {
  const headLength = countHead(messages);
  const sliced = messages.length > MAX_SESSION_MESSAGES ? messages.slice(-MAX_SESSION_MESSAGES) : messages.slice();
  const bounded = sliced.map((message) => boundMessage(message));
  // If the slice dropped the head, the stored head is gone too (the caller's
  // `headLength` then refers to a head that is not in the record).
  return { messages: bounded, headLength: Math.min(headLength, bounded.length) };
}

/** Leading system messages, plus a directly-following `[Project context]` block. */
function countHead(messages: readonly ToolMessage[]): number {
  let head = 0;
  while (head < messages.length && messages[head].role === 'system') head += 1;
  if (head < messages.length && messages[head].role === 'user' && messages[head].content.startsWith('[Project context]')) {
    head += 1;
  }
  return head;
}

function boundMessage(message: ToolMessage): ToolMessage {
  const out: ToolMessage = {
    role: message.role,
    content: clip(message.content),
  };
  if (message.toolCallId) out.toolCallId = message.toolCallId;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    out.toolCalls = message.toolCalls.map((call) => {
      const copy = { ...call };
      if (typeof copy.arguments === 'string') copy.arguments = clip(copy.arguments);
      return copy;
    });
  }
  return out;
}

function clip(text: string): string {
  if (typeof text !== 'string') return '';
  const redacted = redact(text);
  return redacted.length > MAX_MESSAGE_CHARS ? `${redacted.slice(0, MAX_MESSAGE_CHARS)}…[clipped]` : redacted;
}

// ─── The store ──────────────────────────────────────────────────────────────

/**
 * The writer a loop threads through its step boundaries.
 *
 * `save` is called once per completed step; `finish` once, when the turn ends
 * cleanly. Both are best-effort — a read-only home directory degrades to "no
 * continuity", never to a failed turn.
 */
export interface SessionStore {
  readonly id: string;
  /** Snapshot the current thread + accumulators at a step boundary. */
  save(thread: readonly ToolMessage[], accumulators: SessionAccumulators): void;
  /** Mark the turn finished so the transcript is history, not a resume point. */
  finish(thread?: readonly ToolMessage[], accumulators?: SessionAccumulators): void;
  /** Whether the most recent write reached the disk. */
  lastSaved(): boolean;
}

interface StoreState {
  id: string;
  goal: string;
  cwd: string;
  revision: number;
  saved: boolean;
  lastMessages: ToolMessage[];
  lastAccumulators: SessionAccumulators;
}

const STORE_STATES = new WeakMap<SessionStore, StoreState>();

/**
 * Open (or start) the session for this ask, in this directory.
 *
 * An explicit `id` is honoured exactly. With none, the deterministic
 * `checkpointIdFor(goal, cwd)` is used — the SAME key the resume ledger uses —
 * so a reworded re-ask resolves to the same session through
 * {@link resolveSessionIdFor} / {@link findResumableSessionFor}.
 */
/** Whether this process has already opportunistically bounded the store. */
let PRUNED_THIS_PROCESS = false;

/** Keep the store from growing without bound — run at most once per process. */
function pruneOnce(): void {
  if (PRUNED_THIS_PROCESS) return;
  PRUNED_THIS_PROCESS = true;
  try {
    const entries = listSessionSnapshots();
    if (entries.length > 100) pruneSessions({ maxCount: 100 });
  } catch {
    // Best-effort — a prune failure must never break an open.
  }
}

export function openSession(input: { goal: string; cwd: string; id?: string }): SessionStore {
  pruneOnce();
  const id = input.id?.trim() || checkpointIdFor(input.goal, input.cwd);
  const prior = loadSessionSnapshot(id);
  const state: StoreState = {
    id,
    goal: input.goal,
    cwd: input.cwd,
    revision: prior?.revision ?? 0,
    saved: false,
    lastMessages: prior?.messages ?? [],
    lastAccumulators: prior?.accumulators ?? { steps: 0, successfulTools: [], mutatedPaths: [] },
  };

  const persist = (open: boolean): void => {
    const { messages, headLength } = boundMessages(state.lastMessages);
    const snapshot: SessionSnapshot = {
      id: state.id,
      goal: state.goal,
      cwd: state.cwd,
      savedAt: Date.now(),
      revision: state.revision + 1,
      open,
      headLength,
      messages,
      accumulators: state.lastAccumulators,
    };
    state.revision += 1;
    state.saved = writeSnapshot(snapshot);
  };

  const store: SessionStore = {
    id,
    save(thread, accumulators) {
      state.lastMessages = thread.slice();
      state.lastAccumulators = normalizeAccumulators(accumulators);
      persist(true);
    },
    finish(thread, accumulators) {
      if (thread) state.lastMessages = thread.slice();
      if (accumulators) state.lastAccumulators = normalizeAccumulators(accumulators);
      persist(false);
    },
    lastSaved() {
      return state.saved;
    },
  };
  STORE_STATES.set(store, state);
  return store;
}

/**
 * The session id for this ask, in this directory, possibly WORDED DIFFERENTLY.
 *
 * Same contract as `resolveRecordIdFor` in the resume ledger: the exact id if a
 * snapshot exists, else the newest OPEN snapshot in this directory whose goal
 * `goalsLookSame`. A snapshot for a different ask is never returned — the caller
 * would otherwise rehydrate a conversation it never had.
 */
export function resolveSessionIdFor(goal: string, cwd: string, options: { onlyOpen?: boolean } = {}): string {
  const exact = checkpointIdFor(goal, cwd);
  const onlyOpen = options.onlyOpen ?? true;
  const exactSnap = loadSessionSnapshot(exact);
  if (exactSnap && (!onlyOpen || exactSnap.open)) return exact;

  const wanted = normalizeDir(cwd);
  let best: { id: string; savedAt: number } | null = null;
  try {
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (id === exact) continue;
      const snap = loadSessionSnapshot(id);
      if (!snap) continue;
      if (onlyOpen && !snap.open) continue;
      if (normalizeDir(snap.cwd) !== wanted) continue;
      if (!goalsLookSame(snap.goal, goal)) continue;
      if (!best || snap.savedAt > best.savedAt) best = { id, savedAt: snap.savedAt };
    }
  } catch {
    return exact;
  }
  return best?.id ?? exact;
}

/**
 * The resumable snapshot for this ask, or null when there is nothing to resume.
 *
 * Only OPEN snapshots qualify (see the module docstring): a transcript from a
 * turn that ended cleanly is history, and re-feeding it would have the model
 * continue a finished conversation.
 */
export function findResumableSessionFor(goal: string, cwd: string): SessionSnapshot | null {
  const id = resolveSessionIdFor(goal, cwd, { onlyOpen: true });
  const snap = loadSessionSnapshot(id);
  if (!snap || !snap.open || snap.messages.length === 0) return null;
  return snap;
}

/**
 * Rebuild a loop thread from a stored snapshot and a FRESH head.
 *
 * The fresh head (system prompt, current project context) replaces the stored
 * head; the stored conversation tail — the goal and everything done after it —
 * is preserved. The result is what the next process loops over: it already knows
 * what the dead process did, so those steps are neither re-run nor re-paid.
 */
export function rehydrateThread(head: readonly ToolMessage[], snapshot: SessionSnapshot): ToolMessage[] {
  const start = Math.min(snapshot.headLength, snapshot.messages.length);
  return [...head, ...snapshot.messages.slice(start)];
}

/** A bounded, human-facing line describing a resumable snapshot. */
export function formatSessionResume(snapshot: SessionSnapshot): string {
  const steps = snapshot.accumulators.steps;
  const tools = snapshot.accumulators.successfulTools.length;
  const paths = snapshot.accumulators.mutatedPaths.length;
  return (
    `↩️  session for this ask is still OPEN — ${steps} step(s), ${tools} successful tool call(s)` +
    (paths > 0 ? `, ${paths} path(s) changed` : '') +
    ' — the conversation is restored (this is HISTORY, not a status: verify artifacts on disk)'
  );
}

/**
 * List every stored session snapshot, newest first. Best-effort: a corrupt or
 * unreadable record is skipped, never thrown.
 */
export function listSessionSnapshots(): SessionSnapshot[] {
  try {
    const out: SessionSnapshot[] = [];
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith('.json')) continue;
      const snap = loadSessionSnapshot(file.slice(0, -'.json'.length));
      if (snap) out.push(snap);
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Remove one snapshot. Returns whether a file was removed. */
export function clearSession(id: string): boolean {
  try {
    const path = snapshotPath(id);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bound the session directory: drop snapshots older than `maxAgeMs` and keep at
 * most `maxCount` (newest first). Returns how many files were removed.
 *
 * Best-effort and never throws — a prune that fails leaves the records (a disk
 * full of old transcripts is a smaller problem than a broken turn).
 */
export function pruneSessions(options: { maxAgeMs?: number; maxCount?: number; now?: number } = {}): number {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const maxCount = options.maxCount ?? 50;
  let removed = 0;
  try {
    const entries: Array<{ id: string; savedAt: number }> = [];
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      const snap = loadSessionSnapshot(id);
      entries.push({ id, savedAt: snap?.savedAt ?? 0 });
    }
    entries.sort((a, b) => b.savedAt - a.savedAt);
    for (let i = 0; i < entries.length; i += 1) {
      const { id, savedAt } = entries[i];
      const tooOld = maxAgeMs > 0 && now - savedAt > maxAgeMs;
      const overCount = i >= maxCount;
      if ((tooOld || overCount) && clearSession(id)) removed += 1;
    }
  } catch {
    return removed;
  }
  return removed;
}

function normalizeDir(dir: string): string {
  return (dir || '').replace(/[\\/]+$/, '');
}

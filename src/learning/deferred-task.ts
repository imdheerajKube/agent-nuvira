/**
 * Deferred retry queue — the MECHANISM behind "Reply *yes* and I will keep
 * trying until it is done."
 *
 * THE BUG THIS CLOSES. `renderModelBreadthReport` ends every failed turn with
 * that offer, and it went out live to WhatsApp
 * ("A model frees up in about 44s … Reply *yes* …"). Nothing parsed the "yes",
 * stored the task, or re-ran it when a model came back — so a sender who
 * followed the instruction got silence, which is worse than never being asked.
 * A promise the agent cannot keep is a defect, not a courtesy.
 *
 * WHY A STORE INSTEAD OF A TIMER IN THE FAILURE PATH: the model that frees up
 * is often minutes away (a quota window), and a messaging transport's turn is
 * long over by then — there is no in-process stack to sit on. The task is
 * therefore persisted (surviving a gateway restart, which is the normal case
 * for a quota wait), and a periodic drain claims whatever is due.
 *
 * Deliberately a LEAF module (node builtins + path resolution only): the
 * gateway, the CLI and the dashboard all need it, and a shared queue that
 * dragged the routing graph in would be unusable from the dashboard.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveNuviraDataPath } from '../config/paths.js';

/** Which engine the ask needs when it is finally run. */
export type DeferredAskKind = 'chat' | 'pipeline';

/** Lifecycle of one deferred task. */
export type DeferredTaskStatus = 'pending' | 'running';

/** One failed ask waiting for a model to come back. */
export interface DeferredTask {
  id: string;
  /** Messaging platform (`whatsapp`, `telegram`, …) — the reply goes back here. */
  platform: string;
  /** The contact/channel to reply to. */
  channelId: string;
  /** Human sender label, replayed into the retry's origin context. */
  from?: string;
  senderId?: string;
  isGroup?: boolean;
  /** The ORIGINAL ask, verbatim — a retry must run exactly what was asked. */
  text: string;
  kind: DeferredAskKind;
  createdAt: number;
  /** Epoch ms of the last retry attempt (0 = none yet). */
  lastAttemptAt: number;
  /** How many retry attempts have run (never counts the original turn). */
  attempts: number;
  status: DeferredTaskStatus;
  /** Earliest epoch ms the next attempt may run (from the report's free-up ETA). */
  notBefore: number;
  /** Stop retrying after this (a queue that never ends is not a service). */
  deadline: number;
  /**
   * The sender explicitly said "yes".
   *
   * A task is queued optimistically the moment a turn fails (the ask was a real
   * request, so completing it is what the user wants), but its persistence is
   * proportional to CONSENT: an unconfirmed task retries a few times over half
   * an hour, while a confirmed one keeps going for the full horizon. Nobody is
   * enrolled in a six-hour retry loop they never agreed to.
   */
  confirmed?: boolean;
  lastError?: string;
}

/** Everything the queue needs to remember an ask. */
export interface DeferTaskInput {
  platform: string;
  channelId: string;
  text: string;
  kind: DeferredAskKind;
  from?: string;
  senderId?: string;
  isGroup?: boolean;
  /** How long the failure report said until a model frees (absent = unknown). */
  nextFreeInMs?: number;
  /** The failure line the sender saw, for context in later reports. */
  lastError?: string;
}

/** Bounded: a queue is a convenience, not a backlog. */
const MAX_TASKS = 50;
/** Confirmed horizon — "yes, keep trying until it is done". */
export const DEFERRED_TASK_TTL_MS = 6 * 3_600_000;
/** Optimistic horizon — queued because the ask was real, but never confirmed. */
export const UNCONFIRMED_TASK_TTL_MS = 30 * 60_000;
/** Attempt cap, so a permanently broken ask cannot loop for six hours. */
const MAX_ATTEMPTS = 40;
/** Attempt cap while the sender has NOT confirmed the retry. */
const MAX_ATTEMPTS_UNCONFIRMED = 4;

/** How many attempts this task is allowed. */
export function attemptCap(task: DeferredTask): number {
  return task.confirmed ? MAX_ATTEMPTS : MAX_ATTEMPTS_UNCONFIRMED;
}
/**
 * Floor between attempts. A "free in 5s" hint is not a licence to hammer the
 * pool — the failover walk already failed everything once, and a tight loop
 * spends quota re-proving that.
 */
const MIN_WAIT_MS = 20_000;
/** Ceiling: a known 10-hour reset is not worth holding a queue slot for. */
const MAX_WAIT_MS = 60 * 60_000;
/** Default wait when the report could not name a free-up time. */
const DEFAULT_WAIT_MS = 5 * 60_000;

const FILE_NAME = 'deferred-tasks.json';

function storePath(): string {
  return resolveNuviraDataPath(FILE_NAME);
}

interface StoreShape {
  version: number;
  tasks: DeferredTask[];
}

/** Read the queue. Best-effort: a corrupt file is an empty queue, never a throw. */
export function loadDeferredTasks(): DeferredTask[] {
  try {
    const path = storePath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoreShape;
    if (!parsed || !Array.isArray(parsed.tasks)) return [];
    return parsed.tasks.filter(isTaskShape);
  } catch {
    return [];
  }
}

function writeDeferredTasks(tasks: DeferredTask[]): void {
  try {
    const path = storePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: StoreShape = { version: 1, tasks: tasks.slice(0, MAX_TASKS) };
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Best-effort — a store write must never break the turn that deferred it.
  }
}

function isTaskShape(t: unknown): t is DeferredTask {
  if (!t || typeof t !== 'object') return false;
  const o = t as Partial<DeferredTask>;
  return (
    typeof o.id === 'string' &&
    typeof o.platform === 'string' &&
    typeof o.channelId === 'string' &&
    typeof o.text === 'string' &&
    (o.kind === 'chat' || o.kind === 'pipeline') &&
    typeof o.createdAt === 'number' &&
    typeof o.notBefore === 'number' &&
    typeof o.deadline === 'number'
  );
}

/** The conversation a task belongs to — one live retry per conversation. */
function conversationKey(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `retry-${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* fall through */
  }
  return `retry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Clamp a free-up hint into a sane retry wait. */
export function retryWaitMs(nextFreeInMs?: number): number {
  if (typeof nextFreeInMs !== 'number' || !Number.isFinite(nextFreeInMs) || nextFreeInMs <= 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(nextFreeInMs)));
}

/**
 * Record a failed ask for retry, or refresh the pending task for that
 * conversation.
 *
 * The UPDATE path deliberately preserves `attempts` and `createdAt`: the retry
 * that just failed re-enters this function (it goes through the same failure
 * branch), and resetting the counters there would make the attempt cap and TTL
 * meaningless — the task would retry forever.
 *
 * @returns the stored task and whether it was created (vs refreshed).
 */
export function deferTask(input: DeferTaskInput): { task: DeferredTask; created: boolean } {
  const tasks = loadDeferredTasks();
  const key = conversationKey(input.platform, input.channelId);
  const now = Date.now();
  const existing = tasks.find(
    (t) => conversationKey(t.platform, t.channelId) === key && t.text === input.text,
  );
  const notBefore = now + retryWaitMs(input.nextFreeInMs);

  if (existing) {
    existing.notBefore = Math.max(existing.notBefore, notBefore);
    existing.status = 'pending';
    if (input.lastError) existing.lastError = input.lastError;
    if (input.kind) existing.kind = input.kind;
    writeDeferredTasks(tasks);
    return { task: existing, created: false };
  }

  const task: DeferredTask = {
    id: newId(),
    platform: input.platform,
    channelId: input.channelId,
    ...(input.from ? { from: input.from } : {}),
    ...(input.senderId ? { senderId: input.senderId } : {}),
    ...(input.isGroup !== undefined ? { isGroup: input.isGroup } : {}),
    text: input.text,
    kind: input.kind,
    createdAt: now,
    lastAttemptAt: 0,
    attempts: 0,
    status: 'pending',
    notBefore,
    deadline: now + UNCONFIRMED_TASK_TTL_MS,
    ...(input.lastError ? { lastError: input.lastError } : {}),
  };
  // Newest first, bounded: the oldest pending task is the one a user is most
  // likely to have forgotten, and dropping it silently is better than growing
  // an unbounded file.
  writeDeferredTasks([task, ...tasks]);
  return { task, created: true };
}

/** The live task for a conversation (newest first), if any. */
export function getPendingTask(platform: string, channelId: string): DeferredTask | undefined {
  const key = conversationKey(platform, channelId);
  return loadDeferredTasks().find((t) => conversationKey(t.platform, t.channelId) === key);
}

/** Every task currently waiting (for status surfaces, newest first). */
export function listPendingTasks(): DeferredTask[] {
  return loadDeferredTasks();
}

/** Tasks whose next attempt is due and whose TTL has not elapsed. */
export function dueTasks(now: number = Date.now()): DeferredTask[] {
  return loadDeferredTasks().filter(
    (t) => t.status === 'pending' && t.notBefore <= now && t.deadline > now && t.attempts < attemptCap(t),
  );
}

/** Tasks that ran out of attempts or TTL — the sender must be told, not ghosted. */
export function expiredTasks(now: number = Date.now()): DeferredTask[] {
  return loadDeferredTasks().filter(
    (t) => t.status === 'pending' && (t.deadline <= now || t.attempts >= attemptCap(t)),
  );
}

/**
 * The sender said yes: extend this task to the full horizon and keep going.
 * Returns the confirmed task (or undefined when it had already expired).
 */
export function confirmTask(id: string, now: number = Date.now()): DeferredTask | undefined {
  const tasks = loadDeferredTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  task.confirmed = true;
  task.status = 'pending';
  task.deadline = Math.max(task.deadline, now + DEFERRED_TASK_TTL_MS);
  writeDeferredTasks(tasks);
  return task;
}

/** Apply a partial patch to one task by id. Returns the patched task. */
export function updateDeferredTask(id: string, patch: Partial<DeferredTask>): DeferredTask | undefined {
  const tasks = loadDeferredTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  Object.assign(task, patch);
  writeDeferredTasks(tasks);
  return task;
}

/** Drop a task (on success, on a cancel reply, or when it expires). */
export function removeDeferredTask(id: string): void {
  writeDeferredTasks(loadDeferredTasks().filter((t) => t.id !== id));
}

/** Drop every task for a conversation (`stop`, `no`, `cancel`). */
export function cancelTasksFor(platform: string, channelId: string): number {
  const key = conversationKey(platform, channelId);
  const tasks = loadDeferredTasks();
  const kept = tasks.filter((t) => conversationKey(t.platform, t.channelId) !== key);
  if (kept.length !== tasks.length) writeDeferredTasks(kept);
  return tasks.length - kept.length;
}

// ─── "yes" / "no" recognition ───────────────────────────────────────────────

/**
 * Phrases that ACCEPT the retry offer. Whole-message matches only — the gates
 * below make the matcher conservative because a wrong verdict here swallows a
 * real request, which is exactly the class of bug this queue exists to fix.
 */
const ACCEPT_PHRASES = new Set([
  'yes',
  'y',
  'yep',
  'yeah',
  'yup',
  'ya',
  'yaa',
  'ok',
  'okay',
  'k',
  'sure',
  'definitely',
  'please do',
  'do it',
  'go ahead',
  'go on',
  'go for it',
  'keep trying',
  'keep going',
  'keep trying please',
  'try again',
  'retry',
  'please retry',
  'haan',
  'ha',
  'han',
  'theek hai',
  'chalega',
  'yes please',
  'yes please do',
  'please keep trying',
  'sure please',
  'ok please',
  'continue',
  'continue please',
]);

/** Phrases that DECLINE / cancel the offer. */
const DECLINE_PHRASES = new Set([
  'no',
  'n',
  'nope',
  'nah',
  'nahi',
  'stop',
  'stop it',
  'cancel',
  'cancel it',
  'forget it',
  'never mind',
  'nevermind',
  'leave it',
  'no thanks',
  'no thank you',
  'dont',
  "don't",
  'do not',
  'nahi chahiye',
]);

/** An acceptance token embedded in a short reply ("yes, please keep trying"). */
const ACCEPT_TOKEN_RE =
  /\b(?:yes|yep|yeah|yup|sure|ok|okay|haan|please do|go ahead|go on|keep trying|keep going|try again|retry|continue|theek hai)\b/;

/**
 * Words allowed to accompany an accept token. This is what separates
 * "yes, please keep trying" (an acceptance) from "yes I also want a website"
 * (a NEW request that merely starts with yes) — the second contains words that
 * are not filler, so it is handled normally instead of being swallowed.
 * Losing a user's real request to a thumbs-up heuristic is exactly the class of
 * bug this queue exists to fix, so the check is word-by-word strict.
 */
const ACCEPT_FILLER = new Set([
  'yes', 'yep', 'yeah', 'yup', 'ya', 'sure', 'ok', 'okay', 'k', 'please', 'pls',
  'thanks', 'thank', 'you', 'keep', 'trying', 'going', 'go', 'ahead', 'on',
  'do', 'it', 'now', 'try', 'again', 'retry', 'continue', 'haan', 'han', 'yaa',
  'theek', 'hai', 'chalega', 'much', 'so', 'and', 'that', 'this', 'for', 'to',
]);

const DECLINE_TOKEN_RE = /\b(?:no|nope|nah|nahi|stop|cancel|forget it|never ?mind|leave it|don'?t)\b/;

/** True when the message is ONLY punctuation/whitespace/emoji. */
const NON_WORD_ONLY_RE = /^[^\p{L}\p{N}]+$/u;

/**
 * Emoji-only replies that unambiguously accept: 👍 🙌 👌 ✅ 🆗.
 * A bare thumbs-up is how most messaging users say "yes", so it must not fall
 * through to normal handling as punctuation — while an unrelated emoji (❤️, 😂)
 * still does, since those are not answers.
 */
const ACCEPT_EMOJI_RE = /[\u{1F44D}\u{1F44C}\u{1F64C}\u{2705}\u{1F197}]/u;

/**
 * Normalize a reply for phrase matching: lowercase, emoji/punctuation stripped,
 * whitespace collapsed. `"Yes, please! 🙏"` → `"yes please"`.
 */
export function normalizeRetryAnswer(text: string | null | undefined): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this message the sender ACCEPTING the retry offer?
 *
 * Two gates, both required:
 *  1. the whole message must be short (≤ 6 words) — anything longer is a new
 *     request that merely happens to start with "yes", and swallowing it would
 *     lose the user's actual ask;
 *  2. it must be an exact accept phrase, or a short message carrying an accept
 *     token and NO decline token ("yes, keep trying" accepts; "no, do the
 *     other thing" does not).
 *
 * A message that fails either gate falls through to normal handling — the
 * pending task simply stays queued, so the sender can accept later.
 */
export function isRetryAcceptance(text: string | null | undefined): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (NON_WORD_ONLY_RE.test(raw)) return ACCEPT_EMOJI_RE.test(raw);
  const n = normalizeRetryAnswer(raw);
  if (!n) return false;
  if (DECLINE_TOKEN_RE.test(n)) return false;
  if (ACCEPT_PHRASES.has(n)) return true;
  const words = n.split(' ').filter(Boolean);
  if (words.length > 6) return false;
  if (!ACCEPT_TOKEN_RE.test(n)) return false;
  // Every other word must be filler: see ACCEPT_FILLER.
  return words.every((w) => ACCEPT_FILLER.has(w) || ACCEPT_TOKEN_RE.test(w));
}

/** Is this message the sender cancelling the retry offer? */
export function isRetryDecline(text: string | null | undefined): boolean {
  const raw = String(text ?? '').trim();
  if (!raw || NON_WORD_ONLY_RE.test(raw)) return false;
  const n = normalizeRetryAnswer(raw);
  if (!n) return false;
  if (DECLINE_PHRASES.has(n)) return true;
  const words = n.split(' ').filter(Boolean);
  // TWO words, max. "no, don't send it to her" is a different request that
  // happens to contain a decline token — treating it as "cancel" would drop the
  // user's actual instruction as well as their task.
  if (words.length > 2) return false;
  // A decline must not carry an accept token: "no, keep trying" is ambiguous,
  // and guessing wrong CANCELS work the user asked to continue.
  if (ACCEPT_TOKEN_RE.test(n)) return false;
  return DECLINE_TOKEN_RE.test(n);
}

// ─── Sender-facing lines ────────────────────────────────────────────────────

/** Confirmation sent the moment an offer is accepted. */
export function acceptedLine(task: DeferredTask, now: number = Date.now()): string {
  const wait = Math.max(0, task.notBefore - now);
  const when = wait > 60_000 ? `in about ${Math.round(wait / 60_000)}m` : 'shortly';
  return (
    `👍 Understood — I'll keep trying and message you here the moment it's done.\n` +
    `Next attempt ${when}. Reply *stop* to cancel.`
  );
}

/** The line sent when a retry gives up (TTL or attempt cap reached). */
export function abandonedLine(task: DeferredTask, now: number = Date.now()): string {
  const mins = Math.max(1, Math.round((now - task.createdAt) / 60_000));
  const span = mins >= 90 ? `about ${Math.round(mins / 60)}h` : `about ${mins}m`;
  const tries = `${task.attempts} attempt${task.attempts === 1 ? '' : 's'}`;
  if (!task.confirmed) {
    // Honest about WHY it stopped: the sender never confirmed, so this is a
    // courtesy report, not a broken promise.
    return (
      `😔 "${task.text.slice(0, 90)}" still couldn't run — I tried again ${tries} over ${span} and no model came back. ` +
      `I've stopped. Reply *yes* if you want me to keep checking and run it the moment one is free.`
    );
  }
  return (
    `😔 I kept retrying "${task.text.slice(0, 90)}" for ${span} (${tries}) and no model became available. ` +
    `I've stopped rather than hold your request forever. Say *retry* any time and I'll start again.`
  );
}

/** The line sent when a retry attempt starts, so an unexpected reply is explained. */
export function retryingLine(task: DeferredTask): string {
  const cap = attemptCap(task);
  return `🔁 Trying again now (attempt ${task.attempts} of at most ${cap}) — you asked for: "${task.text.slice(0, 80)}"`;
}

/** Count of live tasks (status surfaces / dashboard). */
export function pendingTaskCount(): number {
  return loadDeferredTasks().length;
}

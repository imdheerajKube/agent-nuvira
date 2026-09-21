/**
 * The deferred retry queue — the mechanism behind "Reply *yes* and I will keep
 * trying until it is done."
 *
 * The offer itself was already shipped (see `renderModelBreadthReport`), and it
 * went out live to WhatsApp. Nothing parsed the "yes", stored the task or re-ran
 * it, so a sender who followed the instruction got silence. These tests pin the
 * store's lifecycle AND the reply matcher, because the matcher is the part that
 * can silently destroy a user's real request if it is too eager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFERRED_TASK_TTL_MS,
  UNCONFIRMED_TASK_TTL_MS,
  abandonedLine,
  acceptedLine,
  attemptCap,
  cancelTasksFor,
  confirmTask,
  deferTask,
  dueTasks,
  expiredTasks,
  getPendingTask,
  isRetryAcceptance,
  isRetryDecline,
  listPendingTasks,
  removeDeferredTask,
  retryWaitMs,
  retryingLine,
  updateDeferredTask,
} from '../../src/learning/deferred-task.js';

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-deferred-'));
  process.env.NUVIRA_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const ASK = 'explain how the router picks a model';

function defer(overrides: Partial<Parameters<typeof deferTask>[0]> = {}) {
  return deferTask({
    platform: 'whatsapp',
    channelId: '918800604222@s.whatsapp.net',
    text: ASK,
    kind: 'chat',
    ...overrides,
  });
}

describe('deferred task queue — lifecycle', () => {
  it('queues a failed ask, persisted so a restart can resume it', () => {
    const { task, created } = defer({ nextFreeInMs: 60_000 });
    expect(created).toBe(true);
    expect(task.attempts).toBe(0);
    expect(task.status).toBe('pending');
    expect(task.confirmed).toBeUndefined();
    // An ask nobody confirmed gets the SHORT horizon: never enroll a user in a
    // six-hour retry loop they did not agree to.
    expect(task.deadline - task.createdAt).toBe(UNCONFIRMED_TASK_TTL_MS);
    expect(existsSync(join(tempDir, 'deferred-tasks.json'))).toBe(true);
    expect(getPendingTask('whatsapp', '918800604222@s.whatsapp.net')?.id).toBe(task.id);
  });

  it('refreshes the SAME task on a repeat failure instead of resetting it', () => {
    const first = defer({ nextFreeInMs: 30_000 }).task;
    updateDeferredTask(first.id, { attempts: 3, notBefore: Date.now() - 1 });

    const again = defer({ nextFreeInMs: 90_000 });
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.id);
    // The counters survive: a retry that fails re-enters this function, and
    // resetting here would make the attempt cap and TTL meaningless.
    expect(again.task.attempts).toBe(3);
    expect(again.task.notBefore).toBeGreaterThan(Date.now());
    expect(listPendingTasks()).toHaveLength(1);
  });

  it('keeps a second, DIFFERENT ask as its own task (dedupe is exact, not per-contact)', () => {
    defer();
    defer({ text: 'summarise the changelog' });
    expect(listPendingTasks()).toHaveLength(2);
  });

  it('parks a task until notBefore, then makes it due', () => {
    const { task } = defer({ nextFreeInMs: 600_000 });
    expect(dueTasks()).toHaveLength(0);
    updateDeferredTask(task.id, { notBefore: Date.now() - 1 });
    expect(dueTasks().map((t) => t.id)).toEqual([task.id]);
  });

  it('treats an unconfirmed task as expired after its short horizon', () => {
    const { task } = defer();
    updateDeferredTask(task.id, { deadline: Date.now() - 1 });
    expect(expiredTasks().map((t) => t.id)).toEqual([task.id]);
    expect(dueTasks()).toHaveLength(0);
  });

  it('a confirmation buys the long horizon and the full attempt allowance', () => {
    const { task } = defer();
    expect(attemptCap(task)).toBeLessThan(40);
    const confirmed = confirmTask(task.id)!;
    expect(confirmed.confirmed).toBe(true);
    expect(attemptCap(confirmed)).toBe(40);
    expect(confirmed.deadline - Date.now()).toBeGreaterThan(DEFERRED_TASK_TTL_MS - 5_000);
  });

  it('one success clears the task; one decline clears them all', () => {
    const { task } = defer();
    removeDeferredTask(task.id);
    expect(getPendingTask('whatsapp', '918800604222@s.whatsapp.net')).toBeUndefined();

    defer();
    defer({ text: 'and explain the cache' });
    expect(cancelTasksFor('whatsapp', '918800604222@s.whatsapp.net')).toBe(2);
    expect(listPendingTasks()).toHaveLength(0);
  });

  it('clamps a free-up hint so a "5s" hint cannot become a hot loop', () => {
    expect(retryWaitMs(5_000)).toBe(20_000);
    expect(retryWaitMs(90_000)).toBe(90_000);
    expect(retryWaitMs(10 * 3_600_000)).toBe(3_600_000);
    expect(retryWaitMs(undefined)).toBe(5 * 60_000);
    expect(retryWaitMs(0)).toBe(5 * 60_000);
  });
});

describe('a retry abandoned mid-attempt is recovered, not stranded', () => {
  it('re-pends a task left `running` by a process that died', () => {
    const { task } = defer();
    // The attempt was claimed (status running) and then the process went away —
    // a restart during a quota wait, which is the normal case.
    updateDeferredTask(task.id, { status: 'running', attempts: 1, lastAttemptAt: Date.now() - 20 * 60_000 });

    // A `running` task is invisible to BOTH drain queries, so without the
    // recovery the ask (and the promise) would be lost forever.
    expect(dueTasks().map((t) => t.id)).toEqual([task.id]);
    expect(getPendingTask('whatsapp', '918800604222@s.whatsapp.net')?.status).toBe('pending');
    // The repair is persisted, so the next reader sees it too.
    expect(listPendingTasks().find((t) => t.id === task.id)?.status).toBe('pending');
  });

  it('never steals a LIVE attempt', () => {
    const { task } = defer();
    updateDeferredTask(task.id, { status: 'running', attempts: 1, lastAttemptAt: Date.now() - 60_000 });

    expect(dueTasks()).toHaveLength(0);
    expect(getPendingTask('whatsapp', '918800604222@s.whatsapp.net')?.status).toBe('running');
  });
});

describe('retry-offer replies', () => {
  it('accepts the plain and polite forms', () => {
    for (const yes of ['yes', 'Yes', 'YES!', 'yep', 'ok', 'okay', 'sure', 'haan', 'go ahead', 'keep trying', 'yes please', 'yes, please keep trying', 'please do', 'try again', '👍', 'Yes 🙏']) {
      expect(isRetryAcceptance(yes), yes).toBe(true);
    }
  });

  it('never swallows a NEW request that merely starts with yes', () => {
    // The whole point of the guard: these are real asks, and treating them as
    // "yes" would drop the user's instruction on the floor.
    for (const notYes of [
      'yes I also want a website for the shop',
      'yes but make it in hindi please',
      'yes, now build the whole API with tests',
      'no, don\'t send it to her — send it to my brother instead',
      'explain the router',
      'ok so what about the cache then?',
    ]) {
      expect(isRetryAcceptance(notYes), notYes).toBe(false);
    }
  });

  it('does not treat unrelated messages or emoji as an answer', () => {
    expect(isRetryAcceptance('')).toBe(false);
    expect(isRetryAcceptance('....')).toBe(false);
    expect(isRetryAcceptance('😀')).toBe(false);
    expect(isRetryAcceptance('thanks!')).toBe(false);
  });

  it('recognises a decline, and only as its OWN message', () => {
    for (const no of ['no', 'nope', 'stop', 'cancel', 'forget it', 'never mind', 'no thanks', 'dont']) {
      expect(isRetryDecline(no), no).toBe(true);
    }
    // A longer message with a decline token is a different instruction.
    expect(isRetryDecline("no, don't send it to her")).toBe(false);
    // Ambiguous: declining AND continuing is not a decline.
    expect(isRetryDecline('no, keep trying')).toBe(false);
    expect(isRetryDecline('yes')).toBe(false);
  });

  it('the sender-facing lines name the attempt and the horizon', () => {
    const { task } = defer({ nextFreeInMs: 120_000 });
    expect(acceptedLine(task)).toMatch(/Next attempt in about 2m/);
    expect(acceptedLine(task)).toMatch(/Reply \*stop\*/);
    expect(retryingLine({ ...task, attempts: 3 })).toContain('attempt 3');
    expect(abandonedLine({ ...task, attempts: 2 })).toMatch(/I've stopped/);
    expect(abandonedLine({ ...task, attempts: 2, confirmed: true })).toMatch(/kept retrying/);
  });
});

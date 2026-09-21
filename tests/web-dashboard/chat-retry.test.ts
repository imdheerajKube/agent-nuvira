/**
 * Dashboard chat retries — the GUI twin of the gateway's deferred retry loop.
 *
 * The behaviour that matters: a failed dashboard turn must leave the user with a
 * REAL next step (the ask is queued and re-run when a model is back), the queued
 * ask must belong to the dashboard so the gateway never tries to deliver a
 * session id to a messaging platform, and a `yes`/`stop` reply must be answered
 * without running a model turn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatRetryBroker, DASHBOARD_PLATFORM, type ChatRetryEvent } from '../../src/web-dashboard/chat-retry.js';
import {
  deferTask,
  getPendingTask,
  listPendingTasks,
  updateDeferredTask,
} from '../../src/learning/deferred-task.js';

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-dash-retry-'));
  process.env.NUVIRA_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const SESSION = 'session-abc';
const ASK = 'explain how the router picks a model';

/** A report with one tried model, i.e. something concrete to tell the user. */
function breadthWith(models: number, nextFreeInMs?: number) {
  return () => ({
    tried: Array.from({ length: models }, (_, i) => ({
      provider: 'gemini',
      model: `model-${i}`,
      kind: 'rate-limit',
      skipped: false,
      reason: 'rate limited (quota) — still logged in, just throttled',
    })),
    parked: [],
    ...(nextFreeInMs !== undefined ? { nextFreeInMs } : {}),
  });
}

function broker(overrides: Partial<ConstructorParameters<typeof ChatRetryBroker>[0]> = {}) {
  const events: ChatRetryEvent[] = [];
  const persisted: Array<{ sessionId: string; user: string | null; assistant: string }> = [];
  const answers: string[] = [];
  const instance = new ChatRetryBroker({
    answer: async (_sessionId, text) => {
      answers.push(text);
      return { ok: true, content: 'The router picks the cheapest healthy model.' };
    },
    notify: (e) => events.push(e),
    persistTurn: (sessionId, user, assistant) => persisted.push({ sessionId, user, assistant }),
    breadth: breadthWith(2, 60_000),
    markAttempts: () => 0,
    ...overrides,
  });
  return { instance, events, persisted, answers };
}

describe('a failed dashboard turn queues the retry it just offered', () => {
  it('returns the report AND files the ask under the dashboard platform', () => {
    const { instance } = broker();
    const report = instance.onFailure(SESSION, ASK)!;

    expect(report).toMatch(/Reply \*yes\*/i);
    expect(report).toContain('I tried 2 models');
    const task = getPendingTask(DASHBOARD_PLATFORM, SESSION)!;
    expect(task.text).toBe(ASK);
    expect(task.kind).toBe('chat');
    expect(task.attempts).toBe(0);
  });

  it('queues NOTHING when there is nothing concrete to report (no offer, no promise)', () => {
    const { instance } = broker({ breadth: breadthWith(0) });
    expect(instance.onFailure(SESSION, ASK)).toBeUndefined();
    expect(listPendingTasks()).toHaveLength(0);
  });
});

describe('a yes/stop reply is answered without a model turn', () => {
  it('confirms the queue entry, records the exchange, and does not broadcast it', () => {
    const { instance, events, persisted } = broker();
    instance.onFailure(SESSION, ASK);

    const reply = instance.consumeAnswer(SESSION, 'yes')!;
    expect(reply).toMatch(/keep trying/);
    expect(reply).toMatch(/Next attempt/);

    const task = getPendingTask(DASHBOARD_PLATFORM, SESSION)!;
    expect(task.confirmed).toBe(true);
    // The HTTP response to the acting tab delivers this line; broadcasting it
    // too would render the confirmation twice.
    expect(events).toHaveLength(0);
    expect(persisted[0]).toMatchObject({ sessionId: SESSION, user: 'yes' });
    expect(persisted[0]!.assistant).toBe(reply);
  });

  it('cancels on stop', () => {
    const { instance, persisted } = broker();
    instance.onFailure(SESSION, ASK);

    const reply = instance.consumeAnswer(SESSION, 'stop')!;
    expect(reply).toMatch(/stopped retrying/);
    expect(getPendingTask(DASHBOARD_PLATFORM, SESSION)).toBeUndefined();
    expect(persisted[0]!.user).toBe('stop');
  });

  it('lets a NEW request through untouched, keeping the queue entry', () => {
    const { instance } = broker();
    instance.onFailure(SESSION, ASK);

    expect(instance.consumeAnswer(SESSION, 'write me a poem about the sea')).toBeNull();
    expect(getPendingTask(DASHBOARD_PLATFORM, SESSION)?.text).toBe(ASK);
  });

  it('ignores an answer when nothing was offered', () => {
    const { instance } = broker();
    expect(instance.consumeAnswer(SESSION, 'yes')).toBeNull();
  });
});

describe('the drain runs the queued ask', () => {
  it('re-runs it, pushes the answer, records it, and settles the task', async () => {
    const { instance, events, persisted, answers } = broker();
    instance.onFailure(SESSION, ASK);
    const task = getPendingTask(DASHBOARD_PLATFORM, SESSION)!;
    updateDeferredTask(task.id, { notBefore: Date.now() - 1 });

    await instance.drain();

    expect(answers).toEqual([ASK]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: SESSION, kind: 'answer', attempts: 1 });
    expect(events[0]!.content).toMatch(/Trying again now \(attempt 1/);
    expect(events[0]!.content).toContain('The router picks the cheapest healthy model.');
    // Persisted as well as pushed: the promise outlives the open tab.
    expect(persisted.at(-1)!.assistant).toBe(events[0]!.content);
    expect(getPendingTask(DASHBOARD_PLATFORM, SESSION)).toBeUndefined();
  });

  it('re-queues and reports when the retry fails again', async () => {
    const { instance, events } = broker({
      answer: async () => ({ ok: true, content: '', generationFailed: true }),
    });
    instance.onFailure(SESSION, ASK);
    const task = getPendingTask(DASHBOARD_PLATFORM, SESSION)!;
    updateDeferredTask(task.id, { notBefore: Date.now() - 1 });

    await instance.drain();

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');
    expect(events[0]!.content).toMatch(/I tried 2 models/);
    const after = getPendingTask(DASHBOARD_PLATFORM, SESSION)!;
    expect(after.id).toBe(task.id);
    expect(after.attempts).toBe(1);
    expect(after.notBefore).toBeGreaterThan(Date.now());
  });

  it('waits for a busy session instead of colliding with a live turn', async () => {
    const { instance, answers } = broker({ isBusy: () => true });
    instance.onFailure(SESSION, ASK);
    const task = getPendingTask(DASHBOARD_PLATFORM, SESSION)!;
    updateDeferredTask(task.id, { notBefore: Date.now() - 1 });

    await instance.drain();

    expect(answers).toHaveLength(0);
    expect(getPendingTask(DASHBOARD_PLATFORM, SESSION)?.attempts).toBe(0);
  });

  it('reports an expired retry and stops holding the ask', async () => {
    const { instance, events } = broker();
    instance.onFailure(SESSION, ASK);
    const task = getPendingTask(DASHBOARD_PLATFORM, SESSION)!;
    updateDeferredTask(task.id, { deadline: Date.now() - 1 });

    await instance.drain();

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('abandoned');
    expect(events[0]!.content).toMatch(/still couldn't run|kept retrying/);
    expect(getPendingTask(DASHBOARD_PLATFORM, SESSION)).toBeUndefined();
  });

  it('OWNERSHIP: never touches a task belonging to another surface (the gateway)', async () => {
    const { instance, events, answers } = broker();
    // A WhatsApp ask, mid-wait, in the SAME store.
    deferTask({
      platform: 'whatsapp',
      channelId: '918800604222@s.whatsapp.net',
      text: 'build me a calculator',
      kind: 'pipeline',
      nextFreeInMs: 60_000,
    });
    const gw = getPendingTask('whatsapp', '918800604222@s.whatsapp.net')!;
    updateDeferredTask(gw.id, { notBefore: Date.now() - 1 });

    await instance.drain();

    expect(answers).toHaveLength(0);
    expect(events).toHaveLength(0);
    // Still queued for the gateway to own.
    expect(getPendingTask('whatsapp', '918800604222@s.whatsapp.net')).toBeDefined();
  });
});

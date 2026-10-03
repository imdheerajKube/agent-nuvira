/**
 * Continuity command — tests for src/cli/continuity.ts.
 *
 * Continuity is DEFAULT ON, so `nuvira continuity list` reports the effective
 * switch state through the same resolvers the engine uses, and `clear` forgets
 * what was stored. Both are exercised against a temp homedir / NUVIRA_MEMORY_DIR
 * so no real user data is touched, and `clearContinuity` is driven directly so
 * the test does not depend on commander's process handling.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-continuity-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
}));

import { ContinuityCommand, buildContinuitySummary, clearContinuity } from '../../src/cli/continuity.js';
import {
  openSession,
  listSessionSnapshots,
  resolveSessionStore,
} from '../../src/learning/session-store.js';
import { clearSessionRecallIndex, listRecallEntries, resolveSessionRecall } from '../../src/learning/session-recall.js';
import type { ToolMessage } from '../../src/inference/interface.js';

const ORIGINAL_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_MEMORY_DIR = join(testDirHolder.value, 'memory');
});

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(testDirHolder.value, { recursive: true, force: true });
});

beforeEach(() => {
  clearContinuity();
  delete process.env.NUVIRA_SESSION_STORE;
  delete process.env.NUVIRA_SESSION_RECALL;
});

/** Write one open session snapshot for the given goal. */
function seedSession(goal: string): string {
  const store = openSession({ goal, cwd: process.cwd() });
  store.save(
    [{ role: 'assistant', content: 'working' } as ToolMessage],
    { steps: 2, successfulTools: [], mutatedPaths: [] },
  );
  return store.id;
}

describe('ContinuityCommand', () => {
  it('registers a `continuity` command with list and clear subcommands', () => {
    const command = new ContinuityCommand().create();
    expect(command.name()).toBe('continuity');
    const sub = command.commands.map((c) => c.name());
    expect(sub).toEqual(expect.arrayContaining(['list', 'clear']));
  });
});

describe('buildContinuitySummary', () => {
  it('reports the default switch state as ON when nothing is configured', () => {
    const cm = { getAll: () => ({}) };
    const summary = buildContinuitySummary(cm);
    expect(summary.sessionStore).toBe(true);
    expect(summary.sessionRecall).toBe(true);
  });

  it('honours an explicit config opt-out', () => {
    const cm = { getAll: () => ({ memory: { sessionStore: false, sessionRecall: false } }) };
    const summary = buildContinuitySummary(cm);
    expect(summary.sessionStore).toBe(false);
    expect(summary.sessionRecall).toBe(false);
  });

  it('reflects the stored snapshots and recall entries', () => {
    seedSession('add a login page');

    const cm = { getAll: () => ({}) };
    const summary = buildContinuitySummary(cm);
    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0].goal).toBe('add a login page');
    expect(summary.recall).toHaveLength(0);
  });
});

describe('clearContinuity', () => {
  it('clears both sessions and recall when no flag is given', () => {
    seedSession('do a thing');
    expect(listSessionSnapshots()).toHaveLength(1);

    const result = clearContinuity();
    expect(result.wantSessions).toBe(true);
    expect(result.wantRecall).toBe(true);
    expect(result.removedSessions).toBe(1);
    expect(listSessionSnapshots()).toHaveLength(0);
  });

  it('narrows to sessions only with --sessions', () => {
    seedSession('do a thing');

    const result = clearContinuity({ sessions: true });
    expect(result.wantSessions).toBe(true);
    expect(result.wantRecall).toBe(false);
    expect(result.removedSessions).toBe(1);
  });

  it('narrows to recall only with --recall', () => {
    seedSession('do a thing');

    const result = clearContinuity({ recall: true });
    expect(result.wantSessions).toBe(false);
    expect(result.wantRecall).toBe(true);
    expect(result.removedSessions).toBe(0);
    expect(listSessionSnapshots()).toHaveLength(1);
  });
});

describe('continuity resolvers — env off-switch', () => {
  it('reads the default as ON and an OFF word as off', () => {
    const cm = { getAll: () => ({}) };
    expect(resolveSessionStore({ configManager: cm })).toBe(true);
    process.env.NUVIRA_SESSION_STORE = 'off';
    expect(resolveSessionStore({ configManager: cm })).toBe(false);
    delete process.env.NUVIRA_SESSION_STORE;

    expect(resolveSessionRecall({ configManager: cm })).toBe(true);
    process.env.NUVIRA_SESSION_RECALL = '0';
    expect(resolveSessionRecall({ configManager: cm })).toBe(false);
  });

  it('leaves a closed snapshot out of the resumable set but still lists it', () => {
    const store = openSession({ goal: 'finished ask', cwd: process.cwd() });
    store.save(
      [{ role: 'assistant', content: 'done' } as ToolMessage],
      { steps: 1, successfulTools: [], mutatedPaths: [] },
    );
    store.finish();
    const all = listSessionSnapshots();
    expect(all).toHaveLength(1);
    expect(all[0].open).toBe(false);
    expect(listRecallEntries()).toHaveLength(0);
    expect(clearSessionRecallIndex()).toBe(false);
  });
});

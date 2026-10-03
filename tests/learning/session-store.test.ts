/**
 * Phase 4b/4c — the PERSISTENT SESSION STORE.
 *
 * The promise: a process that dies mid-turn leaves a BOUNDED, REDACTED transcript
 * that the next process can pick up (rehydrate), without re-doing the steps it
 * already completed. The store is history, never a status — a finished turn is
 * closed and not resumable; a reworded re-ask finds the same session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_MESSAGE_CHARS,
  MAX_SESSION_MESSAGES,
  clearSession,
  findResumableSessionFor,
  formatSessionResume,
  loadSessionSnapshot,
  openSession,
  pruneSessions,
  rehydrateThread,
  resolveSessionIdFor,
} from '../../src/learning/session-store.js';
import { checkpointIdFor } from '../../src/agents/checkpoint-store.js';
import type { ToolMessage } from '../../src/inference/interface.js';

const dirs: string[] = [];
const origMem = process.env.NUVIRA_MEMORY_DIR;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'session-store-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  process.env.NUVIRA_MEMORY_DIR = tmp();
});
afterEach(() => {
  if (origMem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = origMem;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HEAD: ToolMessage[] = [
  { role: 'system', content: 'You are Nuvira.' },
  { role: 'user', content: '[Project context]\nfiles: a.ts' },
];

function thread(...tail: ToolMessage[]): ToolMessage[] {
  return [...HEAD, { role: 'user', content: 'fix the hotkey' }, ...tail];
}

describe('session store — round trip', () => {
  it('saves and reloads the thread and accumulators', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'fix the hotkey', cwd });
    store.save(thread({ role: 'assistant', content: 'checking' }, { role: 'tool', toolCallId: '1', content: 'ok' }), {
      steps: 2,
      successfulTools: ['read_file'],
      mutatedPaths: ['src/a.ts'],
    });
    expect(store.lastSaved()).toBe(true);

    const snap = loadSessionSnapshot(store.id);
    expect(snap).not.toBeNull();
    expect(snap!.goal).toBe('fix the hotkey');
    expect(snap!.cwd).toBe(cwd);
    expect(snap!.open).toBe(true);
    expect(snap!.accumulators.steps).toBe(2);
    expect(snap!.accumulators.successfulTools).toEqual(['read_file']);
    expect(snap!.accumulators.mutatedPaths).toEqual(['src/a.ts']);
    // Head (system + project context) + goal + two tail messages.
    expect(snap!.messages.length).toBe(5);
    expect(snap!.headLength).toBe(2);
  });

  it('uses the deterministic checkpoint id by default', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'fix the hotkey', cwd });
    expect(store.id).toBe(checkpointIdFor('fix the hotkey', cwd));
  });

  it('honours an explicit id exactly', () => {
    const store = openSession({ goal: 'anything', cwd: tmp(), id: 'sess-42' });
    expect(store.id).toBe('sess-42');
  });
});

describe('session store — reworded re-ask', () => {
  it('finds an OPEN session for the same ask, worded differently', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'build the translator app', cwd });
    store.save(thread({ role: 'assistant', content: 'made index.html' }), {
      steps: 1,
      successfulTools: ['write_file'],
      mutatedPaths: ['index.html'],
    });

    const found = findResumableSessionFor('build translator app again', cwd);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(store.id);
    expect(resolveSessionIdFor('build translator app again', cwd)).toBe(store.id);
  });

  it('does NOT match a different ask in the same directory', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'update the readme documentation', cwd });
    store.save(thread(), { steps: 1, successfulTools: [], mutatedPaths: [] });
    expect(findResumableSessionFor('fix the hotkey permission', cwd)).toBeNull();
    expect(resolveSessionIdFor('fix the hotkey permission', cwd)).toBe(
      checkpointIdFor('fix the hotkey permission', cwd),
    );
    expect(store.id).toBe(checkpointIdFor('update the readme documentation', cwd));
  });

  it('does NOT match a session from a different directory', () => {
    const store = openSession({ goal: 'fix the hotkey', cwd: tmp() });
    store.save(thread(), { steps: 1, successfulTools: [], mutatedPaths: [] });
    expect(findResumableSessionFor('fix the hotkey', tmp())).toBeNull();
  });
});

describe('session store — a finished turn is history, not a resume point', () => {
  it('finish() closes the session so it is not resumable, but it is still readable', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'fix the hotkey', cwd });
    store.save(thread({ role: 'assistant', content: 'done' }), {
      steps: 1,
      successfulTools: ['edit_file'],
      mutatedPaths: ['a.ts'],
    });
    store.finish();

    // Still on disk and readable (history)…
    const snap = loadSessionSnapshot(store.id);
    expect(snap).not.toBeNull();
    expect(snap!.open).toBe(false);
    // …but NOT offered as a resume point.
    expect(findResumableSessionFor('fix the hotkey', cwd)).toBeNull();
  });
});

describe('session store — bounds and redaction', () => {
  it('keeps only the most recent MAX_SESSION_MESSAGES messages', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'grow', cwd });
    const many: ToolMessage[] = [
      HEAD[0],
      HEAD[1],
      { role: 'user', content: 'grow' },
      ...Array.from({ length: MAX_SESSION_MESSAGES + 10 }, (_, i): ToolMessage => ({
        role: 'tool',
        toolCallId: String(i),
        content: `result ${i}`,
      })),
    ];
    store.save(many, { steps: 1, successfulTools: [], mutatedPaths: [] });
    const snap = loadSessionSnapshot(store.id)!;
    expect(snap.messages.length).toBe(MAX_SESSION_MESSAGES);
    // The TAIL survives (newest results kept).
    expect(snap.messages[snap.messages.length - 1].content).toBe(`result ${MAX_SESSION_MESSAGES + 9}`);
  });

  it('clips an over-long message', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'big', cwd });
    store.save(thread({ role: 'assistant', content: 'x'.repeat(MAX_MESSAGE_CHARS * 2) }), {
      steps: 1,
      successfulTools: [],
      mutatedPaths: [],
    });
    const snap = loadSessionSnapshot(store.id)!;
    const big = snap.messages.find((m) => m.content.startsWith('xxx'));
    expect(big).toBeDefined();
    expect(big!.content.length).toBeLessThan(MAX_MESSAGE_CHARS + 20);
    expect(big!.content.endsWith('…[clipped]')).toBe(true);
  });

  it('redacts a secret-shaped value before it reaches the disk', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'env', cwd });
    store.save(thread({ role: 'assistant', content: 'export API_KEY=sk-abcdefghijklmnop' }), {
      steps: 1,
      successfulTools: [],
      mutatedPaths: [],
    });
    const snap = loadSessionSnapshot(store.id)!;
    const joined = snap.messages.map((m) => m.content).join('\n');
    expect(joined).not.toContain('sk-abcdefghijklmnop');
    expect(joined).toMatch(/API_KEY/);
  });
});

describe('session store — rehydration', () => {
  it('replaces the stored head with a fresh head and keeps the conversation tail', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'fix the hotkey', cwd });
    store.save(
      thread({ role: 'assistant', content: 'checking' }, { role: 'tool', toolCallId: '1', content: 'ok' }),
      { steps: 1, successfulTools: ['read_file'], mutatedPaths: [] },
    );
    const snap = loadSessionSnapshot(store.id)!;

    const freshHead: ToolMessage[] = [
      { role: 'system', content: 'You are Nuvira. (fresh)' },
      { role: 'user', content: '[Project context]\nfiles: a.ts, b.ts' },
    ];
    const rehydrated = rehydrateThread(freshHead, snap);

    expect(rehydrated[0].content).toContain('(fresh)');
    expect(rehydrated[2]).toEqual({ role: 'user', content: 'fix the hotkey' });
    expect(rehydrated[3]).toEqual({ role: 'assistant', content: 'checking' });
    expect(rehydrated[4]).toEqual({ role: 'tool', toolCallId: '1', content: 'ok' });
  });

  it('clamps a head length longer than the stored messages (never leaks a head)', () => {
    const snap = {
      id: 'x', goal: 'g', cwd: '/tmp', savedAt: 0, revision: 1, open: true,
      headLength: 99,
      messages: [{ role: 'user', content: 'g' } as ToolMessage],
      accumulators: { steps: 0, successfulTools: [], mutatedPaths: [] },
    };
    // A stored head that covers the whole record yields no tail — the fresh head
    // is all that remains, which is safe (never resurrects a stale system prompt).
    expect(rehydrateThread([], snap)).toEqual([]);
  });
});

describe('session store — robustness and lifecycle', () => {
  it('a corrupt record is a miss, never a crash', () => {
    const cwd = tmp();
    const id = checkpointIdFor('fix the hotkey', cwd);
    mkdirSync(join(process.env.NUVIRA_MEMORY_DIR!, 'sessions'), { recursive: true });
    writeFileSync(join(process.env.NUVIRA_MEMORY_DIR!, 'sessions', `${id}.json`), '{ not json', 'utf-8');
    expect(loadSessionSnapshot(id)).toBeNull();
    expect(findResumableSessionFor('fix the hotkey', cwd)).toBeNull();
  });

  it('writes nothing when no session is opened', () => {
    const dir = join(process.env.NUVIRA_MEMORY_DIR!, 'sessions');
    expect(existsSync(dir)).toBe(false);
  });

  it('clearSession removes the record', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'fix the hotkey', cwd });
    store.save(thread(), { steps: 1, successfulTools: [], mutatedPaths: [] });
    expect(clearSession(store.id)).toBe(true);
    expect(loadSessionSnapshot(store.id)).toBeNull();
    expect(clearSession(store.id)).toBe(false);
  });

  it('pruneSessions drops the oldest beyond the count cap', () => {
    const cwd = tmp();
    for (let i = 0; i < 5; i += 1) {
      const store = openSession({ goal: `task ${i}`, cwd, id: `s-${i}` });
      store.save(thread({ role: 'assistant', content: `did ${i}` }), {
        steps: 1,
        successfulTools: [],
        mutatedPaths: [],
      });
    }
    const removed = pruneSessions({ maxCount: 2, maxAgeMs: 0 });
    expect(removed).toBe(3);
  });

  it('formatSessionResume says this is HISTORY, not a status', () => {
    const cwd = tmp();
    const store = openSession({ goal: 'fix the hotkey', cwd });
    store.save(thread({ role: 'assistant', content: 'x' }), {
      steps: 3,
      successfulTools: ['read_file', 'edit_file'],
      mutatedPaths: ['a.ts'],
    });
    const line = formatSessionResume(loadSessionSnapshot(store.id)!);
    expect(line).toContain('OPEN');
    expect(line).toMatch(/HISTORY, not a status/);
    expect(line).toMatch(/verify artifacts on disk/);
  });
});

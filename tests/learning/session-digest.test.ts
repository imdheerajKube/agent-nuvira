/**
 * Phase 4 / G6 — the DETERMINISTIC cross-session session digest.
 *
 * Two things are pinned here, and they are different in kind:
 *
 *   1. the STORE (record / get / format / bounds / clear) behaves like the rest
 *      of the deterministic ledgers — per-project, self-bounded, best-effort; and
 *   2. the ADVISORY-ONLY guarantee, which is the whole reason this is a facts
 *      digest and not an LLM summary: a recorded turn that CLAIMS success can
 *      never become a completion signal. Completion still derives from loop
 *      facts and artifacts on disk (see `buildTraceOutcome`), and the digest is
 *      never an input to that decision.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordSessionTurn,
  getSessionDigest,
  formatSessionDigest,
  clearSessionDigest,
  MAX_TURNS,
  MAX_TOOLS_PER_TURN,
  MAX_GOAL_CHARS,
} from '../../src/learning/session-digest.js';
import { buildTraceOutcome, traceOutcomeSucceeded } from '../../src/learning/reasoning-trace.js';

let dir: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-digest-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = dir;
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(dir, { recursive: true, force: true });
});

const PROJECT = '/tmp/example-calc';

describe('recordSessionTurn / getSessionDigest', () => {
  it('round-trips a turn and reads it back', () => {
    recordSessionTurn({
      projectPath: PROJECT,
      goal: 'add keyboard support to the converter',
      outcome: 'acted',
      tools: ['write_file', 'run_terminal'],
      verified: true,
    });
    const digest = getSessionDigest(PROJECT)!;
    expect(digest.turns).toHaveLength(1);
    expect(digest.turns[0]!.goal).toContain('keyboard support');
    expect(digest.turns[0]!.outcome).toBe('acted');
    expect(digest.turns[0]!.tools).toEqual(['write_file', 'run_terminal']);
    expect(digest.turns[0]!.verified).toBe(true);
  });

  it('scopes the digest per project (and returns null for a stranger)', () => {
    recordSessionTurn({ projectPath: '/tmp/proj-a', goal: 'a', outcome: 'acted' });
    recordSessionTurn({ projectPath: '/tmp/proj-b', goal: 'b', outcome: 'failed' });
    expect(getSessionDigest('/tmp/proj-a')!.turns[0]!.goal).toBe('a');
    expect(getSessionDigest('/tmp/proj-b')!.turns[0]!.outcome).toBe('failed');
    expect(getSessionDigest('/tmp/never-seen')).toBeNull();
  });

  it('dedupes tools per turn', () => {
    recordSessionTurn({
      projectPath: PROJECT,
      goal: 'x',
      outcome: 'acted',
      tools: ['write_file', 'write_file', 'run_terminal'],
    });
    expect(getSessionDigest(PROJECT)!.turns[0]!.tools).toEqual(['write_file', 'run_terminal']);
  });

  it('caps the tools kept per turn', () => {
    const tools = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
    recordSessionTurn({ projectPath: PROJECT, goal: 'x', outcome: 'acted', tools });
    expect(getSessionDigest(PROJECT)!.turns[0]!.tools).toHaveLength(MAX_TOOLS_PER_TURN);
  });

  it('clips an over-long goal', () => {
    recordSessionTurn({ projectPath: PROJECT, goal: 'z'.repeat(500), outcome: 'acted' });
    const goal = getSessionDigest(PROJECT)!.turns[0]!.goal;
    expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_CHARS);
    expect(goal.endsWith('…')).toBe(true);
  });

  it('keeps only the newest MAX_TURNS (oldest dropped first)', () => {
    for (let i = 0; i < MAX_TURNS + 5; i += 1) {
      recordSessionTurn({ projectPath: PROJECT, goal: `ask ${i}`, outcome: 'acted' });
    }
    const turns = getSessionDigest(PROJECT)!.turns;
    expect(turns).toHaveLength(MAX_TURNS);
    expect(turns[0]!.goal).toBe('ask 5');
    expect(turns[turns.length - 1]!.goal).toBe(`ask ${MAX_TURNS + 4}`);
  });
});

describe('formatSessionDigest', () => {
  it('is empty for a pristine project (adds no prompt weight)', () => {
    expect(formatSessionDigest(PROJECT)).toBe('');
  });

  it('labels itself as history, NOT a status', () => {
    recordSessionTurn({ projectPath: PROJECT, goal: 'build the app', outcome: 'acted' });
    const block = formatSessionDigest(PROJECT);
    // The disclaimer is the guard rail: a model must not read an old line as
    // proof the CURRENT work is done.
    expect(block).toContain('NOT a status');
    expect(block).toContain('verify artifacts on disk');
  });

  it('renders outcome, goal and a verified marker', () => {
    recordSessionTurn({
      projectPath: PROJECT,
      goal: 'fix the hotkey',
      outcome: 'incomplete',
      tools: ['write_file'],
      verified: true,
    });
    const block = formatSessionDigest(PROJECT);
    expect(block).toContain('incomplete');
    expect(block).toContain('fix the hotkey');
    expect(block).toContain('verified');
  });

  it('shows oldest→newest so the latest ask is the last line', () => {
    recordSessionTurn({ projectPath: PROJECT, goal: 'first ask', outcome: 'acted' });
    recordSessionTurn({ projectPath: PROJECT, goal: 'second ask', outcome: 'acted' });
    const block = formatSessionDigest(PROJECT);
    expect(block.indexOf('first ask')).toBeLessThan(block.indexOf('second ask'));
  });

  it('tolerates a corrupt store file (best-effort, never throws)', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session-digests.json'), '{ not json', 'utf-8');
    expect(() => formatSessionDigest(PROJECT)).not.toThrow();
    expect(formatSessionDigest(PROJECT)).toBe('');
  });
});

describe('clearSessionDigest', () => {
  it('forgets exactly one project', () => {
    recordSessionTurn({ projectPath: PROJECT, goal: 'a', outcome: 'acted' });
    recordSessionTurn({ projectPath: '/tmp/keep', goal: 'b', outcome: 'acted' });
    clearSessionDigest(PROJECT);
    expect(getSessionDigest(PROJECT)).toBeNull();
    expect(getSessionDigest('/tmp/keep')).not.toBeNull();
  });

  it('is a no-op for an unknown project', () => {
    expect(() => clearSessionDigest('/tmp/never-seen')).not.toThrow();
  });
});

describe('ADVISORY ONLY — a digest cannot flip a completion', () => {
  it('records a "success" turn without affecting the outcome of a turn with no facts', () => {
    // A previous session recorded a triumphant turn...
    recordSessionTurn({
      projectPath: PROJECT,
      goal: 'build and verify the whole app',
      outcome: 'acted',
      tools: ['write_file', 'run_terminal'],
      verified: true,
    });
    expect(formatSessionDigest(PROJECT)).toContain('build and verify the whole app');

    // ...but `buildTraceOutcome` is a pure function of THIS turn's loop facts.
    // The digest is never an input, so an empty turn is still `answered` —
    // the old success cannot make the current turn complete.
    const quiet = buildTraceOutcome({});
    expect(quiet.kind).toBe('answered');
    expect(quiet.undeliveredArtifact).toBeUndefined();

    // And a turn that produced no deliverable is STILL incomplete, no matter
    // what the digest claims — the digest has no path to clear this flag.
    const undelivered = buildTraceOutcome({ undeliveredArtifact: true });
    expect(undelivered.kind).toBe('incomplete');
    expect(traceOutcomeSucceeded(undelivered)).toBe(false);
  });
});

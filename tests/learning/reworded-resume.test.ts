/**
 * B3 — a REWORDED ask finds its own record.
 *
 * `checkpointIdFor` hashes the literal goal, so "fix the hotkey" and "hotkey
 * still not working" are unrelated ids and the second ask cannot replay the
 * first. The pipeline arm already matches reworded goals (`goalsLookSame`); the
 * loop's replay ledger now does too.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openResume, closeResume, resolveRecordIdFor } from '../../src/learning/step-checkpoint.js';
import { checkpointIdFor } from '../../src/agents/checkpoint-store.js';

const dirs: string[] = [];
const origMem = process.env.NUVIRA_MEMORY_DIR;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'reworded-resume-'));
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

/** Write a record for `goal` in `cwd` with one recorded step. */
function seed(goal: string, cwd: string): string {
  const opened = openResume({ goal, cwd, resume: {} });
  opened.ledger.record('step-1', 'digest-1', { content: 'answer', toolCalls: [] });
  return closeResume(opened, { goal, cwd }).id;
}

describe('resolveRecordIdFor', () => {
  it('returns the exact id when a record exists for this ask', () => {
    const cwd = tmp();
    const id = seed('fix the hotkey', cwd);
    expect(resolveRecordIdFor('fix the hotkey', cwd)).toBe(id);
    expect(id).toBe(checkpointIdFor('fix the hotkey', cwd));
  });

  it('finds a record for the SAME ask worded differently', () => {
    const cwd = tmp();
    const saved = seed('fix the hotkey permission problem', cwd);
    // Different literal wording, same subject.
    const resolved = resolveRecordIdFor('fix the hotkey permission issue', cwd);
    expect(resolved).toBe(saved);
    expect(resolved).not.toBe(checkpointIdFor('fix the hotkey permission issue', cwd));
  });

  it('does NOT return a record for a different ask in the same directory', () => {
    const cwd = tmp();
    seed('update the readme documentation', cwd);
    const unrelated = resolveRecordIdFor('fix the hotkey permission', cwd);
    expect(unrelated).toBe(checkpointIdFor('fix the hotkey permission', cwd));
  });

  it('does NOT match a record from a different directory', () => {
    const other = tmp();
    const cwd = tmp();
    seed('fix the hotkey', other);
    expect(resolveRecordIdFor('fix the hotkey', cwd)).toBe(checkpointIdFor('fix the hotkey', cwd));
  });
});

describe('openResume — reworded ask replays its own record', () => {
  it('loads the reworded ask\'s recorded steps', () => {
    const cwd = tmp();
    seed('build the translator app', cwd);
    // Same subject, different wording — `goalsLookSame` matches on shared
    // subject tokens ("build" is a stopword), not on the literal string.
    const opened = openResume({ goal: 'build translator app again', cwd, resume: {} });
    expect(opened.ledger.openNotice()).toMatch(/1 recorded step/);
  });

  it('an explicit id is still honoured exactly', () => {
    const cwd = tmp();
    const id = seed('fix the hotkey', cwd);
    const opened = openResume({ goal: 'something else entirely', cwd, resume: { id } });
    expect(opened.id).toBe(id);
  });
});

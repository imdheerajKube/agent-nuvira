/**
 * G3 + G4 — working-state ledger.
 *
 * Pins the cross-turn memory the calculator session lacked: touched files,
 * verification debt, and the user's own regression reports.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  recordWorkingState,
  getWorkingState,
  clearWorkingState,
  detectRegressionSignal,
  formatWorkingState,
  normalizeProjectPath,
  reconcileWithWorkspace,
  workingStateBlock,
} from '../../src/learning/working-state.js';

let dir: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-ws-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = dir;
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(dir, { recursive: true, force: true });
});

const PROJECT = '/tmp/example-calc';

describe('detectRegressionSignal', () => {
  it('catches the phrases the calculator user actually used', () => {
    const reports = [
      "i don't see any change done by you .",
      'i still can see converter on calculator tab in the bottom.',
      'still same issue , converter tab is there when i click on converter tab it has no content',
      'no still converter is not having any conversion logic only tab is visible',
      'now converter is not appearing on calculator but also not appearing on converter as well.',
      'it is better still two issues remaining',
    ];
    for (const r of reports) expect(detectRegressionSignal(r), r).toBe(true);
  });

  it('does not treat a fresh request or a question as a regression', () => {
    expect(detectRegressionSignal('add keyboard support and style the converter')).toBe(false);
    expect(detectRegressionSignal('can you explain how the converter works?')).toBe(false);
    expect(detectRegressionSignal('')).toBe(false);
    // A long new brief is not a correction.
    expect(detectRegressionSignal('Please build a brand new dashboard with charts. '.repeat(20))).toBe(false);
  });
});

describe('recordWorkingState — verification debt', () => {
  it('accumulates unverified edit turns and clears them on a verified turn', () => {
    recordWorkingState(PROJECT, { filesTouched: ['script.js'], unverifiedEdit: true, userMessage: 'enhance the UI' });
    let s = recordWorkingState(PROJECT, { filesTouched: ['style.css'], unverifiedEdit: true, userMessage: 'still broken' })!;
    expect(s.unverifiedEdits).toBe(2);
    expect(s.corrections).toBe(1);
    expect(s.openIssues).toHaveLength(1);

    // A verified turn settles the debt AND answers the open reports.
    s = recordWorkingState(PROJECT, { filesTouched: ['script.js'], verified: true, userMessage: 'go ahead' })!;
    expect(s.unverifiedEdits).toBe(0);
    expect(s.openIssues).toEqual([]);
    expect(s.lastVerifiedAt).toBeTypeOf('number');
  });

  it('keeps the user report in their own words', () => {
    const s = recordWorkingState(PROJECT, {
      unverifiedEdit: true,
      userMessage: 'still same issue , converter tab is there when i click on converter tab it has no content',
    })!;
    expect(s.openIssues[0]).toContain('converter tab');
  });
});

describe('recordWorkingState — files + persistence', () => {
  it('dedupes touched files and keeps recency', () => {
    recordWorkingState(PROJECT, { filesTouched: ['a.js', 'b.js'], unverifiedEdit: true });
    const s = recordWorkingState(PROJECT, { filesTouched: ['a.js'], unverifiedEdit: true })!;
    expect(s.filesTouched).toEqual(['b.js', 'a.js']);
  });

  it('persists to disk and reads back', () => {
    recordWorkingState(PROJECT, { filesTouched: ['script.js'], unverifiedEdit: true, userMessage: 'still broken' });
    const read = getWorkingState(PROJECT)!;
    expect(read.filesTouched).toEqual(['script.js']);
    expect(read.turns).toBe(1);
    expect(read.corrections).toBe(1);
  });

  it('scopes state per project', () => {
    recordWorkingState('/tmp/proj-a', { filesTouched: ['a.js'], unverifiedEdit: true });
    recordWorkingState('/tmp/proj-b', { filesTouched: ['b.js'], unverifiedEdit: true });
    expect(getWorkingState('/tmp/proj-a')!.filesTouched).toEqual(['a.js']);
    expect(getWorkingState('/tmp/proj-b')!.filesTouched).toEqual(['b.js']);
  });

  it('clearWorkingState removes one project (and normalizes the key)', () => {
    recordWorkingState(PROJECT, { filesTouched: ['a.js'], unverifiedEdit: true });
    clearWorkingState(PROJECT);
    expect(getWorkingState(PROJECT)).toBeNull();
    // A native path, so the expectation is the platform's own normalization —
    // `/tmp/example-calc` is `D:\\tmp\\example-calc` on Windows.
    expect(normalizeProjectPath('/tmp/example-calc')).toBe(resolve('/tmp/example-calc'));
  });

  it('returns null for an unknown project', () => {
    expect(getWorkingState('/tmp/never-seen')).toBeNull();
  });
});

/**
 * PER-FILE verification debt.
 *
 * The ledger used to record only a COUNT of unverified edit turns, which cannot
 * be reconciled: the next turn could not tell WHICH file was owed a check, so a
 * verification of anything settled the whole backlog — including, in a
 * monorepo, one that never loaded the file's own suite.
 */
describe('recordWorkingState — per-file debt', () => {
  it('owes a check only on the paths nothing covered', () => {
    const s = recordWorkingState(PROJECT, {
      filesTouched: ['src/a.ts', 'src/b.ts'],
      verifiedPaths: ['src/a.ts'],
      unverifiedPaths: ['src/b.ts'],
    })!;
    expect(s.unverifiedPaths.map((u) => u.path)).toEqual(['src/b.ts']);
    expect(s.unverifiedEdits).toBe(1);
    expect(s.lastVerifiedAt).toBeTypeOf('number');
  });

  it('settles the remaining file on a later turn without disturbing the first', () => {
    recordWorkingState(PROJECT, {
      filesTouched: ['a.ts', 'b.ts'],
      verifiedPaths: ['a.ts'],
      unverifiedPaths: ['b.ts'],
    });
    const s = recordWorkingState(PROJECT, { filesTouched: ['b.ts'], verifiedPaths: ['b.ts'], unverifiedPaths: [] })!;
    expect(s.unverifiedPaths).toEqual([]);
    expect(s.unverifiedEdits).toBe(0);
  });

  it('does NOT let an unrelated verification clear another file\u2019s debt', () => {
    recordWorkingState(PROJECT, { filesTouched: ['b.ts'], verifiedPaths: [], unverifiedPaths: ['b.ts'] });
    const s = recordWorkingState(PROJECT, { filesTouched: ['c.ts'], verifiedPaths: ['c.ts'], unverifiedPaths: [] })!;
    expect(s.unverifiedPaths.map((u) => u.path)).toEqual(['b.ts']);
    expect(s.unverifiedEdits).toBeGreaterThan(0);
  });

  it('names the owed paths in the injected block (a count is not actionable)', () => {
    recordWorkingState(PROJECT, {
      filesTouched: ['src/b.ts'],
      verifiedPaths: [],
      unverifiedPaths: ['src/b.ts'],
    });
    const text = formatWorkingState(getWorkingState(PROJECT));
    expect(text).toContain('Unverified changes (1)');
    expect(text).toContain('src/b.ts');
  });

  it('clears the debt set on a whole-turn (legacy) verification', () => {
    recordWorkingState(PROJECT, { filesTouched: ['a.ts'], verifiedPaths: [], unverifiedPaths: ['a.ts'] });
    const s = recordWorkingState(PROJECT, { filesTouched: ['a.ts'], verified: true })!;
    expect(s.unverifiedPaths).toEqual([]);
    expect(s.unverifiedEdits).toBe(0);
  });

  it('normalises an entry written before per-path debt existed', () => {
    // A real file on disk from an older version has no `unverifiedPaths`; every
    // reader treats it as a list, so the read must supply one.
    writeFileSync(
      join(dir, 'working-state.json'),
      JSON.stringify({
        version: 1,
        projects: {
          [resolve(PROJECT)]: {
            projectPath: PROJECT,
            filesTouched: ['x.js'],
            toolsUsed: [],
            turns: 1,
            unverifiedEdits: 1,
            openIssues: [],
            corrections: 0,
            updatedAt: 1,
          },
        },
      }),
      'utf-8',
    );
    expect(getWorkingState(PROJECT)!.unverifiedPaths).toEqual([]);
  });
});

/**
 * WORKSPACE RECONCILIATION — the ledger records what the loop SAID it changed.
 * That is a report, and the repo's own invariant is that a report is a proposal
 * ("re-read the world: files on disk, VCS status"). These pin the two facts a
 * report cannot cover: an edit made outside the agent, and a change made after
 * the last verification.
 */
describe('reconcileWithWorkspace', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nuvira-ws-repo-'));
    const g = (args: string[]): void => void execFileSync('git', args, { cwd: repo });
    g(['init', '-q']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'a.txt'), 'one\n', 'utf-8');
    g(['add', 'a.txt']);
    g(['commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports a clean tree as nothing to reconcile', () => {
    const r = reconcileWithWorkspace(getWorkingState(repo), repo);
    expect(r.isGitRepo).toBe(true);
    expect(r.dirty).toEqual([]);
    expect(r.unrecorded).toEqual([]);
  });

  it('names a change on disk the ledger never recorded', () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n', 'utf-8');
    writeFileSync(join(repo, 'new.txt'), 'fresh\n', 'utf-8');
    recordWorkingState(repo, { filesTouched: ['a.txt'], verified: true });
    const r = reconcileWithWorkspace(getWorkingState(repo), repo);
    expect(r.dirty).toContain('a.txt');
    expect(r.dirty).toContain('new.txt');
    // `a.txt` was recorded; `new.txt` never was.
    expect(r.unrecorded).toEqual(['new.txt']);
  });

  it('flags a file changed AFTER the last verification', () => {
    recordWorkingState(repo, { filesTouched: [], verified: true });
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n', 'utf-8');
    // Set the mtime explicitly rather than racing the clock, so the assertion is
    // about the rule and not about filesystem timestamp resolution.
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(join(repo, 'a.txt'), future, future);
    const r = reconcileWithWorkspace(getWorkingState(repo), repo);
    expect(r.staleSinceVerification).toEqual(['a.txt']);
  });

  it('does NOT flag a change the verification already covers', () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n', 'utf-8');
    const past = (Date.now() - 60_000) / 1000;
    utimesSync(join(repo, 'a.txt'), past, past);
    recordWorkingState(repo, { filesTouched: ['a.txt'], verified: true });
    const r = reconcileWithWorkspace(getWorkingState(repo), repo);
    expect(r.dirty).toContain('a.txt');
    expect(r.staleSinceVerification).toEqual([]);
  });

  it('is inert outside a repository and never throws', () => {
    const plain = mkdtempSync(join(tmpdir(), 'nuvira-ws-plain-'));
    try {
      const r = reconcileWithWorkspace(null, plain);
      expect(r.dirty).toEqual([]);
      expect(r.unrecorded).toEqual([]);
      expect(r.staleSinceVerification).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('surfaces the git-only facts through workingStateBlock', () => {
    writeFileSync(join(repo, 'unrecorded.js'), 'x\n', 'utf-8');
    recordWorkingState(repo, { filesTouched: ['owed.js'], verifiedPaths: [], unverifiedPaths: ['owed.js'] });
    const block = workingStateBlock(repo);
    expect(block).toContain('Working state');
    expect(block).toContain('owed.js');
    expect(block).toContain('never recorded');
    expect(block).toContain('unrecorded.js');
  });
});

describe('formatWorkingState', () => {
  it('is empty for a pristine project (no prompt noise)', () => {
    expect(formatWorkingState(null)).toBe('');
  });

  it('summarizes files, verification debt and the last user report', () => {
    recordWorkingState(PROJECT, {
      filesTouched: ['script.js', 'style.css'],
      unverifiedEdit: true,
      userMessage: 'still same issue with the dropdowns',
    });
    const text = formatWorkingState(getWorkingState(PROJECT));
    expect(text).toContain('Working state');
    expect(text).toContain('script.js');
    expect(text).toContain('NEVER verified');
    expect(text).toContain('dropdowns');
  });

  it('drops the warning once the work is verified', () => {
    recordWorkingState(PROJECT, { filesTouched: ['a.js'], unverifiedEdit: true });
    recordWorkingState(PROJECT, { filesTouched: ['a.js'], verified: true });
    const text = formatWorkingState(getWorkingState(PROJECT));
    expect(text).not.toContain('NEVER verified');
    expect(text).toContain('Last verified');
  });
});

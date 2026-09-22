/**
 * G3 + G4 — working-state ledger.
 *
 * Pins the cross-turn memory the calculator session lacked: touched files,
 * verification debt, and the user's own regression reports.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordWorkingState,
  getWorkingState,
  clearWorkingState,
  detectRegressionSignal,
  formatWorkingState,
  normalizeProjectPath,
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
    expect(normalizeProjectPath('/tmp/example-calc')).toBe('/tmp/example-calc');
  });

  it('returns null for an unknown project', () => {
    expect(getWorkingState('/tmp/never-seen')).toBeNull();
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

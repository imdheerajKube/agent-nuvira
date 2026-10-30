/**
 * Finding YIELD — the budget signal for an assessment.
 *
 * The behaviour that matters: a finding is recognised by its SHAPE (an id or a
 * severity), its identity is its TITLE (so renumbering is not new work), and a
 * report that is not on disk yet is not the same thing as a report that found
 * nothing.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ASSESSMENT_EXTENSION_CAP,
  assessmentExtensionCap,
  countFindings,
  countSourceFiles,
  findingTitles,
  normalizeFindingTitle,
  readFindingYield,
} from '../../src/learning/finding-yield.js';

const REPORT = `# Audit

## 4. Bug Discovery

### BUG-01 - CRITICAL - removing a project named '..' deletes the data tree
text

### BUG-02 - HIGH - a resumed download corrupts the file

### BUG-03 - MEDIUM - two wx.App objects per process; the interpreter aborts at exit

Some prose that mentions a critical a11y problem but is not a heading.
`;

describe('findingTitles', () => {
  it('reads id-labelled findings and their severity', () => {
    expect(findingTitles(REPORT)).toHaveLength(3);
  });

  it('treats one defect as one finding across id renumbering and formatting', () => {
    const a = countFindings('### BUG-05 - MEDIUM - two wx.App objects per process\n');
    const b = countFindings('### BUG 5 (Medium): two wx.App objects per process\n');
    const c = countFindings('- **[Medium]** two wx.App objects per process\n');
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(normalizeFindingTitle('two `wx.App` objects per process')).toBe(
      normalizeFindingTitle('Two wx.App objects per process'),
    );
  });

  it('accepts a severity-led heading with no id', () => {
    expect(countFindings('### Critical — the archive overwrites the last voice\n')).toBe(1);
  });

  it('does not count prose, a bare severity legend, or the table of contents', () => {
    expect(countFindings('This is critical for the project.')).toBe(0);
    expect(countFindings('- Critical\n- High\n- Medium\n')).toBe(0);
    expect(countFindings('| Severity | Count |\n|---|---|\n| Critical | 2 |\n')).toBe(0);
  });

  it('counts the same heading once, however many times it is repeated', () => {
    const twice = `${REPORT}\n### BUG-01 - CRITICAL - removing a project named '..' deletes the data tree\n`;
    expect(countFindings(twice)).toBe(3);
  });
});

describe('readFindingYield', () => {
  it('prefers the report on disk and reports only findings not yet seen', () => {
    const root = mkdtempSync(join(tmpdir(), 'yield-'));
    const cwd = join(root, 'repo');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(root, 'REPORT.md'), REPORT);

    const first = readFindingYield({ reportPaths: ['../REPORT.md'], root: cwd, seen: new Set() });
    expect(first.reportRead).toBe(true);
    expect(first.total).toBe(3);
    expect(first.fresh).toHaveLength(3);

    const seen = new Set(first.fresh);
    const second = readFindingYield({ reportPaths: ['../REPORT.md'], root: cwd, seen });
    expect(second.fresh).toHaveLength(0);

    writeFileSync(join(root, 'REPORT.md'), `${REPORT}\n### BUG-04 - HIGH - a resumed download silently corrupts the file\n`);
    const third = readFindingYield({ reportPaths: ['../REPORT.md'], root: cwd, seen });
    expect(third.total).toBe(4);
    expect(third.fresh).toHaveLength(1);
  });

  it('falls back to the answer text until a report exists, and says no report was read', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yield-'));
    const yieldNow = readFindingYield({
      content: '### BUG-1 - HIGH - the terms gate cannot be refused\n',
      reportPaths: ['../REPORT.md'],
      root: cwd,
      seen: new Set(),
    });
    expect(yieldNow.reportRead).toBe(false);
    expect(yieldNow.total).toBe(1);
  });

  it('ignores an empty report rather than treating it as a source', () => {
    const root = mkdtempSync(join(tmpdir(), 'yield-'));
    writeFileSync(join(root, 'REPORT.md'), '');
    const yieldNow = readFindingYield({
      content: '### BUG-1 - HIGH - a real finding\n',
      reportPaths: ['REPORT.md'],
      root,
      seen: new Set(),
    });
    expect(yieldNow.reportRead).toBe(false);
    expect(yieldNow.total).toBe(1);
  });
});

describe('assessmentExtensionCap', () => {
  it('scales with the size of the tree and stays finite', () => {
    expect(assessmentExtensionCap(0)).toBe(ASSESSMENT_EXTENSION_CAP.small);
    expect(assessmentExtensionCap(40)).toBe(ASSESSMENT_EXTENSION_CAP.small);
    expect(assessmentExtensionCap(41)).toBe(ASSESSMENT_EXTENSION_CAP.medium);
    expect(assessmentExtensionCap(250)).toBe(ASSESSMENT_EXTENSION_CAP.medium);
    expect(assessmentExtensionCap(251)).toBe(ASSESSMENT_EXTENSION_CAP.large);
    expect(assessmentExtensionCap(1_000_000)).toBe(ASSESSMENT_EXTENSION_CAP.large);
  });

  it('counts the project’s own sources and skips dependency/build trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.py'), '');
    writeFileSync(join(root, 'src', 'b.ts'), '');
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '');
    expect(countSourceFiles(root)).toBe(2);
  });
});

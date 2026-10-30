/**
 * Coverage ledger — breadth as DATA, not as a hope.
 *
 * The measured reason this module exists: on an identical audit Cline found 24
 * defects and agent-nuvira 19, and the gap was almost entirely files never opened
 * (`parsers.py`, the DAISY builders). The earlier plan answered that with a nudge
 * asking the model to read more "because reading is cheap" — a gamble on the model
 * choosing to. The ledger replaces it with a census, an opened set, and the
 * **dependency frontier**: the unread files imported by the files that WERE read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COVERAGE_TARGET,
  CoverageLedger,
  censusSourceFiles,
  importSpecifiers,
  relativeInside,
  resolveSpecifier,
} from '../../src/learning/coverage-ledger.js';

let root = '';

function put(path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coverage-'));
  put('src/a.ts', "import { b } from './b';\nexport const a = b;\n");
  put('src/b.ts', "import { c } from './c';\nexport const b = c;\n");
  put('src/c.ts', 'export const c = 1;\n');
  put('src/deep/d.ts', "import { c } from '../c';\n");
  put('pyapp/paths.py', 'from pyapp.services import clean\n\nA = 1\n');
  put('pyapp/services.py', 'def clean():\n    return 1\n');
  put('README.md', '# docs — not source\n');
  put('node_modules/pkg/index.js', "require('./nope');\n");
  put('.venv/lib/x.py', 'import os\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('breadth of an edit (build and refactor turns)', () => {
  it('names both directions: what the change calls, and what calls the change', () => {
    const ledger = new CoverageLedger(root);
    // b.ts imports c.ts; a.ts imports b.ts. Nothing has been opened.
    const gaps = ledger.unreadAround([join(root, 'src/b.ts')]);

    expect(gaps).toContainEqual({ file: 'src/c.ts', via: 'src/b.ts', direction: 'dependency' });
    expect(gaps).toContainEqual({ file: 'src/a.ts', via: 'src/b.ts', direction: 'dependent' });
  });

  it('drops a file the turn already opened, and keeps the one it has not', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead(join(root, 'src/c.ts'));

    const gaps = ledger.unreadAround([join(root, 'src/b.ts')]);
    expect(gaps.map((g) => g.file)).not.toContain('src/c.ts');
    expect(gaps.map((g) => g.file)).toContain('src/a.ts');
  });

  it('can skip the reverse scan, which is the expensive half', () => {
    const ledger = new CoverageLedger(root);
    const gaps = ledger.unreadAround([join(root, 'src/b.ts')], { reverse: false });

    expect(gaps.every((g) => g.direction === 'dependency')).toBe(true);
    expect(gaps.map((g) => g.file)).toContain('src/c.ts');
  });

  it('refuses an edit outside the project, and one that is not source', () => {
    const ledger = new CoverageLedger(root);
    expect(ledger.unreadAround([join(root, '..', 'elsewhere.ts')])).toEqual([]);
    expect(ledger.unreadAround([join(root, 'README.md')])).toEqual([]);
  });

  it('asks for the named files and allows a reason instead of a read', () => {
    const ledger = new CoverageLedger(root);
    const gaps = ledger.unreadAround([join(root, 'src/b.ts')]);
    const nudge = ledger.editBreadthNudge(gaps, 1);

    expect(nudge).toContain('breadth of this edit');
    expect(nudge).toContain('a caller of the code you just changed');
    // A nudge that demands a read for the count is the failure mode it replaces.
    expect(nudge).toContain('do NOT read all of them for the count');
  });
});

describe('census', () => {
  it('counts source files and skips vendored/build/hidden trees', () => {
    expect(censusSourceFiles(root).sort()).toEqual([
      'pyapp/paths.py',
      'pyapp/services.py',
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/deep/d.ts',
    ]);
  });

  it('is bounded and sorted deterministically (a stable prompt prefix depends on it)', () => {
    const first = censusSourceFiles(root);
    expect(censusSourceFiles(root)).toEqual(first);
    expect(censusSourceFiles(root, 2)).toHaveLength(2);
  });

  it('refuses paths outside the project — a read of ~/.zshrc is not coverage', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('/etc/hosts');
    ledger.recordRead('../outside.ts');
    ledger.recordRead('README.md'); // in the tree, but not source
    expect(ledger.openedCount()).toBe(0);
    expect(relativeInside(root, '/etc/hosts')).toBeNull();
    expect(relativeInside(root, 'src/a.ts')).toBe('src/a.ts');
  });
});

describe('opened set + coverage arithmetic', () => {
  it('counts a file only once it was actually read', () => {
    const ledger = new CoverageLedger(root);
    expect(ledger.snapshot().coverage).toBe(0);
    ledger.recordRead(join(root, 'src/a.ts'));
    const snap = ledger.snapshot();
    expect(snap.openedFiles).toBe(1);
    expect(snap.totalFiles).toBe(6);
    expect(snap.coverage).toBeCloseTo(1 / 6, 5);
    expect(snap.unopened).not.toContain('src/a.ts');
  });

  it('accepts a batched read (`paths[]` including { path } entries)', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordReads(['src/a.ts', { path: 'src/b.ts' }]);
    expect(ledger.openedCount()).toBe(2);
    expect(ledger.snapshot().openedFiles).toBe(2);
  });

  it('groups by top-level area, heaviest unopened first', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    const areas = ledger.snapshot().areas;
    const src = areas.find((a) => a.area === 'src');
    expect(src).toMatchObject({ total: 4, opened: 1, unopened: 3 });
    expect(src?.examples).toContain('b.ts');
    // The heaviest unopened area is first, because that is where reading pays.
    expect(areas[0].area).toBe('src');
  });
});

describe('dependency frontier', () => {
  it('names the unread file an OPENED file imports — one level, no guessing', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    const frontier = ledger.snapshot().frontier;

    expect(frontier).toEqual([{ from: 'src/a.ts', to: 'src/b.ts', via: './b' }]);
    // Depth two is NOT claimed: reading b.ts is the next step's decision, taken
    // with the new facts that read produces.
    expect(frontier.map((e) => e.to)).not.toContain('src/c.ts');
  });

  it('resolves Python absolute imports and parent-relative specifiers', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('pyapp/paths.py');
    ledger.recordRead('src/deep/d.ts');
    const targets = ledger.snapshot().frontier.map((e) => e.to).sort();
    expect(targets).toEqual(['pyapp/services.py', 'src/c.ts']);
  });

  it('empties as the frontier is read (the stop condition is a fact)', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    expect(ledger.snapshot().frontier).toHaveLength(1);
    ledger.recordRead('src/b.ts');
    // a.ts → b.ts is now satisfied; b.ts → c.ts takes its place, which is the
    // point: breadth follows the code graph.
    expect(ledger.snapshot().frontier.map((e) => e.to)).toEqual(['src/c.ts']);
  });

  it('ignores packages and unreadable files instead of inventing edges', () => {
    put('src/uses-pkg.ts', "import express from 'express';\nimport { missing } from './missing';\n");
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/uses-pkg.ts');
    expect(ledger.snapshot().frontier).toEqual([]);
  });
});

describe('import extraction / resolution', () => {
  it('reads ESM, CJS, dynamic and Python forms', () => {
    const specs = importSpecifiers(
      "import a from './a';\nconst b = require('./b');\nconst c = await import('./c');\n",
      'src/x.ts',
    );
    expect(specs).toEqual(['./a', './b', './c']);

    const py = importSpecifiers('from .paths import x\nimport os, sys.path\n', 'app/main.py');
    expect(py).toContain('.paths');
    expect(py).toContain('os');
    expect(py).toContain('sys.path');
  });

  it('resolves explicit, extensionless, index and __init__ targets', () => {
    const universe = new Set(['src/b.ts', 'src/dir/index.ts', 'pkg/__init__.py']);
    expect(resolveSpecifier('src/a.ts', './b', universe)).toBe('src/b.ts');
    expect(resolveSpecifier('src/a.ts', './dir', universe)).toBe('src/dir/index.ts');
    expect(resolveSpecifier('pkg/main.py', 'pkg', universe)).toBe('pkg/__init__.py');
    expect(resolveSpecifier('src/a.ts', 'react', universe)).toBeNull();
    expect(resolveSpecifier('src/a.ts', 'node:fs', universe)).toBeNull();
  });
});

describe('unbacked citations', () => {
  it('flags a finding that cites a file the turn never opened', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    expect(ledger.unbackedCitations(['BUG-01 — src/b.ts:12 leaks the handle'])).toEqual(['src/b.ts:12']);
    // Abbreviating the path does not dodge the check.
    expect(ledger.unbackedCitations(['see b.ts:12'])).toEqual(['src/b.ts:12']);
  });

  it('clears once the file is read', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    ledger.recordRead('src/b.ts');
    expect(ledger.unbackedCitations(['BUG-01 — src/b.ts:12'])).toEqual([]);
  });
});

describe('nudge + report', () => {
  it('returns null when the tree is broadly read and the frontier is empty', () => {
    const ledger = new CoverageLedger(root);
    for (const f of censusSourceFiles(root)) ledger.recordRead(f);
    expect(ledger.nudge()).toBeNull();
  });

  it('names the exact files to open, the areas, and the table to paste', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    const nudge = ledger.nudge({ unbacked: ['src/c.ts:3'] });
    expect(nudge).toBeTruthy();

    // The actionable part: a concrete file→file edge, not "consider reading more".
    expect(nudge).toContain('`src/a.ts` → `src/b.ts`');
    // The table is pre-computed so the model pastes rather than counts.
    expect(nudge).toContain('| Source files | Opened | Coverage |');
    expect(nudge).toContain(`| 6 | 1 | ${Math.round((1 / 6) * 100)}% |`);
    // The unbacked finding is named, with the instruction to verify or mark it.
    expect(nudge).toContain('`src/c.ts:3`');
    expect(nudge).toContain('never opened');
    // Batching is what makes the extra round cheap.
    expect(nudge).toContain('ONE call');
  });

  it('states the target so "broad enough" is not the model’s judgement call', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    expect(ledger.nudge()).toContain(`target ${Math.round(COVERAGE_TARGET * 100)}%`);
  });

  it('report() is stable for an unchanged ledger (safe to paste twice)', () => {
    const ledger = new CoverageLedger(root);
    ledger.recordRead('src/a.ts');
    expect(ledger.report()).toBe(ledger.report());
  });
});

/**
 * Documentation duty is the one axis where all three agents measured on 2026-10-25
 * scored below 70: every one of them wrote docs, and none wrote a README. The claim
 * audit is the axis none of them checks at all — nuvira's own ROADMAP cited tests it
 * never wrote.
 *
 * These tests pin that the duty fires only when the turn made the project RUNNABLE,
 * and that the audit resolves references without judging prose.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  auditDocClaims,
  docClaimsNudge,
  quickstartDuty,
  quickstartNudge,
} from '../../src/learning/doc-claims.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'doc-claims-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

const PACKAGE = JSON.stringify({ name: 'app', scripts: { dev: 'next dev', test: 'vitest run' } }, null, 2);

describe('quickstartDuty', () => {
  it('fires when the turn made the project runnable and left no README', () => {
    put('package.json', PACKAGE);
    const duty = quickstartDuty({ cwd: root, writtenPaths: ['package.json'] });
    expect(duty.needed).toBe(true);
    expect(duty.entry).toBe('package.json');
    expect(quickstartNudge(duty)).toContain('npm run');
  });

  it('reports a README that exists but is too thin to follow', () => {
    put('package.json', PACKAGE);
    put('README.md', '# app\n');
    const duty = quickstartDuty({ cwd: root, writtenPaths: ['package.json'] });
    expect(duty.needed).toBe(true);
    expect(duty.thinReadme?.bytes).toBeLessThan(1200);
  });

  it('is satisfied by a real README, and never fires on an edit turn', () => {
    put('package.json', PACKAGE);
    put('README.md', `# app\n\n${'Run `npm run dev` and open http://localhost:3000.\n'.repeat(40)}`);
    expect(quickstartDuty({ cwd: root, writtenPaths: ['package.json'] }).needed).toBe(false);
    // A service-file edit owes no quickstart, even with no README at all.
    put('README.md', '');
    expect(quickstartDuty({ cwd: root, writtenPaths: ['src/modules/orders/service.ts'] }).needed).toBe(false);
  });
});

describe('auditDocClaims', () => {
  it('catches a documented npm script that package.json does not define', () => {
    put('package.json', PACKAGE);
    put('README.md', '# app\n\nRun the acceptance suite with `npm run test:e2e` before shipping.\n');
    const findings = auditDocClaims({ cwd: root, writtenPaths: ['README.md'] });
    expect(findings).toHaveLength(1);
    expect(findings[0].claim).toContain('npm run test:e2e');
    expect(findings[0].problem).toContain('not a script in package.json');
  });

  it('catches a doc that names a file the workspace does not have', () => {
    put('docs/ROADMAP.md', 'Phase 2 ships `tests/tenant-isolation.test.ts` and `src/billing/plans.ts`.\n');
    const findings = auditDocClaims({ cwd: root, writtenPaths: ['docs/ROADMAP.md'] });
    expect(findings.map((f) => f.claim).sort()).toEqual(['src/billing/plans.ts', 'tests/tenant-isolation.test.ts']);
  });

  it('resolves both against the tree, so a true claim produces nothing', () => {
    put('package.json', PACKAGE);
    put('src/server/http.ts', 'export const ok = 1;\n');
    put('README.md', '# app\n\n`npm run dev` starts `src/server/http.ts`.\n');
    expect(auditDocClaims({ cwd: root, writtenPaths: ['README.md'] })).toEqual([]);
  });

  it('ignores placeholders and never audits documents the turn did not write', () => {
    put('docs/OLD.md', 'Run `npm run does-not-exist` and read `src/ghost.ts`.\n');
    expect(auditDocClaims({ cwd: root, writtenPaths: ['docs/NEW.md'] })).toEqual([]);
    put('docs/NEW.md', 'Run `npm run <script>` in `src/<module>.ts`.\n');
    expect(auditDocClaims({ cwd: root, writtenPaths: ['docs/NEW.md'] })).toEqual([]);
  });

  it('phrases the nudge as facts the model can act on', () => {
    const text = docClaimsNudge(
      [{ doc: 'README.md', claim: 'npm run test:e2e', problem: '"test:e2e" is not a script in package.json' }],
      ['README.md — what this is and how to run it (no such file)'],
    );
    expect(text).toContain('`README.md`: npm run test:e2e');
    expect(text).toContain('Either create what the document names, or correct the document.');
  });
});

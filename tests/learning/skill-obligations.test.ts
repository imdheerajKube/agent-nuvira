/**
 * P6 — binding skill obligations.
 *
 * The property under test is the one that makes a skill more than advice: a
 * LOADED skill can declare what "used" means, the harness records evidence as
 * the turn goes, and `finish` refuses an unqualified completion claim while an
 * obligation is unmet. The complement matters just as much: a `verified:false`
 * claim is never trapped, and a skill that was merely INSTALLED (not loaded)
 * obliges nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'nuvira-oblig-home-'));
const originalHome = process.env.HOME;
let session = '';

import {
  describeObligations,
  evaluateObligations,
  hasObligations,
  parseObligations,
  recordCommandEvidence,
  recordReadEvidence,
  recordSkillLoad,
  resetObligations,
} from '../../src/learning/skill-obligations.js';
import { runFinish } from '../../src/tools/finish-tool.js';
import { FINISH_ACCEPTED_MARKER, FINISH_REFUSED_MARKER } from '../../src/learning/completion-contract.js';
import type { ToolContext } from '../../src/tools/registry.js';

beforeEach(() => {
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  session = `test-${Math.random().toString(36).slice(2)}`;
  process.env.NUVIRA_SESSION_ID = session;
  resetObligations(session);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetObligations(session);
});

const skillMd = (obligations: string): string =>
  ['---', 'name: db-migration', 'description: Use when migrating a database.', obligations, '---', '', '# body', ''].join('\n');

describe('parseObligations', () => {
  it('reads a nested block of lists', () => {
    const o = parseObligations(
      skillMd(
        [
          'obligations:',
          '  must_read:',
          '    - references/checklist.md',
          '    - docs/schema.md',
          '  must_run:',
          '    - scripts/validate_migration.py',
          '  must_produce:',
          '    - docs/migration-plan.md',
          '  must_verify:',
          '    - tests',
        ].join('\n'),
      ),
    );
    expect(o.mustRead).toEqual(['references/checklist.md', 'docs/schema.md']);
    expect(o.mustRun).toEqual(['scripts/validate_migration.py']);
    expect(o.mustProduce).toEqual(['docs/migration-plan.md']);
    expect(o.mustVerify).toEqual(['tests']);
    expect(hasObligations(o)).toBe(true);
  });

  it('reads inline arrays', () => {
    const o = parseObligations(
      skillMd('obligations:\n  must_run: [scripts/a.py, scripts/b.sh]\n  must_verify: [tests, typecheck]'),
    );
    expect(o.mustRun).toEqual(['scripts/a.py', 'scripts/b.sh']);
    expect(o.mustVerify).toEqual(['tests', 'typecheck']);
  });

  it('reads the flat form (no `obligations:` header)', () => {
    const o = parseObligations(skillMd('must_read: [references/guide.md]'));
    expect(o.mustRead).toEqual(['references/guide.md']);
  });

  it('ignores unrelated frontmatter and a skill with no obligations', () => {
    const plain = parseObligations('---\nname: x\ndescription: Use when y.\nplatforms: [linux]\n---\n');
    expect(hasObligations(plain)).toBe(false);
    expect(plain).toEqual({ mustRead: [], mustRun: [], mustProduce: [], mustVerify: [] });
  });

  it('does not leak one skill key into another', () => {
    const o = parseObligations(skillMd('obligations:\n  must_read:\n    - a.md\nversion: 1.0.0\nname: other'));
    expect(o.mustRead).toEqual(['a.md']);
    expect(o.mustRun).toEqual([]);
  });
});

describe('evaluateObligations — evidence decides', () => {
  const obligations = {
    mustRead: ['references/checklist.md'],
    mustRun: ['scripts/validate.py'],
    mustProduce: ['docs/plan.md'],
    mustVerify: ['test'],
  };

  it('reports every obligation unmet before any evidence exists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-cwd-'));
    try {
      recordSkillLoad({ id: 'db-migration', name: 'db-migration', dir: cwd, obligations });
      const report = evaluateObligations({ sessionId: session, cwd });
      expect(report.total).toBe(4);
      expect(report.satisfied).toBe(0);
      expect(report.unmet).toHaveLength(4);
      expect(report.unmet.join('\n')).toContain('references/checklist.md');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('is satisfied by a read, a successful command, a produced file and a green check', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-cwd-'));
    try {
      // The skill lives in the workspace; its reference is skill-relative.
      mkdirSync(join(cwd, 'references'), { recursive: true });
      writeFileSync(join(cwd, 'references', 'checklist.md'), '# checklist\n', 'utf-8');
      recordSkillLoad({ id: 'db-migration', name: 'db-migration', dir: cwd, obligations });

      // A skill-relative read, given as the path the model would actually pass.
      recordReadEvidence(['references/checklist.md'], session);
      // A successful run of the validator.
      recordCommandEvidence('python3 scripts/validate.py --strict', true, session);
      // The produced artifact.
      mkdirSync(join(cwd, 'docs'), { recursive: true });
      writeFileSync(join(cwd, 'docs', 'plan.md'), '# plan\n', 'utf-8');
      // A green check.
      recordCommandEvidence('npm test -- --run', true, session);

      const report = evaluateObligations({ sessionId: session, cwd });
      expect(report.unmet).toEqual([]);
      expect(report.satisfied).toBe(4);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a FAILED command is not evidence (only successes are recorded)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-cwd-'));
    try {
      recordSkillLoad({
        id: 's',
        name: 's',
        dir: cwd,
        obligations: { mustRead: [], mustRun: ['scripts/x.py'], mustProduce: [], mustVerify: [] },
      });
      recordCommandEvidence('python3 scripts/x.py', false, session);
      expect(evaluateObligations({ sessionId: session, cwd }).unmet).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('honours a glob in must_produce', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-cwd-'));
    try {
      recordSkillLoad({
        id: 's',
        name: 's',
        dir: cwd,
        obligations: { mustRead: [], mustRun: [], mustProduce: ['docs/*.md'], mustVerify: [] },
      });
      mkdirSync(join(cwd, 'docs'), { recursive: true });
      expect(evaluateObligations({ sessionId: session, cwd }).unmet).toHaveLength(1);
      writeFileSync(join(cwd, 'docs', 'design.md'), '# d\n', 'utf-8');
      expect(evaluateObligations({ sessionId: session, cwd }).unmet).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a skill that was never LOADED obliges nothing', () => {
    // Installed ≠ loaded: the file exists on disk but no load was recorded.
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-cwd-'));
    try {
      expect(existsSync(cwd)).toBe(true);
      expect(evaluateObligations({ sessionId: session, cwd }).total).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('runFinish — obligations are ADVISORY by default, binding when opted in', () => {
  const ctx = (cwd: string): ToolContext => ({ configManager: {} as never, cwd }) as ToolContext;
  const ENV = 'NUVIRA_ENFORCE_SKILL_OBLIGATIONS';
  const original = process.env[ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('does NOT refuse by default — the unmet gap is carried as advice', async () => {
    // The gate can alter a turn mid-flight and has never been measured in a bench
    // where a skill loads, so it stays off. An unmet obligation is still SHOWN.
    delete process.env[ENV];
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-fin-'));
    try {
      recordSkillLoad({
        id: 'db-migration',
        name: 'db-migration',
        dir: cwd,
        obligations: { mustRead: ['references/checklist.md'], mustRun: [], mustProduce: [], mustVerify: [] },
      });
      const out = await runFinish({ summary: 'migrated the schema' }, ctx(cwd));
      expect(out).not.toContain(FINISH_REFUSED_MARKER);
      expect(out).toContain('advisory only, enforcement is off');
      expect(out).toContain('references/checklist.md');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('REFUSES a verified:true claim once enforcement is opted in, and names the gap', async () => {
    process.env[ENV] = '1';
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-fin-'));
    try {
      recordSkillLoad({
        id: 'db-migration',
        name: 'db-migration',
        dir: cwd,
        obligations: { mustRead: ['references/checklist.md'], mustRun: [], mustProduce: [], mustVerify: [] },
      });
      const out = await runFinish({ summary: 'migrated the schema' }, ctx(cwd));
      expect(out).toContain(FINISH_REFUSED_MARKER);
      expect(out).toContain('references/checklist.md');
      expect(out).toContain('verified:false');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('ACCEPTS once the evidence exists', async () => {
    process.env[ENV] = '1';
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-fin-'));
    try {
      recordSkillLoad({
        id: 'db-migration',
        name: 'db-migration',
        dir: cwd,
        obligations: { mustRead: ['references/checklist.md'], mustRun: [], mustProduce: [], mustVerify: [] },
      });
      recordReadEvidence(['references/checklist.md'], session);
      const out = await runFinish({ summary: 'migrated the schema' }, ctx(cwd));
      expect(out).toContain(FINISH_ACCEPTED_MARKER);
      expect(out).not.toContain(FINISH_REFUSED_MARKER);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('NEVER traps an honest verified:false ending — even with enforcement on', async () => {
    process.env[ENV] = '1';
    const cwd = mkdtempSync(join(tmpdir(), 'nuvira-oblig-fin-'));
    try {
      recordSkillLoad({
        id: 'db-migration',
        name: 'db-migration',
        dir: cwd,
        obligations: { mustRead: ['references/checklist.md'], mustRun: [], mustProduce: [], mustVerify: [] },
      });
      const out = await runFinish(
        { summary: 'partial', verified: false, unmet: ['could not read the checklist'] },
        ctx(cwd),
      );
      expect(out).not.toContain(FINISH_REFUSED_MARKER);
      expect(out).toContain('unmet');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('describeObligations', () => {
  it('prints only the declared kinds', () => {
    expect(describeObligations(undefined)).toEqual([]);
    expect(
      describeObligations({ mustRead: ['a.md'], mustRun: [], mustProduce: [], mustVerify: ['tests'] }),
    ).toEqual(['must read: a.md', 'must verify: tests']);
  });
});

afterAllCleanup();
function afterAllCleanup(): void {
  process.on('exit', () => {
    process.env.HOME = originalHome;
    rmSync(HOME, { recursive: true, force: true });
  });
}

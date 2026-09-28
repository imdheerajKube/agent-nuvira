/**
 * Doc-citation guard (`tests/docs/doc-citations.test.ts`).
 *
 * Every SCREAMING_SNAKE `*.md` a source file cites must exist AND be tracked by
 * git. `TOOL_TRUTHFULNESS_TRACKER.md` was lost for exactly this reason — the repo
 * ignores `*.md` unless a file is whitelisted, so the eight modules citing it by
 * name pointed at nothing, and the loss was invisible until a human noticed.
 *
 * The detector lives in `scripts/check-doc-citations.mjs` so the CLI report and
 * these assertions cannot drift — the same split as
 * `scripts/generate-commands-surface.mjs` + `tests/docs/commands-surface.test.ts`.
 *
 * The synthetic cases matter more than the repo-wide one: they prove the detector
 * FAILS on the two real failure modes rather than merely passing today.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');
const script = join(repoRoot, 'scripts', 'check-doc-citations.mjs');

type Problems = Array<{ kind: string; name: string; detail: string }>;

const detector = (await import('../../scripts/check-doc-citations.mjs')) as unknown as {
  collectCitations: (text: string) => string[];
  findCitationProblems: (
    citations: string[],
    resolveDoc: (name: string) => { path: string; ignored?: boolean } | null,
    options?: {
      notADocCitation?: Map<string, string>;
      acknowledgedLocalOnly?: Map<string, string>;
    },
  ) => Problems;
  NOT_A_DOC_CITATION: Map<string, string>;
  ACKNOWLEDGED_LOCAL_ONLY: Map<string, string>;
};

/**
 * Build an example doc name without writing it literally.
 *
 * The guard scans THIS file's text too, so a literal example name here would be
 * indistinguishable from a real citation and would fail the "tree is clean" case
 * below — which is the guard being correct: it reads text, not intent.
 */
const exampleDoc = (stem: string) => `${stem}_PLAN.md`;

describe('doc citations — every cited doc exists and is tracked', () => {
  it('the checked-in tree is clean', () => {
    // execFileSync throws on a non-zero exit, so this surfaces the report.
    const out = execFileSync('node', [script, '--check'], { cwd: repoRoot, encoding: 'utf8' });
    expect(out).toContain('all exist and are tracked');
  });

  it('governs the SCREAMING_SNAKE citation convention only — not fixture filenames', () => {
    // A bare `\.md` regex would flag the hundreds of files the suites write.
    const { collectCitations } = detector;
    expect(collectCitations('see TOOL_TRUTHFULNESS_TRACKER.md §P4.1')).toEqual([
      'TOOL_TRUTHFULNESS_TRACKER.md',
    ]);
    expect(collectCitations("writeFileSync(join(dir, 'story.md'), 'x')")).toEqual([]);
    expect(collectCitations('see README.md and SKILL.md')).toEqual([]);
    expect(collectCitations('the file 01-chapter-1.md')).toEqual([]);
  });

  it('reports a citation whose doc does not exist anywhere', () => {
    const problems = detector.findCitationProblems([exampleDoc('DELETED')], () => null);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('missing');
  });

  it('reports a citation whose doc exists but is gitignored — the way the tracker was lost', () => {
    const problems = detector.findCitationProblems(['TOOL_TRUTHFULNESS_TRACKER.md'], () => ({
      path: 'TOOL_TRUTHFULNESS_TRACKER.md',
      ignored: true,
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('ignored');
    expect(problems[0].detail).toContain('fresh clone');
  });

  it('stays silent for a tracked doc', () => {
    expect(
      detector.findCitationProblems(['COMMANDS.md'], () => ({ path: 'docs/COMMANDS.md' })),
    ).toEqual([]);
  });

  it('has no acknowledged local-only debt left', () => {
    // The three docs that used to sit here (AGENT_NUVIRA_MAJOR_REVAMP_PLAN.md,
    // ENTERPRISE_GRADE_TRACKER.md, NUVIRA_ROUTER_ROADMAP.md) were published on
    // 2026-09-28, so every citation must now pass on merit. A new entry is a
    // deliberate decision someone made — not a quiet way to mute the guard.
    expect([...detector.ACKNOWLEDGED_LOCAL_ONLY.keys()]).toEqual([]);
  });

  it('stays silent for an acknowledged local-only doc, and for an artifact name', () => {
    // Both lists are injected: the mechanism must hold even while the real lists
    // are empty, or the escape hatch silently stops working.
    const acknowledged = exampleDoc('PINNED');
    expect(
      detector.findCitationProblems([acknowledged], () => ({ path: acknowledged, ignored: true }), {
        acknowledgedLocalOnly: new Map([[acknowledged, 'deliberately local-only']]),
      }),
    ).toEqual([]);

    const artifact = exampleDoc('EMITTED');
    expect(
      detector.findCitationProblems([artifact], () => null, {
        notADocCitation: new Map([[artifact, 'an artifact the code writes, not a doc it cites']]),
      }),
    ).toEqual([]);
  });

  it('keeps the acknowledgement lists justified — every entry has a reason', () => {
    for (const [name, reason] of detector.NOT_A_DOC_CITATION) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
    for (const [name, reason] of detector.ACKNOWLEDGED_LOCAL_ONLY) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });
});

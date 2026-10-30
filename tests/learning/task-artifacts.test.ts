/**
 * Required artifacts — what an ask NAMED, and whether it exists.
 *
 * The measured failure this closes (2026-10-25): a build task named todo.md,
 * progress.md, issues.md, changelog.md, a README and e2e tests; the agent finished
 * early with a green build and produced none of them. Detection must therefore be
 * literal about names but conservative about context — an ask that merely mentions
 * a README is not a request to write one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIN_ARTIFACT_BYTES,
  artifactsGateApplies,
  artifactsNudge,
  deliverableFirstNudge,
  requiredArtifactsFor,
  verifyArtifacts,
} from '../../src/learning/task-artifacts.js';

const SPEC_ASK = [
  'Build a production-ready SaaS platform.',
  'Maintain todo.md, progress.md, issues.md and changelog.md during execution.',
  'Write a README, unit tests, integration tests and e2e tests.',
].join('\n');

let root = '';

const put = (path: string, content: string): void => {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-artifacts-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('requiredArtifactsFor', () => {
  it('finds every named file and test class in a build ask', () => {
    const ids = requiredArtifactsFor(SPEC_ASK).map((r) => r.id);
    expect(ids).toEqual(['todo', 'progress', 'issues', 'changelog', 'readme', 'unit-tests', 'integration-tests', 'e2e-tests']);
  });

  it('ignores an ask that only mentions an artifact it does not ask to create', () => {
    // A review/explain ask names the README but must not be handed a todo list.
    expect(requiredArtifactsFor('Explain the README to me.')).toEqual([]);
    expect(requiredArtifactsFor('Review this codebase and report the bugs.')).toEqual([]);
  });

  it('does not treat "changelog" prose as a deliverable in a non-build ask', () => {
    expect(requiredArtifactsFor('Summarise the changelog for the last release.')).toEqual([]);
  });

  it('never turns a QUESTION about the project into a delivery duty', () => {
    // Measured 2026-10-26: `project` and `app` were build signals on their own, so
    // "read the README and tell me what the project does" was handed a README to
    // write — the nag that makes every other gate ignorable.
    expect(requiredArtifactsFor('Read the README and tell me what the project does.')).toEqual([]);
    expect(requiredArtifactsFor('What does src/app.ts do?')).toEqual([]);
    expect(requiredArtifactsFor('How is the API structured?')).toEqual([]);
    // …while the same nouns inside a WORK ask still count.
    expect(requiredArtifactsFor('Build the project and keep a todo.md.').map((r) => r.id)).toEqual(['todo']);
  });
});

describe('verifyArtifacts', () => {
  it('reports every named file as missing on an empty workspace', () => {
    const { missing, satisfied } = verifyArtifacts(requiredArtifactsFor(SPEC_ASK), root);
    expect(satisfied).toEqual([]);
    expect(missing.map((m) => m.id)).toContain('readme');
    expect(missing.map((m) => m.id)).toContain('todo');
  });

  it('is satisfied by a file with real content, and not by a placeholder', () => {
    put('docs/README.md', 'x'.repeat(MIN_ARTIFACT_BYTES + 10));
    put('todo.md', 'todo\n');
    const { satisfied, missing } = verifyArtifacts(
      requiredArtifactsFor('Build the app and keep a todo.md and README up to date.'),
      root,
    );
    expect(satisfied.map((s) => s.id)).toContain('readme');
    // 5 bytes is a placeholder, not the maintained list the ask described.
    expect(missing.map((m) => m.id)).toContain('todo');
  });

  it('needs actual specs for a test class, not just a runner config', () => {
    put('playwright.config.ts', 'export default { testDir: "e2e" };\n');
    const e2e = requiredArtifactsFor('Build the app with e2e tests.');
    expect(verifyArtifacts(e2e, root).missing.map((m) => m.id)).toEqual(['e2e-tests']);

    put('e2e/login.spec.ts', "it('logs in', () => { expect(1).toBe(1); });\n");
    expect(verifyArtifacts(e2e, root).missing).toEqual([]);
  });

  it('accepts a unit-test file in ANY language, not only jest/vitest naming', () => {
    // Measured 2026-10-30 (DEV-FEATURE, 3 runs): on a Python project the matcher
    // only knew `*.test.ts`, so `tests/test_format_duration.py` could NEVER satisfy
    // `unit-tests` — the gate fired twice after the file was written and the model
    // spent 3-5 more steps proving the file existed. A check that can only fail
    // costs steps and teaches the model to ignore the gate.
    const ask = requiredArtifactsFor('Add a helper and unit tests for it.');
    for (const [path, content] of [
      ['tests/test_format_duration.py', 'import unittest\n\nclass T(unittest.TestCase):\n    pass\n'],
      ['tests/duration_test.go', 'package util\n\nfunc TestFormat(t *testing.T) {}\n'],
      ['spec/duration_spec.rb', "describe 'format' do\nend\n"],
      ['src/test/java/DurationTest.java', 'class DurationTest {}\n'],
    ] as const) {
      rmSync(join(root, path), { force: true });
      put(path, content);
      expect(verifyArtifacts(ask, root).missing.map((m) => m.id), path).toEqual([]);
    }
  });

  it('still requires a REAL unit-test file for a Python project', () => {
    // The looser matcher must not make the requirement free: a non-test module in
    // `tests/` is not a unit test file.
    put('tests/helpers.py', 'def helper():\n    return 1\n');
    const ask = requiredArtifactsFor('Add a helper and unit tests for it.');
    expect(verifyArtifacts(ask, root).missing.map((m) => m.id)).toEqual(['unit-tests']);
  });

  it('distinguishes unit from integration tests', () => {
    put('tests/unit/math.test.ts', "it('adds', () => { expect(1).toBe(1); });\n");
    const both = requiredArtifactsFor('Build it with unit tests and integration tests.');
    const { satisfied, missing } = verifyArtifacts(both, root);
    expect(satisfied.map((s) => s.id)).toEqual(['unit-tests']);
    expect(missing.map((m) => m.id)).toEqual(['integration-tests']);
  });
});

describe('artifactsNudge', () => {
  it('names each missing artifact and the rule that makes the turn not done', () => {
    const text = artifactsNudge(requiredArtifactsFor(SPEC_ASK).slice(0, 2));
    expect(text).toContain('todo.md');
    expect(text).toContain('progress.md');
    expect(text).toContain('has not satisfied the request');
  });
});

describe('deliverableFirstNudge', () => {
  it('names every path the ask asked for and says to write it first, then fill it', () => {
    const text = deliverableFirstNudge(['docs/BUGS_FOUND.md', 'report.md']);
    expect(text).toContain('docs/BUGS_FOUND.md');
    expect(text).toContain('report.md');
    // The ORDER is the point: a skeleton on the first pass, not a document at the end.
    expect(text).toMatch(/FIRST evidence pass/);
    expect(text).toMatch(/saving the document for the end/);
    // And it tells the truth about what will happen at the gate.
    expect(text).toContain('finish');
  });
});

describe('artifactsGateApplies', () => {
  it('fires only for a turn that did work and still lacks a named artifact', () => {
    expect(artifactsGateApplies({ request: SPEC_ASK, cwd: root, didWork: false })).toBeNull();
    expect(artifactsGateApplies({ request: 'What does this repo do?', cwd: root, didWork: true })).toBeNull();
    expect(artifactsGateApplies({ request: SPEC_ASK, cwd: root, didWork: true })?.length).toBeGreaterThan(0);
  });

  it('stays silent once everything named exists', () => {
    put('README.md', 'x'.repeat(60));
    put('todo.md', 'x'.repeat(60));
    put('progress.md', 'x'.repeat(60));
    put('issues.md', 'x'.repeat(60));
    put('changelog.md', 'x'.repeat(60));
    put('tests/unit/a.test.ts', "it('a', () => { expect(1).toBe(1); });\n");
    put('tests/integration/b.test.ts', "it('b integration', () => { expect(1).toBe(1); });\n");
    put('e2e/c.spec.ts', "it('c e2e', () => { expect(1).toBe(1); });\n");
    expect(artifactsGateApplies({ request: SPEC_ASK, cwd: root, didWork: true })).toBeNull();
  });
});

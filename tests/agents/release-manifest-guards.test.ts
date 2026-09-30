/**
 * The two release guards that failed the 3.3.2 release — and both failed in the
 * direction that costs a real release:
 *
 *   1. The nested-manifest guard produced a FALSE POSITIVE. Three sub-package
 *      manifests (`packages/sdk`, `src/agent-sdk`, `vscode-extension`) whose
 *      entire diff was a `repository` / `homepage` URL pointing at the new docs
 *      repo were treated as "dependency changes this pipeline cannot verify", so
 *      Phase 3 refused to tag. The fix distinguishes a URL edit from a dependency
 *      edit; these tests pin both sides of that line, because a guard loosened
 *      without a test is a guard that will drift into refusing everything again.
 *
 *   2. Phase 1 could not say what failed. It reported a 400-character tail, so
 *      "7 files, 25 timeouts" reached the operator as "Test suite failed" and the
 *      forensics had to be done by hand. The digest and the timeout-shape flag
 *      are what make the next failure self-explanatory — and the retry uses that
 *      flag to reproduce a timing-shaped failure before grading a release on it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  evaluateNestedManifests,
  nestedDependencyDelta,
  testFailureDigest,
  testFailureShape,
} from '../../src/agents/release-runner.js';

const dirs: string[] = [];

function withRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'nuvira-nested-'));
  dirs.push(dir);
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t && git config user.name t', { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    // `mkdir -p` is a POSIX shell command: on Windows cmd.exe it fails
    // ("A subdirectory or file . already exists"), which took the whole repo
    // fixture down. mkdirSync is the same operation without a shell.
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

function pkg(body: Record<string, unknown>): string {
  return JSON.stringify({ name: 'sub', version: '1.0.0', ...body }, null, 2) + '\n';
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('nested manifest guard — a URL edit is not a dependency change', () => {
  it('reports NO dependency delta for the docs-repo URL edit that broke 3.3.2', () => {
    const dir = withRepo({ 'sub/package.json': pkg({ repository: { url: 'https://github.com/old/repo' } }) });
    writeFileSync(
      join(dir, 'sub/package.json'),
      pkg({ repository: { url: 'https://github.com/new/docs-repo' }, homepage: 'https://example.com/docs' }),
      'utf-8',
    );
    execSync('git add -A', { cwd: dir });

    expect(nestedDependencyDelta('sub/package.json', dir)).toEqual([]);
  });

  it('names a dependency edit in a nested manifest (the case the guard exists for)', () => {
    const dir = withRepo({ 'sub/package.json': pkg({ dependencies: { a: '^1.0.0' } }) });
    writeFileSync(
      join(dir, 'sub/package.json'),
      pkg({ dependencies: { a: '^1.0.0', bcrypt: '^6.0.0' }, devDependencies: { vitest: '^4.0.0' } }),
      'utf-8',
    );
    execSync('git add -A', { cwd: dir });

    const delta = nestedDependencyDelta('sub/package.json', dir);
    expect(delta).toContain('+bcrypt (dependencies)');
    expect(delta).toContain('+vitest (devDependencies)');
  });

  it('names a re-range and a removal too, not just additions', () => {
    const dir = withRepo({ 'sub/package.json': pkg({ dependencies: { a: '^1.0.0', b: '^2.0.0' } }) });
    writeFileSync(join(dir, 'sub/package.json'), pkg({ dependencies: { a: '^1.2.0' } }), 'utf-8');
    execSync('git add -A', { cwd: dir });

    const delta = nestedDependencyDelta('sub/package.json', dir);
    expect(delta).toContain('~a ^1.0.0 → ^1.2.0 (dependencies)');
    expect(delta).toContain('-b (dependencies)');
  });

  it('returns null — never "no change" — when it cannot make a claim', () => {
    const dir = withRepo({ 'keep.txt': 'x' });
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub/package.json'), pkg({ dependencies: { a: '^1.0.0' } }), 'utf-8');
    execSync('git add -A', { cwd: dir });

    // A NEW nested manifest has no HEAD side: unverifiable, not innocent.
    expect(nestedDependencyDelta('sub/package.json', dir)).toBeNull();
  });
});

describe('evaluateNestedManifests — the decision, kept pure so it can be pinned', () => {
  it('passes a nested package.json whose dependencies did not move', () => {
    const verdict = evaluateNestedManifests(['sub/package.json'], () => []);
    expect(verdict).toEqual({ moved: [], unverifiable: [] });
  });

  it('flags a moved dependency with the path that carries it', () => {
    const verdict = evaluateNestedManifests(['sub/package.json'], () => ['+bcrypt (dependencies)']);
    expect(verdict.moved).toEqual(['sub/package.json: +bcrypt (dependencies)']);
    expect(verdict.unverifiable).toEqual([]);
  });

  it('treats a lockfile as unverifiable by design, not as innocent', () => {
    const verdict = evaluateNestedManifests(['sub/yarn.lock', 'sub/pnpm-lock.yaml'], () => []);
    expect(verdict.moved).toEqual([]);
    expect(verdict.unverifiable).toEqual(['sub/yarn.lock', 'sub/pnpm-lock.yaml']);
  });

  it('treats an unreadable manifest as unverifiable — "I could not read it" is not "it is fine"', () => {
    const verdict = evaluateNestedManifests(['sub/package.json'], () => null);
    expect(verdict.moved).toEqual([]);
    expect(verdict.unverifiable).toEqual(['sub/package.json']);
  });
});

describe('test failure digest — the pipeline can say what broke', () => {
  // Verbatim shape of the vitest output that reached the operator as a fragment.
  const ANSI = '\u001B[';
  const runWithTimeouts = [
    `${ANSI}31m FAIL ${ANSI}39m tests/agents/agents/writer-prompt.test.ts > WriterAgent — execute retry logic`,
    'Error: Test timed out in 15000ms.',
    `${ANSI}31m FAIL ${ANSI}39m tests/gateway/registry.test.ts > GatewayRegistry P1 policies`,
    'Error: Test timed out in 5000ms.',
    ' Test Files  2 failed | 348 passed (350)',
  ].join('\n');

  it('names the failing files even though vitest colours the FAIL marker', () => {
    const shape = testFailureShape(runWithTimeouts);
    expect(shape.files).toEqual([
      'tests/agents/agents/writer-prompt.test.ts',
      'tests/gateway/registry.test.ts',
    ]);
    expect(shape.kinds).toEqual(['Test timed out in 15000ms', 'Test timed out in 5000ms']);
  });

  it('flags a timeout-only failure as the shape to reproduce before blaming the code', () => {
    const shape = testFailureShape(runWithTimeouts);
    expect(shape.timeoutsOnly).toBe(true);

    const digest = testFailureDigest(runWithTimeouts);
    expect(digest).toContain('2 failing file(s):');
    expect(digest).toContain('every failure is a TIMEOUT');
    expect(digest).toContain('re-run before treating this as a code regression');
  });

  it('does NOT flag a mixed or assertion failure as a flake', () => {
    const assertion = [
      `${ANSI}31m FAIL ${ANSI}39m tests/agents/issue-triage-agent.test.ts > detectSource`,
      'AssertionError: expected \'github\' to be \'auto\'',
    ].join('\n');
    expect(testFailureShape(assertion).timeoutsOnly).toBe(false);

    const mixed = [runWithTimeouts, assertion].join('\n');
    expect(testFailureShape(mixed).timeoutsOnly).toBe(false);
    expect(testFailureDigest(mixed)).not.toContain('every failure is a TIMEOUT');
  });

  it('carries the operator context it is given (what the suite was NOT told)', () => {
    const digest = testFailureDigest(runWithTimeouts, 'note: 5 credential(s) were withheld');
    expect(digest).toContain('note: 5 credential(s) were withheld');
  });

  it('says nothing at all for a clean run, so a passing phase stays quiet', () => {
    const clean = ' Test Files  350 passed (350)\n      Tests  6879 passed (6879)';
    expect(testFailureShape(clean).files).toEqual([]);
    expect(testFailureDigest(clean)).toBe('');
  });
});

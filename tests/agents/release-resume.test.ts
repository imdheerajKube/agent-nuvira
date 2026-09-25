/**
 * A release must be CONTINUABLE, not restartable.
 *
 * The live failure: a release run was killed during its npm phase, leaving a
 * pushed commit and tag `v3.3.2` and an unpublished version. Because the scope
 * was saved and never read, a second run started from scratch — which, after a
 * successful bump, means cutting 3.3.3 on top of an unfinished 3.3.2.
 *
 * These tests pin the decision (pure, so it can be reasoned about): when is a
 * saved run the same release (continue), when is it a different one (fresh), and
 * which phase states may be carried forward.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PhaseExecutionEngine, adoptSavedProgress, skipPhasesBefore } from '../../src/agents/phase-engine.js';
import { dependencyDelta } from '../../src/agents/release-runner.js';

const engine = new PhaseExecutionEngine();

function scope(targetVersion: string | undefined, ids = ['phase-1-tests', 'phase-2-version', 'phase-3-git', 'phase-4-npm']) {
  return engine.createScope({
    name: 'Publish: test',
    targetVersion,
    phases: ids.map((id) => ({ id, goal: `do ${id}`, description: id })),
  });
}

describe('adoptSavedProgress — continue or start over', () => {
  it('resumes an unfinished run of the SAME version, by phase id', () => {
    const saved = scope('3.3.2');
    saved.phases[0].status = 'completed';
    saved.phases[1].status = 'completed';
    saved.phases[2].status = 'running'; // killed mid-phase
    saved.phases[3].status = 'pending';

    const fresh = scope('3.3.2');
    const index = adoptSavedProgress(fresh, saved);

    expect(index).toBe(2);
    expect(fresh.phases[0].status).toBe('completed');
    expect(fresh.phases[1].status).toBe('completed');
    // `running` is NOT carried: an interrupted phase must run again. Carrying it
    // is exactly how a resumed release skipped its own npm publish.
    expect(fresh.phases[2].status).toBe('pending');
    expect(fresh.phases[3].status).toBe('pending');
  });

  it('does NOT resume a different version — that is a different release', () => {
    const saved = scope('3.3.2');
    saved.phases[0].status = 'completed';
    const fresh = scope('3.3.3');
    expect(adoptSavedProgress(fresh, saved)).toBe(-1);
    expect(fresh.phases[0].status).toBe('pending');
  });

  it('does not resume a scope with no target version', () => {
    const saved = scope(undefined);
    saved.phases[0].status = 'completed';
    const fresh = scope('3.3.2');
    expect(adoptSavedProgress(fresh, saved)).toBe(-1);
  });

  it('does not resume a COMPLETED release', () => {
    const saved = scope('3.3.2');
    saved.phases.forEach((p) => { p.status = 'completed'; });
    saved.completed = true;
    expect(adoptSavedProgress(scope('3.3.2'), saved)).toBe(-1);
  });

  it('runs a phase that is NEW since the saved run', () => {
    const saved = scope('3.3.2', ['phase-2-version', 'phase-3-git']);
    saved.phases[0].status = 'completed';
    saved.phases[1].status = 'completed';

    // The release pipeline gained a version-pinned-artifact refresh step.
    const fresh = scope('3.3.2', ['phase-2-version', 'phase-2b-artifacts', 'phase-3-git']);
    const index = adoptSavedProgress(fresh, saved);

    expect(index).toBe(1);
    expect(fresh.phases[1].id).toBe('phase-2b-artifacts');
    expect(fresh.phases[1].status).toBe('pending');
    expect(fresh.phases[2].status).toBe('completed');
  });

  it('is a fresh run when nothing has happened yet', () => {
    expect(adoptSavedProgress(scope('3.3.2'), scope('3.3.2'))).toBe(-1);
  });

  it('treats a null saved scope as a fresh run', () => {
    expect(adoptSavedProgress(scope('3.3.2'), null)).toBe(-1);
  });
});

describe('skipPhasesBefore — --from', () => {
  it('accepts an id or the description a human reads in the output', () => {
    const s = scope('3.3.2');
    expect(skipPhasesBefore(s, 'phase-3-git')).toBe(2);
    const again = scope('3.3.2');
    expect(skipPhasesBefore(again, 'phase-3-git')).toBe(2);
    expect(again.phases[0].status).toBe('skipped');
    expect(again.phases[1].status).toBe('skipped');
    expect(again.phases[2].status).toBe('pending');
  });

  it('returns -1 for a typo, so the whole pipeline does not silently run', () => {
    expect(skipPhasesBefore(scope('3.3.2'), 'phase-99-nope')).toBe(-1);
  });
});

describe('dependencyDelta — a release commit changes the version, not the deps', () => {
  const withRepo = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-deps-'));
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t && git config user.name t', { cwd: dir });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf-8');
    execSync('git add -A && git commit -qm init', { cwd: dir });
    return dir;
  };

  const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: deps, ...extra }, null, 2) + '\n';

  it("is silent for a version-only change — the release's own edit", () => {
    const dir = withRepo({ 'package.json': pkg({ a: '^1.0.0' }) });
    writeFileSync(join(dir, 'package.json'), pkg({ a: '^1.0.0' }, { version: '1.0.1' }), 'utf-8');
    expect(dependencyDelta(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names a dependency that appeared (the live bcrypt/express-jwt incident)', () => {
    const dir = withRepo({ 'package.json': pkg({ a: '^1.0.0' }) });
    writeFileSync(join(dir, 'package.json'), pkg({ a: '^1.0.0', bcrypt: '^6.0.0', 'express-jwt': '^8.5.1' }), 'utf-8');
    const delta = dependencyDelta(dir);
    expect(delta).toContain('+bcrypt (dependencies)');
    expect(delta).toContain('+express-jwt (dependencies)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('names removals and re-ranges too', () => {
    const dir = withRepo({ 'package.json': pkg({ a: '^1.0.0', b: '^2.0.0' }) });
    writeFileSync(join(dir, 'package.json'), pkg({ a: '^1.2.0' }), 'utf-8');
    const delta = dependencyDelta(dir);
    expect(delta).toContain('~a ^1.0.0 → ^1.2.0 (dependencies)');
    expect(delta).toContain('-b (dependencies)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('sees only the sections it claims to compare', () => {
    const dir = withRepo({ 'package.json': pkg({ a: '^1.0.0' }) });
    writeFileSync(
      join(dir, 'package.json'),
      pkg({ a: '^1.0.0' }, { devDependencies: { vitest: '^4.0.0' } }),
      'utf-8',
    );
    expect(dependencyDelta(dir)).toEqual(['+vitest (devDependencies)']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports nothing when there is no HEAD to compare against', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-deps-noh-'));
    writeFileSync(join(dir, 'package.json'), pkg({ a: '^1.0.0' }), 'utf-8');
    expect(dependencyDelta(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

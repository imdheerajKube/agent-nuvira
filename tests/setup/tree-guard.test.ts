/**
 * The tree guard has to be tested, because a guard nobody tests is a guard that
 * silently stops guarding — and this one already had a fake-failure mode
 * (`throw` from `globalSetup` teardown is printed and the run still exits 0, so
 * it was a guard that passed the build it was meant to fail).
 *
 * These tests cover the DECISION (pure), the state rules (absent / unreadable /
 * readable), and the nuance that makes the guard usable at all: a version bump
 * must not trip it, and neither must a manifest it could not parse.
 *
 * They also cover the SECOND hard tier — a file created under `src/`, the tree
 * `npm publish` packs — including the two boundaries that keep it useful: a
 * source file that was MODIFIED is a developer's edit (advisory, not failure),
 * and a scratch file outside `src/` is likewise only reported.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFESTS,
  captureTree,
  evaluateTreeGuard,
  manifestDeps,
  treeGuardReport,
  type ManifestSnapshot,
  type TreeSnapshot,
} from './tree-guard.js';

const readable = (deps: Record<string, string>): ManifestSnapshot => ({
  status: 'readable',
  deps: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`dependencies::${k}`, v])),
});

const snap = (manifests: Record<string, ManifestSnapshot>, dirty: string[] = []): TreeSnapshot => ({
  dirty,
  manifests: { ...Object.fromEntries(MANIFESTS.map((m) => [m, { status: 'absent' } as ManifestSnapshot])), ...manifests },
});

function pkg(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { foo: '^1.0.0' }, ...over }, null, 2);
}

function lock(dependencies: Record<string, string>): string {
  return JSON.stringify(
    { name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0', dependencies } } },
    null,
    2,
  );
}

describe('tree guard — reading a manifest', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-tree-guard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an absent manifest as absent, not as a change', () => {
    expect(manifestDeps(join(dir, 'nope.json'))).toEqual({ status: 'absent' });
  });

  it('reports an unparseable manifest as unreadable, not as empty', () => {
    const path = join(dir, 'package.json');
    writeFileSync(path, '{ half-written');
    expect(manifestDeps(path).status).toBe('unreadable');
  });

  it('does not trip on a version-only change — a release bumps the version mid-suite', () => {
    const path = join(dir, 'package.json');
    writeFileSync(path, pkg());
    const first = manifestDeps(path);
    writeFileSync(path, pkg({ version: '9.9.9', description: 'edited' }));
    expect(manifestDeps(path).deps).toEqual(first.deps);
  });

  it('trips when a dependency is added (the bcrypt/express-jwt event)', () => {
    const path = join(dir, 'package.json');
    writeFileSync(path, pkg());
    const before = manifestDeps(path);
    writeFileSync(path, pkg({ dependencies: { foo: '^1.0.0', bcrypt: '^6.0.0', 'express-jwt': '^8.5.1' } }));
    expect(manifestDeps(path).deps).not.toEqual(before.deps);
  });

  it('trips when a dependency RANGE is re-pinned', () => {
    const path = join(dir, 'package.json');
    writeFileSync(path, pkg());
    const before = manifestDeps(path);
    writeFileSync(path, pkg({ dependencies: { foo: '^2.0.0' } }));
    expect(manifestDeps(path).deps).not.toEqual(before.deps);
  });

  it('trips when a devDependency is added (every section counts)', () => {
    const path = join(dir, 'package.json');
    writeFileSync(path, pkg());
    const before = manifestDeps(path);
    writeFileSync(path, pkg({ devDependencies: { bar: '^1.0.0' } }));
    expect(manifestDeps(path).deps).not.toEqual(before.deps);
  });

  it('reads the ROOT dependency set out of a lockfile (packages[""])', () => {
    const path = join(dir, 'package-lock.json');
    writeFileSync(path, lock({ foo: '^1.0.0' }));
    const before = manifestDeps(path);
    writeFileSync(path, lock({ foo: '^1.0.0', bcrypt: '^6.0.0' }));
    expect(manifestDeps(path).deps).not.toEqual(before.deps);
  });

  it('captures every manifest of a real directory', () => {
    writeFileSync(join(dir, 'package.json'), pkg());
    writeFileSync(join(dir, 'package-lock.json'), lock({ foo: '^1.0.0' }));
    const captured = captureTree(dir);
    expect(Object.keys(captured.manifests).sort()).toEqual([...MANIFESTS].sort());
    expect(captured.manifests['package.json'].status).toBe('readable');
    expect(captured.manifests['package-lock.json'].deps!['dependencies::foo']).toBe('^1.0.0');
  });
});

describe('tree guard — verdict', () => {
  it('is clean when nothing moved', () => {
    const verdict = evaluateTreeGuard(snap({ 'package.json': readable({ foo: '^1' }) }), snap({ 'package.json': readable({ foo: '^1' }) }));
    expect(verdict).toEqual({ dependencyChanges: [], createdInSource: [], newDirty: [] });
    expect(treeGuardReport(verdict)).toBeNull();
  });

  it('fails the run on an added dependency and names it', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1' }) }),
      snap({ 'package.json': readable({ foo: '^1', bcrypt: '^6.0.0', 'express-jwt': '^8.5.1' }) }),
    );
    expect(verdict.dependencyChanges).toHaveLength(1);
    expect(verdict.dependencyChanges[0].reason).toBe('changed');
    expect(verdict.dependencyChanges[0].packages).toEqual(['+bcrypt@^6.0.0', '+express-jwt@^8.5.1']);
    const report = treeGuardReport(verdict)!;
    expect(report).toContain('supply-chain');
    expect(report).toContain('bcrypt');
    expect(report).toContain('express-jwt');
  });

  it('distinguishes a re-pinned range in the report', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1.0.0' }) }),
      snap({ 'package.json': readable({ foo: '^2.0.0' }) }),
    );
    expect(verdict.dependencyChanges[0].packages).toEqual(['~foo: ^1.0.0 → ^2.0.0']);
  });

  it('reports a REMOVED dependency too', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1', bar: '^2' }) }),
      snap({ 'package.json': readable({ foo: '^1' }) }),
    );
    expect(verdict.dependencyChanges[0].packages).toEqual(['-bar@^2']);
  });

  it('treats a manifest that APPEARED during the run as a change', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1' }) }),
      snap({ 'package.json': readable({ foo: '^1' }), 'package-lock.json': readable({ foo: '^1' }) }),
    );
    expect(verdict.dependencyChanges).toEqual([
      { manifest: 'package-lock.json', reason: 'created', packages: ['foo'] },
    ]);
  });

  it('treats a manifest that DISAPPEARED during the run as a change', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1' }), 'package-lock.json': readable({ foo: '^1' }) }),
      snap({ 'package.json': readable({ foo: '^1' }) }),
    );
    expect(verdict.dependencyChanges[0]).toMatchObject({ manifest: 'package-lock.json', reason: 'removed' });
  });

  it('stays quiet about a manifest it could not read (no false positive)', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': { status: 'unreadable' } }),
      snap({ 'package.json': readable({ foo: '^1' }) }),
    );
    expect(verdict.dependencyChanges).toEqual([]);
    expect(treeGuardReport(verdict)).toBeNull();
  });

  it('reports new dirt without failing, and only paths that were not already dirty', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1' }) }, [' M src/in-flight-edit.ts']),
      snap({ 'package.json': readable({ foo: '^1' }) }, [' M src/in-flight-edit.ts', '?? tests/scratch.json']),
    );
    expect(verdict.dependencyChanges).toEqual([]);
    expect(verdict.newDirty).toEqual(['?? tests/scratch.json']);
    const report = treeGuardReport(verdict)!;
    expect(report).toContain('tests/scratch.json');
    expect(report).not.toContain('in-flight-edit');
  });

  it('FAILS the run when a file is CREATED under src/ (the leaked-write event)', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1' }) }),
      snap({ 'package.json': readable({ foo: '^1' }) }, ['?? src/test.ts']),
    );
    expect(verdict.createdInSource).toEqual(['?? src/test.ts']);
    const report = treeGuardReport(verdict)!;
    expect(report).toContain('src/test.ts');
    expect(report).toContain('npm publish');
    // Not also listed as advisory dirt — the actionable line must not be buried.
    expect(report).not.toContain('path(s) became dirty');
  });

  it('does not fail on a MODIFIED source file — that may be the developer editing', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1' }) }),
      snap({ 'package.json': readable({ foo: '^1' }) }, [' M src/orchestrator.ts']),
    );
    expect(verdict.createdInSource).toEqual([]);
    expect(treeGuardReport(verdict)).toContain('src/orchestrator.ts');
  });

  it('does not fail on a created file OUTSIDE src/ — still only an advisory', () => {
    const verdict = evaluateTreeGuard(
      snap({ 'package.json': readable({ foo: '^1' }) }),
      snap({ 'package.json': readable({ foo: '^1' }) }, ['?? tests/scratch.json']),
    );
    expect(verdict.createdInSource).toEqual([]);
    expect(treeGuardReport(verdict)).toContain('tests/scratch.json');
  });

  it('bounds the report to 20 paths and says how many it hid', () => {
    const dirty = Array.from({ length: 25 }, (_, i) => `?? scratch-${i}.json`);
    const report = treeGuardReport(evaluateTreeGuard(snap({}), snap({}, dirty)))!;
    expect(report).toContain('and 5 more');
    expect(report).not.toContain('scratch-24.json');
  });
});

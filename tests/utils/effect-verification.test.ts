/**
 * A1 — build/run effect verification.
 *
 * The live Aukat_check failure: a build exited 0, so the run declared the app
 * "successfully built and functional", while the bundle crashed on import.
 * These tests pin the rule: a build is done only when the artifact it produced
 * is OBSERVED to launch, and a crash makes the whole command a failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isBuildCommand,
  extractBuildNames,
  findLaunchCandidates,
  verifyBuildEffect,
  formatEffectVerdict,
} from '../../src/utils/effect-verification.js';
import type { LaunchResult } from '../../src/utils/effect-verification.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'effect-verify-'));
  dirs.push(d);
  return d;
}

/** Create an executable file (the "built artifact"). */
function makeExecutable(path: string): void {
  writeFileSync(path, '#!/bin/sh\necho hi\n');
  chmodSync(path, 0o755);
}

/**
 * The artifact a build writes into `dist/`. Windows artifacts are `name.exe`
 * (the platform's executability rule keys on the extension there, not the
 * mode bits), POSIX ones are bare `name`.
 */
const ARTIFACT_EXT = process.platform === 'win32' ? '.exe' : '';
function artifact(root: string, name: string): string {
  return join(root, 'dist', `${name}${ARTIFACT_EXT}`);
}

beforeEach(() => {
  delete process.env.NUVIRA_EFFECT_VERIFY;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('isBuildCommand', () => {
  it('recognizes artifact-producing builds', () => {
    for (const c of [
      'pyinstaller AukatCheck.spec',
      'python3 -m PyInstaller AukatCheck.spec --clean -y',
      'npm run build',
      'cargo build --release',
      'go build ./cmd/app',
      'xcodebuild -scheme App',
    ]) {
      expect(isBuildCommand(c), c).toBe(true);
    }
  });

  it('does not engage for ordinary commands', () => {
    for (const c of ['python3 main.py', 'npm test', 'pip install -r requirements.txt', 'git status']) {
      expect(isBuildCommand(c), c).toBe(false);
    }
  });
});

describe('extractBuildNames', () => {
  it('reads --name from the command', () => {
    expect(extractBuildNames('pyinstaller --name Foo main.py', tmp())).toContain('Foo');
  });

  it('reads names from a .spec file (dropping the .app suffix)', () => {
    const root = tmp();
    writeFileSync(
      join(root, 'AukatCheck.spec'),
      "exe = EXE(pyz, name='AukatCheck')\napp = BUNDLE(coll, name='AukatCheck.app')\n",
    );
    const names = extractBuildNames('pyinstaller AukatCheck.spec', root);
    expect(names).toContain('AukatCheck');
  });
});

describe('findLaunchCandidates', () => {
  it('finds a freshly-built executable named by the spec and ignores a stale one', () => {
    const root = tmp();
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'AukatCheck.spec'), "a = BUNDLE(coll, name='AukatCheck.app')\n");
    makeExecutable(artifact(root, 'AukatCheck'));
    const stale = artifact(root, 'OldBuild');
    makeExecutable(stale);
    // Age the stale artifact so it falls outside the build window.
    const old = new Date(Date.now() - 100_000);
    utimesSync(stale, old, old);

    const candidates = findLaunchCandidates('pyinstaller AukatCheck.spec', root, Date.now() - 1000);
    const paths = candidates.map((c) => c.path);
    expect(paths).toContain(artifact(root, 'AukatCheck'));
    // The stale artifact was NOT written in this build window.
    expect(paths).not.toContain(artifact(root, 'OldBuild'));
  });

  it('does not treat a non-executable file as a candidate', () => {
    const root = tmp();
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'notexec'), 'data');
    expect(findLaunchCandidates('pyinstaller x.spec', root, 0)).toHaveLength(0);
  });
});

describe('verifyBuildEffect', () => {
  it('is not applicable to non-build commands', async () => {
    const v = await verifyBuildEffect('python3 main.py', tmp());
    expect(v.status).toBe('not-applicable');
  });

  it('reports no-artifact (not failure) when a build produces nothing launchable', async () => {
    const v = await verifyBuildEffect('cargo build', tmp());
    expect(v.status).toBe('no-artifact');
  });

  it('verifies a build whose artifact launches cleanly', async () => {
    const root = tmp();
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'AukatCheck.spec'), "a = BUNDLE(coll, name='AukatCheck.app')\n");
    makeExecutable(artifact(root, 'AukatCheck'));
    const launch = async (): Promise<LaunchResult> => ({
      ok: true, exitCode: null, timedOut: true, stderr: '', reason: '',
    });
    const v = await verifyBuildEffect('pyinstaller AukatCheck.spec', root, { launch });
    expect(v.status).toBe('verified');
  });

  it('FAILS the build when the artifact crashes on launch (the Aukat case)', async () => {
    const root = tmp();
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'AukatCheck.spec'), "a = BUNDLE(coll, name='AukatCheck.app')\n");
    makeExecutable(artifact(root, 'AukatCheck'));
    const launch = async (): Promise<LaunchResult> => ({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stderr: "ModuleNotFoundError: No module named 'PyQt6'",
      reason: 'the artifact exited with code 1',
    });
    const v = await verifyBuildEffect('pyinstaller AukatCheck.spec', root, { launch });
    expect(v.status).toBe('failed');
    expect(v.status === 'failed' && v.stderr).toContain('PyQt6');
  });

  it('honours NUVIRA_EFFECT_VERIFY=off', async () => {
    process.env.NUVIRA_EFFECT_VERIFY = 'off';
    const v = await verifyBuildEffect('pyinstaller x.spec', tmp());
    expect(v.status).toBe('not-applicable');
  });
});

describe('formatEffectVerdict', () => {
  it('describes a crash as a failure with the stderr', () => {
    const msg = formatEffectVerdict({
      status: 'failed',
      artifact: { path: '/x/dist/App', kind: 'executable' },
      reason: 'the artifact exited with code 1',
      stderr: 'boom',
    });
    expect(msg).toMatch(/CRASHES/);
    expect(msg).toContain('boom');
  });

  it('says nothing for no-artifact / not-applicable', () => {
    expect(formatEffectVerdict({ status: 'no-artifact', buildCommand: 'x' })).toBe('');
    expect(formatEffectVerdict({ status: 'not-applicable' })).toBe('');
  });
});

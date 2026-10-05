/**
 * A6 — a plan step that names an artifact is done only when that artifact
 * exists. The extraction must be CONSERVATIVE: a false "missing" that blocks a
 * legitimate step is worse than missing a check.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractArtifactPaths, checkStepArtifacts } from '../../src/tools/step-artifact.js';

describe('extractArtifactPaths (A6)', () => {
  it('finds a named file and a path with an extension', () => {
    const paths = extractArtifactPaths(
      'Build the debug APK at android/app/build/outputs/apk/debug/app-debug.apk and write README.md',
    );
    expect(paths).toContain('android/app/build/outputs/apk/debug/app-debug.apk');
    expect(paths).toContain('README.md');
  });

  it('finds a backticked path', () => {
    expect(extractArtifactPaths('produce `dist/index.html`')).toContain('dist/index.html');
  });

  it('ignores prose, globs, URLs, flags and version numbers', () => {
    const paths = extractArtifactPaths(
      'run the tests (e.g. vitest 1.2.3), see https://example.com/docs.html, then use --config=x and build dist/*.js',
    );
    expect(paths).toEqual([]);
  });

  it('does not treat a bare directory as an artifact', () => {
    expect(extractArtifactPaths('inspect src/ and tests/')).toEqual([]);
  });
});

describe('checkStepArtifacts (A6)', () => {
  it('reports a missing artifact and accepts a present one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-artifacts-'));
    try {
      writeFileSync(join(dir, 'README.md'), '# hi');
      const present = checkStepArtifacts('write README.md', dir);
      expect(present.missing).toEqual([]);
      expect(present.checked).toContain('README.md');

      const absent = checkStepArtifacts('produce the artifact dist/app.apk', dir);
      expect(absent.missing).toEqual(['dist/app.apk']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks nothing when there is no workspace', () => {
    const r = checkStepArtifacts('write README.md', undefined);
    expect(r.missing).toEqual([]);
    expect(r.checked).toContain('README.md');
  });

  it('accepts a BARE filename found in a subdirectory (live-run false positive)', () => {
    // The cal run wrote android/local.properties and android/.../app-debug.apk,
    // then a plan step naming `local.properties` / `app-debug.apk` was refused
    // because a bare name was only ever resolved against the workspace root.
    const dir = mkdtempSync(join(tmpdir(), 'buff-artifacts-nested-'));
    try {
      mkdirSync(join(dir, 'android', 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true });
      writeFileSync(join(dir, 'android', 'local.properties'), 'sdk.dir=/x');
      writeFileSync(join(dir, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), 'zip');

      expect(checkStepArtifacts('add local.properties with the SDK path', dir).missing).toEqual([]);
      expect(checkStepArtifacts('verify app-debug.apk is built', dir).missing).toEqual([]);
      // A bare name that exists NOWHERE is still missing.
      expect(checkStepArtifacts('produce release.aab', dir).missing).toEqual(['release.aab']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count a file that only exists under node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-artifacts-nm-'));
    try {
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
      expect(checkStepArtifacts('produce index.js', dir).missing).toEqual(['index.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

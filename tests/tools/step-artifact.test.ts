/**
 * A6 — a plan step that names an artifact is done only when that artifact
 * exists. The extraction must be CONSERVATIVE: a false "missing" that blocks a
 * legitimate step is worse than missing a check.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
});

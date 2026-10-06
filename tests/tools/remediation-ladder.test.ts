/**
 * A4 — remediation ladder. A recognised toolchain failure must produce a
 * bounded, project-local fix (so the agent repairs instead of looping), and an
 * unrecognised failure must produce nothing at all.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRemediationAutoFixes,
  diagnoseFailure,
  formatAutoApply,
  formatRemediation,
  remediationAutoApplyEnabled,
} from '../../src/tools/remediation-ladder.js';

describe('diagnoseFailure (A4)', () => {
  it('recognises the JDK-version failure from the cal Android run', () => {
    const out =
      'Error: run_terminal: `cd android && ./gradlew assembleDebug` ❌ failed (exit 1).\n' +
      'Output:\n* What went wrong:\n> Could not compile. Java home supplied is invalid. ' +
      'Capacitor Android requires VERSION_21 but this JDK is 17.';
    const r = diagnoseFailure('cd android && ./gradlew assembleDebug', out);
    expect(r?.id).toBe('jdk-version');
    expect(r?.scope).toBe('project-local');
    // The fix must name the project-local move, not just "install Java".
    expect(r?.fix.join(' ')).toMatch(/JAVA_HOME/);
    expect(r?.fix.join(' ')).toMatch(/gradle\.properties/);
    // And it must say NOT to repeat the same command unchanged.
    expect(r?.fix.join(' ')).toMatch(/Do NOT retry the same command/);
  });

  it('recognises a missing Android SDK location and prescribes local.properties', () => {
    const r = diagnoseFailure(
      './gradlew assembleDebug',
      'Output:\n> SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable or by setting the sdk.dir path in your project\'s local.properties file.',
    );
    expect(r?.id).toBe('android-sdk-location');
    expect(r?.fix[0]).toMatch(/local\.properties/);
  });

  it('recognises a non-executable gradlew wrapper', () => {
    const r = diagnoseFailure(
      './gradlew assembleDebug',
      'Error: run_terminal: `./gradlew assembleDebug` ❌ failed.\nOutput:\n/usr/bin/env: bash: No such file\nsh: ./gradlew: Permission denied',
    );
    expect(r?.id).toBe('gradlew-not-executable');
    expect(r?.fix[0]).toMatch(/chmod \+x/);
  });

  it('recognises a missing Python environment and forbids --break-system-packages', () => {
    const r = diagnoseFailure(
      'pip install -r requirements.txt',
      "Output:\nerror: externally-managed-environment\n× This environment is externally managed",
    );
    expect(r?.id).toBe('python-env');
    expect(r?.fix.join(' ')).toMatch(/venv/);
    expect(r?.fix.join(' ')).toMatch(/Do NOT `pip install --break-system-packages`/);
  });

  it('recognises a Node engine mismatch', () => {
    const r = diagnoseFailure('npm install', 'npm WARN EBADENGINE Unsupported engine: required node >=20');
    expect(r?.id).toBe('node-engines');
  });

  it('returns null for an unknown failure (never invents a fix)', () => {
    expect(diagnoseFailure('npm test', 'Error: run_terminal: `npm test` failed.\nOutput:\n1 test failed: expected 2 to be 3')).toBeNull();
    expect(diagnoseFailure('', '')).toBeNull();
  });

  it('formatRemediation names the id, the summary and the ordered steps', () => {
    const r = diagnoseFailure('cd android && ./gradlew assembleDebug', 'Unsupported class file major version 61');
    expect(r).not.toBeNull();
    const text = formatRemediation(r!);
    expect(text).toContain('🔧 Known failure');
    expect(text).toContain(r!.summary);
    expect(text).toMatch(/1\. /);
  });
});

describe('remediation auto-apply (A4, opt-in)', () => {
  const dirs: string[] = [];
  const makeTree = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'nuvira-remediate-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('is OFF unless NUVIRA_REMEDIATE=auto is explicitly set', () => {
    expect(remediationAutoApplyEnabled({})).toBe(false);
    expect(remediationAutoApplyEnabled({ NUVIRA_REMEDIATE: 'on' })).toBe(false);
    expect(remediationAutoApplyEnabled({ NUVIRA_REMEDIATE: 'auto' })).toBe(true);
    expect(remediationAutoApplyEnabled({ NUVIRA_REMEDIATE: 'AUTO' })).toBe(true);
  });

  // POSIX-only: the assertion reads the file's execute bits, which do not exist
  // on Windows (and `applyRemediationAutoFixes` reports chmod-exec as not
  // applicable there — see the win32 branch in src/tools/remediation-ladder.ts).
  it.skipIf(process.platform === 'win32')('chmods the wrapper in place when gradlew is found (idempotently)', () => {
    const cwd = makeTree();
    mkdirSync(join(cwd, 'android'));
    const gradlew = join(cwd, 'android/gradlew');
    writeFileSync(gradlew, '#!/bin/sh\n');
    chmodSync(gradlew, 0o644);

    const r = diagnoseFailure('./gradlew assembleDebug', 'sh: ./gradlew: Permission denied', cwd);
    expect(r?.id).toBe('gradlew-not-executable');
    expect(r?.autoFix).toEqual([{ kind: 'chmod-exec', path: gradlew }]);

    const first = applyRemediationAutoFixes(r!);
    expect(first.applied).toEqual([`chmod +x ${gradlew}`]);
    expect(statSync(gradlew).mode & 0o111).toBeTruthy();

    // Second pass is a no-op — the fix is idempotent.
    const second = applyRemediationAutoFixes(r!);
    expect(second.applied).toEqual([]);
    expect(second.skipped.join(' ')).toMatch(/already executable/);
  });

  it('writes android/local.properties from a discoverable SDK, and never clobbers existing keys', () => {
    const cwd = makeTree();
    const sdk = join(cwd, 'sdk');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    mkdirSync(join(cwd, 'android'));
    const localProps = join(cwd, 'android/local.properties');
    writeFileSync(localProps, '# hand-written\nfoo=bar\n');

    const r = diagnoseFailure(
      './gradlew assembleDebug',
      '> SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.',
      cwd,
      { ANDROID_HOME: sdk },
    );
    expect(r?.id).toBe('android-sdk-location');
    expect(r?.autoFix?.[0]).toMatchObject({ kind: 'write-file', path: localProps, content: `sdk.dir=${sdk}\n` });

    const result = applyRemediationAutoFixes(r!);
    expect(result.applied.length).toBe(1);
    const after = readFileSync(localProps, 'utf-8');
    expect(after).toContain('foo=bar'); // existing key preserved
    expect(after).toContain(`sdk.dir=${sdk}`);

    // Re-applying is a no-op.
    const second = applyRemediationAutoFixes(r!);
    expect(second.applied).toEqual([]);
    expect(second.skipped.join(' ')).toMatch(/already set/);
  });

  it('creates the file (and its directory) when local.properties does not exist yet', () => {
    const cwd = makeTree();
    const sdk = join(cwd, 'sdk');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    const localProps = join(cwd, 'android/local.properties');

    const r = diagnoseFailure('gradle build', 'SDK location not found', cwd, { ANDROID_SDK_ROOT: sdk });
    const result = applyRemediationAutoFixes(r!);
    expect(result.applied.join(' ')).toMatch(/created/);
    expect(existsSync(localProps)).toBe(true);
    expect(readFileSync(localProps, 'utf-8')).toContain(`sdk.dir=${sdk}`);
  });

  it('declares NO auto-fix when the SDK or the wrapper cannot be located', () => {
    const cwd = makeTree();
    // No android/gradlew, no SDK on the machine's candidate paths.
    const sdkCase = diagnoseFailure('gradle build', 'SDK location not found', cwd, {
      HOME: join(cwd, 'no-such-home'),
    });
    expect(sdkCase?.autoFix).toBeUndefined();
    const wrapperCase = diagnoseFailure('./gradlew assembleDebug', 'Permission denied', cwd);
    expect(wrapperCase?.autoFix).toBeUndefined();
  });

  it('formatAutoApply reports what changed, or nothing when there is nothing to say', () => {
    const empty = formatAutoApply({ applied: [], skipped: [] });
    expect(empty).toBe('');
    const note = formatAutoApply({ applied: ['chmod +x /p/gradlew'], skipped: ['/p/x (already set)'] });
    expect(note).toMatch(/Auto-applied/);
    expect(note).toMatch(/✓ chmod \+x/);
    expect(note).toMatch(/NUVIRA_REMEDIATE=auto/);
  });
});

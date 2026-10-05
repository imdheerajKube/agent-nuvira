/**
 * A4 — remediation ladder. A recognised toolchain failure must produce a
 * bounded, project-local fix (so the agent repairs instead of looping), and an
 * unrecognised failure must produce nothing at all.
 */

import { describe, it, expect } from 'vitest';
import { diagnoseFailure, formatRemediation } from '../../src/tools/remediation-ladder.js';

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

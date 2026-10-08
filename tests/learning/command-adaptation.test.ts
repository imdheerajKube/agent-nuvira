/**
 * Command-adaptation tests — the "run → adapt" signal.
 *
 * The detection keys on the shell's OWN exit codes (127 / 9009), not on prose, so
 * these assert that fact path and the bounded note built from it.
 */

import { describe, it, expect } from 'vitest';
import {
  leadingBinary,
  isMissingBinaryFailure,
  buildMissingBinaryNote,
} from '../../src/learning/command-adaptation.js';

describe('leadingBinary', () => {
  it('finds the executable, skipping flags and env assignments', () => {
    expect(leadingBinary('brew install openjdk')).toBe('brew');
    expect(leadingBinary('NODE_ENV=ci npm ci')).toBe('npm');
    expect(leadingBinary('--verbose brew install x')).toBe('brew');
    expect(leadingBinary('/usr/local/bin/wrangler deploy')).toBe('/usr/local/bin/wrangler');
  });

  it('returns null when there is no plain executable', () => {
    expect(leadingBinary('')).toBeNull();
    expect(leadingBinary('   ')).toBeNull();
    // Only env assignments, and a substitution as the first token.
    expect(leadingBinary('FOO=bar BAZ=qux')).toBeNull();
    expect(leadingBinary('$(echo hi)')).toBeNull();
  });
});

describe('isMissingBinaryFailure', () => {
  it('recognizes the shell exit codes', () => {
    expect(isMissingBinaryFailure('Error: run_terminal: `foo` ❌ failed (exit 127).')).toBe(true);
    expect(isMissingBinaryFailure('Error: run_terminal: `foo` ❌ failed (exit 9009).')).toBe(true);
  });

  it('falls back to the shell stderr wording when the exit code is not the standard one', () => {
    expect(isMissingBinaryFailure('bash: foo: command not found')).toBe(true);
    expect(isMissingBinaryFailure("'foo' is not recognized as an internal or external command")).toBe(true);
  });

  it('does NOT fire on an ordinary failure', () => {
    expect(isMissingBinaryFailure('Error: run_terminal: `npm test` ❌ failed (exit 1).')).toBe(false);
    expect(isMissingBinaryFailure('the assertion failed')).toBe(false);
  });
});

describe('buildMissingBinaryNote', () => {
  it('states the machine and names the likely missing executable', () => {
    const note = buildMissingBinaryNote('brew install openjdk');
    expect(note).toContain('not found on this machine');
    expect(note).toContain('brew');
    expect(note).toContain('Package managers present:');
    expect(note).toContain('tool_search');
  });

  it('stays general when no executable can be identified', () => {
    const note = buildMissingBinaryNote('');
    expect(note).toContain('Package managers present:');
    expect(note).not.toContain('is not on PATH');
  });
});

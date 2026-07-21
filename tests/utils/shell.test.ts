/**
 * Shell utility tests — Platform-aware host shell detection.
 *
 * The getHostShell() function is the single source of truth for choosing the
 * correct host shell across Linux, macOS, and Windows. These tests verify
 * that it returns the right value on every platform and handles edge cases
 * like the COMSPEC environment variable.
 *
 * Since we can't actually change the OS at runtime, we mock the `platform()`
 * function from `node:os` via vitest's `vi.mock`.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mock `node:os` ──────────────────────────────────────────────────────────
// We mock before importing the module under test so that `platform()` returns
// whatever we want for each test case.
//
// Note: `vi.hoisted()` is required here because `vi.mock` is hoisted to the
// top of the file by vitest, so the variable must be initialized before
// the mock factory runs (otherwise we get a TDZ ReferenceError).

const mockPlatform = vi.hoisted(() => vi.fn());

vi.mock('node:os', () => ({
  platform: mockPlatform,
}));

// Import AFTER vi.mock so the mock takes effect
import { getHostShell } from '../../src/utils/shell.js';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getHostShell()', () => {
  // Save original COMSPEC so we can restore it after Windows tests
  const originalComspec = process.env.COMSPEC;

  afterEach(() => {
    // Restore COMSPEC after each test
    if (originalComspec === undefined) {
      delete process.env.COMSPEC;
    } else {
      process.env.COMSPEC = originalComspec;
    }
  });

  // ── Unix platforms ─────────────────────────────────────────────────────

  it('should return "/bin/sh" on Linux (platform = "linux")', () => {
    mockPlatform.mockReturnValue('linux');
    expect(getHostShell()).toBe('/bin/sh');
  });

  it('should return "/bin/sh" on macOS (platform = "darwin")', () => {
    mockPlatform.mockReturnValue('darwin');
    expect(getHostShell()).toBe('/bin/sh');
  });

  it('should return "/bin/sh" on FreeBSD (platform = "freebsd")', () => {
    mockPlatform.mockReturnValue('freebsd');
    expect(getHostShell()).toBe('/bin/sh');
  });

  it('should return "/bin/sh" on Android (platform = "android")', () => {
    mockPlatform.mockReturnValue('android');
    expect(getHostShell()).toBe('/bin/sh');
  });

  // ── Windows platform ───────────────────────────────────────────────────

  it('should return "cmd.exe" on Windows when COMSPEC is not set', () => {
    mockPlatform.mockReturnValue('win32');
    delete process.env.COMSPEC;
    expect(getHostShell()).toBe('cmd.exe');
  });

  it('should return the COMSPEC value on Windows when it is set', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe';
    expect(getHostShell()).toBe('C:\\Windows\\system32\\cmd.exe');
  });

  it('should return a custom COMSPEC value on Windows (e.g., PowerShell)', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(getHostShell()).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('should return COMSPEC over bare "cmd.exe" even on non-standard paths', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.COMSPEC = 'D:\\tools\\cmd.exe';
    expect(getHostShell()).toBe('D:\\tools\\cmd.exe');
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('should return "cmd.exe" on Windows when COMSPEC is an empty string', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.COMSPEC = '';
    expect(getHostShell()).toBe('cmd.exe');
  });

  it('should not be affected by COMSPEC on Unix platforms', () => {
    // Set COMSPEC to a Windows path — Unix should still return /bin/sh
    mockPlatform.mockReturnValue('linux');
    process.env.COMSPEC = 'C:\\Windows\\cmd.exe';
    expect(getHostShell()).toBe('/bin/sh');
  });

  it('should handle the empty-string COMSPEC on non-Windows without affecting result', () => {
    mockPlatform.mockReturnValue('darwin');
    process.env.COMSPEC = '';
    expect(getHostShell()).toBe('/bin/sh');
  });

  // ── Determinism ────────────────────────────────────────────────────────

  it('should return consistently for the same platform', () => {
    mockPlatform.mockReturnValue('linux');
    const first = getHostShell();
    const second = getHostShell();
    const third = getHostShell();
    expect(first).toBe('/bin/sh');
    expect(second).toBe('/bin/sh');
    expect(third).toBe('/bin/sh');
  });

  it('should return consistently for Windows', () => {
    mockPlatform.mockReturnValue('win32');
    delete process.env.COMSPEC;
    const first = getHostShell();
    const second = getHostShell();
    const third = getHostShell();
    expect(first).toBe('cmd.exe');
    expect(second).toBe('cmd.exe');
    expect(third).toBe('cmd.exe');
  });
});

/**
 * P5a — Release-sync tests.
 *
 * After a publish, the website/docs release markers must stay at the release
 * level. Pure fixture tests: stale "Current release" / test-count badge /
 * docs header detected; no-op when versions match; historical "Since v1.x"
 * notes are NOT flagged (deliberately narrow markers). Plus runReleaseSync
 * against real fixture files (gaps + emit, no-op when synced, missing target
 * is best-effort).
 */

import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findReleaseDrift, fixReleaseDrift, runReleaseSync, SYNC_TARGETS } from '../../src/tools/release-sync.js';

describe('findReleaseDrift — pure drift detection', () => {
  it('flags a stale Current release marker (v1.73.0 vs v1.74.0)', () => {
    const text = '<p>Current release <strong>v1.73.0</strong> — the wave.</p>';
    const gaps = findReleaseDrift(text, 'website/index.html', '1.74.0');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      file: 'website/index.html',
      found: 'v1.73.0',
      expected: 'v1.74.0',
      kind: 'current-release',
    });
    expect(gaps[0].line).toBe(1);
  });

  it('flags a stale test-count badge (v1.73.0 · N tests)', () => {
    const text = '<span class="arch-tier">v1.73.0 · 4,556 tests</span>';
    const gaps = findReleaseDrift(text, 'website/index.html', '1.74.0');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('test-count-badge');
    expect(gaps[0].found).toBe('v1.73.0');
  });

  it('flags a stale docs header (buff v1.73.x vs v1.74.x)', () => {
    const text = 'Document generated from the live CLI surface (`buff` v1.73.x).';
    const gaps = findReleaseDrift(text, 'docs/COMMANDS.md', '1.74.0');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('cli-version-header');
    expect(gaps[0].found).toBe('v1.73.x');
    expect(gaps[0].expected).toBe('v1.74.x');
  });

  it('flags a stale docs header in the nuvira binary-name form', () => {
    // The live COMMANDS.md footer says `nuvira` v1.74.x — the detector must
    // cover BOTH installed binary names, not just `buff`.
    const text = '*Document generated from the live CLI surface (`nuvira` v1.74.x).*';
    const gaps = findReleaseDrift(text, 'docs/COMMANDS.md', '2.7.0');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('cli-version-header');
    expect(gaps[0].found).toBe('v1.74.x');
    expect(gaps[0].expected).toBe('v2.7.x');
    expect(gaps[0].line).toBe(1);
  });

  it('no-op when the markers already match the published version', () => {
    const text = [
      '<p>Current release <strong>v1.74.0</strong>.</p>',
      '<span class="arch-tier">v1.74.0 · 4,556 tests</span>',
      '(`buff` v1.74.x)',
    ].join('\n');
    expect(findReleaseDrift(text, 'website/index.html', '1.74.0')).toEqual([]);
    // A version prefix on the input is normalized.
    expect(findReleaseDrift(text, 'website/index.html', 'v1.74.0')).toEqual([]);
  });

  it('historical "Since v1.x" notes are NOT markers (no false positives)', () => {
    const text = [
      'Since v1.60.x those windows are live.',
      'Since <strong>v1.62.0</strong> the pipeline can\'t quietly skip work.',
      'New in v1.32.0 — two dedicated agents.',
    ].join('\n');
    expect(findReleaseDrift(text, 'website/index.html', '1.74.0')).toEqual([]);
  });

  it('reports the correct line number for a multi-line file', () => {
    const text = ['line one', '<p>Current release <strong>v1.70.0</strong></p>', 'line three'].join('\n');
    const gaps = findReleaseDrift(text, 'website/index.html', '1.74.0');
    expect(gaps[0].line).toBe(2);
  });

  it('never throws on empty or malformed text', () => {
    expect(findReleaseDrift('', 'website/index.html', '1.74.0')).toEqual([]);
    expect(findReleaseDrift('no markers here at all', 'x.md', '1.74.0')).toEqual([]);
  });
});

describe('runReleaseSync — post-publish check', () => {
  it('finds stale markers across the sync targets and emits the structured event', () => {
    const root = mkdtempSync(join(tmpdir(), 'buff-sync-'));
    try {
      mkdirSync(join(root, 'website'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      // Fixture website with a stale Current release + a matching badge.
      const site = [
        '<p>Current release <strong>v1.73.0</strong> — stale.</p>',
        '<span class="arch-tier">v1.74.0 · 4,556 tests</span>',
      ].join('\n');
      writeFileSync(join(root, 'website', 'index.html'), site);
      writeFileSync(join(root, 'docs', 'COMMANDS.md'), '(`buff` v1.73.x)');

      const events: Array<{ event: string; data: unknown }> = [];
      const ctx = { configManager: {}, cwd: root, emit: (e: string, d: unknown) => events.push({ event: e, data: d }) };
      // reportOnly — the detect-only surface (auto-fix has its own block below).
      const out = runReleaseSync('1.74.0', ctx, { reportOnly: true });

      expect(out).toContain('2 stale release marker');
      expect(out).toContain('website/index.html:1');
      expect(out).toContain('v1.73.0, should be v1.74.0');
      expect(out).toContain('docs/COMMANDS.md');
      expect(out).toContain('ask_user');
      const ev = events.find((e) => e.event === 'release:sync');
      expect(ev).toBeTruthy();
      expect((ev!.data as { version: string; synced: boolean }).version).toBe('1.74.0');
      expect((ev!.data as { gaps: unknown[] }).gaps).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no-op when everything is already at the release level', () => {
    const root = mkdtempSync(join(tmpdir(), 'buff-sync-'));
    try {
      mkdirSync(join(root, 'website'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'website', 'index.html'), '<p>Current release <strong>v1.74.0</strong></p>');
      writeFileSync(join(root, 'docs', 'COMMANDS.md'), '(`buff` v1.74.x)');
      const ctx = { configManager: {}, cwd: root, emit: () => {} };
      const out = runReleaseSync('1.74.0', ctx);
      expect(out).toContain('no version drift');
      expect(out).toContain('✅');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('missing sync targets are best-effort (never throws, reports synced)', () => {
    const root = mkdtempSync(join(tmpdir(), 'buff-sync-'));
    try {
      // No website/ or docs/ at all.
      const ctx = { configManager: {}, cwd: root, emit: () => {} };
      const out = runReleaseSync('1.74.0', ctx);
      expect(out).toContain('no version drift');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SYNC_TARGETS covers the website + docs (the drift surface)', () => {
    expect(SYNC_TARGETS).toEqual(['website/index.html', 'docs/COMMANDS.md']);
  });
});

describe('fixReleaseDrift — pure deterministic patcher (P5a.2)', () => {
  it('rewrites every stale marker version and nothing else', () => {
    const text = [
      '<p>Current release <strong>v1.73.0</strong> — the wave.</p>',
      '<span class="arch-tier">v1.73.0 · 4,556 tests</span>',
      '*Document generated from the live CLI surface (`nuvira` v1.73.x).*',
      '<p>Historical note: since v1.60.x nothing here should change.</p>',
    ].join('\n');
    const fixed = fixReleaseDrift(text, 'v2.7.0');
    expect(fixed).toContain('Current release <strong>v2.7.0</strong>');
    expect(fixed).toContain('v2.7.0 · 4,556 tests');
    expect(fixed).toContain('(`nuvira` v2.7.x)');
    // Non-marker text (including historical notes) is untouched.
    expect(fixed).toContain('since v1.60.x nothing here should change');
    expect(fixed).toContain('the wave.</p>');
    // Deterministic.
    expect(fixReleaseDrift(text, 'v2.7.0')).toBe(fixed);
  });

  it('is the exact inverse of findReleaseDrift (detect⇄fix agreement)', () => {
    const text = 'Current release <strong>v1.0.0</strong>\n(`buff` v1.0.x)\nv1.0.0 · 12 tests';
    const drifted = findReleaseDrift(text, 'f', '9.9.9');
    expect(drifted).toHaveLength(3);
    const fixed = fixReleaseDrift(text, '9.9.9');
    expect(findReleaseDrift(fixed, 'f', '9.9.9')).toEqual([]);
  });

  it('leaves already-current markers byte-identical', () => {
    const text = 'Current release <strong>v2.7.0</strong> and `nuvira` v2.7.x';
    expect(fixReleaseDrift(text, '2.7.0')).toBe(text);
  });
});

describe('runReleaseSync auto-fix (P5a.2) — patch, verify, report', () => {
  it('fixes stale markers on disk and verifies by re-scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'buff-syncfix-'));
    try {
      mkdirSync(join(root, 'website'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'website', 'index.html'), '<p>Current release <strong>v1.74.0</strong></p>');
      writeFileSync(join(root, 'docs', 'COMMANDS.md'), '(`nuvira` v1.74.x) — when in doubt, --help.');
      const events: Array<{ event: string; data: any }> = [];
      const ctx = { configManager: {}, cwd: root, emit: (e: string, d: unknown) => events.push({ event: e, data: d }) };

      const out = runReleaseSync('2.7.0', ctx);

      expect(out).toContain('auto-fixed 2 stale marker');
      expect(out).toContain('✅');
      // The files on disk are now at the release level.
      expect(readFileSync(join(root, 'website', 'index.html'), 'utf-8')).toContain('v2.7.0');
      expect(readFileSync(join(root, 'docs', 'COMMANDS.md'), 'utf-8')).toContain('v2.7.x');
      // Structured event carries the verified fixes.
      const ev = events.find((e) => e.event === 'release:sync');
      expect(ev).toBeTruthy();
      expect(ev!.data.fixes).toHaveLength(2);
      expect(ev!.data.fixes.every((f: { verified: boolean }) => f.verified === true)).toBe(true);
      expect(ev!.data.synced).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reportOnly mode detects without touching the files', () => {
    const root = mkdtempSync(join(tmpdir(), 'buff-syncro-'));
    try {
      mkdirSync(join(root, 'website'), { recursive: true });
      writeFileSync(join(root, 'website', 'index.html'), '<p>Current release <strong>v1.74.0</strong></p>');
      const before = readFileSync(join(root, 'website', 'index.html'), 'utf-8');
      const ctx = { configManager: {}, cwd: root, emit: () => {} };

      const out = runReleaseSync('2.7.0', ctx, { reportOnly: true });

      expect(out).toContain('1 stale release marker');
      expect(out).toContain('Offer to fix');
      expect(readFileSync(join(root, 'website', 'index.html'), 'utf-8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a failed write is reported as an error, never thrown (best-effort)', () => {
    const root = mkdtempSync(join(tmpdir(), 'buff-syncerr-'));
    try {
      mkdirSync(join(root, 'website'), { recursive: true });
      const filePath = join(root, 'website', 'index.html');
      writeFileSync(filePath, '<p>Current release <strong>v1.74.0</strong></p>');
      chmodSync(filePath, 0o444); // read-only
      const ctx = { configManager: {}, cwd: root, emit: () => {} };

      const out = runReleaseSync('2.7.0', ctx);

      expect(out).toContain('write failed');
      // No fix is claimed — the failed file is reported, not fabricated.
      expect(out).not.toContain('✅');
      // The file is untouched (still stale).
      expect(readFileSync(filePath, 'utf-8')).toContain('v1.74.0');
      // Restore permissions so rmSync can clean up on all platforms.
      chmodSync(filePath, 0o644);
    } finally {
      chmodSync(join(root, 'website', 'index.html'), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

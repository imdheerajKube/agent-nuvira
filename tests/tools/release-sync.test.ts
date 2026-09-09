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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findReleaseDrift, runReleaseSync, SYNC_TARGETS } from '../../src/tools/release-sync.js';

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
      const out = runReleaseSync('1.74.0', ctx);

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

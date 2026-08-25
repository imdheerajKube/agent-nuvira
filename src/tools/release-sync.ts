/**
 * P5a — Release-sync loop (website/docs kept at release level).
 *
 * The ask: *"whenever a new publish happens you ensure the website is
 * updated, kept at the same level, you compare release versions, fix the
 * gaps"* (plan row 23). After a successful `publish`, this module diffs the
 * published version against the release-marker strings in the website and
 * docs — version strings drift from package.json after releases (observed:
 * `website/index.html` carries a "Current release vX.Y.Z" marker + a
 * `vX.Y.Z · N tests` badge, `docs/COMMANDS.md` carries a `nuvira vX.Y.x`
 * header), and NO post-publish diff existed.
 *
 * Deterministic and pure at the core (`findReleaseDrift` — fixture-testable):
 * each release-marker pattern is matched and compared against the CURRENT
 * version; a marker that still names an older version is a gap. Historical
 * "Since v1.60.x" notes are deliberately NOT markers — only the three
 * release-marker patterns below are checked, so nothing false-positives.
 *
 * Best-effort by construction: a missing/unreadable sync target, or an
 * emission failure, never throws — a sync check failure must never mark the
 * publish failed (the brief's hard rule).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ToolContext } from './registry.js';

/** One stale release marker found in a sync target. */
export interface ReleaseDriftGap {
  /** The file the stale marker lives in (e.g. website/index.html). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The stale version string found (e.g. v1.73.0). */
  found: string;
  /** What it should be (the published version, e.g. v1.74.0). */
  expected: string;
  /** Which marker pattern flagged it. */
  kind: 'current-release' | 'test-count-badge' | 'cli-version-header';
}

/** The sync targets scanned after a publish (relative to the workspace root). */
export const SYNC_TARGETS = ['website/index.html', 'docs/COMMANDS.md'];

/**
 * Pure drift detector — the testable core. Scans one file's text for the
 * release-marker patterns and returns every marker whose version does NOT
 * match the current (published) version. Never throws.
 *
 * Markers (deliberately narrow — historical notes are not markers):
 *   1. `Current release <strong>vX.Y.Z</strong>`        → exact version
 *   2. `vX.Y.Z · N tests` (the arch-tier badge)          → exact version
 *   3. `nuvira vX.Y.x` (COMMANDS.md header)                → major.minor only
 */
export function findReleaseDrift(text: string, file: string, currentVersion: string): ReleaseDriftGap[] {
  const gaps: ReleaseDriftGap[] = [];
  const clean = currentVersion.trim().replace(/^v/, '');
  const expectedExact = `v${clean}`;
  const expectedMajorMinor = clean.split('.').slice(0, 2).join('.');

  // Marker 1 — the website's "Current release" callout.
  const currentRe = /Current release <strong>v(\d+\.\d+\.\d+)<\/strong>/g;
  let m: RegExpExecArray | null;
  while ((m = currentRe.exec(text)) !== null) {
    const found = m[1];
    if (found !== clean) {
      gaps.push({
        file,
        line: lineNumberAt(text, m.index),
        found: `v${found}`,
        expected: expectedExact,
        kind: 'current-release',
      });
    }
  }

  // Marker 2 — the arch-tier "vX.Y.Z · N tests" badge (N is comma-grouped,
  // e.g. "4,556 tests").
  const badgeRe = /v(\d+\.\d+\.\d+) · [\d,]+ tests/g;
  while ((m = badgeRe.exec(text)) !== null) {
    const found = m[1];
    if (found !== clean) {
      gaps.push({
        file,
        line: lineNumberAt(text, m.index),
        found: `v${found}`,
        expected: expectedExact,
        kind: 'test-count-badge',
      });
    }
  }

  // Marker 3 — the docs "`buff` vX.Y.x" header (major.minor only). The real
  // COMMANDS.md marker wraps `buff` in backticks, but tolerate both forms.
  const cliRe = /`?buff`? v(\d+\.\d+)\.x/g;
  while ((m = cliRe.exec(text)) !== null) {
    const found = m[1];
    if (found !== expectedMajorMinor) {
      gaps.push({
        file,
        line: lineNumberAt(text, m.index),
        found: `v${found}.x`,
        expected: `v${expectedMajorMinor}.x`,
        kind: 'cli-version-header',
      });
    }
  }

  return gaps;
}

/** 1-based line number of a character offset. */
function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** Read a sync target's text (empty string when missing/unreadable). */
function readTarget(root: string, target: string): string {
  try {
    const p = join(root, target);
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

/**
 * Run the post-publish sync check: scan every sync target under the
 * workspace root for stale release markers vs the published version. Emits a
 * structured `release:sync` event (best-effort) so a future GUI card can
 * render the gaps with an offer-to-fix. Returns a model-feedable summary —
 * never throws.
 */
export function runReleaseSync(currentVersion: string, ctx: ToolContext): string {
  const root = ctx.cwd || process.cwd();
  const clean = currentVersion.trim().replace(/^v/, '');
  const gaps: ReleaseDriftGap[] = [];

  for (const target of SYNC_TARGETS) {
    const text = readTarget(root, target);
    if (!text) continue; // a missing target is not a gap — best-effort
    gaps.push(...findReleaseDrift(text, target, clean));
  }

  if (gaps.length === 0) {
    ctx.emit?.('release:sync', { version: clean, gaps: [], synced: true });
    return `✅ Release-sync: website/docs already at v${clean} — no version drift.`;
  }

  const lines = gaps.map(
    (g) => `  • ${g.file}:${g.line} — ${g.kind} shows ${g.found}, should be ${g.expected}`,
  );
  ctx.emit?.('release:sync', { version: clean, gaps, synced: false });
  return (
    `⚠️  Release-sync: ${gaps.length} stale release marker(s) after publishing v${clean}:\n` +
    lines.join('\n') +
    `\nOffer to fix them (ask_user → edit_file) so the website/docs stay at the release level.`
  );
}

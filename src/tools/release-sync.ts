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
 * P5a.2 — AUTO-FIX: detection alone left the fix to a human (or a lucky
 * agent turn). Since every marker is a NARROW, version-bearing regex, the
 * fix is deterministic: rewrite the stale version token, keep everything
 * else byte-identical, then RE-DETECT on the result (a fix that does not
 * verify is reported as failed, never silently claimed). `runReleaseSync`
 * now fixes by default; `reportOnly` opts out. File writes are surgical
 * (target file, matched span only) and failures are best-effort — a sync
 * failure must never mark the publish failed.
 *
 * Deterministic and pure at the core (`findReleaseDrift` / `fixReleaseDrift`
 * — fixture-testable): each release-marker pattern is matched and compared
 * against the CURRENT version; a marker that still names an older version is
 * a gap. Historical "Since v1.60.x" notes are deliberately NOT markers —
 * only the three release-marker patterns below are checked, so nothing
 * false-positives.
 *
 * Best-effort by construction: a missing/unreadable sync target, or an
 * emission failure, never throws — a sync check failure must never mark the
 * publish failed (the brief's hard rule).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

/** One deterministic marker edit applied to a target file. */
export interface ReleaseSyncFix {
  file: string;
  line: number;
  kind: ReleaseDriftGap['kind'];
  found: string;
  expected: string;
  /** True when the re-detection pass confirmed the marker is now current. */
  verified: boolean;
}

/** The result of one auto-fix pass over the sync targets. */
export interface ReleaseSyncResult {
  version: string;
  /** Gaps that were detected (before any fix ran). */
  gaps: ReleaseDriftGap[];
  /** Fixes that were applied (only when auto-fix ran). */
  fixes: ReleaseSyncFix[];
  /** True when every detected gap was fixed AND re-detection is clean. */
  synced: boolean;
  /** Sync targets that could not be read or written (best-effort notes). */
  errors: string[];
}

/** The three release markers, shared by detect + fix (single source of truth). */
interface ReleaseMarker {
  kind: ReleaseDriftGap['kind'];
  /** Capture 1 = stale version digits (no `v`), the ONLY thing a fix rewrites. */
  pattern: RegExp;
  /** Render the marker with a corrected version (capture-preserving). */
  render: (fullMatch: string, staleVersion: string, fixedVersion: string) => string;
}

const RELEASE_MARKERS: ReleaseMarker[] = [
  {
    kind: 'current-release',
    // Marker 1 — the website's "Current release" callout.
    pattern: /Current release <strong>v(\d+\.\d+\.\d+)<\/strong>/g,
    render: (_full, stale, fixed) => _full.replace(`v${stale}`, `v${fixed}`),
  },
  {
    kind: 'test-count-badge',
    // Marker 2 — the arch-tier "vX.Y.Z · N tests" badge (N is comma-grouped).
    pattern: /v(\d+\.\d+\.\d+) · [\d,]+ tests/g,
    render: (_full, stale, fixed) => _full.replace(`v${stale}`, `v${fixed}`),
  },
  {
    kind: 'cli-version-header',
    // Marker 3 — the docs "`buff` vX.Y.x" / "`nuvira` vX.Y.x" CLI header
    // (major.minor only). COMMANDS.md has used both binary names.
    pattern: /`?(?:buff|nuvira)`? v(\d+\.\d+)\.x/g,
    render: (_full, stale, fixed) => _full.replace(`v${stale}.x`, `v${fixed}.x`),
  },
];

/** 1-based line number of a character offset. */
function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Pure drift detector — the testable core. Scans one file's text for the
 * release-marker patterns and returns every marker whose version does NOT
 * match the current (published) version. Never throws.
 */
export function findReleaseDrift(text: string, file: string, currentVersion: string): ReleaseDriftGap[] {
  const gaps: ReleaseDriftGap[] = [];
  const clean = currentVersion.trim().replace(/^v/, '');
  const expectedExact = `v${clean}`;
  const expectedMajorMinor = clean.split('.').slice(0, 2).join('.');

  for (const marker of RELEASE_MARKERS) {
    marker.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = marker.pattern.exec(text)) !== null) {
      const found = m[1];
      const stale =
        marker.kind === 'cli-version-header'
          ? found !== expectedMajorMinor
          : found !== clean;
      if (stale) {
        gaps.push({
          file,
          line: lineNumberAt(text, m.index),
          found: marker.kind === 'cli-version-header' ? `v${found}.x` : `v${found}`,
          expected: marker.kind === 'cli-version-header' ? `v${expectedMajorMinor}.x` : expectedExact,
          kind: marker.kind,
        });
      }
    }
  }

  return gaps;
}

/**
 * P5a.2 — pure marker patcher. Rewrites ONLY the stale version tokens of the
 * release markers in `text` to `currentVersion`; every other byte is kept.
 * Deterministic: same input + version → same output. Companion to
 * `findReleaseDrift` (shared marker table), so anything detection would flag,
 * the patcher fixes — and vice versa.
 */
export function fixReleaseDrift(text: string, currentVersion: string): string {
  const clean = currentVersion.trim().replace(/^v/, '');
  const expectedMajorMinor = clean.split('.').slice(0, 2).join('.');

  let out = text;
  for (const marker of RELEASE_MARKERS) {
    marker.pattern.lastIndex = 0;
    out = out.replace(marker.pattern, (full, stale: string) => {
      const fixed = marker.kind === 'cli-version-header' ? expectedMajorMinor : clean;
      return stale === fixed ? full : marker.render(full, stale, fixed);
    });
  }
  return out;
}

/** Read a sync target's text (empty string when missing/unreadable). */
function readTarget(root: string, target: string): { text: string; ok: boolean } {
  try {
    const p = join(root, target);
    if (!existsSync(p)) return { text: '', ok: false };
    return { text: readFileSync(p, 'utf-8'), ok: true };
  } catch {
    return { text: '', ok: false };
  }
}

/** Write a sync target (false on any failure — reported, never thrown). */
function writeTarget(root: string, target: string, text: string): boolean {
  try {
    writeFileSync(join(root, target), text, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * P5a.2 — run the post-publish sync pass with AUTO-FIX. Detects drift,
 * patches every stale marker, re-reads and RE-DETECTS to verify, and emits a
 * structured `release:sync` event. `reportOnly: true` restores the old
 * detect-only behavior. Returns a model-feedable summary — never throws.
 */
export function runReleaseSync(
  currentVersion: string,
  ctx: ToolContext,
  opts?: { reportOnly?: boolean },
): string {
  const root = ctx.cwd || process.cwd();
  const clean = currentVersion.trim().replace(/^v/, '');
  const reportOnly = opts?.reportOnly === true;
  const gaps: ReleaseDriftGap[] = [];
  const fixes: ReleaseSyncFix[] = [];
  const errors: string[] = [];

  for (const target of SYNC_TARGETS) {
    const read = readTarget(root, target);
    if (!read.ok || !read.text) continue; // a missing target is not a gap — best-effort

    const found = findReleaseDrift(read.text, target, clean);
    gaps.push(...found);

    if (found.length === 0 || reportOnly) continue;

    const fixedText = fixReleaseDrift(read.text, clean);
    if (!writeTarget(root, target, fixedText)) {
      errors.push(`${target}: write failed (read-only checkout?) — fix manually or commit the version bump first.`);
      continue;
    }
    // Verify: re-read the file we just wrote and re-detect. A fix that does
    // not verify is reported as failed — never silently claimed as done.
    const verify = readTarget(root, target);
    const remaining = verify.ok ? findReleaseDrift(verify.text, target, clean) : found;
    for (const gap of found) {
      const stillThere = remaining.some(
        (r) => r.kind === gap.kind && r.line === gap.line,
      );
      fixes.push({ file: gap.file, line: gap.line, kind: gap.kind, found: gap.found, expected: gap.expected, verified: !stillThere });
    }
  }

  const fixedCount = fixes.filter((f) => f.verified).length;
  const failedCount = fixes.filter((f) => !f.verified).length;
  const synced = gaps.length === 0 || (reportOnly === false && failedCount === 0 && errors.length === 0);

  try {
    ctx.emit?.('release:sync', { version: clean, gaps, fixes, synced, reportOnly, errors });
  } catch {
    /* best-effort — the text summary below still ships */
  }

  if (gaps.length === 0) {
    return `✅ Release-sync: website/docs already at v${clean} — no version drift.`;
  }

  if (reportOnly) {
    const lines = gaps.map(
      (g) => `  • ${g.file}:${g.line} — ${g.kind} shows ${g.found}, should be ${g.expected}`,
    );
    return (
      `⚠️  Release-sync: ${gaps.length} stale release marker(s) vs v${clean}:\n` +
      lines.join('\n') +
      `\nOffer to fix them (ask_user → edit_file) so the website/docs stay at the release level.`
    );
  }

  const fixLines = fixes.map(
    (f) =>
      `  • ${f.file}:${f.line} — ${f.kind} ${f.found} → ${f.expected}${f.verified ? ' ✅' : ' ❌ verify failed'}`,
  );
  const errorLines = errors.length > 0 ? `\n⚠️ ${errors.join('\n⚠️ ')}` : '';
  const status =
    failedCount === 0 && errors.length === 0
      ? `✅ Release-sync auto-fixed ${fixedCount} stale marker(s) for v${clean} — verified by re-scan.`
      : `⚠️  Release-sync: ${fixedCount} fixed, ${failedCount} failed for v${clean}:`;

  return `${status}\n${fixLines.join('\n')}${errorLines}`;
}

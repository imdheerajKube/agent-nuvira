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
export declare const SYNC_TARGETS: string[];
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
/**
 * Pure drift detector — the testable core. Scans one file's text for the
 * release-marker patterns and returns every marker whose version does NOT
 * match the current (published) version. Never throws.
 */
export declare function findReleaseDrift(text: string, file: string, currentVersion: string): ReleaseDriftGap[];
/**
 * P5a.2 — pure marker patcher. Rewrites ONLY the stale version tokens of the
 * release markers in `text` to `currentVersion`; every other byte is kept.
 * Deterministic: same input + version → same output. Companion to
 * `findReleaseDrift` (shared marker table), so anything detection would flag,
 * the patcher fixes — and vice versa.
 */
export declare function fixReleaseDrift(text: string, currentVersion: string): string;
/**
 * P5a.2 — run the post-publish sync pass with AUTO-FIX. Detects drift,
 * patches every stale marker, re-reads and RE-DETECTS to verify, and emits a
 * structured `release:sync` event. `reportOnly: true` restores the old
 * detect-only behavior. Returns a model-feedable summary — never throws.
 */
export declare function runReleaseSync(currentVersion: string, ctx: ToolContext, opts?: {
    reportOnly?: boolean;
}): string;
//# sourceMappingURL=release-sync.d.ts.map
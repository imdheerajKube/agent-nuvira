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
/** The sync targets scanned after a publish (relative to the workspace root). */
export const SYNC_TARGETS = ['website/index.html', 'docs/COMMANDS.md'];
const RELEASE_MARKERS = [
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
function lineNumberAt(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n')
            line++;
    }
    return line;
}
/**
 * Pure drift detector — the testable core. Scans one file's text for the
 * release-marker patterns and returns every marker whose version does NOT
 * match the current (published) version. Never throws.
 */
export function findReleaseDrift(text, file, currentVersion) {
    const gaps = [];
    const clean = currentVersion.trim().replace(/^v/, '');
    const expectedExact = `v${clean}`;
    const expectedMajorMinor = clean.split('.').slice(0, 2).join('.');
    for (const marker of RELEASE_MARKERS) {
        marker.pattern.lastIndex = 0;
        let m;
        while ((m = marker.pattern.exec(text)) !== null) {
            const found = m[1];
            const stale = marker.kind === 'cli-version-header'
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
export function fixReleaseDrift(text, currentVersion) {
    const clean = currentVersion.trim().replace(/^v/, '');
    const expectedMajorMinor = clean.split('.').slice(0, 2).join('.');
    let out = text;
    for (const marker of RELEASE_MARKERS) {
        marker.pattern.lastIndex = 0;
        out = out.replace(marker.pattern, (full, stale) => {
            const fixed = marker.kind === 'cli-version-header' ? expectedMajorMinor : clean;
            return stale === fixed ? full : marker.render(full, stale, fixed);
        });
    }
    return out;
}
/** Read a sync target's text (empty string when missing/unreadable). */
function readTarget(root, target) {
    try {
        const p = join(root, target);
        if (!existsSync(p))
            return { text: '', ok: false };
        return { text: readFileSync(p, 'utf-8'), ok: true };
    }
    catch {
        return { text: '', ok: false };
    }
}
/** Write a sync target (false on any failure — reported, never thrown). */
function writeTarget(root, target, text) {
    try {
        writeFileSync(join(root, target), text, 'utf-8');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * P5a.2 — run the post-publish sync pass with AUTO-FIX. Detects drift,
 * patches every stale marker, re-reads and RE-DETECTS to verify, and emits a
 * structured `release:sync` event. `reportOnly: true` restores the old
 * detect-only behavior. Returns a model-feedable summary — never throws.
 */
export function runReleaseSync(currentVersion, ctx, opts) {
    const root = ctx.cwd || process.cwd();
    const clean = currentVersion.trim().replace(/^v/, '');
    const reportOnly = opts?.reportOnly === true;
    const gaps = [];
    const fixes = [];
    const errors = [];
    for (const target of SYNC_TARGETS) {
        const read = readTarget(root, target);
        if (!read.ok || !read.text)
            continue; // a missing target is not a gap — best-effort
        const found = findReleaseDrift(read.text, target, clean);
        gaps.push(...found);
        if (found.length === 0 || reportOnly)
            continue;
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
            const stillThere = remaining.some((r) => r.kind === gap.kind && r.line === gap.line);
            fixes.push({ file: gap.file, line: gap.line, kind: gap.kind, found: gap.found, expected: gap.expected, verified: !stillThere });
        }
    }
    const fixedCount = fixes.filter((f) => f.verified).length;
    const failedCount = fixes.filter((f) => !f.verified).length;
    const synced = gaps.length === 0 || (reportOnly === false && failedCount === 0 && errors.length === 0);
    try {
        ctx.emit?.('release:sync', { version: clean, gaps, fixes, synced, reportOnly, errors });
    }
    catch {
        /* best-effort — the text summary below still ships */
    }
    if (gaps.length === 0) {
        return `✅ Release-sync: website/docs already at v${clean} — no version drift.`;
    }
    if (reportOnly) {
        const lines = gaps.map((g) => `  • ${g.file}:${g.line} — ${g.kind} shows ${g.found}, should be ${g.expected}`);
        return (`⚠️  Release-sync: ${gaps.length} stale release marker(s) vs v${clean}:\n` +
            lines.join('\n') +
            `\nOffer to fix them (ask_user → edit_file) so the website/docs stay at the release level.`);
    }
    const fixLines = fixes.map((f) => `  • ${f.file}:${f.line} — ${f.kind} ${f.found} → ${f.expected}${f.verified ? ' ✅' : ' ❌ verify failed'}`);
    const errorLines = errors.length > 0 ? `\n⚠️ ${errors.join('\n⚠️ ')}` : '';
    const status = failedCount === 0 && errors.length === 0
        ? `✅ Release-sync auto-fixed ${fixedCount} stale marker(s) for v${clean} — verified by re-scan.`
        : `⚠️  Release-sync: ${fixedCount} fixed, ${failedCount} failed for v${clean}:`;
    return `${status}\n${fixLines.join('\n')}${errorLines}`;
}
//# sourceMappingURL=release-sync.js.map
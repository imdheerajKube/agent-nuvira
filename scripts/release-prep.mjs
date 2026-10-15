#!/usr/bin/env node
// Release prep — consolidate the CHANGELOG for a release.
//
// The CHANGELOG accumulates `## [Unreleased]` placeholder blocks ("- feat x" /
// "- fix login") and one-off session headers. For a release we:
//   1. Drop every junk placeholder block ("## [Unreleased]" + "- feat x"/"- fix login").
//   2. Keep real session entries, re-titled `### Session N — …` under one version header.
//   3. Remove bare `## [Unreleased]` header lines from the body.
//   4. Write a `## v<version> — <title>` section with a highlights summary.
//
// Usage: node scripts/release-prep.mjs <version> "<title>"
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
const title = process.argv[3] || 'release';
if (!version) {
  console.error('usage: node scripts/release-prep.mjs <version> ["title"]');
  process.exit(1);
}

const path = 'CHANGELOG.md';
let src = readFileSync(path, 'utf8');

const idx = src.indexOf('# Changelog');
if (idx === -1) {
  console.error('# Changelog header not found — aborting');
  process.exit(1);
}
// THE WORKING REGION IS ABOVE THE FIRST RELEASE, not above the title.
//
// This used to be `src.slice(0, src.indexOf('# Changelog'))`, which is EMPTY by
// construction — the title is the first thing in the file, at index 0 — so the
// loop below never saw a line, `kept` was always `[]`, and every
// `## [Unreleased] — Session N` block was silently DROPPED from the changelog it
// was supposed to fold in (the run printed "0 session entries kept", which reads
// like a file with nothing pending rather than a scan of the wrong span). An
// unreleased block that does not survive its own release is lost work: the text
// exists nowhere else.
//
// The region is everything between the intro and the first `## vX.Y.Z` header,
// which is where the Unreleased blocks and their placeholders live.
const firstReleaseIdx = src.search(/^## v\d+\.\d+\.\d+/m);
const head = src.slice(0, firstReleaseIdx === -1 ? src.length : firstReleaseIdx);
let body = src.slice(idx);

// ── 1+2. Keep only real session entries from the junk region ──────────────
const kept = [];
/**
 * How many session ENTRIES were kept — not how many lines.
 *
 * The message used to report `kept.length`, which is a line count: a changelog
 * with one unreleased entry prints "2 session entries kept", and a missed region
 * prints "0" whether there was nothing to fold or the scan looked at the wrong
 * span. The number a release is judged by has to be the count of entries.
 */
let keptEntries = 0;
let inReal = false;
for (const line of head.split('\n')) {
  if (/^## \[Unreleased\] — Session \d+/.test(line)) {
    inReal = true;
    keptEntries += 1;
    // Strip the numbering AND the separator that follows it, or the entry reads
    // `### Session 54 — — the notes` (the old regex stopped after the digits and
    // left the block's own dash to be joined by the one in the replacement).
    kept.push(line.replace(/^## \[Unreleased\] — Session (\d+)\s*—?\s*/, '### Session $1 — '));
    continue;
  }
  if (/^## \[Unreleased\]$/.test(line) || /^- (feat|fix) (x|login)$/.test(line)) {
    inReal = false;
    continue;
  }
  if (inReal && line.trim() !== '') kept.push(line);
}

// ── 3. Strip the intro, the FOLDED blocks and bare [Unreleased] headers ────
//
// A block that was moved to the top of the file must not stay where it was: the
// section is copied into `kept`, and leaving the original in place published the
// same entry TWICE (once as `### Session N`, once as the `## [Unreleased]` block
// it came from) — visible in the diff of any release folded by this script. The
// whole block is dropped, body included, up to the next `## ` header.
body = body.replace(/# Changelog\n\nAll notable changes to \*\*Agent-Nuvira\*\* are documented in this file\.\n\n?/, '');
const bodyLines = [];
let insideFoldedBlock = false;
for (const line of body.split('\n')) {
  if (/^## \[Unreleased\] — Session \d+/.test(line)) {
    insideFoldedBlock = true;
    continue;
  }
  if (insideFoldedBlock && /^## /.test(line)) insideFoldedBlock = false;
  if (insideFoldedBlock) continue;
  if (line.trim() === '## [Unreleased]') continue;
  bodyLines.push(line);
}
body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n');

const highlights = [
  '- **Major revamp complete** — all 30 rows of the capability parity program are landed (AGENT_NUVIRA_MAJOR_REVAMP_PLAN)',
  '- **Reliability stack** — writer surfaces unparseable output instead of masking it (repair escalates the model), reviewer-blocked verdicts route through a writer fix pass, weak-local-model pre-flight warning before long runs',
  '- **New `buff code-map`** — project symbol map (functions/classes/methods) via the AST engine; closes the last revamp row; AST dedupe fix recovered silently-dropped top-level functions',
  '- **Scheduled jobs** — `buff admin cron add/list/remove/run` with schema-validated args, RBAC-gated writes, channel delivery',
  '- **Multi-channel gateway** — Telegram / Discord / Slack / WhatsApp via `buff gateway`',
  '- **Web tools + modality packs** — `web_search`/`read_page` (SSRF-guarded) plus browser / image / voice / vision tools',
  '- **Structured logging (K1) + runtime metrics (K2)** — JSON logs with correlation IDs; `buff doctor --enterprise` runtime metrics',
  '- **Session recall** — chat auto-recalls per-project sessions and facts',
  '- **4,031 tests passing across 167 files**',
].join('\n');

const out =
  '# Changelog\n\n' +
  'All notable changes to **Agent-Nuvira** are documented in this file.\n\n' +
  `## v${version} — ${title}\n\n` +
  highlights +
  '\n\n' +
  kept.filter((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n') +
  '\n\n' +
  body.trimStart() +
  '\n';

// Say WHAT was kept, and REFUSE to write when a block was present but nothing
// came through it: that combination is the bug above (the block would be dropped,
// and its text exists nowhere else). Counting any `## [Unreleased]` header — not
// only the well-formed `— Session N` ones — is deliberate: a block the fold
// cannot parse is exactly the case that needs to stop the release, since skipping
// it is how work disappears from the changelog.
const pendingBlocks = (head.match(/^## \[Unreleased\]/gm) ?? []).length;
// A SECOND run for the same version must not produce a second header (and a
// second copy of the highlights) — it is a re-run of a release that already
// happened, so it stops instead of rewriting history.
if (new RegExp(`^## v${version.replace(/\./g, '\\.')} — `, 'm').test(src)) {
  console.error(`release-prep: v${version} is already in ${path} — bump the version instead of re-folding it.`);
  process.exit(1);
}
if (pendingBlocks > 0 && keptEntries === 0) {
  console.error(
    `release-prep: ${pendingBlocks} unreleased block(s) found and NONE could be kept — refusing to write ` +
      'a release that would drop them. Fix the block(s) or delete them on purpose.',
  );
  process.exit(1);
}
writeFileSync(path, out);
console.log(
  `CHANGELOG consolidated under v${version} (${keptEntries} session entries kept, ${pendingBlocks} unreleased block(s) folded)`,
);

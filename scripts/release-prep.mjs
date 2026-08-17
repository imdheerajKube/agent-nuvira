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
const head = src.slice(0, idx);
let body = src.slice(idx);

// ── 1+2. Keep only real session entries from the junk region ──────────────
const kept = [];
let inReal = false;
for (const line of head.split('\n')) {
  if (/^## \[Unreleased\] — Session \d+/.test(line)) {
    inReal = true;
    kept.push(line.replace(/^## \[Unreleased\] — Session (\d+):?\s*/, '### Session $1 — '));
    continue;
  }
  if (/^## \[Unreleased\]$/.test(line) || /^- (feat|fix) (x|login)$/.test(line)) {
    inReal = false;
    continue;
  }
  if (inReal && line.trim() !== '') kept.push(line);
}

// ── 3. Strip the intro + bare [Unreleased] headers from the body ───────────
body = body.replace(/# Changelog\n\nAll notable changes to \*\*Agent-Nuvira\*\* are documented in this file\.\n\n?/, '');
body = body
  .split('\n')
  .filter((l) => l.trim() !== '## [Unreleased]')
  .join('\n')
  .replace(/\n{3,}/g, '\n\n');

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

writeFileSync(path, out);
console.log(`CHANGELOG consolidated under v${version} (${kept.length} session entries kept, junk stripped)`);

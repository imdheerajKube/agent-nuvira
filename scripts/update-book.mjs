#!/usr/bin/env node
/**
 * Update the assembled book in place.
 *
 *   node scripts/update-book.mjs            # apply
 *   node scripts/update-book.mjs --dry-run  # report what would change
 *
 * Idempotent: safe to run repeatedly. Nothing is deleted.
 *
 * The four defects it repairs, all verified against the document before writing:
 *
 *   1. DUPLICATE CHAPTER IDS — the guide was assembled by concatenating an early
 *      draft of Part I and then an expanded Part I, so `id="ch01"`–`ch08` each
 *      exist twice. Invalid HTML, and the TOC jumped into the draft.
 *   2. DEAD / WRONG TOC ENTRIES — the sidebar listed chapters 31–35 that do not
 *      exist in the document at all, and listed 25–30 under labels belonging to
 *      other chapters. Everything from 36 up was already correct.
 *   3. MISSING PARTS — the document body carries `<h1>Part …</h1>` headings only
 *      for Parts I–IV; Parts V–XI exist solely as sidebar groupings. The table of
 *      contents is therefore rebuilt from the CHAPTERS (which are real) and
 *      grouped by chapter-number range (which is stable), not from those headers.
 *   4. MISSING CONTENT — Part XII (command reference + dashboard, generated from
 *      the live CLI), Part XIII (advantages), Part XIV (MCP, Chapters 71-73),
 *      Part XV (the SDK, plugin files and the VS Code addon, Chapters 74-76) and
 *      Part XVI (hooks and environment configuration, Chapters 77-78) are added.
 *
 * It also corrects stale facts (version, file/test/provider/channel counts, agent
 * role wording) and verifies at the end that every anchor it wrote resolves.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const BOOK = join(repoRoot, 'book', 'agent-nuvira-complete-guide.html');
const ARCHIVE = join(repoRoot, 'book', 'archive');
const DRY = process.argv.includes('--dry-run');

const START = '<!-- BOOK:GENERATED:START -->';
const END = '<!-- BOOK:GENERATED:END -->';
const APPENDIX_MARK = '<!-- Appendix A -->';

const note = (s) => console.log(s);

let html = readFileSync(BOOK, 'utf-8');
const sizeBefore = html.length;

// ── 0. one backup per day ────────────────────────────────────────────────────
if (!DRY) {
  const stamp = new Date().toISOString().slice(0, 10);
  // Match the STAMP, not a digits-only variant: the file is written as
  // `…${stamp}.bak.html`, so `stamp.replace(/-/g,'')` never matched and the
  // "one backup per day" guard overwrote today's earlier snapshot on every run.
  const has = existsSync(ARCHIVE) && readdirSync(ARCHIVE).some((f) => f.includes(stamp));
  if (!has) {
    copyFileSync(BOOK, join(ARCHIVE, `agent-nuvira-complete-guide.${stamp}.bak.html`));
    note(`• backed up → book/archive/agent-nuvira-complete-guide.${stamp}.bak.html`);
  }
}

// ── 1. drop any previous generated insert (idempotency) ──────────────────────
let stripped = 0;
while (html.includes(START) && html.indexOf(END) > html.indexOf(START)) {
  const a = html.indexOf(START);
  const b = html.indexOf(END) + END.length;
  const after = html[b] === '\n' ? b + 1 : b; // consume the newline the insert added
  html = html.slice(0, a) + html.slice(after);
  stripped++;
}
if (stripped) note(`• removed ${stripped} previously inserted block(s)`);

// ── 2. earlier duplicates lose the id; the LAST occurrence keeps it ──────────
const dataStart = html.indexOf('<main class="content">');
const seen = new Map();
for (const m of html.matchAll(/<div class="chapter" id="([^"]+)">/g)) {
  if (!seen.has(m[1])) seen.set(m[1], []);
  seen.get(m[1]).push(m.index);
}
const renames = [];
for (const [id, positions] of seen) {
  if (positions.length < 2 || !/^ch\d+$/.test(id)) continue;
  if (positions[0] < dataStart) continue;
  positions.slice(0, -1).forEach((pos, i) => renames.push({ pos, id, newId: i === 0 ? `orig-${id}` : `orig${i}-${id}` }));
}
renames.sort((a, b) => b.pos - a.pos);
for (const r of renames) {
  html = html.slice(0, r.pos) + `<div class="chapter" id="${r.newId}">` + html.slice(r.pos + `<div class="chapter" id="${r.id}">`.length);
}
if (renames.length) note(`• renamed ${renames.length} duplicate chapter id(s): ${[...new Set(renames.map((r) => r.newId))].sort().join(', ')}`);

// ── 3. mark the superseded early draft ───────────────────────────────────────
if (!html.includes('BOOK:SUPERSEDED')) {
  const idx = html.indexOf('<div class="chapter" id="orig-ch01">');
  if (idx !== -1) {
    html =
      html.slice(0, idx) +
      `<!-- BOOK:SUPERSEDED -->
<div class="callout">
  <div class="callout-title">📌 Earlier draft — superseded</div>
  <p>The eight chapters that follow are the <strong>first draft of Part I</strong>, kept for
  reference. The <strong>expanded Part I</strong> later in this book covers the same ground in
  far more depth — read that, and use these only to see how the material evolved.</p>
</div>

` +
      html.slice(idx);
    note('• labelled the superseded early draft of Part I');
  }
}

// ── 4. insert the new parts before the appendices ────────────────────────────
const part12 = readFileSync(join(repoRoot, 'book', 'part12-command-reference.html'), 'utf-8');
const part13 = readFileSync(join(repoRoot, 'book', 'part13-advantages.html'), 'utf-8');
// Parts XIV–XVI close the three gaps the earlier parts left open: the MCP
// subsystem (19 modules, its own CLI, its own dashboard page, its own nine-capability
// catalog), the extension surface (`@agent-nuvira/sdk`, plugin files, the VS Code
// addon) and the policy surface (declarative hooks, environment/process config).
const part14 = readFileSync(join(repoRoot, 'book', 'part14-mcp.html'), 'utf-8');
const part15 = readFileSync(join(repoRoot, 'book', 'part15-extending.html'), 'utf-8');
const part16 = readFileSync(join(repoRoot, 'book', 'part16-policy.html'), 'utf-8');

const partHeading = (num, title, sub) => `
<h1 style="text-align:center; margin-top:60px; color:var(--highlight);">Part ${num}</h1>
<h2 style="text-align:center; border:none; color:var(--primary);">${title}</h2>
<p style="text-align:center; color:#666;">${sub}</p>
`;

// ── part descriptions ────────────────────────────────────────────────────────
// Every part states what it covers and WHY the code in it is shaped that way.
// The text lives in `book/part-intros.html` (one delimited block per part) so it
// is reviewable on its own; this script is what places it in the book.
const partIntros = (() => {
  const src = readFileSync(join(repoRoot, 'book', 'part-intros.html'), 'utf-8');
  const map = new Map();
  for (const m of src.matchAll(/<!--\s*PART:([IVX]+)\s*-->([\s\S]*?)<!--\s*\/PART:\1\s*-->/g)) {
    map.set(m[1], m[2].trim());
  }
  return map;
})();
const introOf = (id) => {
  const body = partIntros.get(id);
  if (!body) {
    console.error(`✗ book/part-intros.html has no description for Part ${id} — refusing to build a book with an undescribed part.`);
    process.exit(1);
  }
  return `\n<!-- PART:${id}:START -->\n${body}\n<!-- PART:${id}:END -->\n`;
};

const insertBlock =
  START +
  partHeading('XII', 'Command Reference &amp; Dashboard', 'Chapters 68–69 · Generated from the live CLI and the dashboard source') +
  introOf('XII') +
  part12 +
  partHeading('XIII', 'Why Agent-Nuvira — Capabilities &amp; Advantages', 'Chapter 70 · What it does better, what it costs, and how to verify it') +
  introOf('XIII') +
  part13 +
  partHeading('XIV', 'Model Context Protocol (MCP)', 'Chapters 71–73 · Reaching outside the agent: the catalog, credentials, governance, the outbound server, and the limits') +
  introOf('XIV') +
  part14 +
  partHeading('XV', 'Extending Agent-Nuvira', 'Chapters 74–76 · The Agent SDK, plugin files and shipping paths, and the VS Code addon') +
  introOf('XV') +
  part15 +
  partHeading('XVI', 'Policy &amp; Configuration', 'Chapters 77–78 · Declarative hooks, and the environment / Process Env surface') +
  introOf('XVI') +
  part16 +
  END;

// The appendices were assembled BEFORE chapters 53–67, so a reader following the
// book linearly hits Appendix A in the middle of it. Lift the appendix block and
// re-insert it after the last chapter, with the new parts immediately before it.
// Lifting first and re-inserting at a fixed landmark makes this idempotent.
// The block runs from `<!-- Appendix A -->` to whatever chapter or section
// follows it. This must be landmark-based, not marker-based: the first run MOVES
// the block, so the old `<!-- Final Chapter -->` marker is no longer adjacent.
const appendixAt = html.indexOf(APPENDIX_MARK);
if (appendixAt === -1) {
  console.error('✗ could not find `<!-- Appendix A -->` — refusing to guess an insertion point.');
  process.exit(1);
}
const nextAfterAppendix = (() => {
  const rest = html.slice(appendixAt + APPENDIX_MARK.length);
  const m = /<div class="chapter" id="ch\d+">|<section id="/.exec(rest);
  return m ? appendixAt + APPENDIX_MARK.length + m.index : html.length;
})();
const appendixEnd = nextAfterAppendix;
const appendixBlock = html.slice(appendixAt, appendixEnd);
const wasMidBook = appendixAt < html.indexOf('<div class="chapter" id="ch53">');
html = html.slice(0, appendixAt) + html.slice(appendixEnd);
{
  const dest = html.indexOf('<section id="playgrounds">');
  const at = dest !== -1 ? html.lastIndexOf('\n', dest) + 1 : html.length;
  html = html.slice(0, at) + insertBlock + '\n' + appendixBlock + html.slice(at);
  note(
    '• inserted Part XII (command reference + dashboard) through Part XVI (hooks + environment) before the appendices',
  );
  if (wasMidBook) note('• moved Appendices A–D out of the middle of the book, to after the final chapter');
}

// ── 4b. resync Part V (router deep dive) from its source file ────────────────
// Several `book/partN-*.html` files have drifted from the assembled book, and the
// book is the artifact — so a naive "reassemble from every part file" would DROP
// content (parts II, III, IV and VIII differ in size from their regions here;
// part VIII's region is ~10 KB SHORTER than the file). Part V is therefore
// resynced explicitly, by region, from a file this script controls.
/**
 * Drop a source file's leading maintainer comment.
 *
 * The injected files (`book/partN-*.html`, `book/chapters/chNN.html`) open with a
 * `<!-- … -->` note explaining what was rewritten and why. Those notes belong to
 * the SOURCE, not to the assembled book, and injecting them made the rebuild
 * non-idempotent: the region boundary is the `<h1>`/`<div>` marker, so the
 * comment that the previous run inserted sat just above it and survived while a
 * fresh copy was added — ~1.3 KB of duplicated notes per run.
 *
 * Stripping the comment here is what makes two consecutive runs byte-identical
 * (verified: same sha256 after `npm run docs:book` twice).
 */
function stripLeadingComment(s) {
  const m = /^\s*<!--[\s\S]*?-->/ .exec(s);
  return m ? s.slice(m[0].length).replace(/^\s*\n/, '') : s;
}

{
  const partVStart = html.indexOf('<h1 class="part-title">Part V');
  const partVIStart = html.indexOf('<h1 class="part-title">Part VI');
  if (partVStart === -1 || partVIStart === -1 || partVIStart < partVStart) {
    console.error('✗ could not locate the Part V region — refusing to rewrite it.');
    process.exit(1);
  }
  const part5 = stripLeadingComment(readFileSync(join(repoRoot, 'book', 'part5-router-deep-dive.html'), 'utf-8'));
  const next = html.slice(0, partVStart) + part5 + '\n\n' + html.slice(partVIStart);
  if (next !== html) note('• resynced Part V from book/part5-router-deep-dive.html');
  html = next;
}

// ── 4c. per-chapter overrides ────────────────────────────────────────────────
// A chapter whose ARCHITECTURE is wrong cannot be repaired by a find/replace, so
// it is replaced wholesale. The region runs from this chapter's <div> to the next
// chapter <div> (or the next <section>), so a part heading or section wrapper
// around it is never disturbed.
const CHAPTER_OVERRIDES = {
  // Part III is not resynced as a REGION: book/part3-project-architecture.html
  // holds only chapters 20–22, while the book's Part III spans 16–22. These two
  // chapters are therefore replaced one at a time, from the file that was
  // corrected against src/config/* and src/utils/logger.ts +
  // src/observability/event-bus.ts + src/learning/reasoning-trace.ts.
  //   ch21 — the old sample invented getNuviraHome()/getConfigPath()/getDataPath()
  //          and read `process.env.BUFF_HOME`, which no source has ever read.
  //   ch22 — the logger/event-bus/trace samples were a plausible shape, not the
  //          shipped one (a `process.env.DEBUG` gate, an `enum EventNames`, and
  //          loadTraces()/saveTraces() helpers that do not exist).
  ch21: 'book/chapters/ch21.html',
  ch22: 'book/chapters/ch22.html',
  // The old ch44 described a `ToolRegistry` class and a
  // `src/tools/tool-registry.ts` that do not exist; the real registry is a
  // function-based module over declarative `Tool` descriptors.
  ch44: 'book/chapters/ch44.html',
};
for (const [id, file] of Object.entries(CHAPTER_OVERRIDES)) {
  const marker = html.indexOf(`<div class="chapter" id="${id}">`);
  if (marker === -1) {
    console.error(`✗ chapter override target '${id}' not found — refusing to guess.`);
    process.exit(1);
  }
  const start = marker;
  const candidates = [
    html.indexOf('<div class="chapter" id="', start + 10),
    html.indexOf('<section id="', start + 10),
    html.length,
  ].filter((n) => n > start);
  const end = Math.min(...candidates);
  const replacement = stripLeadingComment(readFileSync(join(repoRoot, file), 'utf-8'));
  if (html.slice(start, end).trim() !== replacement.trim()) {
    html = html.slice(0, start) + replacement + html.slice(end);
    note(`• resynced chapter ${id} from ${file}`);
  }
}

// ── 4d. literal source-path corrections ──────────────────────────────────────
// Each pair names a file the book CLAIMED this repository has, followed by the
// file it actually has (or, for a reader-owned path, a label that says so).
// `scripts/check-book-code.mjs` fails the build if a new unsupported path
// appears, so this list is the only place a correction can live.
const SOURCE_FIXES = [
  // ch44's module comment — its chapter is replaced above, kept for safety.
  ['// src/tools/tool-registry.ts', '// src/tools/registry.ts'],
  // ch46 — the skill registry lives under learning/, not under agents/.
  ['// src/agents/skill-registry.ts', '// src/learning/skills-registry.ts'],
  // ch47 — the image generator is a modality tool, not a standalone top-level file.
  ['image-video-tool.ts', 'modality/image-gen.ts'],
  // …and its code block is a simplified shape, labelled as one rather than
  // presented as the contents of the shipped file.
  ['// src/tools/generate-image.ts',
   '// Illustrative shape of an image tool — the shipped one is src/tools/modality/image-gen.ts'],
  // ch63 — RBAC is enforced by the CLI guard; injection patterns live in the scanner.
  ['// src/security/rbac.ts', '// src/cli/rbac-guard.ts'],
  ['// src/security/injection.ts', '// src/security/scanner.ts'],
  // ch41/ch42 — the dashboard has HistoryBrowser / TracePanel / Layout, not these.
  // Token-level, because these names appear inside <span class="file"> markup in
  // the structure trees, so a phrase match would miss them.
  ['HistoryPage.tsx', 'HistoryBrowser.tsx'],
  ['TracesPage.tsx', 'TracePanel.tsx'],
  ['Sidebar.tsx', 'Layout.tsx'],
  // ch05 — there is no barrel under src/agents/; the real barrel is src/index.ts.
  ['src/agents/index.ts', 'src/index.ts'],
  // ch49 — the real tool-registry import, and the real mock-LLM helper (SDK testing).
  ["import { toolRegistry } from '../../src/tools/tool-registry';",
   "import { getTool, type ToolContext } from '../../src/tools/registry.js';"],
  ["import { createMockCallLLM } from '../helpers';",
   "import { createMockLLM } from '@agent-nuvira/sdk/testing';"],
  ['createMockCallLLM', 'createMockLLM'],
  // ch41 — an illustrative component, labelled as one instead of claiming a file.
  ['// src/web-dashboard/src/components/StatusBadge.tsx',
   '// Example — a component you would add at src/web-dashboard/src/components/StatusBadge.tsx'],
];
for (const [from, to] of SOURCE_FIXES) {
  if (!html.includes(from)) continue;
  const n = html.split(from).length - 1;
  html = html.split(from).join(to);
  note(`• corrected ${n}× ${from}`);
}

// ── 4d-bis. part transition lines ────────────────────────────────────────────
// The hand-written "— End of Part N · Continue to Part N+1: <title> —" dividers
// still carried the SHORT part titles, which no longer match the part heading or
// the sidebar label after the alignment in 4e. Correcting them here (rather than
// in the document) keeps the fix reproducible from any base.
const TRANSITION_FIXES = [
  ['Continue to Part V: Router Deep Dive', 'Continue to Part V: The Router: How the Right Model Is Chosen'],
  ['Continue to Part VI: Dashboard &amp; Gateway', 'Continue to Part VI: The Dashboard: Building a Full-Stack Admin Interface'],
];
for (const [from, to] of TRANSITION_FIXES) {
  if (!html.includes(from)) continue;
  const n = html.split(from).length - 1;
  html = html.split(from).join(to);
  note(`• corrected ${n}× part-transition label: ${from}`);
}

// ── 4d-ter. chapter-body corrections the audit cannot see ────────────────────
// The audit checks paths, commands, identifiers and numbers. It cannot tell that
// a section is teaching code this repository does not contain — e.g. Chapter 41
// presented an Express implementation of the dashboard server, while
// `src/web-dashboard/server.ts` imports no framework at all (its own header: "Uses
// only Node.js built-in modules (no Express, no WebSocket libraries)"). Those
// corrections are made here, one literal edit at a time, and each is skipped when
// its source text is already gone — so a rebuild from any base is safe and a
// re-introduced error is fixed again.
const TEXT_FIXES = [
  // ch19 — the dashboard is served by the CLI's own HTTP server, not Express.
  ['files that the Express server serves to browsers',
   'files that the CLI\'s own Node HTTP server serves to browsers'],
  // Part III diagram.
  ['<div class="step-desc">TypeScript + React<br>+ Express backend</div>',
   '<div class="step-desc">TypeScript + React<br>+ Node HTTP backend</div>'],
  // ch41 — objectives, diagram, tree, prose and takeaways.
  ["Understand the dashboard's architecture (React + Express backend)",
   "Understand the dashboard's architecture (React client + dependency-free Node HTTP server)"],
  ['A[React Frontend] -->|HTTP API| B[Express Server]',
   'A[React Frontend] -->|HTTP API| B[Node http Server]'],
  ['A2[TracesPage]', 'A2[TracePanel]'],
  ['A3[HistoryPage]', 'A3[HistoryBrowser]'],
  ['├── server.ts                       # Express backend',
   '├── server.ts                       # Node http server — no framework'],
  [' * the React frontend and the Express backend.',
   ' * the React frontend and the Node HTTP backend.'],
  ['<li>The dashboard uses <strong>React + Express</strong> for a full-stack solution</li>',
   '<li>The dashboard is <strong>React plus a dependency-free Node HTTP server</strong> — no Express, no WebSocket library</li>'],
  ['<li>The <strong>Express backend</strong> serves both API endpoints and static files</li>',
   '<li>The <strong>Node HTTP server</strong> serves both API endpoints and static files</li>'],
  // ch42 — the sample claimed to BE the shipped component, and declared a
  // function the file does not export (it is `export default function
  // HistoryBrowser({ data }: HistoryBrowserProps)`).
  ['// src/web-dashboard/src/components/HistoryBrowser.tsx',
   '// Illustrative shape — the shipped component is src/web-dashboard/src/components/HistoryBrowser.tsx,\n// which is prop-driven (`data: DashboardData | null`) and re-reads the list after a delete'],
  ['export function HistoryPage() {', 'export default function HistoryBrowser({ data }: HistoryBrowserProps) {'],
  ['metadata?: Record<string, any>>;', 'metadata?: Record<string, any>;'],
  // The same mislabel, this time in a feature card.
  ['React dashboard, Express backend, SSE real-time updates',
   'React dashboard, framework-free Node HTTP backend, SSE real-time updates'],
  // Two strings in the enhancements region were never translated to English.
  ['✅ Instant (毫秒级)', '✅ Instant (sub-millisecond)'],
  ['<td>双向 (two-way)</td>', '<td>Two-way</td>'],
  // ch43 — the trace interfaces and the viewer were invented shapes.
  ['// What a trace looks like in the system',
   '// Illustrative shape — the shipped types are in src/learning/reasoning-trace.ts\n// (TraceStep: seq, timestamp, agentType, provider, model, promptDigest, tokens, latency, success)'],
  ['// A visual timeline showing each agent call',
   '// Illustrative shape — the shipped viewer is src/web-dashboard/src/components/TracePanel.tsx'],

  // ── Part VII: tools, skills, the gateway ─────────────────────────────────
  // ch45 — the adapters are dependency-free `fetch` calls. Their own header says
  // so: "SDK dependencies (grammY/discord.js/@slack/web-api would add hundreds of
  // …". The architecture diagram named the SDK this package deliberately avoids.
  ['B3[Discord.js]', 'B3[Discord REST + webhook]'],
  ['B2[Telegram Bot API]', 'B2[Telegram Bot API · long-poll getUpdates]'],
  ['  - Implement a WhatsApp bridge using Baileys',
   '  - Understand the WhatsApp bridge (Baileys) and the dependency-free REST adapters'],
  ['  - Build the gateway_send tool for message delivery',
   '  - Read the real gateway_send descriptor — its arguments, its three gates, and its honesty rule'],

  // ── Part VIII: testing, deployment, operations ───────────────────────────
  // ch51 — none of these names exist as written. The dashboard port is
  // NUVIRA_DASHBOARD_PORT (default 3030, `.env.example` line 154), the WhatsApp
  // session dir is NUVIRA_WHATSAPP_SESSION_DIR, and there is no database: every
  // durable artifact is a file under the nuvira home.
  ['WHATSAPP_SESSION_DIR=~/.nuvira/whatsapp-session',
   'NUVIRA_WHATSAPP_SESSION_DIR=~/.nuvira/whatsapp/session'],
  ['# Dashboard\nPORT=3000\nNODE_ENV=production',
   '# Dashboard\nNUVIRA_DASHBOARD_PORT=3030\nNODE_ENV=production'],
  ['# Database (if using)\nDATABASE_URL=postgresql://user:pass@localhost:5432/agent-nuvira',
   '# There is NO database. Everything durable is a file under the nuvira home\n# (~/.nuvira, or wherever NUVIRA_HOME points): config, traces, memory,\n# the delivery ledger, and gateway/chat-history.json.'],
  ['# Save process list\npm2 save\n\n# Auto-start on boot\npm2 startup\n', ''],
  // ch52 — debug logging is the CLI's own `-d, --debug` flag (`src/index.ts`
  // calls `setLogLevel('debug')` when it sees it; `src/cli/cli-program.ts`
  // declares it). There is no `DEBUG=` namespace anywhere in the source or the
  // docs. History is one file, not a directory of them.
  ['# Run with debug logging\nDEBUG=* nuvira run "your goal"\n\n# Or set in environment\nexport DEBUG=agent-nuvira:*\nnuvira run "your goal"\n\n# View specific module debug output\nDEBUG=agent-nuvira:router nuvira run "your goal"\nDEBUG=agent-nuvira:planner nuvira run "your goal"\nDEBUG=agent-nuvira:tools nuvira run "your goal"',
   '# Debug logging is the CLI\'s own flag. There is no DEBUG= namespace to\n# remember: `src/index.ts` sees the flag and raises the logger to `debug`.\nnuvira --debug run "your goal"'],
  ['Check ~/.nuvira/conversations/ directory',
   'Check ~/.nuvira/gateway/chat-history.json — history is one file, not a directory'],
  // ch59.4 declared its own `TRUST_THRESHOLD = 0.6` inside the parser. The real
  // threshold is shared from intent.ts and is 0.8. Ordered so the declaration is
  // fixed before the two usages, and idempotent because the old text disappears.
  ['const TRUST_THRESHOLD = 0.6;',
   '// src/nlu/intent.ts — one shared constant, used by every caller\nconst RULE_TRUST_THRESHOLD = 0.8;'],
  ['if (rule.confidence >= TRUST_THRESHOLD) {',
   'if (rule.confidence >= RULE_TRUST_THRESHOLD) {'],
  // ch50/ch66 — the release examples quoted a version four minors behind the
  // shipped package.json.
  ['// npm version 2.7.0 --no-git-tag-version',
   '// npm version 3.5.0 --no-git-tag-version'],
  ['Release v2.7.0: [description]', 'Release v3.5.0: [description]'],
  ['npm version 2.7.0 --no-git-tag-version',
   'npm version 3.5.0 --no-git-tag-version'],

  // ── Part XI: containers, security, workflow, publishing ──────────────────
  // ch67 — the specialist roster is not a fixed number. Name the directory the
  // reader can list instead of quoting a count that drifts every release.
  ['✨ through 21 specialist agents.',
   '✨ through the specialist agents registered under <code>src/agents/agents/</code>.'],
  ['The full pipeline: classifier → planner → writer → reviewer with 21 specialist agents.',
   'The full pipeline: classifier → planner → writer → reviewer, plus the specialist agents under <code>src/agents/agents/</code>.'],
  // ch67 and the cover — the size of the codebase is measured, not remembered.
  // `check-book-code.mjs` now measures it, so this line cannot drift again.
  ['1,180-file TypeScript codebase', '1,250-file TypeScript codebase'],

  // ch63 — the roles are admin / operator / viewer. The takeaway still used the
  // vocabulary the section was rewritten away from.
  ['<li><strong>RBAC</strong> controls who can do what (admin/user/guest roles)</li>',
   '<li><strong>RBAC</strong> controls who can do what — <code>admin</code>, <code>operator</code> and <code>viewer</code>, with legacy single-user mode fully permissive</li>'],

  // ch64 — the third objective promised "workflow automation", which this
  // chapter no longer contains: the workflow templates it pointed at are
  // Chapter 65, and what lives here is a scheduler for registered tools.
  ['<li>Understand workflow automation</li>',
   '<li>Know which automation belongs here — metrics and scheduled tool invocations — and which does not (workflow templates are Chapter 65)</li>'],

  // ch64 — metrics are counters/timers persisted to metrics.json, and scheduled
  // work is a registered tool plus a cron expression. Neither takeaway said so.
  ['<li><strong>Metrics collection</strong> tracks pipeline performance, costs, and model usage</li>',
   '<li><strong>Metrics</strong> are counters and timers (<code>memory.hits</code>, <code>rule.parse.ms</code>, <code>llm.answer.ms</code>) persisted to <code>metrics.json</code>; cost is accounted separately</li>'],
  ['<li><strong>Workflow automation</strong> uses cron for scheduled tasks</li>',
   '<li><strong>Scheduled work</strong> is a registered tool plus a cron expression, stored in <code>~/.nuvira/cron/jobs.json</code></li>'],
  ['<li><strong>Event-driven architecture</strong> enables loose coupling between components</li>',
   '<li><strong>The event bus</strong> carries what has many readers; post-run learning is sequenced by the orchestrator itself, not by a subscriber</li>'],

  // ch65 — the takeaways still described the DAG engine the section replacement
  // above removed: parallel step execution, triggers on the template, retry
  // policy, crash-recovery state. A template has none of those fields, so the
  // closing list has to agree with the prose in front of it.
  ['<h3>📝 Key Takeaways</h3>\n<ul>\n<li>Workflows are <strong>DAGs of tasks</strong> with dependency ordering</li>\n<li>Independent steps run <strong>in parallel</strong> for speed</li>\n<li><strong>Triggers</strong> can be manual, cron, events, or file changes</li>\n<li><strong>Retry policies</strong> handle transient failures</li>\n<li>Workflows <strong>persist state</strong> for recovery after crashes</li>\n</ul>',
   '<div class="key-takeaways">\n<h3>📝 Key Takeaways</h3>\n<ul>\n<li>A workflow template is a <strong>saved shape of work</strong> — steps with declared <code>dependsOn</code> edges, not a second execution engine</li>\n<li>Running one means <strong>planning</strong> it: <code>buildTaskPlanFromTemplate()</code> hands the Orchestrator the same task graph an ad-hoc goal produces</li>\n<li><strong>Triggers belong to the caller</strong> (the CLI, a cron entry) — they are not a field on the template</li>\n<li>The <strong>registry</strong> is what makes a template worth publishing: one reviewed sequence, dependency checks at install time, checksum-verified installs</li>\n<li><code>nuvira workflow upgrade</code> re-resolves an installed template, so a fix in the registry reaches everyone who installed it</li>\n</ul>'],

  // ch66 — the checklist tagged the release `v2.7.0` two steps after bumping the
  // package to 3.5.0 (the same two lines chapter 50 still carried), and the
  // `files` list omitted `.agents/skills/`, which is what ships the bundled
  // skills Part VII describes.
  ['git tag v2.7.0\ngit push origin v2.7.0', 'git tag v3.5.0\ngit push origin v3.5.0'],
  ['"files": ["dist/", "src/web-dashboard/public/", "README.md", "LICENSE"],',
   '"files": ["dist/", "src/web-dashboard/public/", "README.md", "LICENSE", ".agents/skills/"],'],
];
for (const [from, to] of TEXT_FIXES) {
  if (!html.includes(from)) continue;
  const n = html.split(from).length - 1;
  html = html.split(from).join(to);
  note(`• corrected ${n}× ${from.slice(0, 58)}${from.length > 58 ? '…' : ''}`);
}


/**
 * Whole-section replacements: `start` is the first line of the section, `end` is
 * the first line AFTER it that must survive. Skipped when `start` is absent, so
 * running this twice is a no-op.
 */
const SECTION_REPLACEMENTS = [
  {
    start: '<h3>41.6 The Express Backend</h3>',
    // (kept: the earlier Express-era anchor; the section it now finds is the
    // corrected one, so this entry is a no-op on an already-fixed document.)
    end: '<div class="exercise">',
    html: `<h3>41.6 The Backend — and Why There Is No Framework</h3>

<pre><code class="language-typescript">
// src/web-dashboard/server.ts (simplified — the shipped file is ~9.5k lines)

import { createServer } from 'node:http';   // no Express, no WebSocket library

const server = createServer(handleRequest);

// Routing is a chain of exact-path checks, not a framework's router:
if (pathname === '/api/history') { /* … */ }
if (pathname === '/api/history/clear' &amp;&amp; req.method === 'POST') { /* … */ }

// Live updates are Server-Sent Events:
res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

// Static files come from public/, resolved for BOTH runtimes:
//   tsx:  join(__dirname, 'public')
//   dist: join(__dirname, '..', '..', 'src', 'web-dashboard', 'public')
</code></pre>

<p><strong>Why no framework.</strong> The dashboard ships inside the CLI package, so Express
would be a second thing every user installs and a second thing that can break on a Node upgrade.
Plain <code>node:http</code> means the server starts with the package and nothing else. The cost
of that choice is visible in the file: there is no router, no middleware pipeline and no body
parser, so path matching is explicit and each handler parses exactly what it needs.</p>

<div class="callout">
  <div class="callout-title">🐛 One bug this choice had to fix</div>
  <p>macOS resolves <code>localhost</code> to <code>::1</code> (IPv6) <em>before</em>
  <code>127.0.0.1</code>. An IPv4-only bind therefore sent the browser to
  <code>[::1]:port</code>, which answered <code>ECONNREFUSED</code> — an intermittent
  "Dashboard server unreachable". The fix binds <strong>both</strong> loopback families to the
  same handler, best-effort: if the twin family is unavailable or already taken, the primary bind
  still serves, because a loopback quirk must never take the dashboard down.</p>
</div>

`,
  },
];
SECTION_REPLACEMENTS.push(
  {
    // The same Express error again, this time inside a "design decision" box that
    // also justified the choice with unmeasured numbers ("200KB+ of unnecessary
    // framework code", "60% less bundle size"). Neither figure exists in this
    // repository; the real reason is a shipping constraint.
    start: '<div class="decision-title">🎯 Design Decision: React + Express vs Next.js vs SvelteKit</div>',
    end: '<!-- CHAPTER 42 ENHANCEMENT: After Conversation History -->',
    html: `<div class="decision-title">🎯 Design Decision: a React SPA on a framework-free Node server</div>
<p>For the dashboard, the choice that mattered was not <em>which</em> full-stack framework to adopt — it was whether to adopt one at all. The dashboard ships inside the CLI package, so anything added to it is added to every user's install.</p>

<div class="comparison-matrix">
<table>
<tr><th>Option</th><th>What it adds to the install</th><th>What it buys here</th><th>Our Choice</th></tr>
<tr><td><strong>React SPA + node:http</strong></td><td>Nothing at runtime — the client is built and committed</td><td>One server file, SSE for live updates, no framework to upgrade</td><td>✅ <strong>Selected</strong></td></tr>
<tr><td><strong>Next.js</strong></td><td>A server framework and its runtime</td><td>SSR and SEO — neither applies to an internal tool</td><td>❌ No SSR need</td></tr>
<tr><td><strong>SvelteKit</strong></td><td>A compiler toolchain and a framework runtime</td><td>A smaller client bundle; a second component model to learn</td><td>❌ Smaller ecosystem</td></tr>
<tr><td><strong>Vue + Nuxt</strong></td><td>A framework runtime</td><td>The same component model the team already knew in React</td><td>❌ No advantage over React</td></tr>
</table>
</div>

<p><strong>Why not Next.js:</strong> nothing the dashboard does needs server rendering. Its pages read the same local REST API and stream over SSE, so SSR would add a server framework to the install and change nothing a user sees. The reason to reject a framework here is not a bundle-size percentage nobody measured — it is that the dashboard has to start with the package and nothing else.</p>

<p><strong>Real-World Analogy:</strong> reaching for Next.js to build an internal dashboard is like registering a delivery van as a bus — most of the paperwork is for a job you are not doing.</p>
</div>

`,
  },
  {
    // ch51.3 taught an Express health endpoint that also claimed a 503-when-
    // degraded behaviour. The real handler answers 200 with a JSON payload, and
    // the deep provider checks live in the doctor module, not in the server.
    start: '// Health check endpoint for monitoring',
    end: '<h3>51.4 Logging Best Practices</h3>',
    html: `<pre><code class="language-typescript">// src/web-dashboard/server.ts — the real health endpoint
if (pathname === '/api/health') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(readHealthData()));
  return;
}
</code></pre>

<p>The endpoint always answers <code>200</code> with a JSON payload — the status is <em>in</em> the
body, not in the HTTP code, so an uptime monitor can read it without treating a degraded provider
as a dead server. The deep checks are a separate concern: <code>readHealthData()</code> reports what
the dashboard knows, while the provider probes behind <code>nuvira doctor</code> (the
<code>runAllChecks()</code> suite) are what actually decide whether a provider is healthy — and they
can be run from the shell on the same host.</p>

`,
  },
  {
    // The SSE path and header are real (`if (pathname === '/api/sse')` in
    // `server.ts`); the Snippet was Express-shaped and invented the subscription
    // (`eventBus.on('pipeline:update')`). The real feed is the DAG bridge.
    start: '<pre><code class="language-typescript">// Server: Simple SSE endpoint',
    end: '<!-- CHAPTER 43 ENHANCEMENT: After Traces Page -->',
    html: `<pre><code class="language-typescript">// src/web-dashboard/server.ts — the real /api/sse branch (node:http, no framework)
if (pathname === '/api/sse') {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });

  // What feeds this stream is the EventBus, through the DAG bridge — the same
  // bridge the CLI board renders from:
  registerDagHandlers({
    pushDAGUpdate: (update) =&gt; pushDAGUpdate(update),
    updateDAGNode: (nodeId, patch) =&gt; updateDAGNode(nodeId, patch),
    resetDAG: () =&gt; resetDAG(),
  });

  req.on('close', () =&gt; { /* drop this client's subscription */ });
  return;
}</code></pre>

`,
  },
  {
    // ch41.4 + ch41.5 taught a REST client (`api.getMessages()`,
    // `api.sendMessage()`, `api.getTraces()`, an `EventSource`-free polling loop
    // every 3s). None of those methods exist and no `/api/messages` route does:
    // `src/web-dashboard/src/api.ts` is ONE `EventSource` with `subscribe()`,
    // and the real event names are init/refresh/dag/quota/conversation/typing/
    // chat-retry. Replaces both sections, because the polling sample is the
    // premise of the following one.
    start: '<h3>41.4 State Management with Hooks</h3>',
    end: '<h3>41.6 The Backend — and Why There Is No Framework</h3>',
    html: `<h3>41.4 Hooks and the One Stream That Feeds Them</h3>

<pre><code class="language-typescript">
// src/web-dashboard/src/api.ts — the shipped client

export class DashboardAPI {
  private sse: EventSource | null = null;
  private listeners: Set&lt;DashboardListener&gt; = new Set();

  /** Open the ONE stream every page reads from. */
  connect(): void {
    if (this.sse) return;
    this.sse = new EventSource(\`\${this.baseUrl}/api/sse\`);

    this.sse.addEventListener('init', …);         // first full snapshot
    this.sse.addEventListener('refresh', …);      // the periodic tick
    this.sse.addEventListener('dag', …);          // task graph, live
    this.sse.addEventListener('quota', …);        // failover / park / window reset
    this.sse.addEventListener('conversation', …); // a new gateway message
    this.sse.addEventListener('typing', …);       // WhatsApp typing indicator
    this.sse.addEventListener('chat-retry', …);   // background retry state
  }

  subscribe(listener: DashboardListener): () =&gt; void { /* returns unsubscribe */ }
  fetchAll(): Promise&lt;DashboardData | null&gt; { /* one-shot read on page load */ }
}

export const api = new DashboardAPI();
</code></pre>

<p>A page component calls <code>api.subscribe()</code> in a <code>useEffect</code> and renders
whatever snapshot arrives — the same hooks this chapter teaches, pointed at a pushed object
instead of a polled one. <code>useRef</code> holds the mutable bits a render must not reset (a
timer id, the last seen sequence), and <code>useCallback</code> keeps a handler identity stable so
subscribing does not churn.</p>

<p><strong>Why push and not poll.</strong> A frozen snapshot is the failure mode this design
removes. If each panel fetched on its own schedule, the chat thread, the DAG and the traces list
would each be a different moment in time, and a run that finished between two polls would appear
in some panels and not others. One stream, one snapshot, one render — and a page that needs
something the snapshot does not carry asks for it explicitly (see 41.5).</p>

<h3>41.5 The API Client</h3>

<p>The client's job is to be the <em>only</em> place that knows the wire format. Requests a user
triggers — a delete, a save, an admin action — are explicit methods on the same object
(<code>fetchTraces()</code>, <code>saveProvider()</code>, <code>importAcceptance()</code>,
<code>knowledgeQuery()</code>, …), each with an auth story of its own: an admin write carries the
admin token, and a refusal comes back as <code>forbidden</code> rather than an empty success.</p>

<div class="callout">
<div class="callout-title">🐛 Corrected in this edition</div>
<p>These two sections used to teach a REST client — <code>api.getMessages()</code>,
<code>api.sendMessage()</code>, <code>api.getTraces()</code>, <code>api.getConversations()</code> —
refreshed by a <code>setInterval</code> every three seconds. None of those methods exist, and no
<code>/api/messages</code> route ever existed on the server. What ships is a single
<code>EventSource</code> (above) plus explicit methods for user-triggered writes; a component
re-renders from the pushed snapshot rather than re-fetching. The hooks material itself was
accurate, and is kept.</p>
</div>

`,
  },
  {
    // ch45.2 printed a `ToolDefinition` object with `parameters`/`execute` and a
    // `media_path`/`caption` pair. The tool contract in this repository is
    // `registerTool({ name, capability, description, category, inputSchema,
    // endsAgentStep, run })`, the media argument is `image_path`, and the three
    // authorization/approval gates plus the delivery-honesty rule — the actual
    // subject of the chapter — were absent.
    start: '<h3>45.2 The gateway_send Tool</h3>',
    end: '<h3>45.3 Conversation History Storage</h3>',
    html: `<pre><code class="language-typescript">
// src/tools/registry.ts — the tool is DECLARED here; the work happens in
// src/tools/gateway-send.ts, imported lazily so an unused tool costs nothing.

registerTool({
  name: 'gateway_send',
  capability: { effectClass: 'external', reversible: false, grantCategory: 'external' },
  description:
    'Send a message (text or image) to a DIFFERENT channel or contact through the ' +
    'gateway (WhatsApp by contact name or number, Telegram, Slack, Discord, email, ' +
    'or any registered alias). Do NOT use this tool to reply to the CURRENT ' +
    'conversation — your text response is automatically sent back to the ' +
    'originating channel. … For images, set image_path to the file path — the ' +
    'image is sent with text as caption. AUTHORIZATION: on a gateway turn the ' +
    'sender must hold outbound send authority … NEVER claim a message was ' +
    'delivered unless this tool returned its ✅ sent result.',
  category: 'workflow',
  inputSchema: gatewaySendSchema,   // { target, text, image_path? }
  endsAgentStep: false,
  run: (args, ctx) =&gt; import('./gateway-send.js').then((m) =&gt; m.runGatewaySendTool(args, ctx)),
});
</code></pre>

<p><strong>The arguments are one text field, not a text/caption pair.</strong>
<code>gateway_send({ target: 'whatsapp:Alex', text: '&lt;the poem&gt;' })</code>, or with an image:
<code>gateway_send({ target: 'whatsapp:Alex', text: 'here you go', image_path: '/tmp/x.png' })</code>.
When an image is attached the <em>text is the caption</em>, which is exactly why there is no
separate caption parameter to keep in step with it.</p>

<p><strong>Three gates stand between a call and a delivered message</strong>, and every one of
them answers with an explanatory string instead of throwing — a refused send is never silent:</p>
<ol>
<li><strong>Target resolution.</strong> A friendly name, a phone number in any format, or a platform
id all resolve through the channel directory and the contacts store. An unresolvable target comes
back with the alias forms that would have worked.</li>
<li><strong>Contact approval.</strong> A registered contact who is <code>pending</code> gets
“⏳ registered but pending admin approval”; one who was <code>rejected</code> gets “🚫 rejected by
the administrator” — each naming the command an operator can run to change it. The failure
educates instead of saying “unknown target”.</li>
<li><strong>Outbound send authority.</strong> Knowing who may <em>trigger</em> the agent is not the
same as who may make it message <em>someone else</em>. On a gateway turn the sender must hold send
authority for that platform (dashboard → Agent Hub → Permissions → Send authority); an optional
setting requires every recipient to be an approved contact; and a CLI or dashboard turn carries no
origin, so it stays trusted.</li>
</ol>

<p><strong>The honesty rule belongs to the tool.</strong> It writes <code>✅ sent</code> only when
the transport confirmed delivery; a failure returns a <code>⚠️</code>/<code>🚫</code> string that
flows back into the model's context so it can tell the user what actually happened. The loop goes
one step further and judges the <em>result</em> rather than the attempt — a failed send is recorded
as an unverified claim, not as “an action happened”.</p>

<p>Inside a running gateway the tool reuses the <em>live</em> registry and its already-connected
adapters instead of building a second one: a fresh WhatsApp connection opened inside the same
process stalled deliveries for over a minute.</p>

`,
  },
  {
    // ch46.3 presented `src/learning/skills-registry.ts` as a local SKILL.md
    // loader class with keyword scoring, a `findRelevant(goal)` match and a
    // `generateContext()` prompt injection. That module is a multi-source
    // INSTALL registry (github-raw / local-dir / browse-sh / git-repo); the
    // local store is `src/learning/skill-store.ts`, and skills reach the model
    // through the `skill` tool rather than keyword matching.
    start: '<h3>46.3 Skill Loading and Discovery</h3>',
    end: '<h3>46.4 Community Skills</h3>',
    html: `<p>Two different mechanisms carry the word “skill”, and keeping them apart is the real
subject of this section.</p>

<pre><code class="language-typescript">
// src/learning/skills-registry.ts — the INSTALL registry
//
// Source kinds, each normalized into one HubSkillEntry shape so search and
// install behave identically whatever the origin:
//   github-raw  — {base}/index.json + {base}/&lt;name&gt;/SKILL.md
//   local-dir   — a plain folder with the same layout (offline / team shares)
//   browse-sh   — the browse.sh API
//   git-repo    — any git repo, cloned shallowly; the skills root is detected
//                 (repo root / skills/ / .claude/skills/ / .agents/skills/)
//
// Configured by buffconfig skills.registries[] (ordered = priority); the legacy
// BUFF_SKILLS_REGISTRY env var is the single-value fallback when it is absent.
export async function searchAllRegistries(query: string, opts?: { sourceKind?: string })
export async function installFromSource(entry: HubSkillEntry)

// src/learning/skill-store.ts — where an installed skill LIVES
//
// One JSON file per skill plus an index.json, seeded from
// src/skills/bundled-skills.ts (152 bundled skills). The directory is resolved
// PER CALL — envBuff('SKILLS_DIR') || resolveNuviraDataPath('skills') — because
// a module-load constant read the raw home, ignored the isolation override, and
// seeded the developer's real profile on every test run.
export class SkillStore { /* usage tracking, decay scoring, search, gc */ }
export function getSkillStore(): SkillStore
</code></pre>

<p><strong>How a skill reaches the model.</strong> Not by scoring the goal against keywords. The
agent has a <code>skill</code> tool whose description tells it when a reusable capability pack
applies; calling it returns that skill's ordered methodology — steps and parameters — into the
conversation, where it guides the work. Omit the name and the tool lists what is available. A
per-loop hint can surface a matching skill so the model does not have to think of it, but the
choice stays the model's, and an admin can disable a skill outright.</p>

<p><strong>Why the two jobs are separate.</strong> Discovery is a network problem (registries,
authentication, checksums, dependency resolution, shallow clones) and storage is a local one
(files, an index, eviction). Joining them would put a registry fetch on the path that answers “what
skills do I have?”, which is the one question that must never need the network.</p>

`,
  },
  {
    // ch49.4 wrote `new ErrorRepairEngine(3)` and
    // `engine.selectStrategy('tool-error', 0)` — a 0-based attempt, a category
    // that does not exist ('retry-tool' is a STRATEGY), and a two-argument
    // method. `selectStrategy` is a module-level function taking
    // (category, attemptNumber, options) with 1-based attempts, the engine
    // constructor takes `Partial<ErrorRepairOptions>`, and the chapter omitted
    // the weak-model ladder, which is the part that matters when no strong
    // model is reachable.
    start: '<h3>49.4 Testing the Error Repair Engine</h3>',
    end: '<h3>49.5 Integration Testing</h3>',
    html: `<pre><code class="language-typescript">
// src/learning/error-repair.ts
//
// selectStrategy is a MODULE-LEVEL function and attempts are 1-based.
export function selectStrategy(
  category: ErrorCategory,   // 'llm-error' | 'provider-error' | 'process-error' |
                             // 'injection-blocked' | 'context-limit' |
                             // 'budget-exhausted' | 'unknown'
  attemptNumber: number,     // 1, 2, 3 …  (there is no attempt 0)
  options: ErrorRepairOptions,
): RepairStrategy            // 're-prompt' | 'switch-model' | 'adjust-temperature' |
                             // 'retry-tool' | 'alternative-approach' |
                             // 'shrink-scope' | 'skip-step'

// Each category has its own ladder. llm-error, as shipped:
expect(selectStrategy('llm-error', 1, {})).toBe('re-prompt');
expect(selectStrategy('llm-error', 3, {})).toBe('alternative-approach');
expect(selectStrategy('llm-error', 4, {})).toBe('skip-step');

// budget-exhausted and injection-blocked are not repairable at all:
expect(isRepairable('injection-blocked')).toBe(false);

export class ErrorRepairEngine {
  constructor(options: Partial&lt;ErrorRepairOptions&gt; = {})   // not a number
  async repair(taskId, context, callLLM, originalError, executeFn): Promise&lt;AgentResult&gt;
}
</code></pre>

<p><strong>The test that is actually worth writing is the weak-model ladder.</strong> With only a
weak model reachable, the per-category ladder is a trap: its second and third steps
(<code>switch-model</code>, <code>alternative-approach</code>) assume a stronger model exists to
switch <em>to</em>, and re-prompting the same weak model reproduces the identical failure. So when
<code>options.weakModel</code> is set the ladder is replaced entirely by a bounded sequence of
three <em>different kinds</em> of attempt — <code>re-prompt</code> once, then
<code>shrink-scope</code> (ask for the smallest single unit, which a model that cannot hold the
whole task can still get right), then <code>skip-step</code>, which ends honestly instead of
looping. A test asserting that ladder is what keeps the no-strong-model path from silently
reverting to two retries of the same failure.</p>

<p><strong>Two more properties to pin down:</strong> <code>RepairBudget</code> is constructed from
<code>(maxRepairs, repairMode)</code> and is what ends the loop, and
<code>needsApproval(strategy, mode)</code> decides which strategies require a human first —
“prompt” mode must fall back to <code>skip-step</code> rather than proceed when no one can answer.</p>

`,
  },
  {
    // ch51.2 taught PM2 (`pm2 start dist/cli/index.js`, `pm2 startup`,
    // `pm2 monit`). PM2 appears nowhere in this repository — not in package.json,
    // not in the docs — and the real deployment path is the committed Dockerfile
    // plus docker-compose.yml (which is what the container writes into).
    start: '<h3>51.2 Process Management</h3>',
    end: '<h3>51.3 Health Checks</h3>',
    html: `<p>There is no process manager in this repository. The supported paths are the ones the
repository actually ships — a container, or the CLI itself — and both are documented next to the
code that implements them.</p>

<pre><code class="language-bash">
# The shipped path: a three-stage Dockerfile and a compose file that persists state.
cp .env.example .env     # fill in the keys you have
BUFF_DASHBOARD_HOST=0.0.0.0 BUFF_DASHBOARD_PORT=3030 docker compose up

docker compose logs -f                       # follow the dashboard + CLI output
docker compose exec agent-nuvira nuvira doctor

# With local inference instead of a cloud provider:
docker compose --profile ollama up

# One-shot commands against the same image — the entrypoint takes the CLI
docker compose run --rm agent-nuvira chat "explain recursion in Rust"
docker compose run --rm agent-nuvira models --provider groq
</code></pre>

<p><strong>What the container provisions for you.</strong> The entrypoint creates the data
directories (<code>~/.buff</code> and its <code>memory/</code>, <code>skills/</code>,
<code>plugins/</code> children), logs the resolved user, home, data dir and Node version, and then
executes the CLI with the compose <code>CMD</code>. State lives in a named volume
(<code>agent-nuvira-data</code> mounted at <code>/root/.buff</code>), so a rebuild does not lose
config, memory, cache or history — the failure mode to avoid is a container that keeps working
while every restart quietly forgets the last month.</p>

<p><strong>The port has one name and one default.</strong> The dashboard reads
<code>envBuff('DASHBOARD_PORT')</code>, which accepts either prefix
(<code>NUVIRA_DASHBOARD_PORT</code> or <code>BUFF_DASHBOARD_PORT</code>) and defaults to
<strong>3030</strong>. The compose file publishes <code>\"3030:3030\"</code> and probes
<code>http://localhost:3030/api/health</code>, so changing the port in one place and not the others
is what makes a dashboard look deployed but unreachable.</p>

<p><strong>Restart policy is <code>unless-stopped</code></strong> — a crash is retried, a
deliberate stop is respected. That plus the <code>/api/health</code> check below is the whole
supervision story; if a deployment needs more, the right next step is running the same image under
the orchestrator you already operate, because nothing in the process is stateful beyond the volume.</p>

`,
  },
  {
    // ch54.2/54.3 sketched the provider with `initialize(sessionId)`,
    // `prefetch(query, sessionId?, callLLM?)` and a `MemoryPrefetchResult`
    // missing `fewShotContext`, and taught an `isTrivialPrompt` built from a
    // length check plus a hard-coded greeting list. The shipped gate is one
    // anchored regex, and the interface has five hooks the sketch never named
    // (including `name()`/`is_available()`, which is how a backend is chosen).
    start: '<h3>54.2 MemoryProvider Interface</h3>',
    end: '<h3>54.4 Memory Injection into Prompts</h3>',
    html: `<pre><code class="language-typescript">
// src/memory/provider.ts — the lifecycle a backend implements

export interface MemoryProvider {
  readonly name: string;                        // 'local', 'mem0' …
  is_available(): boolean;
  initialize(session_id: string): Promise&lt;void&gt;;
  system_prompt_block(): string;
  prefetch(query: string): Promise&lt;MemoryPrefetchResult&gt;;
  sync_turn(userText: string, assistantText: string): Promise&lt;void&gt;;
  on_session_end(): Promise&lt;void&gt;;
}

export interface MemoryPrefetchResult {
  block: string;                 // the composed block for prompt injection (may be '')
  trajectories: Trajectory[];    // raw similar runs (dashboards / event messages)
  fewShotContext: string;        // plan examples lifted from past runs
  patternContext: string;        // positive episodic patterns
  failureLessonContext: string;  // negative episodic lessons
  factContext: string;           // project-scoped facts and preferences
}

// LocalMemoryProvider is the default; it composes the stores that already
// exist (trajectory store + pattern extractor + failure lessons + fact store).
// A Mem0 provider implements the SAME interface later — no caller changes.
</code></pre>

<h3>54.3 The Trivial-Prompt Gate</h3>

<pre><code class="language-typescript">
// src/memory/provider.ts — the gate is ONE anchored regex, shared by every caller

const TRIVIAL_PROMPT_RE =
  /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|
     continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)
   [\\s!?.:;,'"~…()\\[\\]{}&lt;&gt;*&amp;^%$#@!+=&nbsp;]*$/i;

export function isTrivialPrompt(text: string | null | undefined): boolean {
  if (!text) return true;
  const stripped = text.trim();
  if (!stripped) return true;
  if (stripped.startsWith('/')) return true;   // slash commands never prefetch
  return TRIVIAL_PROMPT_RE.test(stripped);
}
</code></pre>

<p><strong>Why anchored.</strong> A substring test would classify “k8s”, “yolo” and “note” as
greetings, because each one merely <em>starts</em> with a trivial word — and the cost of that bug is
silent: memory simply stops being recalled for exactly the terse, jargon-heavy asks that need it
most. Anchoring the whole string (with a generous trailing-punctuation class) makes
<code>hi!</code>, <code>thanks :)</code> and <code>done???</code> trivial while leaving real input
alone.</p>

<p><strong>Why the gate exists at all.</strong> A prefetch is a real read across the trajectory,
pattern, failure and fact stores — occasionally with an LLM call to summarize. Spending that on
“thanks” is pure cost, and the shared helper means the answer is identical wherever it is asked:
the manager, the chat loop and the planner all call the one function, so there is no second
implementation to drift.</p>

<p><strong>Every hook is best-effort.</strong> A provider that throws must never break the agent:
<code>MemoryManager</code> catches, logs at debug level and returns an empty result, and
<code>sync_turn</code>/<code>on_session_end</code> swallow their own failures. Memory that can take
down a run is worse than no memory, so the failure mode is deliberately “forget this one”.</p>

`,
  },
  {
    // ch59.3 taught ten intents (`create, fix, explain, refactor, test, deploy,
    // config, ask, continue, chat`) and a locally-declared `TRUST_THRESHOLD =
    // 0.6`. The shipped vocabulary is seven intents in src/nlu/intent.ts, the
    // threshold is RULE_TRUST_THRESHOLD = 0.8, and the mode hints are
    // 'dev' | 'recall' | 'execute' | 'chat' | 'config' — not
    // pipeline/chat/config/help.
    start: '<h3>59.3 Intent Classification</h3>',
    end: '<h3>59.4 LLM Verification (Slow Path)</h3>',
    html: `<pre><code class="language-typescript">
// src/nlu/intent.ts — the whole vocabulary

export type NluIntent =
  | 'create'      // build something new — files, features, projects
  | 'continue'    // resume prior work for this project (recall + pipeline)
  | 'fix'         // fix a bug, debug a failure
  | 'explain'     // answer a question, analyze or explain — no file writes
  | 'configure'   // keys, providers, models, settings
  | 'write'       // creative or educational content — an answer, not a build
  | 'unknown';    // ambiguous — fall back to an answer, never guess a pipeline

/** What the pipeline should do with this request. */
export type ModeHint = 'dev' | 'recall' | 'execute' | 'chat' | 'config';

/** Below this, a CREATE intent is ambiguous enough to ask instead of act. */
export const RULE_TRUST_THRESHOLD = 0.8;

export function classifyIntent(text: string): { intent: NluIntent; confidence: number; modeHint: ModeHint }
</code></pre>

<p><strong>The rules are ordered and the first match wins</strong>, which is the design decision worth
noticing: an intent is decided by the earliest pattern that fires, not by the highest score across
all of them. “Fix the failing login test” must be <code>fix</code>, not a tie between
<code>fix</code> and <code>explain</code>; scoring every keyword against every intent makes that
outcome depend on weight tuning, while ordering makes it explicit and testable.</p>

<p><strong>Confidence is how the layer asks for help.</strong> A rule that recognises an input
returns the confidence that rule earned (0.8–0.9 for the decisive patterns). A rule that does not
recognise it returns <strong><code>confidence: 0</code></strong> — never a low-confidence guess — so
the caller can hand the decision to the verification path in 59.4 instead of acting on a
misread.</p>

`,
  },
  {
    // ch60.1 listed nine actions (`create`, `fix`, `explain`, `refactor`, `test`,
    // `deploy`, `config`, `ask`, `continue`, `chat`) and a `help` run mode. The
    // real map is seven descriptors keyed by the seven intents, `run` is
    // 'pipeline' | 'chat' | 'config', and each descriptor also carries a router
    // task-intent and a zod input schema.
    start: '<h3>60.1 Action Descriptors</h3>',
    end: '<h3>60.2 Action Dispatch</h3>',
    html: `<pre><code class="language-typescript">
// src/nlu/actions.ts

export interface ActionDescriptor {
  name: string;                    // tool name, shared with native tool-calling
  description: string;             // the tool schema's description field
  run: 'pipeline' | 'chat' | 'config';
  mode: ModeHint;                  // 'dev' | 'recall' | 'execute' | 'chat' | 'config'
  taskIntent: TaskIntent;          // feeds the router's vocabulary
  inputSchema: ZodType;            // the same schema handed to tool-calling providers
}

/** Every intent resolves to exactly one action — the map is total. */
export const ACTION_BY_INTENT: Record&lt;NluIntent, ActionDescriptor&gt; = {
  create:    { name: 'build',     run: 'pipeline', mode: 'dev',     taskIntent: 'coding'    },
  continue:  { name: 'resume',    run: 'pipeline', mode: 'recall',  taskIntent: 'coding'    },
  fix:       { name: 'repair',    run: 'pipeline', mode: 'execute', taskIntent: 'debugging' },
  explain:   { name: 'assess',    run: 'chat',     mode: 'chat',    taskIntent: 'unknown'   },
  write:     { name: 'write',     run: 'chat',     mode: 'chat',    taskIntent: 'creative'  },
  configure: { name: 'configure', run: 'config',   mode: 'config',  taskIntent: 'unknown'   },
  unknown:   { name: 'ask',       run: 'chat',     mode: 'chat',    taskIntent: 'unknown'   },
};
</code></pre>

<p><strong>Why the map is total.</strong> A missing entry would be a request with no action — a
silent no-op in the one place the user is most likely to notice. Making <code>unknown</code> a real
entry with a real descriptor (“ambiguous request — fall back to a chat answer; no pipeline runs on
a guess”) removes that class of bug by construction, and gives the fallback a name instead of a
special case scattered through the dispatcher.</p>

<p><strong>One vocabulary, four consumers.</strong> The descriptor is where the NLU layer, the
router, the tool schema and the dispatcher agree. <code>taskIntent</code> is what routes the
request to a model class; <code>mode</code> is the pipeline hint; <code>inputSchema</code> is what a
native tool-calling provider sees when this arrives as a tool call; and <code>run</code> decides
who executes it — so renames happen in one table rather than in four switch statements.</p>

<p><strong>Dispatch never invents work.</strong> Non-create intents auto-dispatch with no
user-facing menu at all (see <code>shouldAutoDispatch</code>); only an ambiguous
<code>create</code> below the trust threshold still offers the legacy menu, and only as the
fallback for a case where the verifier could not run.</p>

`,
  },
  {
    // ch62 printed a two-stage node:20 Dockerfile on port 3000 that copied
    // `.agents`, plus a compose file with a `version:` key, a `./src` bind mount
    // and volume names that do not exist. The committed Dockerfile is THREE
    // stages on node:22-alpine, the port is 3030, the entrypoint is
    // docker-entrypoint.sh with CMD ["dashboard"], and state lives in
    // /root/.buff. Replaces both the Dockerfile and the compose section, since
    // the second only repeats the first's numbers.
    start: '<h3>62.1 Dockerfile</h3>',
    end: '<h3>📝 Key Takeaways</h3>',
    html: `<pre><code class="language-bash">
# Dockerfile — three stages, because the dashboard is a second build (#
#   1. cli-builder        npm ci && npm run build          → dist/
#   2. dashboard-builder  (cd src/web-dashboard && npm install && npm run build)
#   3. runtime            node:22-alpine + git, copies dist/ and the built UI

FROM node:22-alpine AS cli-builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache git
WORKDIR /app
COPY --from=cli-builder /app/dist ./dist
COPY --from=cli-builder /app/node_modules ./node_modules
COPY --from=dashboard-builder /app/src/web-dashboard/public ./src/web-dashboard/public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 3030
VOLUME ["/root/.buff"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["dashboard"]
</code></pre>

<p><strong>Why three stages.</strong> The CLI is TypeScript and the dashboard is a Vite/React
build; they have separate dependency manifests and separate build commands. Putting them in one
stage would ship the compiler and the front-end toolchain into the runtime image, and would force a
dashboard rebuild on every CLI-only change. Splitting them also lets the runtime image carry only
what it runs: <code>node:22-alpine</code>, <code>git</code> (the agents shell out to it), the built
CLI, the built static files and the entrypoint script.</p>

<p><strong>Why the entrypoint is a script.</strong> The container has to create its data
directories (<code>/root/.buff</code> plus <code>memory/</code>, <code>skills/</code>,
<code>plugins/</code>), print the resolved user, home, data dir and Node version, and only then
execute the CLI with the <code>CMD</code> as arguments — which is what makes
<code>docker compose run --rm agent-nuvira chat "…"</code> work without a second image or a
special-case shell.</p>

<h3>62.2 Docker Compose</h3>

<pre><code class="language-text">
# docker-compose.yml (abridged)
services:
  agent-nuvira:
    build: { context: ., dockerfile: Dockerfile }
    ports: ["3030:3030"]
    environment:
      - BUFF_DASHBOARD_HOST=0.0.0.0
      - BUFF_DASHBOARD_PORT=3030          # envBuff accepts either prefix
      - GROQ_API_KEY=\${GROQ_API_KEY:-}
      - NVIDIA_NIM_API_KEY=\${NVIDIA_NIM_API_KEY:-}
      - GEMINI_API_KEY=\${GEMINI_API_KEY:-}
      - OPENROUTER_API_KEY=\${OPENROUTER_API_KEY:-}
      - OLLAMA_HOST=\${OLLAMA_HOST:-http://host.docker.internal:11434}
    volumes: ["buff-data:/root/.buff"]       # config, memory, cache, history
    restart: unless-stopped
    healthcheck:                            # probe the real endpoint
      test: ["CMD", "node", "-e", "fetch('http://localhost:3030/api/health')…"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s

  ollama:
    profiles: ["ollama"]                    # only with --profile ollama
    image: ollama/ollama:latest
    volumes: ["ollama-data:/root/.ollama"]

volumes:
  buff-data: { name: agent-nuvira-data }
  ollama-data: { name: agent-nuvira-ollama-data }
</code></pre>

<p><strong>Three details that carry the design.</strong> The named volume
(<code>agent-nuvira-data</code>) is why a rebuild does not lose config, memory or history — an
anonymous volume would. The health check probes <code>/api/health</code> on the same port the
service publishes, so “healthy” means the endpoint a monitor would call actually answers. And
Ollama sits behind a <code>profile</code> instead of always starting, because most deployments use
a cloud provider and should not pay for a model server they never call.</p>

<p>The API keys use the <code>\${VAR:-}</code> form, which passes an empty string when the variable
is unset rather than failing the compose parse — so composing the stack without a given provider's
key is a normal state, not an error, and that provider is simply absent from routing.</p>

`,
  },
  {
    // ch63.1 taught `Role = 'admin' | 'user' | 'guest'` with a hand-written
    // ROLE_PERMISSIONS table. The shipped roles are 'admin' | 'operator' |
    // 'viewer', the matrix is keyed by named AdminActions, and the whole point
    // of the module is its legacy-permissive default.
    start: '<h3>63.1 RBAC (Role-Based Access Control)</h3>',
    end: '<h3>63.2 Prompt Injection Scanning</h3>',
    html: `<pre><code class="language-typescript">
// src/enterprise/rbac.ts

export type Role = 'admin' | 'operator' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'];

/** Actions on the admin/enterprise surface that roles gate. */
export type AdminAction =
  | 'policy.read' | 'policy.write' | 'role.manage' | 'credential.write'
  | 'routing.operate' | 'team.manage' | 'sbom.write' | 'skill.remove'
  | 'cron.manage' | 'gateway.manage' | 'system.manage';

const PERMISSION_MATRIX: Record&lt;Role, ReadonlySet&lt;AdminAction&gt;&gt; = {
  admin:    new Set([… every action, including policy.write and role.manage]),
  operator: new Set(['policy.read', 'routing.operate', 'team.manage',
                     'sbom.write', 'cron.manage', 'gateway.manage']),
  viewer:   new Set(['policy.read']),
};
</code></pre>

<p><strong>A local role file, and a permissive default.</strong> The assignment is a file
(<code>~/.nuvira/rbac.json</code>, or the <code>NUVIRA_CONFIG_DIR</code> override) mapping an OS user
to a role, and the identity is the OS username with <code>BUFF_ACT_AS</code> as an override for
CI and multi-tenant tooling. When that file has no users, the system stays <em>fully permissive</em>
— enabling RBAC can never lock an existing single user out of their own machine. That default is
the single most important line in the design: an access-control feature whose first act can be to
lock the operator out is a feature nobody turns on.</p>

<p><strong>Enforcement is shared, not re-implemented.</strong> The engine could always deny, but
only <code>nuvira admin</code> asked it. A guard module now wraps every sensitive surface — config
vault migration, team writes, SBOM file writes, <code>skill gc</code>, cron and gateway
management, stopping the dashboard — so the semantics are identical everywhere: legacy mode
proceeds, an assigned role is checked, and a denial logs a clear message <em>including how to
bootstrap the first admin</em> and sets exit code <strong>3</strong>. A silent no-op is the failure
mode that makes authorization untestable, so the refusal is loud and machine-visible.</p>

`,
  },
  {
    // ch63.2 printed a `scanForInjection()` returning `{ safe, patterns }` over
    // seven bare patterns. The shipped scanner is `scanForInjections()` returning
    // typed `SecurityFinding[]` over three pattern families, and the orchestrator
    // BLOCKS the call on a finding rather than reporting one. 63.3 attributed a
    // `maskKey` to a credential module that has none; the masking primitive is
    // `maskSecret()` in src/enterprise/secrets.ts, reused by the publish tool, the
    // credential tool, the secret scanner and the audit chain.
    start: '<h3>63.2 Prompt Injection Scanning</h3>',
    end: '<div class="key-takeaways">',
    html: `<pre><code class="language-typescript">
// src/security/scanner.ts

// Three pattern families, not seven loose patterns: instruction override,
// role-play jailbreaks and prompt leaking — plus token-smuggling hints.
const INJECTION_PATTERNS = [
  // Ignore / cancel system instructions
  /\\bignore\\s+(all\\s+)?(previous|above|prior)\\s+(instructions|directions|prompts?)\\b/i,
  /\\bdisregard\\s+(all\\s+)?(previous|above)\\s+(instructions|directions)\\b/i,
  /\\bforget\\s+(all\\s+)?(previous|prior)\\s+(instructions|context)\\b/i,

  // Role-play jailbreaks
  /\\byou\\s+are\\s+(now|free|released|DAN|jailbroken)\\b/i,
  /\\bpretend\\s+(to\\s+)?(be|you\\s+are)\\s+(a|an|the)\\b/i,
  /\\bDAN\\b/i,                                     // "Do Anything Now"

  // Prompt leaking
  /\\boutput\\s+(the\\s+)?(initial|original|first|above)\\s+(prompt|instruction|system)\\b/i,
  /\\breveal\\s+(the\\s+)?(prompt|instructions|system\\s+message)\\b/i,
  /\\bshow\\s+(me\\s+)?(the\\s+)?(prompt|instructions)\\b/i,
  /\\bprint\\s+(the\\s+)?(prompt|instructions|system\\s+prompt)\\b/i,

  // Token smuggling
  /\\bbase64\\s+(\\d+\\s+times|repeat)/i,
];

/** One of four scanners, all of which return typed findings — not booleans. */
export interface SecurityFinding {
  type: 'pii' | 'injection' | 'dangerous-code';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category: string;
  match: string;
  recommendation?: string;
}

export function scanForInjections(text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      findings.push({
        type: 'injection',
        severity: 'high',
        category: 'prompt-injection',
        match: match[0].slice(0, 80),
        recommendation: 'Review the prompt for jailbreak or injection attempts',
      });
    }
  }

  return findings;
}
</code></pre>

<p><strong>The scan is a guardrail, not a warning.</strong> The orchestrator calls it on every
prompt inside the LLM callback it hands to the agents, and a non-empty result <em>throws</em> —
“Injection guardrail blocked LLM call”, formatted by <code>formatScanReport()</code> — so the
request never reaches a provider at all. The same function is exported from
<code>src/index.ts</code> and reused by <code>nuvira security scan</code> and the security agent,
which is why it returns findings rather than a boolean: the caller decides whether a finding is
fatal, and the report can name <em>which</em> pattern matched instead of only refusing.</p>

<h3>63.3 Secure Credential Management</h3>

<pre><code class="language-typescript">
// src/enterprise/secrets.ts — one redaction primitive with four callers

export function maskSecret(value: string): string {
  const v = String(value ?? '').trim();
  if (!v) return '***';
  if (v.length &lt;= 12) return '***';                 // too short to half-show
  return \`\${v.slice(0, HEAD_KEEP)}…\${v.slice(-TAIL_KEEP)}\`;   // gsk_cy8g…S9ak
}

// …and the text-level forms built on it:
//   redact(text)          replaces every key/token-shaped substring
//   safeLine(record)      JSON-encode + redact — what the audit chain stores
//   applyRedaction(text)  redact unless BUFF_NO_REDACT=1 (debugging only)
</code></pre>

<p><strong>One file holds the keys, one function holds the mask.</strong> A provider key is read
first from the process environment, then from a project-root <code>.env</code>, then from the
credential file at <code>resolveNuviraEnvFile()</code> — <code>~/.nuvira/.env</code> by default,
pinned by <code>NUVIRA_ENV_FILE</code> and isolated along with the rest of the config dir — while
<code>.nuviraconfig.json</code> carries everything that is <em>not</em> sensitive. Because
<code>maskSecret()</code> is pure and returns a new string, one rule covers the publish tool, the
credential tool, the secret scanner and the audit chain: a key that reaches a log line is masked
the same way wherever it came from. Short values are masked completely, because a four-character
head of an eight-character secret is half the secret.</p>

`,
  },
  {
    // ch64.1 printed a fixed `Metrics` interface ('pipeline.started',
    // 'cost.incurred') with a `getModelDistribution()` / `getCostReport()` pair;
    // the shipped store is dependency-free counters + timers persisted to
    // metrics.json, and cost lives in a different file. ch64.2's three hard-coded
    // `cron.schedule()` calls do not exist — `src/gateway/cron.ts` schedules
    // user-defined TOOL invocations from ~/.nuvira/cron/jobs.json. ch64.3 wired the
    // memory manager and the self-improver to the event bus; the orchestrator calls
    // both directly, and `getSelfImprover()` is a getter, not an ambient instance.
    start: '<h3>64.1 Metrics Collection</h3>',
    end: '<div class="key-takeaways">',
    html: `<h3>64.1 Metrics Collection</h3>

<pre><code class="language-typescript">
// src/enterprise/metrics.ts — counters + timers, and no new dependency

export interface MetricsData {
  version: number;
  counters: Record&lt;string, number&gt;;
  /** name → { count, totalMs, maxMs } — for avg/max latency budgets. */
  timers: Record&lt;string, { count: number; totalMs: number; maxMs: number }&gt;;
  updatedAt: number;
}

class MetricsStore {                       // module-private; reach it via getMetrics()
  increment(name: string, by = 1) { /* … */ }
  timeSync&lt;T&gt;(name: string, fn: () =&gt; T): T { /* … */ }
}

// The exported surface the rest of the tree uses:
export function countMetric(name: string, by = 1): void;
export function recordMetricTime&lt;T&gt;(name: string, fn: () =&gt; T): T;

// Call sites that actually exist:
countMetric(hit ? 'memory.hits' : 'memory.misses');                  // src/memory/manager.ts
recordMetricTime('rule.parse.ms',    () =&gt; parseRequestSync(message));
recordMetricTime('rule.dispatch.ms', () =&gt; /* … */);
recordMetricTime('llm.answer.ms',    () =&gt; /* … */);                 // src/cli/chat.ts
</code></pre>

<p><strong>Three rules, all stated in the file's own header.</strong> No new dependency — the plan
said “counters/timers (no new dep)”, so it is built on <code>node:fs</code> alone. Writes are lazy:
increments update an in-memory map and <code>save()</code> runs at the end of a run (or when
<code>nuvira doctor</code> asks), so a hot loop never touches disk. And it never throws — a failed
write degrades to an in-memory-only session, because a metrics store that can fail a run is worse
than no metrics. The file is <code>metrics.json</code> in the memory dir, read by
<code>nuvira doctor</code> and by the dashboard; it is a last-writer-wins snapshot, which the header
names as the accepted trade for a lightweight store.</p>

<p><strong>Cost is deliberately a different store.</strong> Token and dollar accounting lives in
<code>src/learning/cost-tracker.ts</code> (<code>~/.nuvira/memory/cost-tracker.json</code>, read back
through <code>costSince()</code>), because pricing is per provider and per model and changes
independently of how often a function ran. The metrics store answers “how long did the rule path
take next to the LLM path”; the cost tracker answers “what did this session spend”.</p>

<h3>64.2 Scheduled Jobs</h3>

<pre><code class="language-bash">
# A job is a scheduled TOOL invocation, stored as inspectable JSON.
nuvira admin cron add nightly-build "0 3 * * *" build --args '{"goal":"rebuild the CLI"}'
nuvira admin cron list
nuvira admin cron run nightly-build       # invoke it now
nuvira admin cron remove nightly-build
</code></pre>

<pre><code class="language-typescript">
// src/gateway/cron.ts — the scheduler core

export interface CronJob {
  id: string;                      // slugified name + timestamp
  name: string;                    // "nightly-build"
  schedule: string;                // 5-field expression, validated by node-cron
  tool: string;                    // a registered tool: build, test, code_search, …
  args: Record&lt;string, unknown&gt;;   // validated against that tool's own schema
}

// runJobNow(job) invokes the registered tool and emits, in order:
//   cron:run → cron:result  (or cron:error)
// dryRunJob(job) validates the schedule + tool WITHOUT executing anything.
// Jobs persist to ~/.nuvira/cron/jobs.json — readable, inspectable JSON.
</code></pre>

<p><strong>Why a job is a tool invocation and not a callback.</strong> A schedule that can run
arbitrary code is a schedule nobody can review. A job names a <em>registered</em> tool plus a JSON
argument object, so it is validated twice — the expression by node-cron, the arguments against the
tool's own schema — and a dry run can answer “would this start?” without starting it. Delivery is
the same pattern as everywhere else: results and errors leave as events, so a CLI run, a gateway
lane and the dashboard read one stream rather than three.</p>

<h3>64.3 Event-Driven Architecture</h3>

<pre><code class="language-typescript">
// The bus is real. The wiring is not what a diagram implies.
const bus = getEventBus();

// The orchestrator EMITS its lifecycle:
//   orchestrator:pipeline-started · orchestrator:task-started
//   orchestrator:plan-ready       · orchestrator:pipeline-completed

// …and at the end of a run it CALLS the learning steps directly, rather than
// subscribing to an event it published itself:
const { getSelfImprover } = await import('../learning/self-improver.js');
await getSelfImprover().processRun(
  { ...orchestrationSummary, trajectoryId },
  housekeepingCallLLM('self-improver', 'Pattern/failure-lesson extraction for: …'),
  options.agentModels as Record&lt;string, string&gt; | undefined,   // per-model stats
  options.verbose,
);
</code></pre>

<p><strong>Why direct calls, not a subscription.</strong> Post-run learning must finish before the
run is reported as done, and its order is not optional: score → agent stats → patterns or failure
lessons. A subscriber would make that sequence depend on who registered first, and a second
subscriber could not fail the first. So the orchestrator sequences those steps itself, inside a
<code>try/catch</code> — a learning failure is logged at debug level and never loses a completed
run. The bus carries what genuinely has many readers (plan progress, task lifecycle, cron results,
traces), which is where decoupling pays for itself.</p>

`,
  },
  {
    // ch65 described a `WorkflowDefinition` with `triggers` and a hand-rolled
    // parallel DAG executor (`Promise.allSettled` over ready steps). The real
    // src/workflow/ is a TEMPLATE registry — `WorkflowTemplate` has no
    // `triggers`, and a template runs by becoming a plan for the Orchestrator.
    start: '<h3>65.1 Workflow Definition</h3>',
    end: '<h3>📝 Key Takeaways</h3>',
    html: `<pre><code class="language-typescript">
// src/workflow/templates.ts

export interface WorkflowTemplate {
  id: string;                    // \`nuvira workflow run quick-fix\`
  name: string;
  description: string;
  steps: WorkflowStep[];         // ordered agent steps — the pipeline shape
  recommendedModels?: Partial&lt;Record&lt;string, string&gt;&gt;;
  useMemory?: boolean;
  version?: string;              // registry-published templates
  author?: string;
  tags?: string[];               // ['test', 'release', 'security']
  dependencies?: WorkflowDependency[];   // templates, npm packages, CLI tools
}

export interface WorkflowStep {
  agentType: string;
  dependsOn: string[];           // step ids, so the order is declared, not implied
  // …
}
</code></pre>

<p><strong>Running a template means planning it.</strong> <code>buildTaskPlanFromTemplate()</code>
turns the template's steps into a task graph and hands that to the Orchestrator — the same plan the
agent builds for an ad-hoc goal. That is why there is no separate execution engine to learn: a
workflow is a saved <em>shape</em> of work, and the planner, retry and verification machinery that
already exists is what runs it. Triggers are the caller's business (the CLI, a cron entry), not a
field on the template.</p>

<h3>65.2 The Registry</h3>

<pre><code class="language-bash">
nuvira workflow list                       # templates available locally
nuvira workflow run quick-fix "&lt;goal&gt;"     # plan + run a template

# src/workflow/registry.ts — templates come from a GitHub-hosted registry
nuvira workflow search &lt;query&gt;
nuvira workflow install &lt;template&gt;         # checksum-verified, version-aware
nuvira workflow info &lt;template&gt;
nuvira workflow publish &lt;template-id&gt;      # prepares a local template to submit
</code></pre>

<p><strong>Why a registry at all.</strong> The value of <code>quick-fix</code> is not the JSON — it is
that the same reviewed sequence is used by everyone instead of each person re-describing “fix it
properly” from scratch. Publishing one requires validation, because a template that is half a plan
is worse than no template: it produces a confident wrong pipeline. Installs resolve
<code>dependencies</code> for the same reason — a template naming a package or CLI tool that is not
present would fail at its first step rather than at install time.</p>

`,
  },
  {
    // ch66.2 printed a package.json that differs from the shipped one in every
    // field that matters: version, bin targets, build script, files and engines.
    // The shipped three bin names all point at dist/index.js, and there is no
    // dist/cli/index.js in the package at all.
    start: '<h3>66.2 package.json Configuration</h3>',
    end: '<div class="key-takeaways">',
    html: `<pre><code class="language-json">
{
  "name": "agent-nuvira",
  "version": "3.5.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "agent-nuvira": "dist/index.js",
    "buff": "dist/index.js",
    "nuvira": "dist/index.js"
  },
  "publishConfig": { "access": "public" },
  "files": ["dist/", "src/web-dashboard/public/", "README.md", "LICENSE"],
  "engines": { "node": "&gt;=18.18.0" },
  "scripts": {
    "build": "npm run build:cli &amp;&amp; node scripts/build-dashboard.mjs",
    "test": "vitest run",
    "prepack": "npm run build",
    "prepublishOnly": "npm run build &amp;&amp; npm test",
    "release:gate": "bash scripts/ci/regression-gate.sh"
  },
  "license": "MIT"
}
</code></pre>

<p><strong>Three entry names, one entry point.</strong> <code>agent-nuvira</code>, <code>buff</code>
and <code>nuvira</code> are aliases for the same binary, so an existing habit keeps working after a
rename. Publishing a path that does not exist (<code>dist/cli/index.js</code>, in the earlier
printing of this section) produces a package that installs cleanly and then fails on first run —
which is why the <code>files</code> list is explicit rather than “everything”.</p>

<p><strong><code>prepublishOnly</code> rebuilds and re-runs the suite</strong>, and
<code>prepack</code> rebuilds as well. Between them, a package cannot be published from a tree whose
source no longer produces a passing build — the discipline is enforced by npm itself at the one
moment it matters, instead of by a checklist somebody has to remember.</p>

`,
  },
  {
    // ch61 taught a flat `PromptParts` object joined in order, with pruning
    // driven by a "40% budget for context". The shipped builder is explicitly
    // LAYERED (STABLE / CONTEXT / VOLATILE) and the stable layer is kept
    // byte-stable across turns so the provider can cache the prefix — which is
    // the chapter's whole point and cannot be recovered from the sketch.
    start: '<h3>61.1 Prompt Structure</h3>',
    end: '<h3>61.3 Prompt Templates in Agent-Nuvira</h3>',
    html: `<pre><code class="language-typescript">
// src/agents/prompt-assembly.ts — layered construction
//
//   Layer 1  STABLE   — identity, tool guidance, skills
//   Layer 2  CONTEXT  — project context files, knowledge files, framework detection
//   Layer 3  VOLATILE — task-specific instructions, timestamp, session info
//
// Key design decision, in the file's own words: “Per-conversation prompt caching
// is sacred. The stable layer must be byte-stable across turns so the LLM
// provider can cache the prefix.”

export function assemblePrompt(
  stablePrompt: string,               // layer 1 — byte-stable across turns
  projectAssessment: ProjectAssessment, // layer 2 — changes when the project changes
  taskDescription: string,            // layer 3 — this task
  agentType: string,
): string
</code></pre>

<p><strong>Why the order is a cost decision, not a readability decision.</strong> Providers cache a prompt
<em>prefix</em>. If the stable layer changes by a single byte between turns — a timestamp moved into
it, skills re-sorted, a tool description regenerated in a different order — the prefix cache misses
and every call re-reads the whole system prompt at full price. That is why the volatile layer
(clock, session, this task's instructions) is pinned to the end and the stable layer is assembled
from inputs that do not drift.</p>

<p><strong>Context files survive the session.</strong> The CONTEXT layer reads project instruction files
(<code>knowledge.md</code>, <code>AGENTS.md</code>, <code>CLAUDE.md</code>) so persistent project rules exist
without being re-typed — and it is also where framework detection lands, which is why a fresh
session on an existing project behaves like a calibrated one rather than a blank one.</p>

<h3>61.2 Context Window Management</h3>

<p>Pruning is not a single budget percentage. The layers differ in what may be removed: the volatile
layer can be dropped outright, the context layer can be truncated oldest-first because its files are
also on disk, and the stable layer is the one that must not be touched — removing it would change the
cached prefix and, worse, drop the tool guidance the model needs to act at all. The order in which
those three are given up is the management policy; a percentage is just one of its parameters
(<code>src/learning/context-budget.ts</code> and <code>context-pruner.ts</code> hold the accounting).</p>

`,
  },
);

for (const { start, end, html: replacement } of SECTION_REPLACEMENTS) {
  const a = html.indexOf(start);
  if (a === -1) continue;
  const b = html.indexOf(end, a);
  if (b === -1) {
    console.error(`✗ found "${start}" but not its end marker — refusing to guess.`);
    process.exit(1);
  }
  html = html.slice(0, a) + replacement + html.slice(b);
  note(`• replaced a section that taught code this repository does not contain: ${start}`);
}

// ── 4d-quater. markup the replacements above consumed ────────────────────────
// A section replacement may use a heading as its `start` (or `end`) marker and
// then not re-emit it. Two pieces of collateral damage followed, and both are
// invisible to a structural check — the chapter still renders:
//
//   • Chapter 62's takeaway list lost the `<div class="key-takeaways">` that
//     opened it (`<h3>📝 Key Takeaways</h3>` was the end marker), leaving a stray
//     `</div>` and a list stripped of its styling.
//   • Chapters 62, 63 and 65 lost the heading that introduced their first code
//     block, so the numbering jumps from the chapter title to 62.2 / 63.2 / 65.2.
//
// Each is restored by anchoring on the first line of the block that follows, and
// every insert is guarded on the FIXED form — the broken form is a substring of
// the fixed one, so a plain split/join would stack another copy on every run.
const MARKUP_RESTORATIONS = [
  ['the takeaway-list wrapper in ch62',
   '<h3>📝 Key Takeaways</h3>\n<ul>\n<li><strong>Multi-stage builds</strong>',
   '<div class="key-takeaways">\n<h3>📝 Key Takeaways</h3>\n<ul>\n<li><strong>Multi-stage builds</strong>'],
  ['the section heading 62.1 Dockerfile',
   '<pre><code class="language-bash">\n# Dockerfile — three stages',
   '<h3>62.1 Dockerfile</h3>\n\n<pre><code class="language-bash">\n# Dockerfile — three stages'],
  ['the section heading 63.1 RBAC',
   '<pre><code class="language-typescript">\n// src/enterprise/rbac.ts',
   '<h3>63.1 RBAC (Role-Based Access Control)</h3>\n\n<pre><code class="language-typescript">\n// src/enterprise/rbac.ts'],
  ['the section heading 63.2 Prompt Injection Scanning',
   '<pre><code class="language-typescript">\n// src/security/scanner.ts',
   '<h3>63.2 Prompt Injection Scanning</h3>\n\n<pre><code class="language-typescript">\n// src/security/scanner.ts'],
  ['the section heading 65.1 Workflow Definition',
   '<pre><code class="language-typescript">\n// src/workflow/templates.ts',
   '<h3>65.1 Workflow Definition</h3>\n\n<pre><code class="language-typescript">\n// src/workflow/templates.ts'],
];
for (const [label, broken, fixed] of MARKUP_RESTORATIONS) {
  if (!html.includes(broken) || html.includes(fixed)) continue;
  html = html.replace(broken, fixed);
  note(`• restored ${label}, which an earlier edit consumed`);
}

// ── 4e. part descriptions (Parts I–XI) ───────────────────────────────────────
// Parts XII–XVI already received theirs inside the inserted block above. These
// four are placed RELATIVE to a landmark (`before` the part's first chapter, for
// the parts whose heading block is followed by a hand-written note) and seven are
// placed `after` the part's own `<h1>` — whichever the surrounding markup needs.
//
// Idempotency: the previously inserted copy is removed by its sentinel first, and
// the payload is inserted with a leading and a trailing newline so the removal is
// byte-exact. Without that, every run would add another description.
const PART_INTRO_ANCHORS = {
  I: { before: '<div class="chapter" id="ch01">' },
  II: { before: '<div class="chapter" id="ch09">' },
  III: { before: '<div class="chapter" id="ch16">' },
  IV: { before: '<div class="chapter" id="ch23">' },
  V: { after: /<h1 class="part-title">Part V\b[^<]*<\/h1>/ },
  VI: { after: /<h1 class="part-title">Part VI\b[^<]*<\/h1>/ },
  VII: { after: /<h1 class="part-title">Part VII\b[^<]*<\/h1>/ },
  VIII: { after: /<h1 class="part-title">Part VIII\b[^<]*<\/h1>/ },
  IX: { after: /<h1 class="part-title">Part IX\b[^<]*<\/h1>/ },
  X: { after: /<h1 class="part-title">Part X\b[^<]*<\/h1>/ },
  XI: { after: /<h1 class="part-title">Part XI\b[^<]*<\/h1>/ },
};
let introsPlaced = 0;
for (const [id, anchor] of Object.entries(PART_INTRO_ANCHORS)) {
  const startNeedle = `\n<!-- PART:${id}:START -->`;
  const endNeedle = `<!-- PART:${id}:END -->\n`;
  for (let a = html.indexOf(startNeedle); a !== -1; a = html.indexOf(startNeedle)) {
    const b = html.indexOf(endNeedle, a);
    if (b === -1) break;
    html = html.slice(0, a) + html.slice(b + endNeedle.length);
  }

  let at = -1;
  if (anchor.before) {
    at = html.indexOf(anchor.before);
    if (at === -1) {
      console.error(`✗ Part ${id}: landmark not found (${anchor.before}) — refusing to guess.`);
      process.exit(1);
    }
  } else {
    const m = anchor.after.exec(html);
    if (!m) {
      console.error(`✗ Part ${id}: part heading not found — refusing to guess.`);
      process.exit(1);
    }
    at = m.index + m[0].length;
  }
  html = html.slice(0, at) + introOf(id) + html.slice(at);
  introsPlaced++;
}
note(`• placed ${introsPlaced} part description(s)`);

// ── 5. read every real chapter out of the document ──────────────────────────
const navStart = html.indexOf('<nav class="sidebar">');
const firstPartTitle = html.indexOf('<div class="part-title">', navStart);
const appendicesTitle = html.indexOf('<div class="part-title">Appendices</div>', navStart);
if (navStart === -1 || firstPartTitle === -1 || appendicesTitle === -1) {
  console.error('✗ sidebar chapter list not found — refusing to rewrite it.');
  process.exit(1);
}

// Parse the WHOLE document: chapters 53–67 live after the appendices, so a
// window that stops at the appendices would silently drop Parts IX–XI.
const content = html.slice(html.indexOf('<main class="content">'));
const chapters = [];
for (const bit of content.split(/(?=<div class="chapter" id=")/).slice(1)) {
  const id = /^<div class="chapter" id="([^"]+)"/.exec(bit)?.[1];
  if (!id || id.startsWith('appendix')) continue;
  const head = bit.slice(0, 1500);
  const h2 = (/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(head)?.[1] ?? '').replace(/<[^>]*>/g, '');
  const cleanTitle = h2.replace(/\s+/g, ' ').trim().replace(/^Chapter\s+\d+\s*[—–-]\s*/, '');
  const num =
    Number(/<div class="ch-number">\s*Chapter\s+(\d+)/.exec(head)?.[1]) ||
    Number(/^ch(\d+)$/.exec(id)?.[1]) ||
    Number(/Chapter\s+(\d+)/.exec(h2)?.[1]) ||
    0;
  chapters.push({ id, num, title: cleanTitle, draft: id.startsWith('orig-') });
}

/** Part ranges by chapter number. Parts V–XI have no in-document heading, only these. */
const PARTS = [
  { num: 'I', title: 'TypeScript Fundamentals', from: 1, to: 8 },
  { num: 'II', title: 'Advanced TypeScript', from: 9, to: 15 },
  { num: 'III', title: 'Project Architecture', from: 16, to: 22 },
  { num: 'IV', title: 'Building Agent-Nuvira from Scratch', from: 23, to: 30 },
  // These titles are the SIDEBAR labels, and they now match the part heading in
  // the body word for word — they used to be shorter and, for Part VI, wrong
  // (it said "Dashboard & Gateway" while the gateway chapter is in Part VII).
  { num: 'V', title: 'The Router: How the Right Model Is Chosen', from: 36, to: 40 },
  { num: 'VI', title: 'The Dashboard: Building a Full-Stack Admin Interface', from: 41, to: 43 },
  { num: 'VII', title: 'Tools, Skills, and the Gateway: Extending Agent Capabilities', from: 44, to: 48 },
  { num: 'VIII', title: 'Testing, Deployment, and Production Operations', from: 49, to: 53 },
  { num: 'IX', title: 'Memory & Learning: Making the Agent Smarter Over Time', from: 54, to: 58 },
  { num: 'X', title: 'NLU & Intent: Understanding What Users Want', from: 59, to: 61 },
  { num: 'XI', title: 'Production, Security & Enterprise Features', from: 62, to: 67 },
  { num: 'XII', title: 'Command Reference & Dashboard', from: 68, to: 69 },
  { num: 'XIII', title: 'Why Agent-Nuvira', from: 70, to: 70 },
  { num: 'XIV', title: 'Model Context Protocol (MCP)', from: 71, to: 73 },
  { num: 'XV', title: 'Extending Agent-Nuvira', from: 74, to: 76 },
  { num: 'XVI', title: 'Policy & Configuration', from: 77, to: 80 },
];

const linkFor = (c) => `<a href="#${c.id}"><span class="ch-num">${c.num ? String(c.num).padStart(2, '0') : '•'}</span> ${c.title}</a>`;

const live = chapters.filter((c) => !c.draft);
const draft = chapters.filter((c) => c.draft);
const grouped = PARTS.map((p) => ({ ...p, chapters: live.filter((c) => c.num >= p.from && c.num <= p.to) }));
const orphans = live.filter((c) => !grouped.some((p) => p.chapters.includes(c)));

const tocParts = grouped
  .filter((p) => p.chapters.length)
  .map((p) => `<div class="part-title">Part ${p.num} — ${p.title}</div>\n${p.chapters.map(linkFor).join('\n')}`)
  .join('\n\n');

const tocDraft = draft.length
  ? `\n\n<div class="part-title">Earlier Draft — Part I (superseded)</div>\n${draft.map(linkFor).join('\n')}`
  : '';
const tocOrphans = orphans.length
  ? `\n\n<div class="part-title">Unnumbered chapters</div>\n${orphans.map(linkFor).join('\n')}`
  : '';

const extras = [
  ['playgrounds', '🎮 Interactive Playgrounds'],
  ['appendix-decisions', '📋 Master Decision Index'],
  ['video-walkthroughs', '🎬 Video Walkthroughs'],
  ['exercises', '📝 Practice Exercises'],
  ['glossary', '📖 Glossary of Terms'],
]
  .filter(([id]) => html.includes(`id="${id}"`))
  .map(([id, label]) => `<a href="#${id}"><span class="ch-num">•</span> ${label}</a>`);
const tocMore = extras.length ? `\n\n<div class="part-title">More in this book</div>\n${extras.join('\n')}` : '';

html = html.slice(0, firstPartTitle) + tocParts + tocDraft + tocOrphans + tocMore + '\n\n' + html.slice(appendicesTitle);

const chapterCount = live.length;
note(`• rebuilt the TOC from the document: ${chapterCount} chapters in ${grouped.filter((p) => p.chapters.length).length} parts (+${draft.length} superseded draft)${orphans.length ? ` (+${orphans.length} orphan)` : ''}`);

// ── 6. verify every anchor written into the sidebar resolves ─────────────────
const tocRegion = html.slice(firstPartTitle, appendicesTitle);
const hrefs = [...tocRegion.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const dead = hrefs.filter((id) => !html.includes(`id="${id}"`));
if (dead.length) {
  note(`  ⚠ unresolved sidebar anchors: ${dead.join(', ')}`);
} else {
  note(`  ✓ all ${hrefs.length} sidebar anchors resolve to an element in the book`);
}

// ── 7. correct stale facts ───────────────────────────────────────────────────
// The live command count, read from the just-regenerated Part XII rather than
// frozen here — the cover has been wrong about it twice.
const cliCommandCount = (/exposes — (\d+) commands across/.exec(part12) ?? [])[1] ?? '353';

const facts = [
  // The cover's version div: matched whole, so the chapter count is always the
  // count we just computed rather than a value frozen by an earlier run.
  [/<div class="version">[^<]*<\/div>/g,
   `<div class="version">Version 3.5.0 · October 2026 · ${chapterCount} Chapters + 4 Appendices · ${cliCommandCount} CLI Commands</div>`],
  // Counts corrected against the live tree (2026-10-13):
  //   23 providers (src/inference/provider-catalog.ts) · 21 registered agent types
  //   (src/agents/module-registry.ts) · 22 gateway platforms
  //   (src/gateway/channel-directory.ts) · 30 dashboard destinations, 98 API
  //   endpoints (src/web-dashboard/src/nav.ts, server.ts) · 9 MCP catalog
  //   capabilities (src/mcp/catalog.ts).
  [/\b22 providers\b/g, '23 providers'],
  [/\b10 messaging channels\b/g, '22 messaging platforms'],
  [/\b22-page web dashboard\b/g, '30-destination web dashboard'],
  [/\b22-page dashboard\b/g, '30-destination dashboard'],
  [/\b61 API endpoints\b/g, '98 API endpoints'],
  // Counts that had drifted from the tree (verified 2026-09-23):
  //   1,575 source .ts/.tsx files · 364 test files · 21 agent modules ·
  //   22 providers · 10 gateway channels.
  [/915 TypeScript files/g, '1,000+ TypeScript files'],
  [/284 test files/g, '512 test files'],
  [/900\+ files/g, '1,000+ files'],
  [/900\+ source files/g, '1,000+ source files'],
  [/900\+ file TypeScript codebase/g, '1,000+ file TypeScript codebase'],
  // Most specific first: the parenthetical role/provider lists, then the bare counts.
  [/<strong>20\+ \(planner[^)]*\)<\/strong>/g,
   '<strong>21 specialist roles (Reasoner, Planner, Context Gatherer, Writer, Reviewer, Runner, Tester, Debugger, Git, Security, MCP, …)</strong>'],
  [/<strong>15\+ \(Groq[^)]*\)<\/strong>/g,
   '<strong>22 (Groq, Gemini, OpenAI, Anthropic, Ollama, Bedrock, OpenRouter, …)</strong>'],
  [/\b20\+ (?:specialized|different) agents/g, '21 specialist agents'],
  [/\b20\+ (?:more )?agents/g, '21 agents'],
  [/20\+ agent types/g, '21 specialist agent roles'],
  [/\b20\+/g, '21'],
  [/\b15\+/g, '22'],
  // The gateway's platform union holds 22 real platforms (`+ 'mock'` for tests),
  // so the prose and the numbers table both said 10 of 22.
  [/The gateway speaks <strong>10 channels<\/strong>: WhatsApp, Telegram, Discord, Slack, Email, Signal, IRC, Matrix, Teams and SMS\./g,
   'The gateway speaks <strong>22 channels</strong>: WhatsApp, Telegram, Discord, Slack, Email, Signal, IRC, Matrix, Teams, SMS, and twelve more — DingTalk, Feishu, WeCom, Mattermost, BlueBubbles, ntfy, Google Chat, Weixin, SimpleX, Home Assistant, webhook and WhatsApp Cloud.'],
  [/<td>10 channels<\/td>/g, '<td>22 channels</td>'],
  [/\b6\+ messaging platforms \([^)]*\)/g,
   '22 messaging platforms (Telegram, Discord, Slack, WhatsApp, Email, Signal, IRC, Matrix, Microsoft Teams, SMS, and more)'],
  // Chapter 45 introduced the same stale count in prose ("supports 10 messaging
  // platforms (…)"), which the rule above never matched.
  [/\b10 messaging platforms \([^)]*\)/g,
   '22 messaging platforms (Telegram, Discord, Slack, WhatsApp, Email, Signal, IRC, Matrix, Microsoft Teams, SMS, and more)'],
  // Tree-size counts, re-measured 2026-10-13 against `find src tests -name '*.ts' -o -name '*.tsx'`:
  //   667 source files under src/ (excluding src/agent-sdk/dist and node_modules)
  //   512 test files under tests/  ·  1,180 TypeScript files in src/ + tests/
  //   156 skills under .agents/skills/
  [/\(orchestrator \+ 20 agents\)/g, '(orchestrator + 21 agents)'],
  [/22 dashboard pages · 98 API endpoints/g, '30 dashboard destinations · 98 API endpoints'],
  [/Test suite \(284 files\)/g, 'Test suite (576 test files)'],
  // 155 skills, measured 2026-10-13: `.agents/skills/` holds 155 directories
  // that each carry a `SKILL.md`, plus the `index.json` manifest beside them.
  // An earlier pass counted the MANIFEST as a skill and wrote 156 — and the
  // filename it printed (`SKILLS.md`) does not exist at all.
  [/\(156 SKILLS?\.md files\)/g, '(155 skills, each a SKILL.md)'],
  [/\b156 SKILLS\b/g, '155 SKILLS'],
  [/\b156 skills\b/g, '155 skills'],
  [/\bover 900 source files\b/g, 'over 667 source files'],

  // ── re-measured 2026-10-13, against the same tree this book documents ──────
  //   576 test files anywhere (`*.test.ts`/`*.test.tsx`; 508 under tests/, 68
  //   co-located with the source) · 667 source files under src/ · 103 dashboard
  //   API routes (98 exact + 5 parameterised) · 353 CLI commands · 114 tools in
  //   the live registry · src/agents/orchestrator.ts is 4,469 lines ·
  //   src/web-dashboard/server.ts is 9,485 · src/agents holds 56 source files ·
  //   src/learning holds 115.
  [/\b512 test files\b/g, '576 test files'],
  [/\b98 API endpoints\b/g, '103 API endpoints'],
  [/\b288 commands\b/g, '353 commands'],
  [/\bover 660 source files\b/g, 'over 667 source files'],
  [/\b660 source files\b/g, '667 source files'],
  [/Central coordinator \(3500\+ lines\)/g, 'Central coordinator (4,469 lines)'],
  [/ORCHESTRATOR \(3500\+ lines\)/g, 'ORCHESTRATOR (4,469 lines)'],
  [/Orchestrator in Agent-Nuvira is 3500\+ lines/g, 'Orchestrator in Agent-Nuvira is 4,469 lines'],
  [/HTTP server \(6000\+ lines\)/g, 'HTTP server (9,485 lines)'],
  [/Multi-agent system \(487 files\)/g, 'Multi-agent system (56 files)'],
  [/self-improvement \(53 files\)/g, 'self-improvement (115 files)'],
  [/self-improvement \(50\+ files\)/g, 'self-improvement (115 files)'],
  [/Tool implementations \(50\+ tools\)/g, 'Tool implementations (114 tools)'],
  [/The hands — 50\+ tools for files/g, 'The hands — 114 tools for files'],
  [/\b915 TypeScript files\b/g, '1,180 TypeScript files'],
  [/\b915 files\b/g, '667 source files'],
  // Counts an earlier correction pass wrote into the document ("1,000+",
  // "364 test files") — re-measured so the book stops repeating them.
  [/\.364 test files\b/g, '576 test files'],
  [/\b364 test files\b/g, '576 test files'],
  [/\b900\+ file codebase\b/g, '667-file codebase'],
  [/\b1,000\+ TypeScript files\b/g, '667 source files'],
  [/\b1,000\+ source files\b/g, '660+ source files'],
  [/\b1,000\+ file TypeScript codebase\b/g, '1,180-file TypeScript codebase'],
];
let corrected = 0;
for (const [re, to] of facts) {
  const hits = (html.match(re) ?? []).length;
  if (!hits) continue;
  const next = html.replace(re, to);
  if (next === html) continue; // already correct — count only real changes
  corrected += hits;
  html = next;
}
note(corrected ? `• corrected ${corrected} stale fact(s) in the cover and Chapter 1` : '• factual corrections already applied');

// ── 8. styles for the generated command surface ──────────────────────────────
if (!html.includes('BOOK:CMD-CSS')) {
  html = html.replace(
    '</style>',
    `  /* BOOK:CMD-CSS — styles for the generated command surface (Chapter 68) */
  ul.cmd-surface { list-style: none; margin: 10px 0 20px; padding: 0; }
  ul.cmd-surface li { padding: 5px 0 5px 14px; border-left: 2px solid var(--border); margin-bottom: 4px; font-size: 14px; }
  ul.cmd-surface li code { background: var(--code-bg); padding: 1px 5px; border-radius: 3px; font-size: 13px; }
  .cmd-flags { color: #888; font-size: 12px; font-family: monospace; }
</style>`,
  );
  note('• added styles for the generated command surface');
}

// ── 9. write ─────────────────────────────────────────────────────────────────
if (DRY) {
  note(`\n(dry run — nothing written; ${sizeBefore.toLocaleString()} → ${html.length.toLocaleString()} bytes)`);
} else {
  writeFileSync(BOOK, html, 'utf-8');
  note(`\n✓ wrote ${BOOK}\n  ${sizeBefore.toLocaleString()} → ${html.length.toLocaleString()} bytes`);
}

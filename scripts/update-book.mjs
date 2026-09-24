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
 *      the live CLI) and Part XIII (advantages, hand-written) are added.
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
  const tag = stamp.replace(/-/g, '');
  const has = existsSync(ARCHIVE) && readdirSync(ARCHIVE).some((f) => f.includes(tag));
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

const partHeading = (num, title, sub) => `
<h1 style="text-align:center; margin-top:60px; color:var(--highlight);">Part ${num}</h1>
<h2 style="text-align:center; border:none; color:var(--primary);">${title}</h2>
<p style="text-align:center; color:#666;">${sub}</p>
`;

const insertBlock =
  START +
  partHeading('XII', 'Command Reference &amp; Dashboard', 'Chapters 68–69 · Generated from the live CLI and the dashboard source') +
  part12 +
  partHeading('XIII', 'Why Agent-Nuvira — Capabilities &amp; Advantages', 'Chapter 70 · What it does better, what it costs, and how to verify it') +
  part13 +
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
  note('• inserted Part XII (command reference + dashboard) and Part XIII (advantages) before the appendices');
  if (wasMidBook) note('• moved Appendices A–D out of the middle of the book, to after the final chapter');
}

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
  { num: 'V', title: 'Router Deep Dive', from: 36, to: 40 },
  { num: 'VI', title: 'Dashboard & Gateway', from: 41, to: 43 },
  { num: 'VII', title: 'Tools, Skills & Gateway', from: 44, to: 48 },
  { num: 'VIII', title: 'Testing & Production', from: 49, to: 53 },
  { num: 'IX', title: 'Memory & Learning', from: 54, to: 58 },
  { num: 'X', title: 'NLU & Intent', from: 59, to: 61 },
  { num: 'XI', title: 'Production & Enterprise', from: 62, to: 67 },
  { num: 'XII', title: 'Command Reference & Dashboard', from: 68, to: 69 },
  { num: 'XIII', title: 'Why Agent-Nuvira', from: 70, to: 70 },
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
const facts = [
  // The cover's version div: matched whole, so the chapter count is always the
  // count we just computed rather than a value frozen by an earlier run.
  [/<div class="version">[^<]*<\/div>/g,
   `<div class="version">Version 3.3.0 · September 2026 · ${chapterCount} Chapters + 4 Appendices · 288 CLI Commands</div>`],
  // Counts that had drifted from the tree (verified 2026-09-23):
  //   1,575 source .ts/.tsx files · 364 test files · 21 agent modules ·
  //   22 providers · 10 gateway channels.
  [/915 TypeScript files/g, '1,000+ TypeScript files'],
  [/284 test files/g, '364 test files'],
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
  [/\b6\+ messaging platforms \([^)]*\)/g,
   '10 messaging platforms (WhatsApp, Telegram, Discord, Slack, Email, Signal, IRC, Matrix, Teams, SMS)'],
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

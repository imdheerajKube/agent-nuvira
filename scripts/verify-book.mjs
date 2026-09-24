#!/usr/bin/env node
/**
 * Structural verification of the assembled book.
 *
 *   node scripts/verify-book.mjs
 *
 * Exits non-zero on any real defect. Because the book is not in version control
 * (`.gitignore` ignores `book/`), this script is the safety net: it re-derives the
 * invariants that `scripts/update-book.mjs` is supposed to hold, so a later edit
 * cannot quietly break navigation again.
 *
 * Checks:
 *   1. no duplicate `id` attributes anywhere in the document
 *   2. every table-of-contents href resolves to a real element
 *   3. every TOC label matches the title of the element it points at
 *      (this is what was broken: the sidebar advertised chapters that did not
 *      exist and pointed others at the wrong chapter)
 *   4. live chapter numbers are unique and strictly increasing in reading order
 *   5. the appendices sit after the last chapter, not in the middle
 *   6. the generated Part XII is in sync with the live CLI
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const BOOK = join(repoRoot, 'book', 'agent-nuvira-complete-guide.html');

const html = readFileSync(BOOK, 'utf-8');
const failures = [];
const passes = [];
const ok = (msg) => passes.push(msg);
const fail = (msg) => failures.push(msg);

const norm = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, '')
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();

// ── 1. duplicate ids ─────────────────────────────────────────────────────────
{
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  dupes.length ? fail(`duplicate id attribute(s): ${dupes.join(', ')}`) : ok(`no duplicate ids (${ids.length} ids checked)`);
}

// ── 2 & 3. TOC resolution and label↔target agreement ─────────────────────────
const navStart = html.indexOf('<nav class="sidebar">');
const tocStart = html.indexOf('<div class="part-title">', navStart);
const tocEnd = html.indexOf('<div class="part-title">Appendices</div>', navStart);
if (navStart === -1 || tocStart === -1 || tocEnd === -1) {
  fail('could not locate the sidebar chapter list');
} else {
  const toc = html.slice(tocStart, tocEnd);
  const entries = [...toc.matchAll(/<a href="#([^"]+)">\s*<span class="ch-num">[^<]*<\/span>\s*([^<]+)<\/a>/g)];
  let unresolved = 0;
  let mismatched = 0;
  for (const [, id, label] of entries) {
    const at = html.indexOf(`id="${id}"`);
    if (at === -1) {
      unresolved++;
      continue;
    }
    // the chapter title is the first <h2> after the anchor's element
    const window = html.slice(at, at + 1500);
    const title = (/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(window) ?? [])[1];
    if (title && norm(title) !== norm(label) && !norm(title).endsWith(norm(label))) {
      mismatched++;
      if (mismatched <= 5) fail(`TOC label does not match its target: "${label}" → "${title.replace(/<[^>]*>/g, '').trim()}"`);
    }
  }
  unresolved ? fail(`${unresolved} TOC link(s) point at an element that does not exist`) : ok(`all ${entries.length} TOC links resolve`);
  mismatched ? fail(`${mismatched} TOC label(s) disagree with the chapter they point at`) : ok('every TOC label matches the chapter it points at');
}

// ── 4. live chapter numbers unique and increasing ────────────────────────────
{
  const chapters = [];
  for (const m of html.matchAll(/<div class="chapter" id="(ch\d+)">/g)) {
    chapters.push({ id: m[1], num: Number(m[1].slice(2)), at: m.index });
  }
  const nums = chapters.map((c) => c.num);
  const dupes = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  dupes.length ? fail(`two live chapters share a number: ${dupes.join(', ')}`) : ok(`${chapters.length} live chapters have unique numbers`);
  let outOfOrder = 0;
  for (let i = 1; i < chapters.length; i++) if (chapters[i].num < chapters[i - 1].num) outOfOrder++;
  outOfOrder ? fail(`${outOfOrder} chapter(s) appear out of numerical order`) : ok('chapters appear in strictly increasing numerical order');
}

// ── 5. appendices after the last chapter ─────────────────────────────────────
{
  const lastChapter = Math.max(...[...html.matchAll(/<div class="chapter" id="ch(\d+)">/g)].map((m) => m.index));
  const appA = html.indexOf('<div class="chapter" id="appendixA">');
  if (appA === -1) fail('Appendix A is missing');
  else if (appA < lastChapter) fail('the appendices still sit before the final chapter');
  else ok('the appendices come after the final chapter');
}

// ── 6. generated part is in sync with the live CLI ───────────────────────────
{
  try {
    execFileSync('node', [join(repoRoot, 'scripts', 'generate-book-chapters.mjs'), '--check'], { stdio: 'pipe' });
    ok('the generated command reference is in sync with the live CLI');
  } catch {
    fail('the generated command reference is stale — run: node scripts/generate-book-chapters.mjs');
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`Book: ${BOOK}`);
console.log(`Size: ${html.length.toLocaleString()} bytes\n`);
for (const p of passes) console.log(`  ✓ ${p}`);
for (const f of failures) console.log(`  ✗ ${f}`);
console.log(failures.length ? `\n✗ ${failures.length} problem(s) found.` : '\n✓ book structure is sound.');
process.exit(failures.length ? 1 : 0);

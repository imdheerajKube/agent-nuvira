/**
 * Doc-citation guard (`scripts/check-doc-citations.mjs`).
 *
 * Source files cite design/tracker docs by name — `@see AGENT_NUVIRA_MAJOR_REVAMP_PLAN.md`,
 * `see ENTERPRISE_GRADE_TRACKER.md §G16`, `TOOL_TRUTHFULNESS_TRACKER.md`. That
 * citation is only worth anything if the cited file exists for the reader. Four
 * times now it has not: `TOOL_TRUTHFULNESS_TRACKER.md` plus three docs cited from
 * `src/enterprise/*` were all ignored by `*.md`, so they existed on the
 * developer's machine and nowhere else and every fresh clone's comments pointed at
 * nothing. All four are published now (see the whitelist in `.gitignore`); this
 * guard is what keeps the next one from going unnoticed.
 *
 * Every SCREAMING_SNAKE `*.md` citation in code must resolve to a file that exists
 * AND is not ignored by git. The convention is narrowed to SCREAMING_SNAKE on
 * purpose — a bare `\.md` regex matches the hundreds of fixture filenames the
 * suites write (`story.md`, `x.md`, `01-chapter-1.md`), which are not citations of
 * anything.
 *
 * Two explicit acknowledgement lists keep it honest rather than quiet:
 *   - `NOT_A_DOC_CITATION` — names the code *produces* (an artifact it writes),
 *     not a document it references. Without this they read as dangling citations.
 *   - `ACKNOWLEDGED_LOCAL_ONLY` — a cited doc that is deliberately not published.
 *     Listing it here is a decision someone can review, not an oversight the guard
 *     can only report. Publishing one means adding it to `.gitignore`'s whitelist
 *     and removing it from this list.
 *
 * Both lists are injectable via `findCitationProblems`' third argument so the
 * tests exercise the mechanism even when (as now) the real lists are empty.
 *
 * Usage: `node scripts/check-doc-citations.mjs [--check]` → exit 0 in sync, 1 on
 * any unacknowledged problem. The logic is exported so `tests/docs/doc-citations.test.ts`
 * can exercise the detector directly, the same split as
 * `generate-commands-surface.mjs` + its drift-guard test.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** SCREAMING_SNAKE `*.md` — the repo's tracker/plan/design-doc convention. */
export const CITATION_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\.md\b/g;

/** Names the code WRITES, not documents it references. */
export const NOT_A_DOC_CITATION = new Map([
  [
    'CODE_ASSESSMENT.md',
    'the artifact the `code-assessment` skill has the agent produce (see src/learning/skill-types.ts)',
  ],
  [
    'RELEASE_NOTES.md',
    'the notes file `github-release-agent` writes into the working directory (src/agents/agents/github-release-agent.ts)',
  ],
]);

/**
 * Cited by code, deliberately not published. Each entry is a decision, not a
 * silence: the citation dangles on a fresh clone until someone publishes the doc
 * (`.gitignore` whitelist) or drops the citation.
 *
 * EMPTY (2026-09-28) — the three docs that used to be listed here
 * (`AGENT_NUVIRA_MAJOR_REVAMP_PLAN.md`, `ENTERPRISE_GRADE_TRACKER.md`,
 * `NUVIRA_ROUTER_ROADMAP.md`) are now published and whitelisted, so they pass on
 * merit. The mechanism stays because the next one is a decision, not a bug.
 */
export const ACKNOWLEDGED_LOCAL_ONLY = new Map([]);

const SCAN_DIRS = ['src', 'tests', 'scripts'];
const SCAN_EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.nuvira',
  'public',
  'book',
]);

/** Every unique citation in one file's text, in source order. */
export function collectCitations(text) {
  return [...new Set(text.match(CITATION_RE) ?? [])];
}

/**
 * Decide what is wrong with a set of citations.
 *
 * `resolveDoc(name)` returns `{ path } | { path, ignored: true } | null`, and the
 * two acknowledgement lists are overridable — both injectable so the detector is
 * testable without touching the real tree or the real lists.
 */
export function findCitationProblems(citations, resolveDoc, options = {}) {
  const artifacts = options.notADocCitation ?? NOT_A_DOC_CITATION;
  const localOnly = options.acknowledgedLocalOnly ?? ACKNOWLEDGED_LOCAL_ONLY;
  const problems = [];
  for (const name of citations) {
    if (artifacts.has(name)) continue;
    const found = resolveDoc(name);
    if (!found) {
      problems.push({ kind: 'missing', name, detail: 'no such file anywhere in the repo' });
    } else if (found.ignored && !localOnly.has(name)) {
      problems.push({
        kind: 'ignored',
        name,
        detail: `${found.path} exists but is ignored by git, so a fresh clone cannot see it`,
      });
    }
  }
  return problems;
}

/** Walk the scan roots, returning every code file path (absolute). */
function codeFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (SCAN_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        out.push(join(dir, entry.name));
      }
    }
  };
  for (const dir of SCAN_DIRS) {
    const full = join(root, dir);
    if (existsSync(full)) visit(full);
  }
  return out;
}

/** Every tracked-or-present `.md` basename in the repo → its relative path. */
function indexMarkdown(root) {
  const index = new Map();
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (entry.name.endsWith('.md')) {
        if (!index.has(entry.name)) index.set(entry.name, []);
        index.get(entry.name).push(join(dir, entry.name).slice(root.length + 1));
      }
    }
  };
  visit(root);
  return index;
}

/** `git check-ignore` in-process: exit 0 = ignored. */
function isIgnored(root, relPath) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', relPath], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function check(root = resolve(import.meta.dirname, '..')) {
  const index = indexMarkdown(root);
  const citations = new Map(); // name → Set of citing files
  for (const file of codeFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const name of collectCitations(text)) {
      if (!citations.has(name)) citations.set(name, new Set());
      citations.get(name).add(file.slice(root.length + 1));
    }
  }

  const resolveDoc = (name) => {
    const paths = index.get(name);
    if (!paths || paths.length === 0) return null;
    const path = paths[0];
    return { path, ignored: isIgnored(root, path) };
  };

  const problems = findCitationProblems([...citations.keys()], resolveDoc);
  return { citations, problems, resolver: resolveDoc };
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const { citations, problems, resolver } = check(root);

  const acknowledged = [...citations.keys()].filter(
    (name) => resolver(name)?.ignored && ACKNOWLEDGED_LOCAL_ONLY.has(name),
  );

  if (problems.length === 0) {
    console.log(
      `doc-citations: ${citations.size} cited doc(s) checked — all exist and are tracked` +
        (acknowledged.length ? ` (${acknowledged.length} acknowledged local-only)` : ''),
    );
    for (const name of acknowledged) console.log(`  · local-only: ${name}`);
    return 0;
  }

  console.error(`doc-citations: ${problems.length} broken citation(s):`);
  for (const p of problems) {
    console.error(`  ✗ [${p.kind}] ${p.name} — ${p.detail}`);
    const citers = [...(citations.get(p.name) ?? [])];
    if (citers.length) console.error(`      cited from: ${citers.join(', ')}`);
  }
  console.error(
    '\nFix: ship the cited doc and whitelist it in .gitignore, drop the citation,\n' +
      'or (if the name is an artifact the code WRITES) add it to NOT_A_DOC_CITATION in\n' +
      'scripts/check-doc-citations.mjs with the reason.',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

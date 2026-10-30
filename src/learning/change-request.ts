/**
 * CHANGE REQUESTS — a requirement change that arrives while the turn is still running.
 *
 * WHY THIS EXISTS (measured 2026-10-26). A long autonomous turn has no second user
 * message: `nuvira chat "<ask>"` is one shot, and once it starts, a 30-minute build
 * cannot be interrupted with "actually, teams instead of projects". Real work does
 * not behave like that — the requirement changes mid-flight, and the agent that
 * cannot hear it delivers the wrong product with a clean transcript. The benchmark's
 * adaptability aspect (10 % of its rubric) had no way to be exercised at all, and
 * `scripts/bench/platform/inject-events.mjs` has been writing `CHANGE_REQUEST.md`
 * into the workspace since 2026-10-25 on the bet that the agent re-reads its root at
 * a milestone. Measured: none of the three agents mentioned it.
 *
 * WHAT THIS IS. The file the harness already writes becomes a channel:
 *
 *   - the loop looks for `CHANGE_REQUEST.md` at every step (one `statSync`), and a
 *     NEW one (changed content) is delivered to the model ONCE as a harness
 *     directive, the moment it appears — not at the ceiling, where there is no
 *     budget left to act on it;
 *   - at the end of the turn, a change request whose substance is nowhere in the
 *     tree is reported as outstanding, with the bullets that are missing.
 *
 * WHY A FILENAME AND NOT A DIRECTORY WATCH. Any new file could be a scratch output
 * of the turn's own commands, and turning those into instructions would be a
 * self-feeding loop. `CHANGE_REQUEST.md` is a name only a human (or the harness)
 * writes, which is what makes it safe to treat as a user message.
 *
 * THE SUBSTANCE CHECK IS WEAK ON PURPOSE. It cannot tell whether "teams instead of
 * projects" was implemented WELL; it can tell whether the request's distinctive
 * words appear anywhere in the tree the turn produced. A bullet whose words appear
 * nowhere is the honest floor: not adapted, or adapted under a name nobody can find.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** The channel the benchmark harness and a user both write. */
export const CHANGE_REQUEST_FILE = 'CHANGE_REQUEST.md';

/**
 * Every name the request has been written under.
 *
 * WHY MORE THAN ONE (found 2026-10-27 while validating against the real benchmark
 * trees): the harness wrote `CHANGE_REQUESTS.md` — plural, one file accumulating several
 * events — and the reader only ever opened the singular name. A requirement delivered
 * under the name the loop does not read is indistinguishable from a requirement nobody
 * sent, which is the exact failure this module exists to end. The first match wins; the
 * singular name stays first because that is what `inject-events.mjs` writes.
 */
export const CHANGE_REQUEST_FILES = [CHANGE_REQUEST_FILE, 'CHANGE_REQUESTS.md', 'CHANGE_REQUEST.txt'] as const;

/** Above this the file is not a change request (and reading it is not cheap). */
const MAX_CHARS = 8000;

/** Bounded source read for the substance check. */
const MAX_FILES = 4000;
const MAX_BYTES_PER_FILE = 200_000;

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'playwright-report',
  'test-results',
]);

export interface ChangeRequest {
  /** Workspace-relative path. */
  path: string;
  /** The heading/title line, when the file has one. */
  title: string;
  /** The `- ` bullets, which is how every injected event is written. */
  bullets: string[];
  /** The whole text, trimmed and bounded. */
  text: string;
  /** Identity of this content — a new value means the requirement changed again. */
  signature: string;
}

/** Words that carry no substance and would mark any tree as "adapted". */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'their', 'rather',
  'than', 'every', 'each', 'must', 'should', 'would', 'could', 'will', 'have', 'has',
  'not', 'but', 'all', 'any', 'can', 'now', 'new', 'old', 'one', 'two', 'its', 'it',
  'update', 'keep', 'make', 'add', 'change', 'changed', 'record', 'state', 'does', 'did',
  'they', 'them', 'then', 'there', 'when', 'where', 'which', 'while', 'without', 'end',
  'and', 'the', 'of', 'to', 'in', 'on', 'is', 'are', 'be', 'by', 'as', 'at', 'or', 'if',
  'instead', 'belongs', 'belong', 'every', 'rather', 'alongside', 'accordingly', 'away',
]);

function signatureOf(text: string): string {
  // Stable and dependency-free: length + a rolling 32-bit hash of the content.
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

/**
 * The current change request, or null. Cheap: one `stat` when the file is absent,
 * one bounded read when it is present.
 */
export function readChangeRequest(cwd: string): ChangeRequest | null {
  let found: { path: (typeof CHANGE_REQUEST_FILES)[number]; abs: string } | null = null;
  for (const name of CHANGE_REQUEST_FILES) {
    const abs = join(cwd, name);
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size > 0) {
        found = { path: name, abs };
        break;
      }
    } catch {
      // Absent is the normal case for every name but one.
    }
  }
  if (!found) return null;
  let text = '';
  try {
    text = readFileSync(found.abs, 'utf-8').slice(0, MAX_CHARS);
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n');
  const title = (lines.find((l) => /^#{1,6}\s+/.test(l)) ?? lines[0] ?? '').replace(/^#{1,6}\s+/, '').trim();
  const bullets = lines.map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l)).map((l) => l.replace(/^[-*]\s+/, ''));
  return { path: found.path, title, bullets, text: trimmed, signature: signatureOf(trimmed) };
}

/** The directive the model reads mid-turn: the change, and that it is a change. */
export function changeRequestNudge(req: ChangeRequest): string {
  return [
    `A CHANGE REQUEST arrived while you were working: \`${req.path}\`${req.title ? ` — ${req.title}` : ''}.`,
    '',
    req.text,
    '',
    'This is a USER requirement change, not a note to acknowledge: fold it into what you are building',
    'now — schema, code, tests and the documents you already wrote — so the delivered product is',
    'coherent under the new requirement rather than carrying both the old and the new design.',
  ].join('\n');
}

/** Distinctive words of a bullet: what a tree would have to mention to have heard it. */
export function distinctiveWords(text: string): string[] {
  const words = (text || '')
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    if (out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/** Concatenated text of the tree's own source, lowercased and bounded. */
function treeText(root: string): string {
  const parts: string[] = [];
  const stack: string[] = [root];
  let files = 0;
  while (stack.length && files < MAX_FILES) {
    const dir = stack.pop() as string;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (files >= MAX_FILES) break;
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile() || st.size > MAX_BYTES_PER_FILE) continue;
      // The REQUEST is not the implementation: reading it as evidence would make
      // every change request self-satisfying (it contains its own every word).
      if (/^change_requests?\.md$/i.test(name)) continue;
      if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|sql|prisma|md|py|go|rs|html|css|sh)$/i.test(name)) continue;
      try {
        parts.push(readFileSync(abs, 'utf-8').toLowerCase());
      } catch {
        continue;
      }
      files += 1;
    }
  }
  return parts.join('\n');
}

export interface ChangeRequestStatus {
  request: ChangeRequest;
  /** Bullets whose distinctive words appear nowhere in the tree. */
  unheard: string[];
  /** Bullets that are at least mentioned. */
  heard: number;
  signature: string;
}

/**
 * Which bullets the tree has not heard. The whole tree is read once, only when a
 * change request exists, and only at the end of the turn / at the ceiling.
 */
export function changeRequestStatus(input: { cwd: string; request: ChangeRequest; treeText?: string }): ChangeRequestStatus {
  const text = input.treeText ?? treeText(input.cwd);
  const haystack = text.toLowerCase();
  const unheard: string[] = [];
  let heard = 0;
  for (const bullet of input.request.bullets.length > 0 ? input.request.bullets : input.request.text.split('\n')) {
    const words = distinctiveWords(bullet);
    if (words.length === 0) continue;
    // A bullet is heard when a QUARTER of its distinctive words appear (the rest are
    // prose glue): "users now need TEAMS instead of Projects" needs `teams` and
    // `projects` to exist, which is exactly the evidence a reviewer would look for.
    const need = Math.max(1, Math.ceil(words.length / 4));
    const found = words.filter((w) => haystack.includes(w)).length;
    if (found >= need) heard += 1;
    else unheard.push(bullet);
  }
  return { request: input.request, unheard, heard, signature: input.request.signature };
}

/** The end-of-turn message: the request, and exactly which parts are missing. */
export function changeRequestUnheardNudge(status: ChangeRequestStatus): string {
  const lines = status.unheard.slice(0, 4).map((b) => `  - ${b}`);
  return [
    `\`${status.request.path}\` changed while you were building, and the tree does not reflect these parts of it:`,
    ...lines,
    status.unheard.length > 4 ? `  …and ${status.unheard.length - 4} more.` : '',
    'Implement the change now (schema, code, tests, and the documents you wrote), or state in the answer',
    'that it is not implemented. Delivering the pre-change design while the change request sits in the',
    'workspace is the one outcome that is definitely wrong.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Workspace-relative posix path helper (kept local; used by callers that report). */
export function relPosix(root: string, abs: string): string {
  return abs.slice(root.length + 1).split(sep).join('/');
}

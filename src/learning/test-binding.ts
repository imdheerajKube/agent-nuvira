/**
 * Test binding — do the modules this turn WROTE have a test that names them?
 *
 * WHY THIS EXISTS (measured 2026-10-25). agent-nuvira shipped a working app with
 * 22 route handlers, seven domain modules and TWO test files, and every
 * verification gate the loop owned was satisfied: `npx tsc --noEmit` passed,
 * `next build` passed, and a tester sub-agent reported "4/4 tests passed". All
 * three are true and none of them is the question, which is: for the surfaces
 * that did not exist before this turn, is there a test that exercises THIS one?
 * Cline produced 20 test files on the same prompt; the difference was not skill,
 * it was that nothing asked.
 *
 * So this module answers that question from the filesystem, cheaply and without
 * a model:
 *
 *   written modules (this turn) − modules any test file imports = UNBOUND
 *
 * The result is a NAMED gap ("`src/modules/documents/service.ts` is new and no
 * test imports it"), which is the only kind of objection the loop is allowed to
 * raise — see the same rule in `requirement-ledger.ts` and `task-artifacts.ts`.
 *
 * WHAT IT DOES NOT DO. It never asserts a module is untested when a test reaches
 * it indirectly through an alias it cannot resolve: an unresolved specifier is
 * matched by path suffix and basename, and a module it cannot classify is simply
 * not counted. A false "unbound" costs one line in one bounded nudge, but a
 * false "bound" would let the gap back in, so the matching errs toward binding.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  'out',
]);

/** Extensions treated as behaviour-bearing source. */
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.php', '.java', '.kt']);

/** Files that are configuration, types or documentation — never "a surface". */
const NON_SURFACE = /(?:\.d\.ts|\.config\.[cm]?[jt]s|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|\.stories\.[cm]?[jt]sx?|\.mdx?|\.json|\.ya?ml|\.css|\.scss)$/i;

/** Path fragments that are not application surfaces. */
const NON_SURFACE_PATH = /(?:^|\/)(?:tests?|__tests__|e2e|__mocks__|mocks|fixtures|scripts|migrations|seed|generated)(?:\/|$)/i;

/** A test file, by the conventions every runner shares. */
const TEST_FILE =
  /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|test_[^/]*\.py|[^/]*_test\.py|[^/]*_test\.go)$|(?:^|\/)(?:tests?|__tests__|e2e)\/[^/]+\.(?:[cm]?[jt]sx?|py|go|rs)$/i;

/** Modules smaller than this are not "a surface" (a re-export barrel, a const). */
const MIN_SOURCE_CHARS = 40;

/** Bounded walk: a binding check must never become the most expensive thing in a turn. */
const WALK_MAX_FILES = 6000;
const WALK_MAX_DEPTH = 6;
const READ_MAX_CHARS = 60_000;

export interface BindingReport {
  /** Source modules this turn wrote that export something. */
  written: string[];
  /** Of those, the ones some test file imports. */
  bound: string[];
  /** Of those, the ones no test file imports — the named gap. */
  unbound: string[];
  /** How many test files the scan found. */
  testFiles: number;
  /** bound / written, or null when the turn wrote no source module. */
  ratio: number | null;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < WALK_MAX_FILES) {
    const { dir, depth } = stack.pop()!;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (IGNORED_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth + 1 <= WALK_MAX_DEPTH) stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      out.push(abs);
      if (out.length >= WALK_MAX_FILES) break;
    }
  }
  return out;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function readBounded(file: string, max = READ_MAX_CHARS): string {
  try {
    return readFileSync(file, 'utf-8').slice(0, max);
  } catch {
    return '';
  }
}

/** Does this file contain an export (or a Python/Go equivalent)? */
function exportsSomething(content: string, ext: string): boolean {
  if (content.length < MIN_SOURCE_CHARS) return false;
  if (ext === '.py' || ext === '.rb') return /^(?:def |class )/m.test(content);
  if (ext === '.go') return /^func /m.test(content);
  if (ext === '.rs') return /^pub (?:fn|struct|enum|trait|mod)/m.test(content);
  if (ext === '.php') return /\bfunction\s+\w+/i.test(content);
  return /(?:^|\n)\s*export\b/.test(content);
}

/** Is a written path a behaviour-bearing source module? */
export function isSourceModule(path: string, cwd?: string): boolean {
  const rel = cwd ? posix(relative(cwd, resolve(cwd, path))) : posix(path);
  const ext = extname(rel).toLowerCase();
  if (!SOURCE_EXT.has(ext)) return false;
  if (NON_SURFACE.test(rel)) return false;
  if (NON_SURFACE_PATH.test(rel)) return false;
  return true;
}

/** Strip an extension and a trailing `/index` — the path a specifier tends to use. */
function moduleKey(relPath: string): string {
  const ext = extname(relPath);
  let key = ext ? relPath.slice(0, -ext.length) : relPath;
  key = key.replace(/\.d$/, '');
  if (key.endsWith('/index')) key = key.slice(0, -'/index'.length);
  return key.replace(/^\.\//, '');
}

/** Every import-ish specifier in a test file. */
function specifiersOf(content: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bvi\.mock\s*\(|\bjest\.mock\s*\()\s*['"`]([^'"`\n]+)['"`]/g,
    /\bimport\s+['"`]([^'"`\n]+)['"`]/g,
    /^\s*from\s+([\w.]+)\s+import\b/gm, // python
  ];
  for (const re of patterns) {
    for (const match of content.matchAll(re)) {
      const spec = match[1]?.trim();
      if (spec) out.push(spec);
    }
  }
  return out;
}

/**
 * Does `spec` (an import specifier written in `fromFile`) resolve to `moduleAbs`?
 *
 * Three tiers, most precise first:
 *  1. a RELATIVE specifier, resolved against the importing file;
 *  2. an alias/absolute specifier (`@/…`, `~/…`, `src/…`) matched by path suffix;
 *  3. a bare specifier that still carries a directory (`modules/documents/service`).
 *
 * A single-segment bare word (`./service` aside) is never enough on its own — that
 * is how `import { thing } from 'service'` would bind an unrelated module.
 */
function resolvesTo(spec: string, fromFile: string, moduleAbs: string, moduleKeyPath: string): boolean {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(fromFile), spec);
    const candidates = [base, ...SOURCE_EXT_ORDER.map((e) => `${base}${e}`), ...SOURCE_EXT_ORDER.map((e) => join(base, `index${e}`))];
    return candidates.some((c) => c === moduleAbs);
  }
  const normalized = spec.replace(/\\/g, '/');
  // Alias or root-relative: compare the SUFFIX, so `@/modules/x/service` binds
  // `src/modules/x/service.ts` without this module knowing the alias table.
  if (normalized.startsWith('@/') || normalized.startsWith('~/') || normalized.startsWith('/') || normalized.startsWith('#')) {
    const stripped = normalized.replace(/^[@~#]\/?/, '').replace(/^\//, '');
    const key = moduleKey(stripped);
    return moduleKeyPath === key || moduleKeyPath.endsWith(`/${key}`) || key.endsWith(`/${moduleKeyPath}`);
  }
  // Root-relative without an alias (`src/modules/x/service`).
  const key = moduleKey(normalized);
  if (key.includes('/')) {
    if (moduleKeyPath === key || moduleKeyPath.endsWith(`/${key}`)) return true;
  }
  // Bare package name: only a path-based match can bind it, never a guess.
  return false;
}

const SOURCE_EXT_ORDER = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.php', '.java', '.kt'];

/**
 * Which of the modules this turn wrote is imported by a test file.
 *
 * `writtenPaths` is the turn's own mutation ledger (relative or absolute); a test
 * file that does not exist yet cannot bind anything, which is exactly the gap.
 */
export function bindWrittenModulesToTests(input: {
  cwd: string;
  writtenPaths: readonly string[];
  /** Extra specifier text to treat as a binding (e.g. a test a sub-agent wrote). */
  maxFiles?: number;
}): BindingReport {
  const cwd = input.cwd;
  const seen = new Set<string>();
  const written: string[] = [];
  for (const raw of input.writtenPaths) {
    if (!raw) continue;
    const abs = resolve(cwd, raw);
    if (!existsSync(abs)) continue;
    if (!isSourceModule(abs, cwd)) continue;
    const content = readBounded(abs, 20_000);
    if (!exportsSomething(content, extname(abs).toLowerCase())) continue;
    const rel = posix(relative(cwd, abs));
    if (seen.has(rel)) continue;
    seen.add(rel);
    written.push(rel);
  }
  if (written.length === 0) {
    return { written: [], bound: [], unbound: [], testFiles: 0, ratio: null };
  }

  const files = walk(cwd);
  const testFiles = files.filter((f) => TEST_FILE.test(posix(relative(cwd, f))));
  // One pass over the tests: keep (file, specifier) pairs only for tests.
  const specs: Array<{ file: string; spec: string }> = [];
  for (const file of testFiles) {
    for (const spec of specifiersOf(readBounded(file))) specs.push({ file, spec });
  }

  const bound: string[] = [];
  const unbound: string[] = [];
  for (const rel of written) {
    const abs = resolve(cwd, rel);
    const keyPath = moduleKey(rel);
    const hit = specs.some(({ file, spec }) => resolvesTo(spec, file, abs, keyPath));
    (hit ? bound : unbound).push(rel);
  }

  return {
    written,
    bound,
    unbound,
    testFiles: testFiles.length,
    ratio: written.length > 0 ? bound.length / written.length : null,
  };
}

/**
 * Should this turn be asked to bind tests at all?
 *
 * Narrow on purpose: a greenfield build (or a turn that wrote several new
 * modules) is where unbound surfaces are a real gap; a one-line edit in a mature
 * repo is not, and asking there would be the nag that makes every other gate
 * ignorable. Two modules is the floor because a single new module is often a
 * helper whose test legitimately rides on its caller's.
 */
export function testBindingApplies(input: { buildShapedAsk: boolean; moduleCount: number }): boolean {
  return input.buildShapedAsk && input.moduleCount >= 2;
}

/** The nudge: the cheapest unbound modules, named, with the rule that makes it stick. */
export function unboundModulesNudge(unbound: readonly string[], total: number): string {
  const shown = unbound.slice(0, 3);
  const lines = shown.map((m) => `  - \`${m}\` is new and no test file imports it`);
  const more = unbound.length > shown.length ? `\n  …and ${unbound.length - shown.length} more.` : '';
  const covered = Math.max(0, total - unbound.length);
  return [
    `Before this turn ends: ${covered}/${total} of the modules it wrote have a test that imports them.`,
    ...lines,
    more,
    'Add a test for the cheapest of these that FAILS if the module is broken (not a smoke test that asserts nothing), and RUN it.',
    'A build with tests only for its trivial helpers is not tested; the surfaces that carry the behaviour are the ones that matter.',
  ]
    .filter(Boolean)
    .join('\n');
}

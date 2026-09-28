#!/usr/bin/env node
/**
 * Is the COMMITTED dashboard bundle the one the source actually builds?
 *
 * WHY THIS EXISTS. `src/web-dashboard/public/` is a build artifact that is
 * committed, because the dashboard server serves it directly (server.ts resolves
 * PUBLIC_DIR to `<repo>/src/web-dashboard/public`) and an install from npm has no
 * vite. That makes it a hand-maintained copy of generated output, and generated
 * output drifts: the Subagents tab was written, tested, committed and reviewed —
 * and the shipped bundle had `grep -c Subagents` = **0**, because it had been
 * built several commits earlier. Nothing caught it. The component suite runs the
 * SOURCE through vitest, so it passes either way; the typecheck sees types; the
 * build is only run when someone remembers to run it.
 *
 * TWO MODES, because the two halves of the problem need different evidence:
 *
 *   default     Git-history freshness — no build, no dependencies. The newest
 *               commit touching the bundle's INPUTS must not be newer than the
 *               newest commit touching its OUTPUTS. Cheap enough to run as a
 *               test, and it catches the drift above (source in commit N,
 *               bundle last built at N-3).
 *
 *   --rebuild   Builds with the dashboard's own toolchain and compares the output
 *               against the committed files, byte for byte — except that a
 *               sourcemap's dependency PATHS are excluded, because those record
 *               where the package manager put them rather than what was built (see
 *               normaliseOutput). This is the complete check: it also catches a
 *               stale bundle committed alongside a source change in the SAME
 *               commit, which history cannot order. Needs the dashboard tree
 *               installed.
 *
 *               The build goes to a SCRATCH dir beside `public/` rather than the
 *               configured outDir, so it cannot clobber uncommitted bundle work;
 *               the scratch dir is removed afterwards either way. It has to be
 *               inside the dashboard tree at the same depth as `public/`, and
 *               that is not cosmetic: MEASURED, a build into /tmp produces a
 *               byte-different sourcemap, because `sources` is recorded relative
 *               to the OUTPUT file's directory (`../../src/…` from a sibling of
 *               the source tree, an absolute-looking escape from /tmp). At the
 *               same depth every emitted file matches, sourcemap included.
 *
 * Exit codes: 0 in sync · 1 stale (the failure this exists to produce) ·
 * 2 could not judge (not a git repo, or too little history to order).
 *
 * Usage:
 *   node scripts/check-dashboard-bundle.mjs             # history check
 *   node scripts/check-dashboard-bundle.mjs --rebuild    # byte comparison
 *   node scripts/check-dashboard-bundle.mjs --json
 *   node scripts/check-dashboard-bundle.mjs --root <dir> # check another checkout
 */

import { existsSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

/** The dashboard package root, relative to the repo root. */
export const DASHBOARD_DIR = 'src/web-dashboard';

/** Where vite writes the served bundle. */
export const BUNDLE_OUTPUT_DIR = `${DASHBOARD_DIR}/public`;

/**
 * Inputs that need no discovery: the build's own config. The vite config,
 * tsconfig and package.json all change what the bundle IS (aliases, targets,
 * dependency versions), so a change to any of them can make the committed
 * bundle wrong.
 *
 * FILES ONLY — never a directory. A directory pathspec sweeps in everything
 * beneath it, including the test files excluded below, and `git rev-list` then
 * blames a test-only commit for an out-of-date bundle (measured: it named the
 * locale-assertion commit, which touched nothing under the dashboard but
 * `*.test.tsx`). `src/web-dashboard/src` is enumerated instead.
 */
const STATIC_INPUTS = [
  `${DASHBOARD_DIR}/index.html`,
  `${DASHBOARD_DIR}/vite.config.ts`,
  `${DASHBOARD_DIR}/tsconfig.json`,
  `${DASHBOARD_DIR}/package.json`,
  `${DASHBOARD_DIR}/package-lock.json`,
];

/** Source extensions the bundle is built from, for the import scan. */
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'];

/** Bundle files we never want to compare or commit. */
const BUNDLE_FILE_EXTS = ['.js', '.css', '.map', '.html'];

/**
 * Test files are NOT bundle inputs. Vite bundles only what the entry HTML
 * reaches, so an edited assertion cannot change the output — and the dashboard
 * tree holds 28 of them, which is enough for every test edit to look like a
 * stale bundle. MEASURED: src/web-dashboard/src holds 73 files, 28 of them tests;
 * the committed sourcemap lists 41 bundled modules.
 */
const TEST_FILE_RE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Is this a test file (never an input to the bundle)? */
export function isTestFile(file) {
  return TEST_FILE_RE.test(file);
}

// ─── Import scan: the inputs that live OUTSIDE the dashboard tree ───────────

/**
 * Relative import specifiers in a source file (`from '…'`, `import('…')`,
 * `require('…')`). Deliberately dependency-free and conservative: a specifier it
 * misses makes this guard narrower, never wrong, and the `--rebuild` mode does
 * not depend on the scan at all.
 */
export function extractSpecifiers(code) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

/**
 * Resolve a relative specifier to a file in the repo, or null when it does not
 * leave the dashboard tree (the interesting case is only the escapees).
 *
 * The dashboard reaches into the ROOT tree through small shims — `src/mask.ts`
 * re-exports `../../utils/mask.js`, `src/admin-auth.ts` imports
 * `../../config/paths.js` and `../../enterprise/rbac.js` — and those root files
 * are inputs to the bundle just as much as the dashboard's own source. They are
 * discovered rather than listed, because a hardcoded list silently misses the
 * next shim.
 */
export function resolveSpecifier(fromFile, spec, root) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(join(root, fromFile)), spec);
  const candidates = [
    base,
    // A `.js` specifier in a TypeScript tree means the `.ts` original (ESM's
    // explicit-extension rule, mirrored by scripts/fix-esm-extensions.mjs).
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    ...SOURCE_EXTS.map((ext) => base + ext),
    ...SOURCE_EXTS.map((ext) => join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(root, candidate).split(sep).join('/');
    }
  }
  return null;
}

/** Every file under `dir`, repo-relative, skipping node_modules. */
export function listSourceFiles(root, dir, { skipTests = false } = {}) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relPath = relative(root, full).split(sep).join('/');
      if (skipTests && isTestFile(relPath)) continue;
      out.push(relPath);
    }
  };
  walk(join(root, dir));
  return out;
}

/**
 * Every repo file the committed bundle was made from, read out of its own
 * sourcemap. Vite records every module it bundled, so this is authoritative —
 * no import parsing, and no guessing at which of the tree's files are reachable.
 *
 * MEASURED: the whole repo reach is 41 files — 39 under the dashboard tree plus
 * `src/utils/format.ts` and `src/utils/mask.ts`. Two things that a directory
 * walk would include are deliberately absent because the bundle does not contain
 * them: the 28 `*.test.tsx` files, and type-only modules such as
 * `src/web-dashboard/src/types.ts` (a comment-only edit there would otherwise
 * leave this check permanently red with no rebuild able to clear it, since a
 * rebuild would change no bytes). The flip side is accepted and covered by
 * `--rebuild`, which needs no input list at all.
 */
export function readBundledRepoSources(root = DEFAULT_ROOT) {
  const out = new Set();
  const assetsDir = join(root, BUNDLE_OUTPUT_DIR, 'assets');
  if (!existsSync(assetsDir)) return out;
  let entries;
  try {
    entries = readdirSync(assetsDir);
  } catch {
    return out;
  }
  for (const file of entries) {
    if (!file.endsWith('.js.map')) continue;
    let map;
    try {
      map = JSON.parse(readFileSync(join(assetsDir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(map?.sources)) continue;
    // Sources are relative to the MAP's own directory (MEASURED: the shims read
    // `../../../utils/format.ts` from `public/assets/`, not a path from the
    // dashboard root) — so resolve from beside the map, then keep whatever lands
    // outside the dashboard tree but inside the repo.
    const mapDir = dirname(join(assetsDir, file));
    for (const source of map.sources) {
      if (typeof source !== 'string' || source.includes('node_modules')) continue;
      const resolvedPath = relative(root, resolve(mapDir, source)).split(sep).join('/');
      if (resolvedPath.startsWith('..')) continue;
      if (existsSync(join(root, resolvedPath))) out.add(resolvedPath);
    }
  }
  return out;
}

/**
 * The full input set: the static entries plus every repo file the committed
 * bundle was built from. Duplicates removed, sorted, so the result is stable
 * enough to assert on.
 */
export function bundleInputPaths(root = DEFAULT_ROOT) {
  const paths = new Set(STATIC_INPUTS);

  // 1. Exactly the modules the committed bundle contains (see above).
  const bundled = readBundledRepoSources(root);
  for (const file of bundled) paths.add(file);

  // 2. No sourcemap to read (a build configured without one): fall back to the
  //    tree minus tests, plus relative imports that leave it. Over-broad by
  //    design — it cannot tell a bundled shim from an unbundled one, nor a
  //    type-only module from a real one — and only used when there is no map.
  if (bundled.size === 0) {
    for (const file of listSourceFiles(root, `${DASHBOARD_DIR}/src`, { skipTests: true })) {
      paths.add(file);
    }
    for (const file of [...paths]) {
      if (!/\.(ts|tsx|js|jsx|mjs|html)$/.test(file)) continue;
      let code;
      try {
        code = readFileSync(join(root, file), 'utf-8');
      } catch {
        continue;
      }
      for (const spec of extractSpecifiers(code)) {
        const resolvedPath = resolveSpecifier(file, spec, root);
        if (resolvedPath && !resolvedPath.startsWith(`${DASHBOARD_DIR}/`)) paths.add(resolvedPath);
      }
    }
  }

  return [...paths].sort();
}

/** The committed bundle's files, repo-relative. */
export function bundleOutputPaths(root = DEFAULT_ROOT) {
  const dir = join(root, BUNDLE_OUTPUT_DIR);
  if (!existsSync(dir)) return [];
  return listSourceFiles(root, BUNDLE_OUTPUT_DIR)
    .filter((f) => BUNDLE_FILE_EXTS.some((ext) => f.endsWith(ext)))
    .sort();
}

// ─── Freshness comparison (pure) ────────────────────────────────────────────

/**
 * Decide the bundle's freshness from the newest commit on each side.
 *
 * `same` is a pass but is called out rather than folded into `fresh`: history
 * cannot order two changes made in one commit, so the stronger guarantee there
 * comes from `--rebuild`, and claiming more than that would be exactly the kind
 * of overstatement this repo has been removing.
 */
export function compareFreshness(inputCommit, outputCommit) {
  if (!inputCommit || !outputCommit) {
    return {
      verdict: 'unknown',
      reason: !inputCommit
        ? 'no commit in the available history touches the bundle inputs'
        : 'no commit in the available history touches the committed bundle',
    };
  }
  if (inputCommit === outputCommit) {
    return { verdict: 'same', reason: 'the newest input and output changes are in the same commit' };
  }
  return { verdict: 'compare', inputCommit, outputCommit };
}

// ─── Git plumbing ───────────────────────────────────────────────────────────

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Is `ancestor` an ancestor of `descendant`? */
function isAncestor(root, ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** The newest commit in the available history touching any of `paths`. */
function newestCommitFor(root, paths) {
  if (paths.length === 0) return '';
  const out = git(root, ['rev-list', '-1', 'HEAD', '--', ...paths]);
  return out.split('\n')[0]?.trim() ?? '';
}

/** Short `hash subject` for a commit, for the report. */
function describeCommit(root, hash) {
  if (!hash) return '(none)';
  const line = git(root, ['log', '-1', '--format=%h %s', hash]);
  return line.split('\n')[0] ?? hash;
}

// ─── Checks ─────────────────────────────────────────────────────────────────

/**
 * History check: is the newest source-affecting commit newer than the last
 * commit that touched the bundle? Clock-skew-proof — it uses commit ORDER
 * (`rev-list` + `merge-base --is-ancestor`), never timestamps, so a rebase or a
 * machine with a wrong clock cannot flip the verdict.
 */
export function checkHistory(root = DEFAULT_ROOT) {
  const inputs = bundleInputPaths(root);
  const outputs = bundleOutputPaths(root);

  if (outputs.length === 0) {
    return {
      ok: false,
      code: 1,
      mode: 'history',
      message:
        'the dashboard bundle is missing entirely — no files under ' +
        `${BUNDLE_OUTPUT_DIR}. Build it with: npm run build:dashboard`,
      inputs,
      outputs,
    };
  }

  let inputCommit;
  let outputCommit;
  try {
    inputCommit = newestCommitFor(root, inputs);
    outputCommit = newestCommitFor(root, outputs);
  } catch {
    return { ok: true, code: 2, mode: 'history', message: 'not a git repository — cannot order the bundle against its source', inputs, outputs };
  }

  const verdict = compareFreshness(inputCommit, outputCommit);
  if (verdict.verdict === 'unknown') {
    return { ok: true, code: 2, mode: 'history', message: `${verdict.reason} — cannot judge`, inputs, outputs };
  }
  if (verdict.verdict === 'same') {
    return { ok: true, code: 0, mode: 'history', message: `${verdict.reason}; re-run with --rebuild to prove the bytes`, inputs, outputs };
  }

  // The bundle is in sync only if it was built AFTER the newest input change:
  // the output commit must be a DESCENDANT of the input commit.
  if (isAncestor(root, verdict.inputCommit, verdict.outputCommit)) {
    return { ok: true, code: 0, mode: 'history', message: `bundle rebuilt after the newest source change (${describeCommit(root, verdict.outputCommit)})`, inputs, outputs };
  }

  return {
    ok: false,
    code: 1,
    mode: 'history',
    message:
      'the committed dashboard bundle is OLDER than its source.\n' +
      `  newest source change: ${describeCommit(root, verdict.inputCommit)}\n` +
      `  newest bundle change: ${describeCommit(root, verdict.outputCommit)}\n` +
      '  The dashboard server serves src/web-dashboard/public directly, so the page\n' +
      '  users get is the older one. Rebuild and commit it: npm run build:dashboard',
    inputs,
    outputs,
  };
}

/**
 * Normalise a built file for comparison.
 *
 * A sourcemap carries a `sources` array that vite records as paths relative to
 * the OUTPUT directory, resolved through each module's real path. MEASURED, that
 * makes the map depend on where the package manager put the dependencies rather
 * than on the source: built here, every dependency reads `../../node_modules/…`,
 * but built with `node_modules` as a SYMLINK (pnpm, npm link) the same source
 * emits `../../../../../../../Users/…/node_modules/…` for each of them. Those
 * entries say where react sat on the building machine, so comparing them would
 * fail a perfectly current bundle for a package manager the repo does not
 * forbid. Paths are dropped; `sourcesContent` and `mappings` are still compared,
 * so a module whose code changed, or a changed order/layout, still differs — and
 * the module count is kept explicitly, since a map that gained or lost a module
 * is a real difference even if every remaining module holds the same code.
 */
export function normaliseOutput(file, contents) {
  if (!file.endsWith('.map')) return contents;
  let parsed;
  try {
    parsed = JSON.parse(contents.toString('utf-8'));
  } catch {
    return contents;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return contents;
  const { sources, ...rest } = parsed;
  return Buffer.from(JSON.stringify({ ...rest, moduleCount: Array.isArray(sources) ? sources.length : 0 }));
}

/**
 * Read every file under `dir` into a map of path → contents, keyed RELATIVE TO
 * `dir`. Both sides of the comparison are keyed the same way, so a build written
 * outside the repo (the temp outDir) compares cleanly against `public/`.
 */
function readTree(dir) {
  const out = new Map();
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/**
 * Byte check: build the bundle into a TEMP dir with the dashboard's own
 * toolchain and compare it to the committed files.
 *
 * The temp dir matters twice over. It keeps the check non-destructive — the
 * configured outDir is the real `public/`, so building in place would overwrite
 * whatever a developer has not committed yet — and the output is
 * content-addressed, so the file NAMES are part of the comparison: a changed
 * bundle shows up as a new asset hash even before the bytes are read.
 */
export function checkRebuild(root = DEFAULT_ROOT) {
  const dashboardDir = join(root, DASHBOARD_DIR);
  if (!existsSync(join(dashboardDir, 'package.json'))) {
    return { ok: false, code: 2, mode: 'rebuild', message: `no dashboard package at ${DASHBOARD_DIR}` };
  }
  if (!existsSync(join(dashboardDir, 'node_modules'))) {
    return {
      ok: false,
      code: 2,
      mode: 'rebuild',
      message:
        'the dashboard tree is not installed, so the bundle cannot be rebuilt.\n' +
        `  Install it: cd ${DASHBOARD_DIR} && npm ci`,
    };
  }

  // Sibling of public/, same depth — see the header note on why the depth
  // matters. Removed in the finally below, on success and failure alike.
  const outDir = join(dashboardDir, '.bundle-check');
  rmSync(outDir, { recursive: true, force: true });
  try {
    execFileSync('npm', ['run', 'build', '--', '--outDir', outDir, '--emptyOutDir'], {
      cwd: dashboardDir,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: true,
      // NODE_ENV is PINNED. A build is not environment-independent: vite bakes
      // `process.env.NODE_ENV` into the bundle, and MEASURED, building this tree
      // with NODE_ENV=test produces `index-BEXqDnGR.js` where the committed
      // artifact is `index-DxxxI4lk.js` — so a check that inherited its caller's
      // environment would report a perfectly good bundle as wrong whenever it
      // ran under a test runner (vitest sets NODE_ENV=test). The committed
      // artifact is the production build, so that is what this reproduces.
      env: { ...process.env, NODE_ENV: 'production' },
    });

    const built = readTree(outDir);
    const committed = readTree(join(root, BUNDLE_OUTPUT_DIR));

    const problems = [];
    for (const [file, contents] of built) {
      const committedContents = committed.get(file);
      if (!committedContents) {
        problems.push(`not in the repo: ${BUNDLE_OUTPUT_DIR}/${file}`);
        continue;
      }
      if (!normaliseOutput(file, committedContents).equals(normaliseOutput(file, contents))) {
        problems.push(`differs from a fresh build: ${BUNDLE_OUTPUT_DIR}/${file}`);
      }
    }
    for (const file of committed.keys()) {
      if (!built.has(file)) problems.push(`committed but not produced by a build: ${BUNDLE_OUTPUT_DIR}/${file}`);
    }

    if (problems.length === 0) {
      return { ok: true, code: 0, mode: 'rebuild', message: `committed bundle matches a fresh build (${built.size} file(s))` };
    }
    return {
      ok: false,
      code: 1,
      mode: 'rebuild',
      message:
        'the committed dashboard bundle does NOT match what the source builds:\n  ' +
        problems.join('\n  ') +
        '\n  Rebuild and commit it: npm run build:dashboard',
    };
  } catch (err) {
    return { ok: false, code: 2, mode: 'rebuild', message: `the dashboard build failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// ─── CLI entry ──────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const useRebuild = process.argv.includes('--rebuild');
  const asJson = process.argv.includes('--json');
  // `--root` exists so the guard can be pointed at a fixture checkout in a test
  // (and at another clone by hand). Everything else resolves from the repo this
  // script lives in, so running it from any subdirectory checks the same tree.
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag !== -1 && process.argv[rootFlag + 1] ? resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const result = useRebuild ? checkRebuild(root) : checkHistory(root);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    const detail = result.code === 2 ? '⚠' : '✔';
    console.log(`dashboard-bundle: ${detail} ${result.message}`);
  } else {
    console.error(`dashboard-bundle: ✘ ${result.message}`);
  }
  process.exit(result.ok ? 0 : 1);
}

/**
 * The tree guard — the test suite must not modify the project it runs in.
 *
 * WHY THIS EXISTS. During a live release run, `bcrypt@^6.0.0` and
 * `express-jwt@^8.5.1` appeared in `package.json` and `package-lock.json` while
 * the release pipeline sat between its commit and its publish phase. Nothing in
 * this repo references either package. The release's `git add -A` was one step
 * from committing them into a tagged release, and `npm publish` — which packs the
 * WORKING TREE, not the committed tree — was seconds from publishing them.
 *
 * That is a supply-chain event, and the suite is the only thing that runs in this
 * repo on every change; if a test can write a dependency into the manifest, it
 * must not be able to do it quietly.
 *
 * TWO TIERS, deliberately:
 *
 *  - DEPENDENCY MANIFEST CHANGES FAIL THE RUN. Unambiguous: no test needs to add,
 *    remove or re-range a package to pass. A failure here means the suite (or
 *    something it spawned) edited the project's dependency set.
 *  - A FILE CREATED UNDER `src/` FAILS THE RUN. `src/` is what `npm publish`
 *    packs and what the release commit's `git add -A` stages, and no test needs
 *    to create a source file. Measured: a test that TIMED OUT left its
 *    orchestrator run in flight; `afterEach` had already restored the per-test
 *    `applyFileChanges` spy, so the leaked run reached the real method and wrote
 *    its mock fixture — `src/test.ts`, `const x = 2;` — into the working tree,
 *    one `git add -A` from being committed into a tagged release and published.
 *  - OTHER NEWLY-DIRTY FILES ARE REPORTED, not failed. A test that leaves a
 *    scratch file behind is a real defect, but failing the whole run on a path
 *    that may be a developer's own in-flight edit would train people to ignore
 *    this guard — and a guard people ignore is worse than none. The report names
 *    the paths so the next step is a one-line fix rather than an investigation.
 *
 * ENFORCEMENT (the part that is easy to get wrong). The snapshot is taken in
 * `globalSetup.setup()` and compared in `teardown()`. `teardown()` runs during
 * vitest's close, AFTER the results are printed — and a `throw` from there is
 * reported as `error during close` while **the process still exits 0** (measured:
 * a throwing teardown with every test green exited 0). A throw would therefore
 * have been a guard that prints the supply-chain risk and passes the build. The
 * hard tier sets `process.exitCode = 1`, which vitest honours (measured: exit 1),
 * and does not throw — the throw only added a stack trace after the real message.
 *
 * WHAT A CHANGE MEANS, four states and a rule for each:
 *   readable → readable, entries differ      ⇒ FAIL, and name the packages
 *   absent   → readable                       ⇒ FAIL (a manifest created mid-run)
 *   readable → absent                         ⇒ FAIL (a manifest deleted mid-run)
 *   a path under `src/` appears               ⇒ FAIL (a test wrote into the tree
 *                                                    `npm publish` packs)
 *   unreadable on either side                 ⇒ stay quiet
 * The last rule is not laziness: an unreadable manifest is one the guard cannot
 * make a claim about (a developer's half-written file, a lockfile mid-rewrite),
 * and a guard that fails on a file it could not parse is the kind of noise that
 * gets it disabled. A version-only change is likewise not a change: the entries
 * compared are the DEPENDENCY SECTIONS, never the file text.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Manifests whose dependency sections are the hard invariant. */
export const MANIFESTS = ['package.json', 'package-lock.json'] as const;

/**
 * The tree `npm publish` packs and the release commit's `git add -A` stages.
 * Creating a file here is the one non-manifest change that fails the run.
 */
export const PUBLISHED_SOURCE_DIR = 'src/';

/** Sections that define the dependency set, in both manifest shapes. */
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

type DepSection = (typeof DEP_SECTIONS)[number];

/** One dependency, attributed to the section and manifest it was declared in. */
export interface DepEntry {
  manifest: string;
  section: string;
  name: string;
  range: string;
}

export interface ManifestSnapshot {
  /**
   * `absent` — the file is not there. `unreadable` — it is there but not valid
   * JSON (so no claim can be made). `readable` — parsed, with its dependency set.
   */
  status: 'absent' | 'unreadable' | 'readable';
  deps?: Record<string, string>;
}

export interface TreeSnapshot {
  /** `git status --porcelain` lines, e.g. `XY path`. */
  dirty: string[];
  /** Dependency set of each manifest. */
  manifests: Record<string, ManifestSnapshot>;
}

export interface DependencyChange {
  manifest: string;
  reason: 'created' | 'removed' | 'changed';
  /** Package names that moved, `name@range` when the range itself changed. */
  packages: string[];
}

export interface TreeGuardVerdict {
  /** Manifests whose dependency set moved — the first hard failure. */
  dependencyChanges: DependencyChange[];
  /** Files CREATED under `src/` while the tests ran — the second hard failure. */
  createdInSource: string[];
  /** Paths that became dirty while the tests ran — reported, not failed. */
  newDirty: string[];
}

function repoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return process.cwd();
  }
}

function dirtyPaths(): string[] {
  try {
    const out = execSync('git status --porcelain', { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
    return out
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean);
  } catch {
    // Not a git repo, or git is unavailable: the guard has nothing to compare.
    return [];
  }
}

/**
 * The dependency set of one manifest, keyed by `section::name`.
 *
 * Sections are read from the top level AND, for a lockfile, from
 * `packages[""]` — the root package's own declared set, which is where npm puts
 * it. Both are included because a writer may touch either; the report dedupes.
 */
export function manifestDeps(path: string): ManifestSnapshot {
  if (!existsSync(path)) return { status: 'absent' };

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { status: 'unreadable' };
  }

  const deps: Record<string, string> = {};
  const collect = (bag: unknown, prefix: string): void => {
    if (!bag || typeof bag !== 'object') return;
    for (const [name, range] of Object.entries(bag as Record<string, unknown>)) {
      deps[`${prefix}${name}`] = typeof range === 'string' ? range : JSON.stringify(range);
    }
  };

  for (const section of DEP_SECTIONS) collect(pkg[section], `${section}::`);
  const lockRoot = (pkg.packages as Record<string, Record<string, unknown>> | undefined)?.[''];
  if (lockRoot) {
    for (const section of DEP_SECTIONS) collect(lockRoot[section], `${section}::`);
  }

  return { status: 'readable', deps };
}

export function captureTree(root: string): TreeSnapshot {
  return {
    dirty: dirtyPaths(),
    manifests: Object.fromEntries(MANIFESTS.map((m) => [m, manifestDeps(join(root, m))])),
  };
}

/** The package name inside a report entry (`+pkg@range`, `~pkg: a → b`, `-pkg@range`). */
function packageOfEntry(entry: string): string {
  const body = entry.replace(/^[+~-]/, '');
  const cut = Math.min(...['@', ':'].map((c) => { const i = body.indexOf(c); return i === -1 ? body.length : i; }));
  return body.slice(0, cut).trim();
}

/** Package names from entry keys, with the section prefix stripped and deduped. */
function namesOf(deps: Record<string, string>): Set<string> {
  return new Set(Object.keys(deps).map((k) => k.split('::')[1] ?? k));
}

function diffEntries(before: Record<string, string>, after: Record<string, string>): string[] {
  const moved: string[] = [];
  for (const [key, range] of Object.entries(after)) {
    const name = key.split('::')[1] ?? key;
    if (!(key in before)) moved.push(`+${name}@${range}`);
    else if (before[key] !== range) moved.push(`~${name}: ${before[key]} → ${range}`);
  }
  for (const [key, range] of Object.entries(before)) {
    const name = key.split('::')[1] ?? key;
    if (!(key in after)) moved.push(`-${name}@${range}`);
  }
  return [...new Set(moved)].sort();
}

/**
 * Compare two snapshots. Pure, so the decision this guard makes can be tested —
 * a guard nobody tests is a guard that silently stops guarding.
 */
export function evaluateTreeGuard(before: TreeSnapshot, after: TreeSnapshot): TreeGuardVerdict {
  const dependencyChanges: DependencyChange[] = [];

  for (const name of MANIFESTS) {
    const was = before.manifests[name];
    const now = after.manifests[name];
    // No claim can be made about a manifest that could not be read on either side.
    if (!was || !now || was.status === 'unreadable' || now.status === 'unreadable') continue;

    if (was.status === 'absent' && now.status === 'readable') {
      dependencyChanges.push({ manifest: name, reason: 'created', packages: [...namesOf(now.deps!)].sort() });
    } else if (was.status === 'readable' && now.status === 'absent') {
      dependencyChanges.push({ manifest: name, reason: 'removed', packages: [...namesOf(was.deps!)].sort() });
    } else if (was.status === 'readable' && now.status === 'readable') {
      const moved = diffEntries(was.deps!, now.deps!);
      if (moved.length > 0) dependencyChanges.push({ manifest: name, reason: 'changed', packages: moved });
    }
  }

  const beforeDirty = new Set(before.dirty);
  const newDirty = after.dirty.filter((line) => !beforeDirty.has(line));

  return {
    dependencyChanges,
    // `??` is the only status that means the file was not there before; a tracked
    // source file the run merely modified would show as a modification instead.
    createdInSource: newDirty.filter(
      (line) => line.startsWith('?? ') && line.slice(3).trim().startsWith(PUBLISHED_SOURCE_DIR),
    ),
    newDirty,
  };
}

/** The report text for a verdict — `null` when there is nothing to say. */
export function treeGuardReport(verdict: TreeGuardVerdict): string | null {
  const lines: string[] = [];

  if (verdict.dependencyChanges.length > 0) {
    lines.push('✘ the dependency set changed while the tests ran:');
    // package.json and package-lock.json describe the same packages; name each
    // package once, then say which manifests carried the edit.
    const manifestsOfPackage = new Map<string, Set<string>>();
    for (const change of verdict.dependencyChanges) {
      for (const entry of change.packages) {
        const pkg = packageOfEntry(entry);
        if (!manifestsOfPackage.has(pkg)) manifestsOfPackage.set(pkg, new Set());
        manifestsOfPackage.get(pkg)!.add(change.manifest);
      }
    }
    for (const [pkg, manifests] of [...manifestsOfPackage].sort((a, b) => a[0].localeCompare(b[0]))) {
      const detail = verdict.dependencyChanges
        .flatMap((c) => c.packages.filter((p) => packageOfEntry(p) === pkg))
        .join(', ');
      lines.push(`    ${pkg} — ${detail} [${[...manifests].join(', ')}]`);
    }
    lines.push(
      '  Nothing in the suite may add, remove or re-range a dependency: that is a',
      '  supply-chain change, and `npm publish` packs the WORKING TREE — so a',
      '  dependency written by a test would be PUBLISHED. Find the writer and',
      '  sandbox it before proceeding.',
    );
  }

  if (verdict.createdInSource.length > 0) {
    lines.push(
      `✘ ${verdict.createdInSource.length} file(s) were CREATED under ${PUBLISHED_SOURCE_DIR} while the tests ran:`,
      ...verdict.createdInSource.slice(0, 20).map((l) => `    ${l}`),
      ...(verdict.createdInSource.length > 20
        ? [`    …and ${verdict.createdInSource.length - 20} more`]
        : []),
      `  No test creates a file under ${PUBLISHED_SOURCE_DIR}: that is the tree`,
      '  `npm publish` packs and the release commit stages, so a leaked write would',
      '  be committed into the tagged release and published. The usual author is a',
      '  test that TIMED OUT — its run continues after `afterEach` restored the',
      '  mocks that were preventing the write. Find the writer and isolate it.',
    );
  }

  // Already failed above; listing it twice would bury the actionable line.
  const otherDirty = verdict.newDirty.filter((line) => !verdict.createdInSource.includes(line));
  if (otherDirty.length > 0) {
    lines.push(
      `⚠ ${otherDirty.length} path(s) became dirty during the run — a test may be writing into the repo:`,
      ...otherDirty.slice(0, 20).map((l) => `    ${l}`),
      ...(otherDirty.length > 20 ? [`    …and ${otherDirty.length - 20} more`] : []),
    );
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

let before: TreeSnapshot | null = null;
let root = process.cwd();

export async function setup(): Promise<void> {
  root = repoRoot();
  before = captureTree(root);
}

export async function teardown(): Promise<void> {
  if (!before) return;

  const verdict = evaluateTreeGuard(before, captureTree(root));
  const report = treeGuardReport(verdict);
  if (!report) return;

  console.error(`\n[tree-guard]\n${report}\n`);

  if (verdict.dependencyChanges.length > 0 || verdict.createdInSource.length > 0) {
    // NOT a throw: see the ENFORCEMENT note at the top of this file. A throw from
    // globalSetup teardown is printed as "error during close" and the run still
    // exits 0 — the guard would report the supply-chain risk and pass the build.
    process.exitCode = 1;
  }
}

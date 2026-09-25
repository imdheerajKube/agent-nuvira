/**
 * Release runners — the DETERMINISTIC half of the publish pipeline.
 *
 * `nuvira publish` defines its phases as goals ("Bump version (patch), update
 * CHANGELOG.md with release notes") and used to hand every one of them to the
 * LLM orchestrator. That made a mechanical release depend on plan quality and
 * provider health: a live 3.3.2 run planned an unrelated job (add
 * `standard-version`, write a new `scripts/release.ts`) instead of bumping the
 * version, and the write steps then failed under a rate-limited provider. A
 * release is not a creative task — every step here is a command with a known
 * correct outcome — so each phase now carries a RUNNER, and the orchestrator is
 * only used for phases that have none (e.g. the free-text `evaluate` phase of
 * `nuvira phase add`).
 *
 * Properties that matter:
 * - A runner reads the world at RUN time (version, changelog, branch, remote)
 *   rather than closing over state, so a phase resumed later in a new process
 *   sees the same facts the filesystem does.
 * - Nothing is invented: the changelog entry is built from `git log`, and the
 *   commit headline is the changelog heading when one exists.
 * - An author-written `## vX.Y.Z` section in CHANGELOG.md is LEFT ALONE. The
 *   generated entry is a fallback for the case where nobody wrote one, never an
 *   overwrite of prose a human wrote.
 * - Failures carry the command's own output as the error, so the summary line
 *   the user reads says what npm/git actually said.
 * - A phase refuses the work it must not do, rather than doing it and reporting
 *   afterwards: the git phase will not tag a release that changes the dependency
 *   set, and the version phase will not commit a version whose pinned artifacts
 *   are stale.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stripTestUnsafeEnv } from '../config/live-credentials.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type BumpType = 'patch' | 'minor' | 'major';

export interface PhaseRunOutcome {
  success: boolean;
  summary: string;
  error?: string;
  details?: string;
}

/** A phase's deterministic implementation. No arguments: it reads the world. */
export type ReleasePhaseRunner = () => Promise<PhaseRunOutcome>;

/** Phase ids produced by `buildPublishPhases` — the runner table's keys. */
export const RELEASE_PHASE_IDS = {
  tests: 'phase-1-tests',
  version: 'phase-2-version',
  git: 'phase-3-git',
  npm: 'phase-4-npm',
  github: 'phase-5-github',
} as const;

// ─── Command helpers ────────────────────────────────────────────────────────

interface ExecOutcome {
  ok: boolean;
  output: string;
}

/**
 * Run a command and never throw — the caller decides what a non-zero exit
 * means. `2>&1` keeps stderr in the captured text because that is where npm,
 * git and gh put the sentence that explains a failure.
 */
function run(command: string, timeoutMs = 600_000, cwd?: string, env?: NodeJS.ProcessEnv): ExecOutcome {
  try {
    const output = execSync(`${command} 2>&1`, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: 'pipe',
      // Undefined keeps the inherited environment; a caller passes `env` to
      // spawn WITHOUT something this process holds (the test phase passes a
      // credential-stripped copy — see `src/config/live-credentials.ts`).
      ...(env ? { env } : {}),
    });
    return { ok: true, output: (output || '').trim() };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (error.stdout || error.stderr || error.message || '').trim() };
  }
}

function tail(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * What actually failed, in the form an operator can act on.
 *
 * WHY. A failed Test Verification used to report `tail(output, 400)`, which on a
 * real vitest run is a few characters of the LAST line — the reader learns the
 * suite failed but not which file, which test, or why, and has to re-run the
 * suite by hand to find out. That is the difference between a pipeline that can
 * only refuse and one that can be repaired: the diagnosis is the deliverable.
 * Measured on the release that surfaced this: 7 files and 25 timeouts, none of
 * them named by the pipeline.
 */
export function testFailureDigest(output: string): string {
  // vitest colours the `FAIL` marker, so the escape sequences sit BETWEEN the
  // marker and the path and a plain match finds nothing. Measured: the first
  // version of this digest reported the failure kind and named no file at all.
  const clean = output.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');

  const files = [
    ...new Set([...clean.matchAll(/(?:FAIL\s+|❯\s+)(tests\/[^\s(]+)/g)].map((m) => m[1])),
  ];
  const kinds = [
    ...new Set(
      [
        ...clean.matchAll(/Test timed out in \d+ ?ms/g),
        ...clean.matchAll(/Timed out waiting for [^\n]+/g),
        ...clean.matchAll(/AssertionError/g),
        ...clean.matchAll(/Unhandled [Ee]rrors?/g),
      ].map((m) => m[0]),
    ),
  ];

  const lines: string[] = [];
  if (files.length > 0) {
    const shown = files.slice(0, 10).join(', ');
    lines.push(`${files.length} failing file(s): ${shown}${files.length > 10 ? `, +${files.length - 10} more` : ''}`);
  }
  if (kinds.length > 0) lines.push(`failure kinds: ${kinds.slice(0, 6).join('; ')}`);
  return lines.join('\n');
}

// ─── Package + changelog primitives ─────────────────────────────────────────

interface PackageManifest {
  version?: string;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export function readManifest(cwd = process.cwd()): PackageManifest | null {
  const path = join(cwd, 'package.json');
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as PackageManifest;
  } catch {
    return null;
  }
}

export function readVersion(cwd = process.cwd()): string {
  return readManifest(cwd)?.version || '';
}

/** Pure version arithmetic — exported so it can be pinned by test. */
export function bumpVersionString(current: string, bumpType: BumpType): string {
  const parts = current.split('.').map((p) => Number.parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (bumpType === 'major') return `${parts[0] + 1}.0.0`;
  if (bumpType === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/** The tag this release is measured from — version tags only (`v3.3.1`). */
export function lastReleaseTag(): string {
  const tagged = run('git describe --tags --abbrev=0 --match "v[0-9]*"', 15_000);
  if (tagged.ok && tagged.output) return tagged.output.split('\n')[0].trim();
  // No version tag yet: measure from the root commit so the entry is not empty.
  const root = run('git rev-list --max-parents=0 HEAD', 15_000);
  return root.ok ? root.output.split('\n')[0].trim() : '';
}

export function commitsSince(base: string): string[] {
  if (!base) return [];
  const log = run(`git log --oneline --no-decorate ${base}..HEAD`, 15_000);
  if (!log.ok) return [];
  return log.output.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Does CHANGELOG.md already have a section for this version? Section = `## vX.Y.Z`. */
export function hasChangelogSection(version: string, changelog: string): boolean {
  if (!changelog) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\b` is not enough: '3.3' followed by '.1' IS a word boundary, so '3.3'
  // would match the '## v3.3.1' heading and the release would keep a section
  // belonging to a different version.
  return new RegExp(`^##\\s*v?${escaped}(?![0-9.])`, 'm').test(changelog);
}

/**
 * The headline of `## vX.Y.Z — headline`, used as the commit subject.
 * Returns '' when the section carries no headline.
 */
export function changelogHeadline(version: string, changelog: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = changelog.match(new RegExp(`^##\\s*v?${escaped}\\s*[—-]\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

/** The full text of the `## vX.Y.Z` section, for GitHub release notes. */
export function changelogSection(version: string, changelog: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s*v?${escaped}(?![0-9.]).*$`, 'm');
  const start = changelog.search(heading);
  if (start === -1) return '';
  const rest = changelog.slice(start);
  const nextSection = rest.slice(1).search(/^##\s/m);
  return (nextSection === -1 ? rest : rest.slice(0, nextSection + 1)).trim();
}

function readChangelog(cwd = process.cwd()): string {
  const path = join(cwd, 'CHANGELOG.md');
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch {
    return '';
  }
}

// ─── Phase 1: tests ─────────────────────────────────────────────────────────

export async function runTestsPhase(): Promise<PhaseRunOutcome> {
  const manifest = readManifest();
  if (!manifest?.scripts?.test) {
    return { success: true, summary: 'No test script in package.json — nothing to run' };
  }

  // Generous: a full suite on a large project runs for minutes, and a timeout
  // here would read as "tests failed" for a suite that was still passing.
  //
  // The suite is spawned WITHOUT the credentials this process holds. The release
  // legitimately loads `~/.nuvira/.env` to push and publish, and it used to hand
  // that same environment to `npm test` — so tests conditioned on a provider key
  // woke up and took real network paths, and Phase 1 failed on the operator's
  // shell rather than on the code. See `src/config/live-credentials.ts`.
  const result = run('npm test', 1_800_000, undefined, stripTestUnsafeEnv());
  if (!result.ok) {
    const digest = testFailureDigest(result.output);
    const files = /^(\d+) failing file/.exec(digest)?.[1];
    return {
      success: false,
      summary: files ? `Test suite failed (${files} file(s))` : 'Test suite failed',
      error: [digest, tail(result.output, 400)].filter(Boolean).join('\n'),
    };
  }

  const passed = result.output.match(/Tests\s+.*?(\d+)\s+passed/);
  return {
    success: true,
    summary: passed ? `Tests passed (${passed[1]} passing)` : 'Tests passed',
    details: tail(result.output, 800),
  };
}

// ─── Phase 2: version bump + changelog ──────────────────────────────────────

export async function runVersionBumpPhase(bumpType: BumpType = 'patch'): Promise<PhaseRunOutcome> {
  const cwd = process.cwd();
  const pkgPath = join(cwd, 'package.json');
  const manifest = readManifest(cwd);

  if (!manifest) {
    return { success: false, summary: 'No package.json found', error: `Expected ${pkgPath}` };
  }

  const current = manifest.version || '0.0.0';
  const next = bumpVersionString(current, bumpType);
  if (next === current) {
    return { success: false, summary: `Version did not change (${current})`, error: 'Bump produced the same version' };
  }

  manifest.version = next;
  writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  // The lockfile's OWN version fields are the ones npm compares; leaving them
  // stale makes `npm ci` in a fresh checkout disagree with package.json.
  const lockPath = join(cwd, 'package-lock.json');
  let lockSynced = false;
  try {
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
        version?: string;
        packages?: Record<string, { version?: string }>;
      };
      lock.version = next;
      if (lock.packages?.['']) lock.packages[''].version = next;
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
      lockSynced = true;
    }
  } catch (err) {
    logger.warn(`  ⚠️  Could not sync package-lock.json: ${err}`);
  }

  // Changelog: an author-written section wins. Only write a generated one when
  // the version has no section at all.
  const changelog = readChangelog(cwd);
  let changelogNote = 'kept the existing entry';
  if (!hasChangelogSection(next, changelog)) {
    const commits = commitsSince(lastReleaseTag());
    const date = new Date().toISOString().slice(0, 10);
    const bullets = commits.length
      ? commits.map((c) => `- ${c}`).join('\n')
      : '- No commits recorded since the previous release.';
    const entry = `## v${next} — released ${date}\n\n${bullets}\n\n`;
    const header = '# Changelog\n';
    const body = changelog.startsWith(header)
      ? header + '\n' + entry + changelog.slice(header.length).replace(/^\n+/, '')
      : entry + changelog;
    writeFileSync(join(cwd, 'CHANGELOG.md'), body, 'utf-8');
    changelogNote = `added an entry from ${commits.length} commit(s)`;
  }

  // Version-pinned artifacts — the recorder the release docs pin to, the
  // dashboard bundle that inlines the version — must move in the SAME commit as
  // the version. They did not, and the 3.3.2 release is what found it: the
  // pipeline bumped, committed and pushed, and then `prepublishOnly`'s test run
  // failed on the staleness guard ("cast records v3.3.1 but package.json is
  // v3.3.2"), so the publish could not complete. The v3.3.1 release had fixed
  // this by hand, which is exactly the sign it belongs in the pipeline.
  const artifacts = await regenerateVersionPinnedArtifacts();
  if (!artifacts.success) {
    return {
      success: false,
      summary: `Bumped to ${next}, but its version-pinned artifacts could not be regenerated`,
      error: artifacts.error,
    };
  }

  const parts = [
    `Bumped ${current} -> ${next} (${bumpType})`,
    `changelog ${changelogNote}`,
    lockSynced ? 'lockfile synced' : null,
    artifacts.summary,
  ].filter(Boolean);

  return { success: true, summary: parts.join('; ') };
}

/**
 * Which dependencies differ between HEAD and the working tree.
 *
 * Compares every dependency section as a SET, so a pure reformat is not a
 * finding while an added, removed or re-ranged package is — and reports the
 * packages by name so the message is actionable rather than "package.json
 * changed".
 */
export function dependencyDelta(cwd = process.cwd()): string[] {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
  const local = readManifest(cwd);
  if (!local) return [];

  const headRaw = run('git show HEAD:package.json', 15_000, cwd);
  if (!headRaw.ok || !headRaw.output.trim()) return []; // no HEAD yet — nothing to compare
  let head: PackageManifest;
  try {
    head = JSON.parse(headRaw.output) as PackageManifest;
  } catch {
    return [];
  }

  const changes: string[] = [];
  for (const section of sections) {
    const before = (head[section] ?? {}) as Record<string, string>;
    const after = (local[section] ?? {}) as Record<string, string>;
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[name] === after[name]) continue;
      if (!(name in before)) changes.push(`+${name} (${section})`);
      else if (!(name in after)) changes.push(`-${name} (${section})`);
      else changes.push(`~${name} ${before[name]} → ${after[name]} (${section})`);
    }
  }
  return changes.sort();
}

/**
 * Run the project's own hook for artifacts that embed the version.
 *
 * The hook is an explicit npm script rather than a guess at which directories
 * are generated: a project that needs one declares `release:artifacts`, and a
 * project without it skips this cleanly. Guessing by path ("rebuild if `public/`
 * is tracked") would be wrong in both directions, and wrong silently.
 */
export async function regenerateVersionPinnedArtifacts(): Promise<PhaseRunOutcome> {
  const manifest = readManifest();
  const hook = manifest?.scripts?.['release:artifacts'];
  if (!hook) {
    return { success: true, summary: 'no release:artifacts hook to run' };
  }

  const result = run('npm run release:artifacts', 1_800_000);
  if (!result.ok) {
    return {
      success: false,
      summary: 'release:artifacts failed',
      error: tail(result.output, 400),
    };
  }

  return { success: true, summary: 'version-pinned artifacts regenerated' };
}

// ─── Phase 3: git commit, tag, push ─────────────────────────────────────────

export async function runGitPhase(): Promise<PhaseRunOutcome> {
  const version = readVersion();
  if (!version) {
    return { success: false, summary: 'Cannot tag without a version', error: 'package.json has no version' };
  }
  const tag = `v${version}`;

  // ── A release commit changes the VERSION, not the dependency set ──────────
  // Checked against HEAD, so it is independent of when the change appeared. The
  // incident: two dependencies were written into `package.json` mid-release by
  // something outside the pipeline, and this phase's `git add -A` was one step
  // from committing them into a tagged, published release whose code never
  // referenced either. A dependency change is a decision with its own commit,
  // never a side effect of cutting a release.
  const deps = dependencyDelta();
  if (deps.length > 0 && process.env.NUVIRA_ALLOW_DEP_CHANGES !== '1') {
    return {
      success: false,
      summary: 'Refusing to tag a release that changes dependencies',
      error:
        `${deps.join(', ')} differ from HEAD. A release commit must not introduce or remove ` +
        'dependencies — commit that change on its own (and say why), or set NUVIRA_ALLOW_DEP_CHANGES=1 ' +
        'if the dependency change is genuinely part of this release.',
    };
  }

  const branchResult = run('git rev-parse --abbrev-ref HEAD', 15_000);
  const branch = branchResult.ok ? branchResult.output.trim() : 'main';

  const remotes = run('git remote', 15_000);
  if (!remotes.ok || !remotes.output.trim()) {
    return { success: false, summary: 'No git remote configured', error: 'Add a remote: git remote add origin <url>' };
  }
  const remote = remotes.output.split('\n')[0].trim();

  // Stage everything the release touched (version bump, changelog, lockfile).
  const staged = run('git add -A', 30_000);
  if (!staged.ok) {
    return { success: false, summary: 'git add failed', error: tail(staged.output) };
  }

  // ── What the commit will actually CONTAIN ──────────────────────────────
  // `git add -A` stages the whole working tree, which is right for a release
  // (it ships the work), but it means the commit's contents have to be READ
  // rather than assumed. The dependency guard above only reads the ROOT
  // manifest, so a NESTED manifest — a sub-package's package.json or lockfile —
  // could still carry a dependency change into a tagged, published release
  // unseen. That is the same supply-chain event one level down, so it gets the
  // same rule: refuse it unless the operator says the change is intended.
  const stagedList = run('git diff --cached --name-only', 30_000);
  const stagedPaths = stagedList.ok
    ? stagedList.output.split('\n').map((p) => p.trim()).filter(Boolean)
    : [];

  const ROOT_MANIFESTS = new Set([
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
    'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
  ]);
  const NESTED_MANIFEST_RE =
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock)$/;
  const nestedManifests = stagedPaths.filter(
    (p) => !ROOT_MANIFESTS.has(p) && NESTED_MANIFEST_RE.test(p),
  );
  if (nestedManifests.length > 0 && process.env.NUVIRA_ALLOW_DEP_CHANGES !== '1') {
    return {
      success: false,
      summary: 'Refusing to tag a release that changes a nested dependency manifest',
      error:
        `${nestedManifests.join(', ')} would enter this release commit. The dependency check ` +
        'reads only the root manifest, so a nested package.json/lockfile is a dependency ' +
        'change this pipeline cannot verify. Commit it on its own, or set ' +
        'NUVIRA_ALLOW_DEP_CHANGES=1 if it is genuinely part of this release.',
    };
  }

  const status = run('git status --short', 30_000);
  const changedCount = status.ok ? status.output.split('\n').filter(Boolean).length : 0;

  // Names, not just a count: the live incident was one `git add -A` from
  // committing two packages nobody had declared, and "21 files changed" said
  // nothing about them. The list is bounded because a release commit can
  // legitimately be large, and it is reported on the success path too — the
  // point is that the operator can SEE what shipped.
  const stagedNote = stagedPaths.length
    ? `staging ${stagedPaths.length} path(s): ${stagedPaths.slice(0, 40).join(', ')}` +
      (stagedPaths.length > 40 ? ` …and ${stagedPaths.length - 40} more` : '')
    : 'nothing staged';

  let committed = false;
  if (changedCount > 0) {
    const headline = changelogHeadline(version, readChangelog());
    const message = headline ? `Release ${tag}: ${headline}` : `Release ${tag}`;
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-release-'));
    const msgFile = join(dir, 'commit-msg.txt');
    writeFileSync(msgFile, message + '\n', 'utf-8');
    const commit = run(`git commit -F "${msgFile}"`, 60_000);
    try { unlinkSync(msgFile); } catch { /* best-effort */ }
    if (!commit.ok) {
      return { success: false, summary: 'git commit failed', error: tail(commit.output) };
    }
    committed = true;
  }

  const existingTag = run(`git tag -l "${tag}"`, 15_000);
  let createdTag = false;
  if (!existingTag.ok || existingTag.output.trim() !== tag) {
    const tagResult = run(`git tag -a "${tag}" -m "Release ${tag}"`, 30_000);
    if (!tagResult.ok) {
      return { success: false, summary: `Failed to create tag ${tag}`, error: tail(tagResult.output) };
    }
    createdTag = true;
  }

  const pushBranch = run(`git push -u "${remote}" "${branch}"`, 180_000);
  if (!pushBranch.ok) {
    return {
      success: false,
      summary: `Push to ${remote}/${branch} failed`,
      error: tail(pushBranch.output, 400),
    };
  }

  const pushTag = run(`git push "${remote}" "${tag}"`, 120_000);
  if (!pushTag.ok) {
    return {
      success: false,
      summary: `Committed and pushed ${branch}, but pushing tag ${tag} failed`,
      error: tail(pushTag.output, 400),
    };
  }

  const parts = [
    committed ? `committed ${changedCount} file(s)` : 'nothing to commit',
    createdTag ? `tagged ${tag}` : `${tag} already existed`,
    `pushed to ${remote}/${branch}`,
    stagedNote,
  ];
  return { success: true, summary: parts.join('; ') };
}

// ─── Phase 4: npm build + publish ───────────────────────────────────────────

/** Turn npm's exit text into the sentence the user needs. */
export function describeNpmError(output: string): string {
  if (output.includes('ENEEDAUTH')) return 'Authentication required — set NPM_TOKEN (nuvira credentials set NPM_TOKEN)';
  if (output.includes('E403') || /\b403\b/.test(output) || output.includes('not_logged_in') || output.includes('unauthorized')) {
    return 'Not authorized to publish — check the npm token and its permissions';
  }
  if (output.includes('cannot publish over previously published version')) {
    return 'Version already published — bump to a new version';
  }
  if (output.includes('E402') || output.includes('unpaid')) return 'Payment required — check the npm account';
  if (output.includes('E404')) return 'Package not found — check the name and registry';
  return tail(output, 400);
}

export async function runNpmPhase(): Promise<PhaseRunOutcome> {
  const manifest = readManifest();
  if (!manifest) {
    return { success: false, summary: 'No package.json found', error: 'Cannot publish without a manifest' };
  }

  const version = manifest.version || '';
  if (manifest.scripts?.build) {
    const build = run('npm run build', 1_200_000);
    if (!build.ok) {
      return { success: false, summary: 'Build failed — publish aborted', error: tail(build.output, 400) };
    }
  }

  // `npm publish` runs the project's own `prepublishOnly` — here that is
  // `npm run build && npm test`, which takes ~10 minutes on this repo. Timing
  // out mid-publish would leave a release half-shipped, so this is deliberately
  // long rather than tidy.
  const publish = run('npm publish', 2_700_000);
  if (!publish.ok) {
    return { success: false, summary: `npm publish failed for ${version}`, error: describeNpmError(publish.output) };
  }

  return { success: true, summary: `Published agent-nuvira@${version} to the npm registry`, details: tail(publish.output, 400) };
}

// ─── Phase 5: GitHub release ────────────────────────────────────────────────

export async function runGitHubReleasePhase(): Promise<PhaseRunOutcome> {
  const gh = run('gh --version', 15_000);
  if (!gh.ok) {
    return {
      success: false,
      summary: 'GitHub CLI not available',
      error: 'Install the gh CLI (https://cli.github.com) or create the release from the pushed tag',
    };
  }

  const version = readVersion();
  if (!version) {
    return { success: false, summary: 'Cannot name a release without a version', error: 'package.json has no version' };
  }
  const tag = `v${version}`;

  const existing = run(`gh release view "${tag}"`, 30_000);
  if (existing.ok) {
    return { success: true, summary: `GitHub release ${tag} already exists` };
  }

  // Notes come from the changelog section for this version; when nobody wrote
  // one, fall back to the commit list rather than shipping an empty release.
  const section = changelogSection(version, readChangelog());
  const notes = section || commitsSince(lastReleaseTag()).map((c) => `- ${c}`).join('\n') || `Release ${tag}`;

  const dir = mkdtempSync(join(tmpdir(), 'nuvira-release-notes-'));
  const notesFile = join(dir, 'notes.md');
  writeFileSync(notesFile, notes + '\n', 'utf-8');
  const create = run(`gh release create "${tag}" --title "${tag}" --notes-file "${notesFile}"`, 120_000);
  try { unlinkSync(notesFile); } catch { /* best-effort */ }

  if (!create.ok) {
    return { success: false, summary: `Could not create GitHub release ${tag}`, error: tail(create.output, 400) };
  }

  return { success: true, summary: `Created GitHub release ${tag}`, details: tail(create.output, 200) };
}

// ─── Runner table ───────────────────────────────────────────────────────────

/**
 * The deterministic implementation for every phase `buildPublishPhases`
 * produces. A phase whose id is absent here keeps the orchestrator.
 */
export function createReleaseRunners(bumpType: BumpType): Record<string, ReleasePhaseRunner> {
  return {
    [RELEASE_PHASE_IDS.tests]: runTestsPhase,
    [RELEASE_PHASE_IDS.version]: () => runVersionBumpPhase(bumpType),
    [RELEASE_PHASE_IDS.git]: runGitPhase,
    [RELEASE_PHASE_IDS.npm]: runNpmPhase,
    [RELEASE_PHASE_IDS.github]: runGitHubReleasePhase,
  };
}

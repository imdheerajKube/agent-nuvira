/**
 * WS5 (#27) — a turn's own git worktree, and the diff it leaves behind.
 *
 * WHY A WORKTREE AT ALL. The ask is "try this and show me what changed". Running
 * that in the operator's own tree makes the answer inseparable from the damage: a
 * turn that edits twelve files to test one hypothesis has changed the tree the
 * operator is working in, and the only record of it is whatever they notice. A
 * second checkout of the SAME repository (a `git worktree`) gives the turn a real
 * tree — same code, same test runner, same `node_modules` — that can be thrown
 * away, and turns "what changed" into a diff against the commit it started from.
 *
 * WHY THE BASE IS `HEAD`, AND WHY THE NOTICE SAYS SO. `git worktree add … HEAD`
 * checks out a commit, so UNCOMMITTED work in the operator's tree is not visible
 * inside the copy. That is a real trap — a run that "did not see my edit" — so the
 * number of dirty files in the source tree is MEASURED at creation and reported,
 * rather than left to be discovered. A clean tree reports nothing.
 *
 * WHY IT REFUSES INSTEAD OF DEGRADING. Not every directory can be isolated: not a
 * repository, no commit yet, no `git` at all. The tempting behaviour — run in the
 * real tree and report the turn normally — is the one outcome this feature exists
 * to prevent, because the caller acts on a diff that describes a tree nobody ran
 * in. So isolation either happens or the turn STOPS, and the refusal says why.
 *
 * WHY THE DIFF IS MEASURED BEFORE TEARDOWN. Removing the worktree is what
 * destroys the evidence, so the order is not a detail: measure, then remove. A
 * teardown that fails (a git lock, a file handle) is reported as "not removed"
 * rather than assumed, since the directory is left in the operator's profile with
 * a branch pointing at it.
 *
 * GIT'S OWN STDOUT IS KEPT SEPARATE FROM THE MESSAGE. One helper here returns a
 * never-empty `out` (git printing nothing is a fact worth a sentence), and a
 * second field `raw` holding exactly what git wrote. Counting or parsing `out` is
 * how a PRISTINE repository came to be reported as having one uncommitted change:
 * `git status --porcelain` prints nothing, the fallback sentence has one line, and
 * the count was taken from the sentence (see TOOL_TRUTHFULNESS_TRACKER).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';

/** The environment key a deployment asks for isolation through. */
export const WORKTREE_ENABLE_ENV = 'NUVIRA_ISOLATE';
/** The environment keys a forked child reads to learn which worktree it is in. */
export const WORKTREE_DIR_ENV = 'NUVIRA_WORKTREE_DIR';
export const WORKTREE_BASE_ENV = 'NUVIRA_WORKTREE_BASE';
/**
 * How long `git worktree add` may take — a big repository is still a checkout.
 *
 * 60s rather than 20s: a checkout that is sub-second locally was measured
 * TIMING OUT at exactly 20s on a loaded Windows CI runner (the parity suite
 * creates five worktrees in one process, and the runner was concurrently
 * importing a 8k-test suite). The failure mode is nasty — the surface reports a
 * refusal and the turn never runs — so the bound is deliberately generous; a
 * genuinely stuck `git` still fails, just later.
 */
export const WORKTREE_CREATE_TIMEOUT_MS = 60_000;
/** Bound on one file's diff body, so a huge change cannot be handed over whole. */
export const WORKTREE_PATCH_CHARS = 120_000;

/** ─── Requests ─────────────────────────────────────────────────────────────── */

/**
 * What an isolation request resolved to.
 *
 * Exactly two fields, and no more: the parity suite asserts the shape of a
 * default request (`{asked: false, keep: false}`), so a third field added here
 * would be a silent change to a documented value. `asked` and `keep` are kept
 * apart because asking to be isolated and asking to KEEP the result are separate
 * decisions, and a plain `--worktree` must not leave a directory behind.
 */
export interface IsolationRequest {
  asked: boolean;
  keep: boolean;
}

/**
 * Resolve an isolation request from a caller's options, with the environment as
 * the fallback — not the other way round.
 *
 * `undefined` means "nobody said anything", and only then does `NUVIRA_ISOLATE`
 * decide. An explicit `false` is a DECISION (a surface that offers an off switch
 * must be able to turn a deployment's `NUVIRA_ISOLATE=1` off for one turn), and
 * it outranks the environment. This is the distinction a commander-style `false`
 * default destroys: with one, every CLI turn carries an explicit decline and the
 * documented `NUVIRA_ISOLATE=1` is unreachable from the command line.
 */
export function resolveIsolationRequest(input: {
  worktree?: boolean;
  keepWorktree?: boolean;
}): IsolationRequest {
  const asked = input.worktree === undefined ? envAsks(WORKTREE_ENABLE_ENV) : input.worktree === true;
  // `keep` is only meaningful when isolation was asked for; a lever with nothing
  // to keep would otherwise read as a request in its own right.
  const keep = asked && input.keepWorktree === true;
  return { asked, keep };
}

/** True when an environment key asks for something (`1`/`true`/`yes`). */
function envAsks(name: string): boolean {
  const raw = envBuff(name.replace(/^NUVIRA_/, ''));
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** ─── Git ──────────────────────────────────────────────────────────────────── */

/**
 * A git invocation, with git's exact stdout kept separate from the message.
 *
 * `raw` is what git wrote (possibly nothing, possibly several lines). `out` is
 * never empty — a caller that only wants to SAY something can use it, and a
 * caller that wants to COUNT or PARSE must use `raw`, because the fallback
 * sentence is not git's output and has its own line count.
 */
interface GitResult {
  ok: boolean;
  raw: string;
  out: string;
  err: string;
}

function gitRun(dir: string, args: string[], timeoutMs = WORKTREE_CREATE_TIMEOUT_MS): GitResult {
  try {
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const raw = (r.stdout ?? '').trim();
    return {
      ok: r.status === 0,
      raw,
      out: raw || 'git reported no output',
      err: (r.stderr ?? '').trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, raw: '', out: 'git reported no output', err: message };
  }
}

/**
 * Files with uncommitted work in `dir`, counted from git's OWN output.
 *
 * Counts LINES of `raw`: `git status --porcelain` prints one line per changed or
 * untracked path, and prints NOTHING for a clean tree — which must count as zero,
 * not as the one line of a fallback sentence.
 */
function dirtyCount(dir: string): number {
  const status = gitRun(dir, ['status', '--porcelain'], 5_000);
  if (!status.ok) return 0;
  return status.raw.split('\n').filter((line) => line.trim() !== '').length;
}

/** The commit a turn would start from, or null when there is none. */
function headOf(dir: string): string | null {
  const head = gitRun(dir, ['rev-parse', 'HEAD'], 5_000);
  const sha = head.raw.trim();
  return head.ok && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * Why `repoCwd` cannot be isolated, or null when it can.
 *
 * Shared by the refusal path and by the parity harness, which uses it to assert
 * that the checkout it is about to drive CAN be isolated — a harness that
 * silently proved nothing because it ran somewhere unisolatable would be worse
 * than a failure.
 */
export function worktreeRefusal(repoCwd: string): string | null {
  const inside = gitRun(repoCwd, ['rev-parse', '--is-inside-work-tree'], 5_000);
  if (!inside.ok || inside.raw.trim() !== 'true') {
    return `'${repoCwd}' is not inside a git work tree (git is unavailable, or this is not a repository)`;
  }
  if (!headOf(repoCwd)) {
    return `'${repoCwd}' has no commit to start from — an isolated copy is a checkout of HEAD`;
  }
  return null;
}

/** The refusal, as the operator reads it. A failure, not a degradation. */
export function isolationRefusalText(why: string): string {
  return (
    `Isolation was requested, but this turn cannot be isolated: ${why}.\n` +
    'Nothing ran — no model was called and no file was touched.'
  );
}

/** ─── The worktree ─────────────────────────────────────────────────────────── */

/** A live worktree: where it is, and the commit everything is measured against. */
export interface IsolatedWorktree {
  /** The checkout the turn runs in. */
  dir: string;
  /** The commit the diff is against (full sha). */
  base: string;
  /** The branch the worktree is checked out on, created with it. */
  branch: string;
  /** The repository it was created from. */
  repoCwd: string;
  /** Uncommitted paths in the SOURCE tree, which the copy cannot see. */
  sourceDirty: number;
}

/** Where worktrees live (`~/.nuvira/worktrees`, overridable for tests/CI). */
function worktreesRoot(): string {
  return envBuff('WORKTREES_DIR') || join(resolveNuviraHome(), 'worktrees');
}

/** A filesystem- and branch-safe name for this turn, from its label. */
function worktreeName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  const stamp = randomBytes(4).toString('hex').slice(0, 6);
  const salt = randomBytes(2).toString('hex').slice(0, 4);
  return `${slug || 'turn'}-${stamp}-${salt}`;
}

/**
 * Make a worktree of `repoCwd`, or return null when that is impossible.
 *
 * `node_modules` is LINKED rather than installed: a worktree has no dependencies
 * of its own, and an isolated turn that could not run a test would measure
 * nothing. The link is best-effort — a filesystem that cannot symlink still gets
 * an isolated tree, just one without dependencies.
 */
export function createIsolatedWorktree(input: {
  repoCwd: string;
  label: string;
  timeoutMs?: number;
}): IsolatedWorktree | null {
  if (worktreeRefusal(input.repoCwd) !== null) return null;
  const base = headOf(input.repoCwd);
  if (!base) return null;

  const name = worktreeName(input.label);
  const dir = join(worktreesRoot(), name);
  const branch = `nuvira/${name}`;
  try {
    mkdirSync(worktreesRoot(), { recursive: true });
  } catch {
    return null;
  }

  const added = gitRun(
    input.repoCwd,
    ['worktree', 'add', '-b', branch, dir, 'HEAD'],
    input.timeoutMs ?? WORKTREE_CREATE_TIMEOUT_MS,
  );
  if (!added.ok) {
    // Leave nothing behind: a half-made worktree registers with the parent repo
    // even when the checkout failed.
    try {
      rmSync(dir, { recursive: true, force: true });
      gitRun(input.repoCwd, ['worktree', 'prune'], 5_000);
    } catch {
      /* best-effort */
    }
    return null;
  }

  const sourceModules = join(input.repoCwd, 'node_modules');
  const linkedModules = join(dir, 'node_modules');
  if (existsSync(sourceModules) && !existsSync(linkedModules)) {
    try {
      symlinkSync(sourceModules, linkedModules, 'dir');
    } catch {
      /* a filesystem that cannot link still gets an isolated tree */
    }
  }

  return { dir, base, branch, repoCwd: input.repoCwd, sourceDirty: dirtyCount(input.repoCwd) };
}

/** ─── The diff ─────────────────────────────────────────────────────────────── */

/**
 * What an isolated turn changed.
 *
 * NOTE THE TWO HALVES OF `diff`, because they are not the same list and reading
 * the wrong one renders an empty card: `files` is the changed PATHS (one string
 * per file — what a reader scans), and `payload.files[].body` is the unified diff
 * of each. `payload` deliberately has the shape the `git:diff` event already
 * carries, so an isolated change renders with the diff card that is already
 * there instead of a second renderer that could drift from it.
 */
export interface WorktreeDiff {
  /** Changed paths, sorted as git reports them. */
  files: string[];
  summary: string;
  /** True when the run changed nothing — a fact, not a failure. */
  unchanged: boolean;
  payload: {
    files: Array<{ path: string; body: string }>;
    summary: string;
  };
}

/** Split git's own unified diff into one body per file, keyed by path. */
function payloadOf(patch: string, files: string[]): Array<{ path: string; body: string }> {
  const sections = patch.split(/^diff --git /m).filter((section) => section.trim() !== '');
  const byPath = new Map<string, string>();
  for (const section of sections) {
    // `a/<path> b/<path>` — the path with a space in it is why this reads the
    // `b/` side rather than splitting the line on whitespace.
    const match = section.match(/^a\/(.+?) b\//);
    if (!match) continue;
    byPath.set(match[1], `diff --git ${section}`.slice(0, WORKTREE_PATCH_CHARS));
  }
  return files.map((path) => ({ path, body: byPath.get(path) ?? '' }));
}

/**
 * The pathspec that keeps the linked `node_modules` out of a measurement.
 *
 * The repository's own ignore rule is `node_modules/`, which matches a DIRECTORY —
 * and what a worktree gets is a SYMLINK, which that rule does not match at all. So
 * a run that changed one file reported two, the second being the dependency link
 * this module created itself. Excluded by pathspec rather than by writing an
 * ignore file into the worktree, because the ignore file is the repository's.
 */
const MEASURE_SCOPE = ['.', ':(exclude)node_modules'];

/**
 * Measure the diff against the worktree's base commit.
 *
 * UNTRACKED FILES COUNT, and that is why the index is staged first: a run that
 * CREATES a file has changed the tree, and `git diff` alone would report nothing
 * for it. Staging inside a worktree that is about to be thrown away is free, and
 * a worktree that is KEPT has its new files staged — which is what `git diff
 * --cached` reads on the next measurement.
 */
export function worktreeDiff(
  handle: IsolatedWorktree,
  opts: { timeoutMs?: number } = {},
): WorktreeDiff {
  const timeout = opts.timeoutMs ?? WORKTREE_CREATE_TIMEOUT_MS;
  gitRun(handle.dir, ['add', '-A', '--', ...MEASURE_SCOPE], timeout);
  const names = gitRun(
    handle.dir,
    ['diff', '--cached', '--name-only', handle.base, '--', ...MEASURE_SCOPE],
    timeout,
  );
  const files = names.ok
    ? names.raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    : [];
  const short = handle.base.slice(0, 7);
  const summary = files.length === 0
    ? `nothing changed against ${short}`
    : `${files.length} file${files.length === 1 ? '' : 's'} changed against ${short}`;
  const patch = gitRun(
    handle.dir,
    ['diff', '--cached', handle.base, '--', ...MEASURE_SCOPE],
    timeout,
  );
  return {
    files,
    summary,
    unchanged: files.length === 0,
    payload: { files: payloadOf(patch.ok ? patch.raw : '', files), summary },
  };
}

/** The honest "nothing is known yet" diff, for a measurement that failed. */
function unmeasuredDiff(base: string): WorktreeDiff {
  const short = base.slice(0, 7);
  const summary = `the diff against ${short} could not be measured`;
  return { files: [], summary, unchanged: false, payload: { files: [], summary } };
}

/**
 * Remove a worktree and the branch that was made with it.
 *
 * Returns whether the directory is GONE, not whether git was happy: a removal
 * that succeeded but left the directory (a file handle, a lock) has still left a
 * directory in the operator's profile, and "removed: true" is the claim the
 * console prints.
 */
export function discardWorktree(handle: IsolatedWorktree, opts: { timeoutMs?: number } = {}): boolean {
  const timeout = opts.timeoutMs ?? WORKTREE_CREATE_TIMEOUT_MS;
  let gitSaid = false;
  try {
    gitSaid = gitRun(
      handle.repoCwd,
      ['worktree', 'remove', '--force', handle.dir],
      timeout,
    ).ok;
  } catch {
    gitSaid = false;
  }
  if (existsSync(handle.dir)) {
    try {
      rmSync(handle.dir, { recursive: true, force: true });
    } catch {
      /* fall through — the directory decides */
    }
  }
  try {
    if (!existsSync(handle.dir)) gitRun(handle.repoCwd, ['branch', '-D', handle.branch], 5_000);
    gitRun(handle.repoCwd, ['worktree', 'prune'], 5_000);
  } catch {
    /* best-effort */
  }
  return gitSaid || !existsSync(handle.dir);
}

/** ─── Lifecycle ────────────────────────────────────────────────────────────── */

/** A started isolation: the worktree, or the refusal that replaced it. */
export type IsolationStart =
  | { ok: true; worktree: IsolatedWorktree }
  | { ok: false; refusal: string };

/**
 * Start isolation for a turn, or return null when nobody asked for one.
 *
 * Null and a refusal are different answers and both are load-bearing: null means
 * the turn runs where it always did, and a refusal means the turn DOES NOT RUN.
 */
export function beginIsolation(input: {
  request: IsolationRequest;
  repoCwd: string;
  label: string;
}): IsolationStart | null {
  if (!input.request.asked) return null;
  const why = worktreeRefusal(input.repoCwd);
  if (why) return { ok: false, refusal: isolationRefusalText(why) };
  const worktree = createIsolatedWorktree({ repoCwd: input.repoCwd, label: input.label });
  if (!worktree) {
    const reason = worktreeRefusal(input.repoCwd) ?? 'the worktree could not be created';
    return { ok: false, refusal: isolationRefusalText(reason) };
  }
  return { ok: true, worktree };
}

/** The environment a forked child reads, so a tool can say where it is running. */
export function worktreeEnv(handle: IsolatedWorktree): Record<string, string> {
  return {
    [WORKTREE_DIR_ENV]: handle.dir,
    [WORKTREE_BASE_ENV]: handle.base,
  };
}

/**
 * Where the turn is running, said when it starts.
 *
 * The base commit is named as a commit AND as a branch, and the dirty count is
 * reported when it is non-zero — the two facts that decide whether the diff at
 * the end describes what the operator expected.
 */
export function worktreeNotice(handle: IsolatedWorktree): string {
  const lines = [
    `🌿 isolated in a git worktree: ${handle.dir}`,
    `   base: ${handle.base.slice(0, 7)} (branch ${handle.branch})`,
  ];
  if (handle.sourceDirty > 0) {
    lines.push(
      `   note: ${handle.sourceDirty} uncommitted change(s) in the source tree are NOT in this worktree`,
    );
  }
  return lines.join('\n');
}

/** What the turn changed, what happened to the directory, and the diff itself. */
export interface IsolationOutcome {
  dir: string;
  base: string;
  diff: WorktreeDiff;
  /** False when the directory was KEPT (`--keep-worktree`). */
  removed: boolean;
  /** The operator-facing line (see `worktreeNotice` / this module's `notice`). */
  notice: string;
}

/**
 * Finish isolation: measure the diff, then tear the worktree down (unless kept).
 *
 * Never throws — the caller attaches this to the turn's own result, and a git
 * error must not replace an answer with a message about a directory.
 */
export function endIsolation(handle: IsolatedWorktree, opts: { keep: boolean }): IsolationOutcome {
  let diff: WorktreeDiff;
  try {
    diff = worktreeDiff(handle);
  } catch {
    diff = unmeasuredDiff(handle.base);
  }
  let removed = false;
  if (!opts.keep) {
    try {
      removed = discardWorktree(handle);
    } catch {
      removed = false;
    }
  }
  const lines = [`   ${diff.summary}`];
  for (const file of diff.files) lines.push(`   · ${file}`);
  if (opts.keep) lines.push(`   (kept: ${handle.dir} — nothing was removed)`);
  else if (removed) lines.push('   (the worktree was removed — the diff above is what is left of it)');
  else lines.push(`   (the worktree could NOT be removed: ${handle.dir})`);
  return { dir: handle.dir, base: handle.base, diff, removed, notice: lines.join('\n') };
}

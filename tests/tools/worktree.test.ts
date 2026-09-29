/**
 * WS5 (#27) — the isolation primitive, against REAL git.
 *
 * Every case here makes a real repository and a real worktree: this module's whole
 * job is to talk to git and to the filesystem, and a stubbed `git` would test the
 * stub. The two defects this suite exists to pin are both about values that a
 * fake could not have got wrong:
 *
 *   - a PRISTINE repository reported as having an uncommitted change (the count
 *     came from a fallback message rather than from git's own empty stdout), and
 *   - the diff being measured AFTER teardown (which would report nothing, since
 *     the evidence is the directory that was removed).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  WORKTREE_BASE_ENV,
  WORKTREE_DIR_ENV,
  WORKTREE_ENABLE_ENV,
  beginIsolation,
  createIsolatedWorktree,
  discardWorktree,
  endIsolation,
  resolveIsolationRequest,
  worktreeDiff,
  worktreeEnv,
  worktreeNotice,
  worktreeRefusal,
} from '../../src/tools/worktree.js';

/** Run git, asserting it worked — a broken fixture must fail loudly. */
function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** A real repository with one commit. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws5-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'start\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

const made: string[] = [];
function track(dir: string): string {
  made.push(dir);
  return dir;
}

const previousWorktreesDir = process.env.NUVIRA_WORKTREES_DIR;
const previousIsolate = process.env[WORKTREE_ENABLE_ENV];

beforeEach(() => {
  // Worktrees go to a temp root so a test cannot leave one in the real profile.
  process.env.NUVIRA_WORKTREES_DIR = track(mkdtempSync(join(tmpdir(), 'ws5-worktrees-')));
  delete process.env[WORKTREE_ENABLE_ENV];
});

afterAll(() => {
  if (previousWorktreesDir === undefined) delete process.env.NUVIRA_WORKTREES_DIR;
  else process.env.NUVIRA_WORKTREES_DIR = previousWorktreesDir;
  if (previousIsolate === undefined) delete process.env[WORKTREE_ENABLE_ENV];
  else process.env[WORKTREE_ENABLE_ENV] = previousIsolate;
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('WS5 isolation — the request', () => {
  it('is off unless somebody asks, and the environment is the fallback', () => {
    expect(resolveIsolationRequest({})).toEqual({ asked: false, keep: false });
    process.env[WORKTREE_ENABLE_ENV] = '1';
    expect(resolveIsolationRequest({})).toEqual({ asked: true, keep: false });
    // An explicit DECLINE outranks the environment — that is the whole point of
    // leaving the CLI flags default-less, and the bug this pins.
    expect(resolveIsolationRequest({ worktree: false })).toEqual({ asked: false, keep: false });
    delete process.env[WORKTREE_ENABLE_ENV];
    expect(resolveIsolationRequest({ worktree: true })).toEqual({ asked: true, keep: false });
  });

  it('only honours keep when isolation was actually asked for', () => {
    expect(resolveIsolationRequest({ worktree: true, keepWorktree: true })).toEqual({
      asked: true,
      keep: true,
    });
    // A keep lever with nothing to keep is not a request for isolation.
    expect(resolveIsolationRequest({ keepWorktree: true })).toEqual({ asked: false, keep: false });
  });
});

describe('WS5 isolation — what can be isolated', () => {
  it('refuses a directory that is not a repository', () => {
    const why = worktreeRefusal(track(mkdtempSync(join(tmpdir(), 'ws5-norepo-'))));
    expect(why).not.toBeNull();
    expect(why).toContain('not inside a git work tree');
  });

  it('refuses a repository with no commit to start from', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'ws5-nocommit-')));
    git(dir, ['init', '-q']);
    const why = worktreeRefusal(dir);
    expect(why).not.toBeNull();
    expect(why).toContain('no commit to start from');
  });

  it('accepts a repository with a commit', () => {
    expect(worktreeRefusal(tempRepo())).toBeNull();
  });
});

describe('WS5 isolation — the worktree and its diff', () => {
  it('makes a real checkout, measures what changed, then removes it', () => {
    const repo = tempRepo();
    const handle = createIsolatedWorktree({ repoCwd: repo, label: 'Try the retry fix' });
    expect(handle).not.toBeNull();
    expect(existsSync(handle!.dir)).toBe(true);
    expect(handle!.dir).not.toBe(repo);
    expect(handle!.base).toMatch(/^[0-9a-f]{40}$/);
    expect(handle!.branch).toMatch(/^nuvira\/try-the-retry-fix-/);
    // The checkout is the SAME code, not an empty directory.
    expect(existsSync(join(handle!.dir, 'README.md'))).toBe(true);

    writeFileSync(join(handle!.dir, 'created-inside.txt'), 'hello\n');
    const diff = worktreeDiff(handle!);
    expect(diff.unchanged).toBe(false);
    expect(diff.files).toEqual(['created-inside.txt']);
    expect(diff.summary).toBe(`1 file changed against ${handle!.base.slice(0, 7)}`);
    // The deliverable is the BODY, in the shape the existing diff card renders.
    expect(diff.payload.files).toHaveLength(1);
    expect(diff.payload.files[0].path).toBe('created-inside.txt');
    expect(diff.payload.files[0].body).toContain('diff --git');

    const outcome = endIsolation(handle!, { keep: false });
    expect(outcome.removed).toBe(true);
    expect(existsSync(handle!.dir)).toBe(false);
    expect(outcome.diff.files).toEqual(['created-inside.txt']);
    expect(outcome.notice).toContain('the worktree was removed');
    expect(outcome.notice).toContain('· created-inside.txt');
    // Teardown must not touch the tree it was made from.
    expect(existsSync(join(repo, 'created-inside.txt'))).toBe(false);
  });

  it('reports a clean repository as having NO uncommitted change', () => {
    // THE REGRESSION. `git status --porcelain` prints nothing here, and the count
    // used to be taken from a never-empty fallback message — so every isolated
    // turn in a clean checkout claimed one uncommitted change existed.
    const repo = tempRepo();
    const handle = createIsolatedWorktree({ repoCwd: repo, label: 'clean tree' });
    expect(handle!.sourceDirty).toBe(0);
    const notice = worktreeNotice(handle!);
    expect(notice).toContain('isolated in a git worktree');
    expect(notice).not.toContain('uncommitted change');

    // And a tree that changed NOTHING is reported as unchanged, not as a failure.
    const diff = worktreeDiff(handle!);
    expect(diff.unchanged).toBe(true);
    expect(diff.files).toEqual([]);
    expect(diff.summary).toContain('nothing changed');
    discardWorktree(handle!);
  });

  it('counts real uncommitted work in the source tree, so nothing disappears quietly', () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'uncommitted.txt'), 'not committed\n');
    const handle = createIsolatedWorktree({ repoCwd: repo, label: 'dirty tree' });
    expect(handle!.sourceDirty).toBe(1);
    const notice = worktreeNotice(handle!);
    expect(notice).toContain('1 uncommitted change(s) in the source tree are NOT in this worktree');
    // The copy is a checkout of HEAD, so the uncommitted file is genuinely absent.
    expect(existsSync(join(handle!.dir, 'uncommitted.txt'))).toBe(false);
    discardWorktree(handle!);
  });

  it('does not report the dependency link it made as a change', () => {
    // `node_modules` is LINKED into the worktree, and the repository's own ignore
    // rule (`node_modules/`) matches a DIRECTORY — a symlink is not one. Without an
    // explicit exclusion the link appeared in every diff beside the real change.
    const repo = tempRepo();
    mkdirSync(join(repo, 'node_modules', 'some-dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'some-dep', 'index.js'), 'module.exports = 1;\n');
    const handle = createIsolatedWorktree({ repoCwd: repo, label: 'linked deps' });
    expect(handle).not.toBeNull();
    // The link is really there — the isolated turn can resolve its dependencies.
    expect(existsSync(join(handle!.dir, 'node_modules', 'some-dep', 'index.js'))).toBe(true);
    writeFileSync(join(handle!.dir, 'created-inside.txt'), 'hello\n');
    const diff = worktreeDiff(handle!);
    expect(diff.files).toEqual(['created-inside.txt']);
    expect(diff.payload.files.map((file) => file.path)).toEqual(['created-inside.txt']);
    discardWorktree(handle!);
  });

  it('keeps the worktree when asked, and says so', () => {
    const repo = tempRepo();
    const handle = createIsolatedWorktree({ repoCwd: repo, label: 'keep me' });
    writeFileSync(join(handle!.dir, 'kept.txt'), 'stays\n');
    const outcome = endIsolation(handle!, { keep: true });
    expect(outcome.removed).toBe(false);
    expect(existsSync(handle!.dir)).toBe(true);
    expect(outcome.notice).toContain('kept:');
    // The kept directory really is a usable tree with the change in it.
    expect(existsSync(join(handle!.dir, 'kept.txt'))).toBe(true);
  });

  it('tells a forked child which worktree it is running in', () => {
    const repo = tempRepo();
    const handle = createIsolatedWorktree({ repoCwd: repo, label: 'child' });
    const env = worktreeEnv(handle!);
    expect(env[WORKTREE_DIR_ENV]).toBe(handle!.dir);
    expect(env[WORKTREE_BASE_ENV]).toBe(handle!.base);
    discardWorktree(handle!);
  });

  it('does nothing at all when nobody asked', () => {
    const repo = tempRepo();
    expect(beginIsolation({ request: { asked: false, keep: false }, repoCwd: repo, label: 'x' }))
      .toBeNull();
  });

  it('REFUSES instead of running unisolated, and the refusal says what happened', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'ws5-refuse-')));
    const start = beginIsolation({
      request: { asked: true, keep: false },
      repoCwd: dir,
      label: 'write a file',
    });
    expect(start).not.toBeNull();
    expect(start!.ok).toBe(false);
    if (start!.ok) throw new Error('unreachable');
    expect(start!.refusal).toContain('Isolation was requested');
    expect(start!.refusal).toContain('Nothing ran');
    expect(start!.refusal).toContain('not inside a git work tree');
    // Nothing was created anywhere: a refusal is not a partial isolation.
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });
});

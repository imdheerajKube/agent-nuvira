/**
 * P3b — Gated git tool tests.
 *
 * The agent commits IN CONVERSATION, visibly: diff → card → ask_user
 * accept/reject → gated commit of only the accepted subset. Tests run against
 * a REAL temp git repo (init + commit) — no network, no mocks of git itself.
 *
 * Deny parity with run_terminal holds for the destructive actions (reset --hard
 * / clean / checkout -- .). `push` is deliberately NOT one of them any more: it
 * is a real GATED action on this tool, while the raw `git push` shell string
 * stays denied in run_terminal. Both halves of that exception are asserted
 * below, so neither can drift back unnoticed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runGitTool, parseDiffIntoSections, deniedGitAction } from '../../src/tools/git-tool.js';
import { getTool, listTools } from '../../src/tools/registry.js';
import { toolsetForTool, TOOLSETS, filterToolsByToolsets } from '../../src/tools/toolsets.js';
import { classifyCommand } from '../../src/tools/run-terminal.js';
import type { ToolContext } from '../../src/tools/registry.js';

let repo = '';
let remoteRepo = '';

function gitRepo(argv: string[]): string {
  return execFileSync('git', argv, { cwd: repo, encoding: 'utf-8' }).trim();
}

/** The refs that exist in the bare `origin` — what a push actually moved. */
function remoteRefs(): string {
  if (!remoteRepo) return '';
  return execFileSync('git', ['for-each-ref', '--format=%(refname)'], {
    cwd: remoteRepo,
    encoding: 'utf-8',
  }).trim();
}

/**
 * A repo wired to a REAL bare remote, so a push is an actual push (no network,
 * no mock — the pipe is a local path). Returns the tool context and the remote.
 */
function freshRepoWithRemote(): { ctx: ToolContext; remote: string } {
  repo = mkdtempSync(join(tmpdir(), 'buff-git-tool-'));
  remoteRepo = mkdtempSync(join(tmpdir(), 'buff-git-remote-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remoteRepo });
  // The branch name is pinned rather than inherited from the machine's
  // init.defaultBranch, so the assertions read the same everywhere.
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', remoteRepo], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'one\n', 'utf-8');
  gitRepo(['add', 'a.txt']);
  gitRepo(['commit', '-m', 'init']);
  return { ctx: { configManager: {}, cwd: repo }, remote: remoteRepo };
}

/** A fresh temp repo with one committed file + one uncommitted change. */
function freshRepo(): { ctx: ToolContext; file: string } {
  repo = mkdtempSync(join(tmpdir(), 'buff-git-tool-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n', 'utf-8');
  gitRepo(['add', 'a.txt']);
  gitRepo(['commit', '-m', 'init']);
  // Uncommitted change: edit a.txt + add a new file.
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf-8');
  writeFileSync(join(repo, 'b.txt'), 'new file\n', 'utf-8');
  return { ctx: { configManager: {}, cwd: repo }, file: join(repo, 'a.txt') };
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (remoteRepo) rmSync(remoteRepo, { recursive: true, force: true });
  repo = '';
  remoteRepo = '';
});

describe('git tool', () => {
  it('status reports the working-tree state (read-only, no confirm)', async () => {
    const { ctx } = freshRepo();
    const out = await runGitTool({ action: 'status' }, ctx);
    expect(out).toContain('git status');
    expect(out).toContain('a.txt');
    expect(out).toContain('b.txt');
  });

  it('log lists recent commits (read-only)', async () => {
    const { ctx } = freshRepo();
    const out = await runGitTool({ action: 'log' }, ctx);
    expect(out).toContain('git log');
    expect(out).toContain('init');
  });

  it('diff returns the unified text AND emits the structured git:diff event', async () => {
    const { ctx } = freshRepo();
    const events: Array<{ event: string; data: unknown }> = [];
    const emitCtx: ToolContext = { ...ctx, emit: (e, d) => events.push({ event: e, data: d }) };
    const out = await runGitTool({ action: 'diff' }, emitCtx);
    expect(out).toContain('git diff');
    expect(out).toContain('a.txt');
    const gitDiff = events.find((e) => e.event === 'git:diff');
    expect(gitDiff).toBeTruthy();
    const payload = gitDiff!.data as { files: Array<{ path: string; body: string }>; summary: string };
    expect(payload.summary).toContain('file');
    expect(payload.files.some((f) => f.path.includes('a.txt'))).toBe(true);
    // The diff includes the added lines.
    expect(payload.files.some((f) => f.body.includes('+three'))).toBe(true);
  });

  it('diff with a clean tree reports no changes (no event)', async () => {
    const { ctx } = freshRepo();
    gitRepo(['checkout', '--', '.']);
    gitRepo(['clean', '-f', 'b.txt']);
    const events: Array<{ event: string }> = [];
    const emitCtx: ToolContext = { ...ctx, emit: (e) => events.push({ event: e }) };
    const out = await runGitTool({ action: 'diff' }, emitCtx);
    expect(out).toContain('no working-tree changes');
    expect(events.some((e) => e.event === 'git:diff')).toBe(false);
  });

  it('commit is GATED: refused without confirm (no repository mutation)', async () => {
    const { ctx } = freshRepo();
    const before = gitRepo(['rev-parse', 'HEAD']);
    const out = await runGitTool({ action: 'commit', message: 'my change' }, ctx);
    expect(out).toContain('needs explicit confirmation');
    expect(out).toContain('ask_user');
    // Nothing was committed.
    expect(gitRepo(['rev-parse', 'HEAD'])).toBe(before);
    expect(gitRepo(['status', '--short'])).toContain('a.txt');
  });

  it('commit requires a non-empty message (git refuses empty messages)', async () => {
    const { ctx } = freshRepo();
    const out = await runGitTool({ action: 'commit', confirm: true, message: '   ' }, ctx);
    expect(out).toContain('needs a message');
  });

  it('commits ONLY the accepted files subset when files are given', async () => {
    const { ctx } = freshRepo();
    const out = await runGitTool(
      { action: 'commit', message: 'accept a.txt only', confirm: true, files: ['a.txt'] },
      ctx,
    );
    expect(out).toContain('✅ Committed');
    expect(out).toContain('a.txt');
    // The accepted file is committed…
    const status = gitRepo(['status', '--short']);
    expect(status).not.toContain('a.txt');
    // …but the un-accepted file is still untracked (accept/reject contract).
    expect(status).toContain('b.txt');
  });

  it('commit without files stages everything', async () => {
    const { ctx } = freshRepo();
    const out = await runGitTool({ action: 'commit', message: 'commit all', confirm: true }, ctx);
    expect(out).toContain('✅ Committed');
    expect(gitRepo(['status', '--short'])).toBe('');
  });

  it('DENY parity with run_terminal — reset --hard/clean/checkout -- . are refused', async () => {
    const { ctx } = freshRepo();
    for (const action of ['reset --hard', 'clean', 'checkout -- .']) {
      const out = await runGitTool({ action: action as never, confirm: true }, ctx);
      expect(out).toContain('Error:');
      expect(out).toContain('denied');
      // Parity: the equivalent run_terminal command is also denied.
      const cmd = `git ${action}`;
      expect(classifyCommand(cmd)).toBe('deny');
    }
  });

  it('deniedGitAction refuses the destructive actions, and push is NOT one of them (it is gated, not denied)', () => {
    expect(deniedGitAction('reset --hard')).toContain('denied');
    expect(deniedGitAction('clean')).toContain('denied');
    expect(deniedGitAction('status')).toBeNull();
    // push became a first-class GATED action; removing it from the deny list is
    // what makes the capability reachable at all.
    expect(deniedGitAction('push')).toBeNull();
  });

  it('the raw `git push` SHELL string stays denied in run_terminal — the structured tool is the sanctioned path', () => {
    expect(classifyCommand('git push')).toBe('deny');
    expect(classifyCommand('git push origin main')).toBe('deny');
    expect(classifyCommand('git push --force')).toBe('deny');
  });

  it('exposes push in its registered action schema (the capability is discoverable, not just implemented)', () => {
    const tool = getTool('git');
    expect(tool).toBeDefined();
    const parsed = tool!.inputSchema;
    // The enum is the real contract the model sees; a missing 'push' here means
    // the action exists in code but can never be called.
    const shape = parsed as unknown as { shape?: { action?: { options?: string[] } } };
    expect(shape.shape?.action?.options).toContain('push');
    expect(tool!.description).toContain('push');
  });

  it('rejects shell metacharacters in the commit message and files', async () => {
    const { ctx } = freshRepo();
    const msgBad = await runGitTool({ action: 'commit', message: 'x; rm -rf /', confirm: true }, ctx);
    expect(msgBad).toContain('Error:');
    const fileBad = await runGitTool(
      { action: 'commit', message: 'ok', confirm: true, files: ['a.txt; touch /tmp/pwn'] },
      ctx,
    );
    expect(fileBad).toContain('Error:');
  });

  it('parseDiffIntoSections splits a unified diff into per-file bodies', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index abc..def 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      ' one',
      ' two',
      '+three',
      'diff --git a/b.txt b/b.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.txt',
      '@@ -0,0 +1 @@',
      '+new file',
    ].join('\n');
    const sections = parseDiffIntoSections(diff);
    expect(sections).toHaveLength(2);
    expect(sections[0].path).toBe('a.txt');
    expect(sections[0].body).toContain('+three');
    expect(sections[1].path).toBe('b.txt');
    expect(parseDiffIntoSections('')).toEqual([]);
  });

  it('is registered and owned by the code toolset (toolset gate applies)', () => {
    const tool = getTool('git');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('workflow');
    expect(toolsetForTool('git')?.name).toBe('code');
    expect(TOOLSETS.find((t) => t.name === 'code')?.tools).toEqual(['code_search', 'delegate', 'clone_repo', 'git', 'read_extract', 'credential_files']);
    const names = filterToolsByToolsets(listTools(), ['code']).map((t) => t.name);
    expect(names).not.toContain('git');
  });
});

describe('git tool — push', () => {
  it('is GATED by DEFAULT: a local-only request does not authorize sending work to a remote', async () => {
    const { ctx } = freshRepoWithRemote();
    const out = await runGitTool(
      { action: 'push' },
      { ...ctx, authorizationRequest: 'commit these changes' },
    );
    expect(out).toContain('git push:');
    expect(out).toContain("user's call");
    expect(out).toContain('ask_user');
    // Nothing left the machine — the remote has no branch at all.
    expect(remoteRefs()).not.toContain('refs/heads/main');
  });

  it('asks (never pushes) when the MODEL raised the push on its own', async () => {
    const { ctx } = freshRepoWithRemote();
    const out = await runGitTool({ action: 'push' }, { ...ctx, authorizationRequest: 'write a poem about git' });
    expect(out).toContain("user's call");
    expect(remoteRefs()).not.toContain('refs/heads/main');
  });

  it('PUSHES when the user’s own request named the push', async () => {
    const { ctx } = freshRepoWithRemote();
    const out = await runGitTool(
      { action: 'push' },
      { ...ctx, authorizationRequest: 'commit and push this project to github' },
    );
    expect(out).toContain('✅ Pushed main');
    expect(out).toContain('origin');
    // The commit really is on the remote now.
    expect(remoteRefs()).toContain('refs/heads/main');
  });

  it('PUSHES with confirm:true after the user approved via ask_user (model-initiated)', async () => {
    const { ctx } = freshRepoWithRemote();
    const out = await runGitTool({ action: 'push', confirm: true }, ctx);
    expect(out).toContain('✅ Pushed main');
    // Confirmed means the user already saw it — no second "decided for you" note.
    expect(out).not.toContain('Pushed without asking');
    expect(remoteRefs()).toContain('refs/heads/main');
  });

  it('reports what git actually printed (a push writes to stderr, which stdout-only would drop)', async () => {
    const { ctx } = freshRepoWithRemote();
    const out = await runGitTool({ action: 'push', confirm: true }, ctx);
    // "To <path>" is git's own stderr line — the result must carry it.
    expect(out).toContain('To ');
    expect(out).not.toContain('git reported no output');
  });

  it('emits the visible-write event when it decides a named push itself', async () => {
    const { ctx } = freshRepoWithRemote();
    const events: Array<{ event: string; data: unknown }> = [];
    await runGitTool(
      { action: 'push' },
      {
        ...ctx,
        authorizationRequest: 'push the work to origin',
        emit: (e, d) => events.push({ event: e, data: d }),
      },
    );
    const applied = events.find((e) => e.event === 'autonomy:write-applied');
    expect(applied).toBeTruthy();
    expect((applied!.data as { tool: string }).tool).toBe('git push');
  });

  it('refuses an option-injection or metacharacter remote/branch (allow-listed refs)', async () => {
    const { ctx } = freshRepoWithRemote();
    for (const bad of ['--force', 'origin;rm -rf /', 'refs/../../etc', '-u']) {
      const out = await runGitTool({ action: 'push', remote: bad, confirm: true }, ctx);
      expect(out, bad).toContain('Error:');
      expect(out, bad).toContain('denied');
    }
    const badBranch = await runGitTool({ action: 'push', branch: '--force', confirm: true }, ctx);
    expect(badBranch).toContain('denied');
  });

  it('explains itself when there is no remote to push to', async () => {
    const { ctx } = freshRepo();
    const out = await runGitTool({ action: 'push', confirm: true }, ctx);
    expect(out).toContain('no remote');
    expect(out).toContain('git remote add origin');
  });
});

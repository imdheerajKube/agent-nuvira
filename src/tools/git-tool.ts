/**
 * P3b — Gated git tool (diff/commit with accept-reject).
 *
 * The ask (master-plan P3b): *"change the code files, asked me to commit"* —
 * the agent must commit in-conversation, VISIBLY. `run_terminal` covers git
 * read-only as a verify-class command and commit only as a raw confirm-class
 * string — but there is no structured diff surface, no accept/reject, no
 * message-first commit. This tool closes that (matrix row 15).
 *
 * Actions:
 *   - `status` / `log` — read-only, run directly (no confirm).
 *   - `diff` — runs `git diff`, returns the unified text AND emits a
 *     structured `git:diff` event (per-file bodies) so the dashboard chat
 *     renders a 🔧 diff card with +/− sections (the P2 artifact pattern,
 *     streamed over the same event chain as P0.7's plan:changed).
 *   - `commit` — GATED: requires `confirm: true`, which the model only sets
 *     after the user approved via ask_user (the same gate as edit_file /
 *     write_file / run_cli). Optional `files` = the ACCEPTED subset — only
 *     those are staged+committed ("accept/reject applies only accepted
 *     hunks" — the model shows the diff card, the user picks files, the
 *     commit touches nothing else).
 *
 * Security (deny-first, shared with run_terminal):
 *   - `git push`, `git reset --hard`, `git clean`, `git checkout -- .` are
 *     STRUCTURALLY unexpressible (the action enum has no such action) AND a
 *     deny guard refuses any future action name that maps to them (parity
 *     test: a command denied in run_terminal is denied here).
 *   - argv-array exec (execFileSync, NO shell) — the message/files are
 *     passed as arguments, injection is structurally impossible.
 *   - The commit message may be empty (git opens the editor — blocked):
 *     an empty message is refused with guidance instead.
 *
 * Never throws: every failure returns a helpful string.
 */

import { execFileSync } from 'node:child_process';
import type { ToolContext } from './registry.js';

/** The tool's args (zod-validated in the registry). */
export interface GitToolArgs {
  /** What to do. */
  action: 'status' | 'log' | 'diff' | 'commit';
  /** Commit message (action=commit, required). */
  message?: string;
  /**
   * Files to stage+commit — the ACCEPTED subset after the user reviewed the
   * diff card. Absent = everything (still gated by confirm:true).
   */
  files?: string[];
  /** Commit gate — true ONLY after the user approved via ask_user. */
  confirm?: boolean;
  /** Limit for `log` (default 20). */
  limit?: number;
}

/** The structured diff payload the GUI renders as a card. */
export interface GitDiffPayload {
  files: Array<{ path: string; body: string }>;
  summary: string;
}

/** Action names that map to denied git commands (parity with run_terminal). */
const DENIED_ACTIONS: Record<string, string> = {
  push: 'git push is denied — pushing is a human decision, never an autonomous loop.',
  'reset --hard': 'git reset --hard is denied — it destroys the working tree irreversibly.',
  clean: 'git clean is denied — it removes untracked files irreversibly.',
  'checkout -- .': 'git checkout -- . is denied — it discards working-tree changes irreversibly.',
  'checkout --': 'git checkout -- . is denied — it discards working-tree changes irreversibly.',
};

// Shell operators that would matter IF a shell were involved — argv-array
// exec makes even these inert, but refuse them anyway (defense in depth).
// NOTE: \s is deliberately NOT here — commit messages and file names contain
// spaces legitimately and argv exec passes them safely.
const SHELL_METACHARS = /[;&|`$()<>"'\\]/;

/** Run git with an argv array (no shell). Returns stdout or a masked error. */
function git(argv: string[], ctx: ToolContext): { ok: boolean; out: string; code?: number } {
  try {
    const out = execFileSync('git', argv, {
      cwd: ctx.cwd || process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number; message?: string };
    const detail = String(e.stderr ?? e.stdout ?? e.message ?? '').toString().trim().slice(0, 400);
    return { ok: false, out: detail || 'git failed', code: e.status };
  }
}

/** Split a unified diff into per-file sections (diff --git … hunk blocks). */
export function parseDiffIntoSections(diff: string): Array<{ path: string; body: string }> {
  if (!diff.trim()) return [];
  const sections: Array<{ path: string; body: string }> = [];
  let current: { path: string; body: string } | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current);
      // "diff --git a/foo.ts b/foo.ts" → the b-side path (may be /dev/null).
      const b = line.split(' b/').slice(1).join(' b/');
      current = { path: b.replace(/^b\//, ''), body: line };
    } else if (current) {
      current.body += `\n${line}`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** The deny guard: an action name that maps to a run_terminal-denied git command. */
export function deniedGitAction(action: string): string | null {
  return DENIED_ACTIONS[action] ?? null;
}

export async function runGitTool(args: GitToolArgs, ctx: ToolContext): Promise<string> {
  const action = String(args?.action ?? '').trim();
  if (!action) return 'Error: git tool needs an action (status | log | diff | commit).';

  // Deny guard — an action that maps to a run_terminal-denied command is
  // refused before anything runs (parity with the shared deny list).
  const denied = deniedGitAction(action);
  if (denied) return `Error: ${denied}`;
  if (!['status', 'log', 'diff', 'commit'].includes(action)) {
    return `Error: unknown git action '${action}' — use status | log | diff | commit.`;
  }

  if (action === 'status') {
    const r = git(['status', '--short'], ctx);
    if (!r.ok) return `git status failed: ${r.out}`;
    return r.out ? `git status:\n${r.out}` : 'git status: working tree clean.';
  }

  if (action === 'log') {
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 20)));
    const r = git(['log', '--oneline', `-${limit}`], ctx);
    if (!r.ok) return `git log failed: ${r.out}`;
    return r.out ? `git log (last ${limit}):\n${r.out}` : 'git log: no commits yet.';
  }

  if (action === 'diff') {
    const r = git(['diff'], ctx);
    if (!r.ok) return `git diff failed: ${r.out}`;
    const sections = parseDiffIntoSections(r.out);
    if (sections.length === 0) return 'git diff: no working-tree changes.';
    // Emit the structured payload for the GUI diff card (best-effort).
    const payload: GitDiffPayload = {
      files: sections,
      summary: `${sections.length} file${sections.length === 1 ? '' : 's'} changed`,
    };
    ctx.emit?.('git:diff', payload);
    // The model sees the full unified diff text too (it decides the commit).
    const files = sections.map((s) => s.path).join(', ');
    return `git diff — ${payload.summary}: ${files}\n${r.out.slice(0, 6000)}`;
  }

  // ── action === 'commit' — the GATED path ────────────────────────────────
  const message = String(args.message ?? '').trim();
  if (!message) {
    return 'Error: git commit needs a message (git refuses empty messages — it would open an editor). Call ask_user for the commit message, then re-call with it.';
  }
  if (!args.confirm) {
    return (
      'git commit: this changes the repository history and needs explicit confirmation. ' +
      'Call ask_user (yes/no — show the diff card first so the user sees exactly what will be committed), ' +
      'then re-call git commit with the SAME message plus confirm:true only if the user agreed.'
    );
  }
  if (SHELL_METACHARS.test(message)) {
    return 'Error: git commit message contains shell metacharacters — denied (argv exec would still be safe, but refuse anyway).';
  }
  const files = (args.files ?? []).map((f) => String(f).trim()).filter(Boolean);
  if (files.some((f) => SHELL_METACHARS.test(f) || f.startsWith('/') || f.includes('..'))) {
    return 'Error: git commit files must be workspace-relative paths without shell metacharacters — denied.';
  }

  // Stage ONLY the accepted subset (absent → everything) — the accept/reject
  // contract: the user picked files off the diff card, nothing else is touched.
  const stageArgs = files.length > 0 ? ['add', '--', ...files] : ['add', '-A'];
  const staged = git(stageArgs, ctx);
  if (!staged.ok) return `git add failed: ${staged.out}`;

  const committed = git(['commit', '-m', message], ctx);
  if (!committed.ok) {
    return `git commit failed: ${committed.out}`;
  }
  const what = files.length > 0 ? files.join(', ') : 'all changes';
  return `✅ Committed (${what}):\n${committed.out.slice(0, 800)}`;
}

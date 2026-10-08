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
 *   - `push` — GATED, and the strictest gate here: a push is the one git action
 *     whose effect is visible OUTSIDE this machine (a remote other people and CI
 *     read). It proceeds when the user's OWN REQUEST named it ("commit and push
 *     this to GitHub" — the evidence is in `requestRequestsPush`, so the ask is
 *     not a round trip), and it ASKS otherwise. A request that only asked to
 *     record work locally ("commit these changes") does not unlock it: the agent
 *     must not decide on its own to publish someone's work.
 *
 * Security (deny-first, shared with run_terminal):
 *   - `git push` is reachable HERE (gated, argv-array, auditable) and DELIBERATELY
 *     still denied as a raw `run_terminal` shell string. The structured tool is
 *     the sanctioned path: it validates the remote/branch as literals, passes
 *     them as argv (injection impossible), reports what it pushed, and asks
 *     first. The unstructured shell string gets none of that, so it stays denied.
 *   - `git reset --hard`, `git clean`, `git checkout -- .` are STRUCTURALLY
 *     unexpressible (the action enum has no such action) AND deny-guarded —
 *     there is no gated variant of them because no user request makes an
 *     irreversible working-tree wipe the right thing to do in a tool call.
 *   - argv-array exec (execFileSync, NO shell) — the message/files/remote/branch
 *     are passed as arguments, injection is structurally impossible.
 *   - The commit message may be empty (git opens the editor — blocked):
 *     an empty message is refused with guidance instead.
 *
 * Never throws: every failure returns a helpful string.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import type { ToolContext } from './registry.js';
import {
  decideStateChange,
  requestRequestsCommit,
  requestRequestsPush,
} from '../learning/autonomy-policy.js';
import { sessionGrantCovers } from '../learning/session-grant.js';
import { grantCategoryOfTool } from './capability-registry.js';

/** The tool's args (zod-validated in the registry). */
export interface GitToolArgs {
  /** What to do. */
  action: 'status' | 'log' | 'diff' | 'commit' | 'push';
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
  /** Push destination (action=push, default: the repo's first remote). */
  remote?: string;
  /** Push source branch (action=push, default: the current branch). */
  branch?: string;
  /** action=push — also push tags (`git push --tags`). */
  tags?: boolean;
}

/** The structured diff payload the GUI renders as a card. */
export interface GitDiffPayload {
  files: Array<{ path: string; body: string }>;
  summary: string;
}

/**
 * Action names that map to denied git commands — parity with run_terminal.
 *
 * `push` is deliberately ABSENT: it is a real, gated action on this tool (see
 * the module docstring), while the raw `git push` shell string stays denied in
 * run_terminal. Everything here destroys working-tree state that no request
 * makes safe to do from a tool call.
 */
const DENIED_ACTIONS: Record<string, string> = {
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

/**
 * A remote name or ref that is safe as an argv literal.
 *
 * The push path is the one place a caller-supplied string reaches a network
 * command, so it is allow-listed rather than deny-listed: letters/digits first
 * (never a leading `-`, which is how an argv entry turns into an option), then
 * the punctuation real branch names use (`feature/x`, `v3.3.2`, `release_1`).
 */
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Run git with an argv array (no shell). Returns stdout or a masked error. */
function git(
  argv: string[],
  ctx: ToolContext,
  timeoutMs = 60_000,
): { ok: boolean; out: string; code?: number } {
  try {
    const out = execFileSync('git', argv, {
      cwd: ctx.cwd || process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number; message?: string };
    const detail = String(e.stderr ?? e.stdout ?? e.message ?? '').toString().trim().slice(0, 400);
    return { ok: false, out: detail || 'git failed', code: e.status };
  }
}

/**
 * Run a git subcommand that reports its progress on STDERR and capture BOTH
 * streams.
 *
 * `execFileSync` returns stdout only, and a successful `git push` writes
 * everything it has to say ("To <url> … main -> main", "Everything up-to-date")
 * to stderr — so a push reported through the stdout-only helper would look like
 * it said nothing at all. Returns a never-empty string so a result line can
 * always show what git actually printed.
 */
function gitCombined(argv: string[], ctx: ToolContext, timeoutMs: number): { ok: boolean; out: string } {
  const r = spawnSync('git', argv, {
    cwd: ctx.cwd || process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const failed = r.error ? String((r.error as Error).message) : '';
  return { ok: r.status === 0, out: text || failed || 'git reported no output' };
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

/**
 * The push action — the only git operation here whose effect LEAVES this machine.
 *
 * Gate: the user's OWN REQUEST must have named the push, or the model must have
 * confirmed with the user first. A local-only commit request does NOT authorize
 * it. That asymmetry with {@link runGitTool}'s commit path is the point: a commit
 * is undone by a reset, while a push is read by everyone with access to the
 * remote and acted on by CI, so the agent must not infer it from work the user
 * only asked to record.
 *
 * Every caller-supplied ref is allow-listed ({@link SAFE_REF_RE}) and passed as
 * an argv literal, so neither an option-injection (`--force`) nor a shell
 * metacharacter can travel through it.
 */
async function pushAction(args: GitToolArgs, ctx: ToolContext): Promise<string> {
  const remoteArg = String(args.remote ?? '').trim();
  const branchArg = String(args.branch ?? '').trim();

  for (const [label, value] of [['remote', remoteArg], ['branch', branchArg]] as const) {
    if (!value) continue;
    if (!SAFE_REF_RE.test(value) || value.includes('..')) {
      return `Error: git push ${label} '${value}' is not a plain remote/branch name — denied.`;
    }
  }

  // Resolve the defaults from the repository, so BOTH the confirmation and the
  // result can name exactly what moves.
  let remote = remoteArg;
  if (!remote) {
    const remotes = git(['remote'], ctx);
    remote = remotes.ok ? (remotes.out.split('\n')[0] ?? '').trim() : '';
  }
  if (!remote) {
    return (
      'Error: git push has no remote to push to. Add one first ' +
      '(git remote add origin <url>), or pass remote explicitly.'
    );
  }

  let branch = branchArg;
  if (!branch) {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx);
    branch = head.ok ? head.out.trim() : '';
  }
  if (!branch || branch === 'HEAD') {
    return 'Error: git push needs a branch to push, and HEAD is detached. Check out a branch, or pass branch explicitly.';
  }

  // ── The gate ────────────────────────────────────────────────────────────
  const namedByRequest = requestRequestsPush(ctx.authorizationRequest ?? '');
  // The user may also have granted off-machine actions for this session — an
  // explicit go-ahead that covers a push the request did not name.
  const gitGrant = grantCategoryOfTool('git');
  const grantCovers = !namedByRequest && gitGrant !== null && sessionGrantCovers(ctx.planStore, gitGrant);
  if (!args.confirm && !namedByRequest && !grantCovers) {
    // `external` is what makes the ask unconditional here — even a request that
    // authorized writes cannot authorize this, because it was not the user who
    // decided the work should leave this machine.
    ctx.pendingConfirmation = { tool: 'git', command: `git push ${remote} ${branch}`, category: 'external' };
    const verdict = decideStateChange({
      tool: 'git push',
      action: `pushing ${branch} to '${remote}'`,
      changeClass: 'external',
      namedByRequest: false,
      authorizedByRequest: ctx.writesAuthorized?.authorized === true,
    });
    return (
      `git push: pushing ${branch} to '${remote}' sends this work to a remote that other ` +
      `people and CI can see, so it is the user's call (${verdict.reason}). ` +
      'Call ask_user (show the branch, the remote, and the commits that would move), then ' +
      're-call git push with confirm:true only if the user agreed.'
    );
  }

  // Longer than the read-only timeout: a push carries the whole working history
  // over the network, and timing out mid-push is worse than waiting.
  const pushed = gitCombined(['push', '-u', remote, branch], ctx, 180_000);
  if (!pushed.ok) return `git push failed: ${pushed.out}`;

  let tagsNote = '';
  if (args.tags) {
    const tags = gitCombined(['push', remote, '--tags'], ctx, 120_000);
    tagsNote = tags.ok ? '; pushed tags' : `; but pushing tags failed: ${tags.out}`;
  }

  const reported = !args.confirm;
  const reason = namedByRequest
    ? 'the request itself names the push'
    : 'allowed for this session by the user';
  if (reported) {
    // Reported, never silent — same contract as the commit path's autonomous
    // write: the user must be able to see where their work just went.
    ctx.emit?.('autonomy:write-applied', {
      tool: 'git push',
      remote,
      branch,
      reason,
    }, 'tool-loop');
  }

  const result = `✅ Pushed ${branch} → ${remote}${tagsNote}:\n${pushed.out.slice(0, 800)}`;
  if (!reported) return result;
  return (
    `${result}\n💡 Pushed without asking: ${reason}. ` +
    'State the push in your answer so the user can see where the work went.'
  );
}

export async function runGitTool(args: GitToolArgs, ctx: ToolContext): Promise<string> {
  const action = String(args?.action ?? '').trim();
  if (!action) return 'Error: git tool needs an action (status | log | diff | commit | push).';

  // Deny guard — an action that maps to a run_terminal-denied command is
  // refused before anything runs (parity with the shared deny list).
  const denied = deniedGitAction(action);
  if (denied) return `Error: ${denied}`;
  if (!['status', 'log', 'diff', 'commit', 'push'].includes(action)) {
    return `Error: unknown git action '${action}' — use status | log | diff | commit | push.`;
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

  // ── action === 'push' — the OUTBOUND path (external effect, own gate) ───
  if (action === 'push') {
    return pushAction(args, ctx);
  }

  // ── action === 'commit' — the GATED path ────────────────────────────────
  const message = String(args.message ?? '').trim();
  if (!message) {
    return 'Error: git commit needs a message (git refuses empty messages — it would open an editor). Call ask_user for the commit message, then re-call with it.';
  }
  // ── G16: the gate's missing input is whether the USER asked for the commit ─
  // "Commit these changes" IS the approval, and asking for it again is a round
  // trip in the most common dev flow. Note the asymmetry, and why it is right:
  // the commit is local and recoverable (a reflog entry, not a lost file), but
  // it is NOT marked `recoverable` here — only the request NAMING a commit
  // unlocks it, so a commit the model decided on its own still asks.
  let decidedAutonomously = false;
  let autonomyReason = '';
  if (!args.confirm) {
    const verdict = decideStateChange({
      tool: 'git commit',
      action: 'recording a commit in this repository',
      changeClass: 'local-state',
      namedByRequest: requestRequestsCommit(ctx.authorizationRequest ?? ''),
      authorizedByRequest: ctx.writesAuthorized?.authorized === true,
    });
    if (verdict.action !== 'proceed') {
      return (
        'git commit: this changes the repository history and needs explicit confirmation ' +
        `(${verdict.reason}). ` +
        'Call ask_user (yes/no — show the diff card first so the user sees exactly what will be committed), ' +
        'then re-call git commit with the SAME message plus confirm:true only if the user agreed.'
      );
    }
    decidedAutonomously = true;
    autonomyReason = verdict.reason;
    ctx.emit?.('autonomy:write-applied', {
      tool: 'git commit',
      message,
      files: args.files ?? [],
      reason: verdict.reason,
    }, 'tool-loop');
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
  const result = `✅ Committed (${what}):\n${committed.out.slice(0, 800)}`;
  if (!decidedAutonomously) return result;
  // Reported, never silent: the user must be able to see (and undo) a commit
  // they did not explicitly request in this turn's wording.
  return (
    `${result}\n💡 Committed without asking: ${autonomyReason}. ` +
    'State the commit in your answer so the user can amend or reset it.'
  );
}

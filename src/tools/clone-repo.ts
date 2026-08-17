/**
 * P3a — clone_repo tool (assess OTHER people's projects).
 *
 * The Copilot capability the user compared us against: "cloned the repo in a
 * temp dir and did analysis". The agent can now clone any git repo (depth-1,
 * shallow) into a SANDBOXED cache dir and point the whole coding-tool family
 * at it — read_file / list_dir / glob / code_search / run_terminal all
 * resolve against `ctx.cwd`, so setting it to the clone scopes the entire
 * turn to the assessed project. The user's own workspace is never touched.
 *
 * Security (deny-first, the standing rule):
 *   - URL must match http(s):// or git@ / git:// — nothing else.
 *   - The URL is validated for shell metacharacters and passed as an argv
 *     array to `git` (execFileSync, NO shell) — injection is structurally
 *     impossible, and the validation is the second line of defense.
 *   - Depth-1 shallow ONLY — never a full clone (brief: "depth-1 shallow
 *     only; the clone dir is outside the user workspace and marked
 *     ephemeral").
 *   - Clone lives in ~/.buff/clones/<sha256(url)> — a hashed cache OUTSIDE
 *     the user workspace; re-clone on missing .git, reuse otherwise (no
 *     stray clones accumulate in the user's project).
 *
 * Never throws: every failure returns a helpful string (a failed clone must
 * never kill the turn).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import type { ToolContext } from './registry.js';

/** The tool's args (zod-validated in the registry). */
export interface CloneRepoArgs {
  /** Git repository URL — http(s)://, git@host:, or git:// only. */
  url: string;
  /** Optional branch/tag/commit to check out (default: the remote default). */
  ref?: string;
}

/** Only these URL shapes are accepted — everything else is denied. */
const URL_RE =
  /^(https?:\/\/[^\s]+|git@[^\s:]+:[^\s]+|git:\/\/[^\s]+)$/i;

/** Shell metacharacters that make a URL immediately suspect (deny-first). */
const SHELL_METACHARS = /[;&|`$()<>"'\\\s]/;

/** The ephemeral cache root for clones (outside the user workspace). */
function clonesDir(): string {
  return join(homedir(), '.buff', 'clones');
}

/** Hashed cache path for a URL (stable — re-clones reuse the same dir). */
function cloneTarget(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return join(clonesDir(), hash);
}

/**
 * Clone (or reuse) a repo, then scope the whole turn to it via ctx.cwd.
 * Returns a short summary the model sees (path + top-level entries).
 */
export async function runCloneRepo(args: CloneRepoArgs, ctx: ToolContext): Promise<string> {
  const url = String(args?.url ?? '').trim();
  if (!url) return 'Error: clone_repo needs a url (http(s):// or git@host:path).';

  // Deny-first URL validation — reject before any command is built.
  if (!URL_RE.test(url)) {
    return 'Error: clone_repo url must be http(s)://, git@host:path, or git:// — got an unsupported form (denied).';
  }
  if (SHELL_METACHARS.test(url)) {
    return 'Error: clone_repo url contains shell metacharacters — denied.';
  }
  if (args?.ref && SHELL_METACHARS.test(String(args.ref))) {
    return 'Error: clone_repo ref contains shell metacharacters — denied.';
  }

  const target = cloneTarget(url);
  try {
    if (!existsSync(join(target, '.git'))) {
      mkdirSync(clonesDir(), { recursive: true });
      const argv = ['clone', '--depth', '1', '--quiet'];
      if (args?.ref) argv.push('--branch', String(args.ref));
      argv.push(url, target);
      // argv array + execFileSync → NO shell, injection structurally impossible.
      execFileSync('git', argv, { stdio: 'ignore', timeout: 120_000 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: git clone failed for ${url}: ${msg.slice(0, 200)}`;
  }

  // Scope the whole coding-tool family to the clone (read_file/list_dir/glob/
  // code_search/run_terminal all resolve against ctx.cwd).
  ctx.cwd = target;

  let entries = '';
  try {
    entries = readdirSync(target)
      .slice(0, 30)
      .map((e) => `  ${e}`)
      .join('\n');
  } catch {
    entries = '  (unreadable)';
  }

  const refNote = args?.ref ? ` @ ${args.ref}` : '';
  return (
    `✅ Cloned ${url}${refNote} → ${target}\n` +
    `Workspace is now scoped to the clone — read_file / list_dir / glob / code_search / run_terminal operate on it. ` +
    `The user's own project is untouched (the clone is an ephemeral cache under ~/.buff/clones/).\n` +
    `Top-level entries:\n${entries}`
  );
}

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
 *   - Clone lives in ~/.nuvira/clones/<sha256(url)> — a hashed cache OUTSIDE
 *     the user workspace; re-clone on missing .git, reuse otherwise (no
 *     stray clones accumulate in the user's project).
 *
 * Never throws: every failure returns a helpful string (a failed clone must
 * never kill the turn).
 */
import type { ToolContext } from './registry.js';
/** The tool's args (zod-validated in the registry). */
export interface CloneRepoArgs {
    /** Git repository URL — http(s)://, git@host:, or git:// only. */
    url: string;
    /** Optional branch/tag/commit to check out (default: the remote default). */
    ref?: string;
}
/**
 * Clone (or reuse) a repo, then scope the whole turn to it via ctx.cwd.
 * Returns a short summary the model sees (path + top-level entries).
 */
export declare function runCloneRepo(args: CloneRepoArgs, ctx: ToolContext): Promise<string>;
//# sourceMappingURL=clone-repo.d.ts.map
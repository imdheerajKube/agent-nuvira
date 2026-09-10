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
    files: Array<{
        path: string;
        body: string;
    }>;
    summary: string;
}
/** Split a unified diff into per-file sections (diff --git … hunk blocks). */
export declare function parseDiffIntoSections(diff: string): Array<{
    path: string;
    body: string;
}>;
/** The deny guard: an action name that maps to a run_terminal-denied git command. */
export declare function deniedGitAction(action: string): string | null;
export declare function runGitTool(args: GitToolArgs, ctx: ToolContext): Promise<string>;
//# sourceMappingURL=git-tool.d.ts.map
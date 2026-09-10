/**
 * P0.4 — `run_terminal` — the verify tool (`src/tools/run-terminal.ts`).
 *
 * The ask (master-plan P0.4): *"test not only by scripts but by actual
 * invocation"* — the agent must run a single test file, a typecheck, a git
 * diff, and see the REAL output in the conversation, not a black-box
 * summary. This is the tool that turns "the tests pass" into verifiable
 * truth the agent can iterate on: run → read failure → edit → re-run.
 *
 * Security model — deny-first, three classes:
 *
 * 1. **deny** — NEVER runs, regardless of confirm. Destructive/system-level
 *    commands outside the loop's business: `sudo`, `git push`, `git reset
 *    --hard`, `git clean`, `git checkout -- .`, `rm -rf` at dangerous
 *    targets, mkfs/dd/shutdown/kill -9, fork bombs. The deny regexes scan
 *    the ENTIRE command string — so `echo $(rm -rf /)` and piped variants
 *    are caught too, not just a leading command.
 * 2. **verify** — read-only check commands run WITHOUT confirmation:
 *    typecheck/test/lint/build runners and git read-only + basic shell
 *    reads. This is a POSITIVE allowlist of leading-token prefixes —
 *    anything not listed falls through to confirm (deny-first default).
 * 3. **confirm** — everything else (state-changing: installs, mutations,
 *    network, arbitrary code) requires `confirm: true`, which the model
 *    only has after the user approved via ask_user — the same gate as
 *    edit_file/write_file and run_cli.
 *
 * Also: a leading `buff`/`agent-nuvira` command is routed to run_cli (the
 * manifest resolver) instead — no double execution paths for CLI control.
 *
 * Output: capped (a 40MB log must not flood context) and masked
 * (maskSenderId — phone numbers never echo back in full).
 */
import type { ToolContext } from './registry.js';
type CommandClass = 'deny' | 'verify' | 'confirm';
/** Classify a command — deny regexes on the FULL string, prefix match on tokens. */
export declare function classifyCommand(command: string): CommandClass;
/** ─── The tool ───────────────────────────────────────────────────────────── */
export interface RunTerminalArgs {
    command: string;
    confirm?: boolean;
    timeout_ms?: number;
}
export declare function runTerminalTool(args: RunTerminalArgs, ctx: ToolContext): Promise<string>;
export {};
//# sourceMappingURL=run-terminal.d.ts.map
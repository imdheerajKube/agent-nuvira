/**
 * Interactive missing-system-tool prompt for the runner (enterprise parity).
 *
 * When a command needs a system tool that is not installed (e.g. `zip` for
 * packaging an NVDA addon, `git`, `make`, `cmake`), the runner must NOT fail
 * silently and must NOT install OS-level software without consent. Instead it:
 *
 *   1. Detects the missing tool from the failing command.
 *   2. Recommends the OS-appropriate install command (Homebrew on macOS,
 *      apt/dnf/apk on Linux, winget/choco on Windows).
 *   3. Asks the user for approval (interactive TTY) — "install now", "show me
 *      manual steps", or "skip".
 *   4. On approval the runner executes the install, verifies the tool, and
 *      RE-RUNS the original command so the task completes.
 *
 * Non-interactive (piped/CI) stdin never blocks: the recommended command is
 * printed and the task fails with actionable instructions — the manual task is
 * left to the user, exactly like a human agent would hand off a step it cannot
 * complete alone (e.g. generating a token).
 *
 * This module is small and dependency-light so it can be unit tested in
 * isolation (inquirer mocked), mirroring failover-prompt.ts / weak-model-prompt.ts.
 */
/** What the user chose when a required system tool is missing. */
export type ToolInstallChoice = 'install' | 'manual' | 'skip';
/** Per-platform install commands for a known tool. */
export interface ToolInstallOptions {
    darwin?: string;
    linux?: string;
    win32?: string;
}
/** Whether we have an install recipe for this tool on any OS. */
export declare function isKnownSystemTool(tool: string): boolean;
/**
 * Pick the concrete install command for a tool on this machine.
 *
 * @param tool      Bare command name (e.g. 'zip').
 * @param platform  process.platform value ('darwin' | 'linux' | 'win32').
 * @param hasPkgMgr Predicate answering "is this package manager on PATH?"
 *                  (the runner injects its commandExists check).
 * @returns The full shell command to install the tool, or null when no recipe
 *          applies to this platform/package-manager combination.
 */
export declare function toolInstallCommand(tool: string, platform: NodeJS.Platform, hasPkgMgr: (name: string) => boolean): string | null;
/**
 * Ask the user how to handle a missing system tool. TTY-only — callers must
 * gate on process.stdin.isTTY (non-interactive callers fall through to the
 * fail-with-instructions path instead of blocking).
 *
 * @param tool   Bare command name that is missing (e.g. 'zip').
 * @param cmd    The concrete OS-appropriate install command to recommend.
 * @returns 'install' to run the install and continue, 'manual' to show steps
 *          and fail, or 'skip' to continue without installing.
 */
export declare function promptToolInstall(tool: string, cmd: string): Promise<ToolInstallChoice>;
/** Render the manual-install instructions for a tool (used when the user asks, or in non-interactive mode). */
export declare function manualInstallSteps(tool: string, cmd: string): string;
//# sourceMappingURL=tool-install-prompt.d.ts.map
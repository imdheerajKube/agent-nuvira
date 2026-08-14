/**
 * RunnerAgent — Executes shell commands in the project directory and captures output.
 *
 * This is the agent that makes agent-nuvira capable of *running* the programs
 * it creates. Without this, the system can write files but can never execute
 * them or show the user what happened.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-03-run", "description": "Run: python hello.py", "agentType": "runner", "dependsOn": ["step-02-write"] }
 * ```
 *
 * The command to run is determined by:
 * 1. The task description — if it contains a command wrapped in backticks
 *    (e.g., "Run `python hello.py`"), that command is extracted and executed.
 * 2. The "Run:" prefix — if the description starts with "Run:", the rest is
 *    treated as the command (e.g., "Run: python hello.py").
 * 3. The LLM fallback — if no explicit command is found, the LLM is asked
 *    what command to run based on the current context (files created, project type).
 *
 * Output is stored in context metadata as `runResult` and returned in the summary.
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * Result of running a command, stored in context.metadata.runResult.
 */
export interface RunResult {
    /** Whether the command exited with code 0 */
    success: boolean;
    /** The exact command that was executed */
    command: string;
    /** Process exit code */
    exitCode: number;
    /** Standard output */
    stdout: string;
    /** Standard error */
    stderr: string;
    /** Duration in milliseconds */
    duration: number;
    /** Error message if execSync threw */
    error?: string;
    /** Whether dependencies were auto-installed before a retry */
    dependencyInstallAttempted?: boolean;
    /** Whether the dependency install succeeded */
    dependencyInstallSucceeded?: boolean;
    /** Package manager / tool used for the install (e.g. 'npm', 'brew', 'winget') */
    dependencyInstallTool?: string;
    /** Whether the tool itself had to be installed first (e.g. Homebrew) */
    dependencyInstallToolInstalled?: boolean;
}
/** A detected dependency-install plan for a project */
export interface InstallPlan {
    /** The package-manager tool to run (e.g. 'npm', 'pip', 'brew', 'cargo') */
    tool: string;
    /** The full install command to execute */
    command: string;
    /** The manifest file that triggered the plan */
    manifest: string;
}
/** Result of a dependency-install attempt (including tool bootstrapping) */
export interface DependencyInstallResult {
    /** Whether the install succeeded */
    success: boolean;
    /** The install command that was attempted */
    command: string;
    /** The package-manager tool used */
    tool?: string;
    /** Whether the tool itself was installed first */
    toolInstalled?: boolean;
    /** Human-readable detail for logs */
    message?: string;
}
/**
 * RunnerAgent — Executes shell commands and captures output.
 */
export declare class RunnerAgent extends Agent {
    readonly name = "Runner";
    readonly description = "Executes shell commands and captures output";
    /** Stored LLM call function for command suggestion fallback */
    private _callLLM?;
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Determine the command to run.
     *
     * Priority order:
     * 1. Parse from task description (backtick-wrapped command or "Run:" prefix)
     * 2. Ask the LLM what command to run based on the files that were created
     */
    private determineCommand;
    /**
     * Execute a command inside a Docker sandbox container.
     * Falls back to host execution if Docker is not available.
     */
    private executeWithDocker;
    /**
     * Check whether a command is likely to succeed before executing it.
     * Currently validates:
     * - `npm test` / `npm run test`: checks that the project's package.json has a `test` script
     */
    private isCommandAvailable;
    /**
     * Rewrite interpreter tokens that don't exist on this machine to their
     * versioned equivalents. On modern macOS/Ubuntu there is no `python` — only
     * `python3` (and `pip3`) — so a command like `python main.py` exits 127
     * even though Python IS installed. The repair loop was re-running the same
     * broken `python …` command until the budget was exhausted. Normalizing
     * here (before execution and before any retry) is what makes Python tasks
     * actually runnable.
     */
    private normalizeInterpreter;
    /**
     * Execute a command directly on the host machine.
     * Validates the command first, and falls back to LLM suggestion if the command is not available.
     */
    /**
     * Heuristic: does this failure look like a missing dependency?
     * Matches common "Cannot find module", "command not found", and ENOENT errors.
     */
    private looksLikeMissingDependency;
    /**
     * Detect which package manager a project needs based on its manifest files.
     * Supports npm/yarn/pnpm, pip (requirements/setup/pyproject), bundler,
     * cargo, go, composer, and dart pub.
     */
    private detectInstallPlan;
    /**
     * Check whether a CLI tool is available on PATH (cross-platform).
     */
    private commandExists;
    /**
     * Bootstrap-install a missing package-manager tool so that the project's
     * dependencies can be installed. Handles Homebrew, winget, choco, npm,
     * pip, cargo, and more — installing the tool itself if it is missing.
     */
    private installTool;
    /** Install Node.js (which bundles npm) via the platform package manager. */
    private installNodeViaPlatform;
    /** Install Python via the platform package manager (so pip can be bootstrapped). */
    private installPythonViaPlatform;
    /** Install Ruby via the platform package manager. */
    private installRubyViaPlatform;
    /** Install PHP via the platform package manager. */
    private installPhpViaPlatform;
    /** Install Go via the platform package manager. */
    private installGoViaPlatform;
    /**
     * Run an install command and return its outcome.
     */
    private runInstallCommand;
    /**
     * When no manifest exists, detect a missing interpreter/tool from the failed
     * command itself (e.g. "python3 script.py" → python3 → install Python).
     * This lets the runner install bare tools even in manifest-less directories.
     */
    private detectToolFromCommand;
    /**
     * Install dependencies for the project using the appropriate package manager
     * (npm, pip, brew, cargo, etc.). If the package manager itself is missing,
     * it is bootstrap-installed first (e.g. Homebrew on macOS, winget on Windows).
     * When no manifest is present, falls back to installing the missing
     * interpreter/tool referenced by the failed command.
     *
     * Controlled by context.metadata.autoInstallTools !== false — set to false
     * to only attempt the install command without installing missing tools.
     */
    private installDependencies;
    private executeOnHost;
    /**
     * True when this runner execution is a repair/alternative-approach attempt
     * (the ErrorRepairEngine appends these markers to context.goal).
     */
    private isRepairAttempt;
    /**
     * Ask the LLM for the NEXT command after a previous command failed.
     * This is what makes the repair loop ADAPT instead of re-running the same
     * failing command: the LLM sees the task, the previous command, its captured
     * stdout/stderr, AND the full project context (written files + reference
     * docs), and proposes a corrected command (e.g. create the Cloudflare Pages
     * project before deploying, or — when the deliverable CANNOT run in this
     * environment — the PACKAGING command that produces the deployable artifact).
     */
    private askLLMForRepairCommand;
    /**
     * Fallback: ask the LLM what command to run based on the project context.
     * Includes the written file contents, package.json metadata, and curated
     * reference docs (referenceDocsFor) so the LLM can choose a CORRECT action —
     * including recognizing when the deliverable CANNOT run in this environment
     * (a plugin/addon that needs its host app) and proposing the PACKAGING
     * command that produces the deployable artifact instead of a useless run.
     */
    private askLLMForCommand;
    /**
     * Deterministic "cannot run here → package it" detection.
     *
     * When the project written for this task is a known addon/package whose
     * runtime is NOT this machine (NVDA addon = manifest.ini + globalPlugins/
     * needs the NVDA screen reader), running it can never succeed — the correct
     * build action is to PACKAGE the source tree into the deployable artifact.
     * This returns that packaging command, or null when no deterministic target
     * exists (falls through to the LLM).
     *
     * Currently supports: NVDA addons (manifest.ini + globalPlugins/ → zip into
     * a .nvda-addon archive, the real distribution format per the reference doc).
     */
    private detectPackagingCommand;
    /**
     * Detect a missing system tool referenced by a command (enterprise parity).
     *
     * Scans every token of the command (so compound commands like
     * `cd addon && zip -r …` are covered), checks each against the known-tool
     * recipes, and returns the FIRST missing tool name — or null when nothing
     * is missing / unknown. Only the bare tool name is checked (paths like
     * /usr/bin/zip are unwrapped to zip).
     */
    private detectMissingSystemTool;
    /**
     * Ensure every known system tool referenced by a command is installed.
     *
     * Enterprise flow (parity with a human agent):
     * - Tool present → null (continue).
     * - Tool missing + interactive TTY → ask the user with the OS-appropriate
     *   install command. On 'install': execute it, verify, and continue. On
     *   'manual'/'skip': return the manual steps as the error (the user takes
     *   over the manual task — e.g. installing brew, generating a token).
     * - Tool missing + non-interactive (piped/CI) → never block; return the
     *   recommended install command as the error so the user can run it.
     *
     * Returns null to proceed, or an error string that fails the step.
     */
    private ensureSystemTool;
}
//# sourceMappingURL=runner.d.ts.map
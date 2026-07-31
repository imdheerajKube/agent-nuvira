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
     * Fallback: ask the LLM what command to run based on the project context.
     * Includes project's package.json metadata so the LLM can make an informed choice.
     */
    private askLLMForCommand;
}
//# sourceMappingURL=runner.d.ts.map
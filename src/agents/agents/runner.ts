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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';
import { runShell, runShellSync } from '../../utils/shell.js';
import { SandboxManager } from '../../sandbox/manager.js';
import { detectProjectImage } from '../../sandbox/images.js';
import { getSandboxConfig } from '../../sandbox/types.js';
import { referenceDocsFor } from '../reference-docs.js';
import { detectNoOpCommand } from '../artifact-verification.js';
import {
  isKnownSystemTool,
  manualInstallSteps,
  promptToolInstall,
  toolInstallCommand,
  type ToolInstallChoice,
} from '../../cli/tool-install-prompt.js';

/** Maximum stdout/stderr length to store in context metadata */
const MAX_OUTPUT_LENGTH = 10_000;

/** Timeout per command in milliseconds (default: 2 minutes) */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Maximum number of fallback attempts when command validation fails */
const MAX_FALLBACK_ATTEMPTS = 2;

/** Maximum number of auto-dependency-install + retry cycles */
const MAX_DEP_INSTALL_RETRIES = 1;

/** Timeout for installing a missing package-manager tool itself (10 min) */
const TOOL_INSTALL_TIMEOUT_MS = 600_000;

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
  /**
   * True when the command exited 0 while provably doing nothing — `zip` matching
   * none of its inputs, `git` with nothing to commit. A caller must not treat an
   * exit code as evidence of a deliverable when this is set (
   * see `artifact-verification.ts` for the live failure this came from).
   */
  producedNothing?: boolean;
  /** Why the command is considered a no-op, for the trace and the user. */
  noOpReason?: string;
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
export class RunnerAgent extends Agent {
  readonly name = 'Runner';
  readonly description = 'Executes shell commands and captures output';

  /** Stored LLM call function for command suggestion fallback */
  private _callLLM?: LLMCallFn;

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    // Store the LLM function for command validation fallback
    this._callLLM = callLLM;

    try {
      // 1. Determine which command to run
      this.report(context, 'thinking', 'Determining which command to run…');
      let command = await this.determineCommand(context, callLLM);
      if (!command) {
        this.report(context, 'failed', 'Could not determine a command to run');
        return {
          success: false,
          summary: 'No command to run',
          error: 'Could not determine which command to execute from the task description or context.',
        };
      }

      // Normalize `python` → `python3` / `pip` → `pip3` when the bare binary
      // is missing (macOS/Ubuntu ship only the versioned ones). Done at the
      // SINGLE choke point so BOTH host and Docker/sandbox execution get the
      // fix — otherwise the exit-127 repair loop just re-runs the same broken
      // `python …` command until the budget is exhausted.
      command = this.normalizeInterpreter(command);

      // ENTERPRISE TOOL HANDLING: if the command needs a system tool that is
      // not installed (e.g. `zip` for packaging), detect it BEFORE running and
      // ask the user to approve an OS-appropriate install (interactive TTY) or
      // surface the manual steps (non-interactive) — never fail silently and
      // never install OS software without consent. On approval the install
      // runs, the tool is verified, and the original command proceeds.
      const toolOutcome = await this.ensureSystemTool(context, command);
      if (toolOutcome !== null) {
        // Either the user declined/skipped (return its error) or the install
        // failed — the command cannot run without the tool.
        if (context.metadata.verboseLogging) {
          logger.warn(`     🛠️  Missing system tool handling: ${toolOutcome}`);
        }
        return {
          success: false,
          summary: `Required tool not available: ${toolOutcome}`,
          error: toolOutcome,
        };
      }

      this.report(context, 'running', `Executing \`${command}\` and capturing output…`);

      // Check if we should run inside a Docker sandbox
      const useDocker = context.metadata.useDockerSandbox === true ||
        getSandboxConfig().enabled === true;

      if (useDocker) {
        return await this.executeWithDocker(context, command);
      }

      // 2. Execute the command on the host via shared method
      return await this.executeOnHost(context, command);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Runner failed',
        error: msg,
      };
    }
  }

  /**
   * Determine the command to run.
   *
   * Priority order:
   * 1. Parse from task description (backtick-wrapped command or "Run:" prefix)
   * 2. Ask the LLM what command to run based on the files that were created
   */
  private async determineCommand(context: AgentContext, callLLM: LLMCallFn): Promise<string | null> {
    // Find the current 'runner' task in the plan. When several tasks run in
    // parallel, the orchestrator marks the CURRENT step via
    // metadata.currentTaskId so the runner uses ITS OWN description.
    const currentTaskId = context.metadata.currentTaskId as string | undefined;
    const runnerTask = context.taskPlan.find(
      (s) => s.agentType === 'runner' &&
        (currentTaskId ? s.id === currentTaskId : s.status === 'running'),
    );
    const description = runnerTask?.description || context.goal;

    // REPAIR-AWARE (adaptive repair loop): when this execution is a repair or
    // alternative-approach attempt (the repair engine appends [REPAIR ATTEMPT]
    // / [ALTERNATIVE APPROACH] markers to context.goal), the previous command
    // FAILED. Blindly re-extracting the same backticked command from the
    // unchanged task description would re-run the identical failure until the
    // budget dies — the exact bug observed with `wrangler pages deploy` (4
    // identical runs). Instead, ask the LLM for the NEXT command informed by
    // the previous attempt's captured output.
    if (this.isRepairAttempt(context)) {
      const repairCommand = await this.askLLMForRepairCommand(context, callLLM, description);
      if (repairCommand) return repairCommand;
      // LLM unavailable — fall through to the standard extraction strategies
      // (better to re-run a possibly-fixed context than to fail outright).
    }

    // Strategy 1: Extract command from backticks in the description
    // e.g., "Run `python hello.py` and verify output"
    const backtickMatch = description.match(/`([^`]+)`/);
    if (backtickMatch) {
      return backtickMatch[1].trim();
    }

    // Strategy 2: Extract from "Run:" prefix
    // e.g., "Run: python hello.py"
    const runPrefixMatch = description.match(/^Run:\s*(.+)/i);
    if (runPrefixMatch) {
      return runPrefixMatch[1].trim();
    }

    // Strategy 3: Ask the LLM what command to run
    return await this.askLLMForCommand(context, callLLM);
  }

  /**
   * Execute a command inside a Docker sandbox container.
   * Falls back to host execution if Docker is not available.
   */
  private async executeWithDocker(context: AgentContext, command: string): Promise<AgentResult> {
    const sandboxManager = new SandboxManager();
    let containerId = '';

    try {
      // Check Docker availability
      const dockerAvailable = await sandboxManager.isDockerAvailable();
      if (!dockerAvailable) {
        // Fall back to host execution
        return this.executeOnHost(context, command);
      }

      // Detect the right image for the project
      const image = detectProjectImage(context.workingDirectory);

      // Allow timeout override via context.metadata.runnerTimeout
      const timeoutMs = (typeof context.metadata.runnerTimeout === 'number')
        ? context.metadata.runnerTimeout
        : DEFAULT_TIMEOUT_MS;

      // Create a Docker container (use default /workspace as workdir)
      containerId = await sandboxManager.createContainer(
        image.image,
        {
          memoryLimit: '512m',
          cpuLimit: 0.5,
          timeoutMs,
          networkAccess: false,
        },
      );

      // Copy project files to the container's workspace
      await sandboxManager.copyProjectToContainer(containerId, context.workingDirectory);

      // Run the command inside the container
      if (context.metadata.verboseLogging) {
        logger.info(`     Running (Docker): ${command}`);
      }

      const result = await sandboxManager.runCommand(containerId, command, timeoutMs);

      // Build run result from sandbox result. Same question as the host path:
      // a successful exit is not evidence that anything was produced.
      const noOpReason = result.success
        ? detectNoOpCommand(command, result.stdout, result.stderr)
        : null;

      const runResult: RunResult = {
        success: result.success,
        producedNothing: noOpReason !== null,
        noOpReason: noOpReason ?? undefined,
        command,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, MAX_OUTPUT_LENGTH),
        stderr: result.stderr.slice(0, MAX_OUTPUT_LENGTH),
        duration: result.durationMs,
        error: result.error,
      };

      context.metadata['runResult'] = runResult;

      // Build summary
      const lines: string[] = [];
      lines.push(`Command: ${command} (Docker)`);
      lines.push(`Exit code: ${result.exitCode}`);
      lines.push(`Duration: ${result.durationMs}ms`);

      if (result.stdout) {
        const truncated = result.stdout.length > 500;
        lines.push(`stdout:${truncated ? ' (first 500 chars)' : ''}`);
        lines.push(result.stdout.slice(0, 500));
        if (truncated) lines.push(`... (${result.stdout.length - 500} more chars)`);
      }

      if (result.stderr && result.exitCode !== 0) {
        const truncated = result.stderr.length > 500;
        lines.push(`stderr:${truncated ? ' (first 500 chars)' : ''}`);
        lines.push(result.stderr.slice(0, 500));
        if (truncated) lines.push(`... (${result.stderr.length - 500} more chars)`);
      }

      // Clean up
      await sandboxManager.destroyContainer(containerId).catch(() => {});

      return {
        // A command that matched nothing is not a completed step, even at exit 0.
        success: result.exitCode === 0 && noOpReason === null,
        summary: noOpReason !== null
          ? `⚠️ Command exited 0 but did nothing (Docker): ${noOpReason} — ${command}`
          : result.exitCode === 0
            ? `✅ Command succeeded (Docker): ${command}`
            : `❌ Command failed (exit ${result.exitCode}): ${command}`,
        details: lines.join('\n'),
        error: noOpReason ?? (result.error || undefined),
      };
    } catch (err) {
      if (containerId) {
        await sandboxManager.destroyContainer(containerId).catch(() => {});
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Docker sandbox execution failed',
        error: msg,
      };
    }
  }

  /**
   * Check whether a command is likely to succeed before executing it.
   * Currently validates:
   * - `npm test` / `npm run test`: checks that the project's package.json has a `test` script
   */
  private isCommandAvailable(command: string, workingDir: string): { available: boolean; reason?: string } {
    // Check npm test commands
    const npmTestPattern = /^npm\s+(run\s+)?test(\s|$)/;
    if (npmTestPattern.test(command.trim())) {
      const pkgPath = join(workingDir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
          if (!pkg.scripts?.test) {
            return {
              available: false,
              reason: `Project at ${workingDir} has no "test" script in package.json. ` +
                `The command "${command}" would fail with "Missing script: test".`,
            };
          }
        } catch {
          return {
            available: false,
            reason: `Could not parse package.json at ${pkgPath} to check for a test script.`,
          };
        }
      } else {
        return {
          available: false,
          reason: `No package.json found at ${workingDir}. The command "${command}" requires an npm project.`,
        };
      }
    }

    return { available: true };
  }

  /**
   * Rewrite interpreter tokens that don't exist on this machine to their
   * versioned equivalents. On modern macOS/Ubuntu there is no `python` — only
   * `python3` (and `pip3`) — so a command like `python main.py` exits 127
   * even though Python IS installed. The repair loop was re-running the same
   * broken `python …` command until the budget was exhausted. Normalizing
   * here (before execution and before any retry) is what makes Python tasks
   * actually runnable.
   */
  private normalizeInterpreter(command: string): string {
    if (!command || process.platform === 'win32') return command;
    const hasPython = this.commandExists('python');
    const hasPython3 = this.commandExists('python3');
    const hasPip = this.commandExists('pip');
    const hasPip3 = this.commandExists('pip3');
    if (hasPython && hasPip) return command; // common case — nothing to do

    return command
      .split('&&')
      .map((segment) => {
        let seg = segment;
        if (!hasPython && hasPython3) {
          seg = seg.replace(/^(\s*)(python)(?=\s|$)/g, '$1python3');
        }
        if (!hasPip && hasPip3) {
          seg = seg.replace(/^(\s*)(pip)(?=\s|$)/g, '$1pip3');
        }
        return seg;
      })
      .join('&&');
  }

  /**
   * Execute a command directly on the host machine.
   * Validates the command first, and falls back to LLM suggestion if the command is not available.
   */
  /**
   * Heuristic: does this failure look like a missing dependency?
   * Matches common "Cannot find module", "command not found", and ENOENT errors.
   */
  private looksLikeMissingDependency(command: string, stdout: string, stderr: string, execError?: string): boolean {
    const haystack = `${command}\n${stdout}\n${stderr}\n${execError || ''}`.toLowerCase();
    const signals = [
      'cannot find module',
      'module not found',
      'command not found',
      'is not recognized',
      'not recognized as an internal',
      'enoent',
      'no such file',
      'could not resolve',
      'cannot find package',
      'missing script: test',
      'npm error',
      'pip: command not found',
      'moduleerror',
      'unable to resolve',
      'could not find',
      'is not installed',
      'not found in path',
      'cannot be found',
    ];
    return signals.some((s) => haystack.includes(s));
  }

  /**
   * Detect which package manager a project needs based on its manifest files.
   * Supports npm/yarn/pnpm, pip (requirements/setup/pyproject), bundler,
   * cargo, go, composer, and dart pub.
   */
  private detectInstallPlan(workingDir: string): InstallPlan | null {
    // JavaScript / TypeScript — check lockfiles FIRST because a pnpm/yarn
    // project also contains a package.json. Lockfile presence wins.
    if (existsSync(join(workingDir, 'pnpm-lock.yaml'))) {
      return { tool: 'pnpm', command: 'pnpm install', manifest: 'pnpm-lock.yaml' };
    }
    if (existsSync(join(workingDir, 'yarn.lock'))) {
      return { tool: 'yarn', command: 'yarn install --frozen-lockfile', manifest: 'yarn.lock' };
    }
    if (existsSync(join(workingDir, 'package.json'))) {
      return { tool: 'npm', command: 'npm install --no-audit --no-fund', manifest: 'package.json' };
    }

    // Python
    if (existsSync(join(workingDir, 'requirements.txt'))) {
      return { tool: 'pip', command: 'pip install -r requirements.txt', manifest: 'requirements.txt' };
    }
    if (existsSync(join(workingDir, 'pyproject.toml'))) {
      return { tool: 'pip', command: 'pip install -e .', manifest: 'pyproject.toml' };
    }
    if (existsSync(join(workingDir, 'setup.py'))) {
      return { tool: 'pip', command: 'pip install -e .', manifest: 'setup.py' };
    }

    // Ruby
    if (existsSync(join(workingDir, 'Gemfile'))) {
      return { tool: 'bundle', command: 'bundle install', manifest: 'Gemfile' };
    }

    // Rust
    if (existsSync(join(workingDir, 'Cargo.toml'))) {
      return { tool: 'cargo', command: 'cargo build', manifest: 'Cargo.toml' };
    }

    // Go
    if (existsSync(join(workingDir, 'go.mod'))) {
      return { tool: 'go', command: 'go mod download', manifest: 'go.mod' };
    }

    // PHP
    if (existsSync(join(workingDir, 'composer.json'))) {
      return { tool: 'composer', command: 'composer install', manifest: 'composer.json' };
    }

    // Dart / Flutter
    if (existsSync(join(workingDir, 'pubspec.yaml'))) {
      return { tool: 'dart', command: 'dart pub get', manifest: 'pubspec.yaml' };
    }

    return null;
  }

  /**
   * Check whether a CLI tool is available on PATH (cross-platform).
   */
  private commandExists(tool: string): boolean {
    return runShellSync(
      process.platform === 'win32' ? `where ${tool}` : `which ${tool}`,
      { timeoutMs: 5000, emitEvents: false, source: 'runner' },
    ).success;
  }

  /**
   * Bootstrap-install a missing package-manager tool so that the project's
   * dependencies can be installed. Handles Homebrew, winget, choco, npm,
   * pip, cargo, and more — installing the tool itself if it is missing.
   */
  private installTool(tool: string): DependencyInstallResult {
    const platform = process.platform;

    // ── npm / yarn / pnpm ────────────────────────────────────────────────
    if (tool === 'npm' || tool === 'yarn' || tool === 'pnpm') {
      // npm ships with Node.js. Only bootstrap Node when npm is actually
      // missing — never reinstall an existing toolchain.
      if (!this.commandExists('npm')) {
        const nodeInstall = this.installNodeViaPlatform(platform);
        if (!nodeInstall.success) return nodeInstall;
      }
      if (tool === 'npm') {
        // npm should now exist; verify in case the install didn't refresh PATH
        return this.commandExists('npm')
          ? { success: true, command: 'npm is now available', toolInstalled: true, message: 'npm is now available' }
          : { success: false, command: 'npm was installed but is not on PATH', message: 'npm was installed but is not on PATH for this process — open a new terminal and retry.' };
      }
      // yarn / pnpm are installed via npm (which we just ensured exists)
      return this.runInstallCommand(`npm install -g ${tool}`, process.cwd());
    }

    // ── pip ──────────────────────────────────────────────────────────────
    if (tool === 'pip') {
      if (this.commandExists('python3') || this.commandExists('python')) {
        // Python exists but pip may not — bootstrap pip via ensurepip
        const python = this.commandExists('python3') ? 'python3' : 'python';
        return this.runInstallCommand(`${python} -m ensurepip --upgrade`, process.cwd());
      }
      // No Python at all — install it first
      const pyInstall = this.installPythonViaPlatform(platform);
      if (!pyInstall.success) return pyInstall;
      const python = this.commandExists('python3') ? 'python3' : 'python';
      return this.runInstallCommand(`${python} -m ensurepip --upgrade`, process.cwd());
    }

    // ── Homebrew (macOS) ────────────────────────────────────────────────
    if (tool === 'brew') {
      // Install Homebrew itself — the official install script.
      // NONINTERACTIVE=1 prevents the script from blocking on sudo/confirm
      // prompts when stdio is piped.
      return this.runInstallCommand(
        'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        process.cwd(),
      );
    }

    // ── bundle (Ruby) ────────────────────────────────────────────────────
    if (tool === 'bundle') {
      if (this.commandExists('gem')) {
        return this.runInstallCommand('gem install bundler', process.cwd());
      }
      const rb = this.installRubyViaPlatform(platform);
      if (!rb.success) return rb;
      return this.runInstallCommand('gem install bundler', process.cwd());
    }

    // ── cargo (Rust) ─────────────────────────────────────────────────────
    if (tool === 'cargo') {
      // Rustup is the standard bootstrap installer
      return this.runInstallCommand(
        'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
        process.cwd(),
      );
    }

    // ── go ───────────────────────────────────────────────────────────────
    if (tool === 'go') {
      if (platform === 'darwin' || platform === 'linux') {
        return this.installGoViaPlatform(platform);
      }
      if (platform === 'win32') {
        // winget ships the official Go installer
        return this.runInstallCommand(
          'winget install GoLang.Go --silent --accept-package-agreements --accept-source-agreements',
          process.cwd(),
        );
      }
    }

    // ── composer (PHP) ───────────────────────────────────────────────────
    if (tool === 'composer') {
      // Always install to a user-writable dir ($HOME/.local/bin, or
      // USERPROFILE on Windows) instead of /usr/local/bin, which requires
      // sudo and doesn't exist on Apple Silicon. HOME is unset on Windows.
      const home = process.env.HOME || process.env.USERPROFILE;
      const localBin = home ? `${home}/.local/bin` : '.';
      if (!this.commandExists('php')) {
        // PHP missing — install it first (via brew/apt/winget)
        const phpInstall = this.installPhpViaPlatform(platform);
        if (!phpInstall.success) return phpInstall;
      }
      return this.runInstallCommand(
        `mkdir -p "${localBin}" && curl -sS https://getcomposer.org/installer | php -- --install-dir="${localBin}" --filename=composer`,
        process.cwd(),
      );
    }

    // ── dart ─────────────────────────────────────────────────────────────
    if (tool === 'dart') {
      if (platform === 'darwin') {
        // Bootstrap Homebrew first if missing (consistent with other tools)
        const brewCmd = this.commandExists('brew')
          ? 'brew install dart-lang/dart/dart'
          : 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install dart-lang/dart/dart';
        return this.runInstallCommand(brewCmd, process.cwd());
      }
      if (platform === 'linux') {
        // Dart is NOT in stock Ubuntu/Debian repos — add Google's apt repo first
        const dartCmd = [
          'apt-get update && apt-get install -y apt-transport-https wget gnupg',
          'wget -qO- https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/dart.gpg',
          'echo "deb [signed-by=/usr/share/keyrings/dart.gpg] https://storage.googleapis.com/download.dartlang.org/linux/debian stable main" > /etc/apt/sources.list.d/dart.list',
          'apt-get update && apt-get install -y dart',
        ].join(' && ');
        return this.runInstallCommand(dartCmd, process.cwd());
      }
      if (platform === 'win32') {
        return this.runInstallCommand(
          'winget install Dart.Dart --silent --accept-package-agreements --accept-source-agreements',
          process.cwd(),
        );
      }
    }

    return { success: false, command: '', message: `No bootstrap strategy for tool '${tool}' on ${platform}` };
  }

  /** Install Node.js (which bundles npm) via the platform package manager. */
  private installNodeViaPlatform(platform: string): DependencyInstallResult {
    if (platform === 'darwin') {
      // macOS: prefer Homebrew; bootstrap Homebrew itself if missing
      if (this.commandExists('brew')) {
        return this.runInstallCommand('brew install node', process.cwd());
      }
      return this.runInstallCommand(
        'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install node',
        process.cwd(),
      );
    }
    if (platform === 'linux') {
      // Linux: use the distro package manager, with NodeSource as a fallback
      const candidates = [
        'apt-get update && apt-get install -y nodejs npm',
        'dnf install -y nodejs npm',
        'yum install -y nodejs npm',
        'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs',
      ];
      for (const cmd of candidates) {
        const res = this.runInstallCommand(cmd, process.cwd());
        if (res.success) return res;
      }
      return { success: false, command: candidates.join(' | '), message: 'Could not install Node.js on Linux' };
    }
    if (platform === 'win32') {
      // Windows: winget (preferred) → choco → MSI download
      const candidates = [
        'winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements',
        'choco install nodejs -y',
        'powershell -NoProfile -Command "Invoke-WebRequest -Uri https://nodejs.org/dist/latest/node-v22.14.0-x64.msi -OutFile $env:TEMP\\node.msi; Start-Process msiexec -ArgumentList \'/i $env:TEMP\\node.msi /quiet\' -Wait"',
      ];
      for (const cmd of candidates) {
        const res = this.runInstallCommand(cmd, process.cwd());
        if (res.success) return res;
      }
      return { success: false, command: candidates.join(' | '), message: 'Could not install Node.js on Windows' };
    }
    return { success: false, command: '', message: `Unsupported platform: ${platform}` };
  }

  /** Install Python via the platform package manager (so pip can be bootstrapped). */
  private installPythonViaPlatform(platform: string): DependencyInstallResult {
    if (platform === 'darwin') {
      return this.commandExists('brew')
        ? this.runInstallCommand('brew install python3', process.cwd())
        : this.runInstallCommand('NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install python3', process.cwd());
    }
    if (platform === 'linux') {
      const candidates = [
        'apt-get update && apt-get install -y python3 python3-pip',
        'dnf install -y python3 python3-pip',
      ];
      for (const cmd of candidates) {
        const res = this.runInstallCommand(cmd, process.cwd());
        if (res.success) return res;
      }
      return { success: false, command: candidates.join(' | '), message: 'Could not install Python on Linux' };
    }
    if (platform === 'win32') {
      const candidates = [
        'winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements',
        'choco install python -y',
      ];
      for (const cmd of candidates) {
        const res = this.runInstallCommand(cmd, process.cwd());
        if (res.success) return res;
      }
      return { success: false, command: candidates.join(' | '), message: 'Could not install Python on Windows' };
    }
    return { success: false, command: '', message: `Unsupported platform: ${platform}` };
  }

  /** Install Ruby via the platform package manager. */
  private installRubyViaPlatform(platform: string): DependencyInstallResult {
    if (platform === 'darwin') {
      return this.commandExists('brew')
        ? this.runInstallCommand('brew install ruby', process.cwd())
        : this.runInstallCommand('NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install ruby', process.cwd());
    }
    if (platform === 'linux') {
      const candidates = [
        'apt-get update && apt-get install -y ruby-full',
        'dnf install -y ruby',
      ];
      for (const cmd of candidates) {
        const res = this.runInstallCommand(cmd, process.cwd());
        if (res.success) return res;
      }
      return { success: false, command: candidates.join(' | '), message: 'Could not install Ruby on Linux' };
    }
    if (platform === 'win32') {
      return this.runInstallCommand(
        'winget install RubyInstallerTeam.Ruby.3.2 --silent --accept-package-agreements --accept-source-agreements',
        process.cwd(),
      );
    }
    return { success: false, command: '', message: `Unsupported platform: ${platform}` };
  }

  /** Install PHP via the platform package manager. */
  private installPhpViaPlatform(platform: string): DependencyInstallResult {
    if (platform === 'darwin') {
      const brewCmd = this.commandExists('brew')
        ? 'brew install php'
        : 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install php';
      return this.runInstallCommand(brewCmd, process.cwd());
    }
    if (platform === 'linux') {
      const candidates = [
        'apt-get update && apt-get install -y php-cli',
        'dnf install -y php-cli',
      ];
      for (const cmd of candidates) {
        const res = this.runInstallCommand(cmd, process.cwd());
        if (res.success) return res;
      }
      return { success: false, command: candidates.join(' | '), message: 'Could not install PHP on Linux' };
    }
    if (platform === 'win32') {
      return this.runInstallCommand(
        'winget install PHP.PHP.8.3 --silent --accept-package-agreements --accept-source-agreements',
        process.cwd(),
      );
    }
    return { success: false, command: '', message: `Unsupported platform: ${platform}` };
  }

  /** Install Go via the platform package manager. */
  private installGoViaPlatform(platform: string): DependencyInstallResult {
    if (platform === 'darwin') {
      return this.commandExists('brew')
        ? this.runInstallCommand('brew install go', process.cwd())
        : this.runInstallCommand('NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install go', process.cwd());
    }
    if (platform === 'linux') {
      const candidates = [
        'apt-get update && apt-get install -y golang-go',
        'dnf install -y golang',
      ];
      for (const cmd of candidates) {
        const res = this.runInstallCommand(cmd, process.cwd());
        if (res.success) return res;
      }
      return { success: false, command: candidates.join(' | '), message: 'Could not install Go on Linux' };
    }
    return { success: false, command: '', message: `Unsupported platform: ${platform}` };
  }

  /**
   * Run an install command and return its outcome.
   */
  private runInstallCommand(command: string, cwd: string): DependencyInstallResult {
    const result = runShellSync(command, {
      cwd,
      timeoutMs: TOOL_INSTALL_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      source: 'runner',
    });
    if (result.success) {
      return { success: true, command, toolInstalled: true, message: `Installed via: ${command}` };
    }
    return { success: false, command, message: (result.stderr || result.stdout).trim() || 'Install command failed' };
  }

  /**
   * When no manifest exists, detect a missing interpreter/tool from the failed
   * command itself (e.g. "python3 script.py" → python3 → install Python).
   * This lets the runner install bare tools even in manifest-less directories.
   */
  private detectToolFromCommand(command: string): string | null {
    if (!command) return null;
    const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase() || '';
    const tool = firstWord.split(/[\\/]/).pop() || firstWord; // handle paths like /usr/bin/node
    const toolMap: Record<string, string> = {
      node: 'npm',
      npm: 'npm',
      npx: 'npm',
      python: 'pip',
      python3: 'pip',
      pip: 'pip',
      pip3: 'pip',
      go: 'go',
      cargo: 'cargo',
      rustc: 'cargo',
      bundle: 'bundle',
      bundler: 'bundle',
      ruby: 'bundle',
      composer: 'composer',
      php: 'composer',
      dart: 'dart',
      flutter: 'dart',
      yarn: 'yarn',
      pnpm: 'pnpm',
      brew: 'brew',
    };
    const mapped = toolMap[tool];
    // Only install if the tool is genuinely missing (avoids re-installs)
    if (mapped && !this.commandExists(mapped)) {
      return mapped;
    }
    return null;
  }

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
  private installDependencies(
    workingDir: string,
    autoInstallTools = true,
    failedCommand?: string,
  ): DependencyInstallResult {
    const plan = this.detectInstallPlan(workingDir);
    if (!plan) {
      // No manifest — try to bootstrap a missing interpreter/tool referenced
      // by the failed command (e.g. "python3 script.py" when python3 is absent).
      if (autoInstallTools && failedCommand) {
        const missingTool = this.detectToolFromCommand(failedCommand);
        if (missingTool) {
          const installResult = this.installTool(missingTool);
          return {
            success: installResult.success,
            command: failedCommand,
            tool: missingTool,
            toolInstalled: installResult.success,
            message: installResult.success
              ? `Auto-installed missing tool '${missingTool}' from command`
              : `Missing tool '${missingTool}' could not be auto-installed: ${installResult.message}`,
          };
        }
      }
      return { success: false, command: '', message: 'No supported dependency manifest detected' };
    }

    // ── Ensure the package manager tool exists ─────────────────────────
    if (!this.commandExists(plan.tool)) {
      if (autoInstallTools) {
        const installResult = this.installTool(plan.tool);
        if (!installResult.success) {
          return {
            success: false,
            command: plan.command,
            tool: plan.tool,
            toolInstalled: false,
            message: `Package manager '${plan.tool}' is missing and could not be auto-installed: ${installResult.message}`,
          };
        }
        // Tool was installed — retry the actual install command (normalize
        // `pip` → `pip3` first — after ensurepip on macOS only the versioned
        // binary may exist on PATH).
        const attempt = this.runInstallCommand(this.normalizeInterpreter(plan.command), workingDir);
        return {
          success: attempt.success,
          command: plan.command,
          tool: plan.tool,
          toolInstalled: true,
          message: attempt.success
            ? `Installed missing tool '${plan.tool}', then ${plan.command}`
            : `Tool installed but install failed: ${attempt.message}`,
        };
      }
      return {
        success: false,
        command: plan.command,
        tool: plan.tool,
        toolInstalled: false,
        message: `Package manager '${plan.tool}' is not installed (auto-install of tools is disabled)`,
      };
    }

    // ── Tool exists — just run the install command (normalized: macOS has
    //    `pip3`, not `pip`, so `pip install -r …` would otherwise 127).
    const attempt = this.runInstallCommand(this.normalizeInterpreter(plan.command), workingDir);
    return {
      success: attempt.success,
      command: plan.command,
      tool: plan.tool,
      toolInstalled: false,
      message: attempt.success ? undefined : attempt.message,
    };
  }

  private async executeOnHost(
    context: AgentContext,
    command: string,
    fallbackAttempts = 0,
    depRetries = 0,
  ): Promise<AgentResult> {
    // (Command was already normalized at the execute() choke point — retries
    // here simply carry the normalized command forward.)

    // Validate the command before executing
    const validation = this.isCommandAvailable(command, context.workingDirectory);
    if (!validation.available) {
      if (context.metadata.verboseLogging) {
        logger.info(`     ⚠️  Command validation: ${validation.reason}`);
      }

      // Try LLM fallback (up to MAX_FALLBACK_ATTEMPTS times)
      if (fallbackAttempts < MAX_FALLBACK_ATTEMPTS && this._callLLM) {
        const altCommand = await this.askLLMForCommand(context, this._callLLM);
        if (altCommand && altCommand !== command) {
          if (context.metadata.verboseLogging) {
            logger.info(`     🔄 LLM suggested alternative command (attempt ${fallbackAttempts + 1}): ${altCommand}`);
          }
          return this.executeOnHost(context, altCommand, fallbackAttempts + 1);
        }
      }

      // No alternative — return a clear error instead of running a broken command
      return {
        success: false,
        summary: `Command not available: ${command}`,
        error: validation.reason,
      };
    }

    if (context.metadata.verboseLogging) {
      logger.info(`     Running: ${command}`);
    }

    const timeoutMs = (typeof context.metadata.runnerTimeout === 'number')
      ? context.metadata.runnerTimeout
      : DEFAULT_TIMEOUT_MS;

    // Execute through the shared shell choke point (E1) — emits exec:shell
    // events so every run is a visible lane; never throws on non-zero exit.
    const startTime = Date.now();
    const shellResult = await runShell(command, {
      cwd: context.workingDirectory,
      timeoutMs,
      maxBuffer: 1024 * 1024,
      source: 'runner',
    });
    const exitCode = shellResult.exitCode;
    const stdout = shellResult.stdout.trim();
    const stderr = shellResult.stderr.trim();
    const execError = shellResult.success ? undefined : (stderr || stdout).slice(0, 500) || `Command exited with code ${shellResult.exitCode}`;

    const duration = Date.now() - startTime;

    // ── Auto-install missing dependencies and retry once ───────────────
    // If the command failed because a module/command is missing, try to install
    // dependencies (npm install / pip install / brew install / etc.) using the
    // project's package manager — and bootstrap-install the package manager
    // itself if it is missing. Then re-run the command. This lets the agent
    // close tasks that need `npm install` (or any platform's toolchain) before
    // they can run.
    let depInstallAttempted = false;
    let depInstallSucceeded = false;
    let depInstallTool: string | undefined;
    let depInstallToolInstalled = false;
    // Holds the actionable tool-install message when a missing system tool
    // blocked the run (surfaced in the result error instead of the raw
    // "command not found" so the user sees exactly what to do).
    let toolBlockError: string | null = null;
    if (exitCode !== 0 && depRetries < MAX_DEP_INSTALL_RETRIES && this.looksLikeMissingDependency(command, stdout, stderr, execError)) {
      // ENTERPRISE TOOL PATH FIRST: a "command not found" for a KNOWN system
      // tool (e.g. `zip`, `git`, `make`) is NOT a project-dependency problem —
      // it needs an OS-level install with user consent. Handle it here too
      // (covers tools invoked mid-command by scripts), then re-run.
      const missingTool = this.detectMissingSystemTool(command);
      if (missingTool) {
        const toolOutcome = await this.ensureSystemTool(context, command);
        if (toolOutcome === null) {
          // Installed — retry the original command once.
          return this.executeOnHost(context, command, fallbackAttempts, depRetries + 1);
        }
        // User declined / install failed / non-interactive: fall through to
        // record the failed run with the actionable message.
        if (context.metadata.verboseLogging) {
          logger.info(`     🛠️  Tool '${missingTool}' not available — ${toolOutcome}`);
        }
        depInstallAttempted = true;
        depInstallSucceeded = false;
        depInstallTool = missingTool;
        toolBlockError = toolOutcome;
      } else {
        if (context.metadata.verboseLogging) {
          logger.info('     📦 Command failed — missing dependency detected, installing...');
        }
        // autoInstallTools defaults to true; set metadata.autoInstallTools=false
        // to only run the install command without bootstrapping missing tools.
        const autoInstallTools = context.metadata.autoInstallTools !== false;
        const installResult = this.installDependencies(context.workingDirectory, autoInstallTools, command);
        depInstallAttempted = true;
        depInstallSucceeded = installResult.success;
        depInstallTool = installResult.tool;
        depInstallToolInstalled = installResult.toolInstalled === true;
        if (context.metadata.verboseLogging) {
          if (installResult.toolInstalled) {
            logger.info(`     🛠️  Auto-installed missing tool '${installResult.tool}'`);
          }
          logger.info(`     📦 Dependency install ${installResult.success ? 'succeeded' : 'failed'}: ${installResult.command || installResult.message}`);
        }

        if (installResult.success) {
          // Retry the original command once after a successful install
          return this.executeOnHost(context, command, fallbackAttempts, depRetries + 1);
        }
      }
    }

    // Exit code 0 answers "did the process fail?", not "did it do anything?".
    // `zip` prints `zip warning: name not matched` for every input it could not
    // find and still exits 0 — which is precisely how a 22-byte empty archive was
    // recorded as a finished deliverable. Ask the output as well as the status.
    const noOpReason = exitCode === 0 ? detectNoOpCommand(command, stdout, stderr) : null;

    const runResult: RunResult = {
      success: exitCode === 0,
      producedNothing: noOpReason !== null,
      noOpReason: noOpReason ?? undefined,
      command,
      exitCode,
      stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
      stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
      duration,
      error: toolBlockError || execError,
      dependencyInstallAttempted: depInstallAttempted,
      dependencyInstallSucceeded: depInstallSucceeded,
      dependencyInstallTool: depInstallTool,
      dependencyInstallToolInstalled: depInstallToolInstalled,
    };

    context.metadata['runResult'] = runResult;

    if (depInstallAttempted) {
      this.report(
        context,
        depInstallSucceeded ? 'installed' : 'failed',
        depInstallSucceeded
          ? 'Installed missing dependencies — re-running the command'
          : toolBlockError || `Dependency install failed (${depInstallTool || 'unknown tool'})`,
      );
    }
    context.metadata['dependencyInstallAttempted'] = depInstallAttempted;
    context.metadata['dependencyInstallSucceeded'] = depInstallSucceeded;
    context.metadata['dependencyInstallTool'] = depInstallTool;
    context.metadata['dependencyInstallToolInstalled'] = depInstallToolInstalled;

    const lines: string[] = [];
    lines.push(`Command: ${command}`);
    lines.push(`Exit code: ${exitCode}`);
    lines.push(`Duration: ${duration}ms`);

    if (stdout) {
      const truncated = stdout.length > 500;
      lines.push(`stdout:${truncated ? ' (first 500 chars)' : ''}`);
      lines.push(stdout.slice(0, 500));
      if (truncated) lines.push(`... (${stdout.length - 500} more chars)`);
    }

    if (stderr && exitCode !== 0) {
      const truncated = stderr.length > 500;
      lines.push(`stderr:${truncated ? ' (first 500 chars)' : ''}`);
      lines.push(stderr.slice(0, 500));
      if (truncated) lines.push(`... (${stderr.length - 500} more chars)`);
    }

    return {
      // The step's outcome, not the process's. `zip` exits 0 after failing to
      // find every input it was given, so an exit code alone would let a
      // fabricated deliverable through as a success.
      success: exitCode === 0 && noOpReason === null,
      summary: noOpReason !== null
        ? `⚠️ Command exited 0 but did nothing: ${noOpReason} — ${command}`
        : exitCode === 0
          ? `✅ Command succeeded: ${command}`
          : toolBlockError
            ? `❌ Required tool not available: ${command}`
            : `❌ Command failed (exit ${exitCode}): ${command}`,
      details: lines.join('\n'),
      error: (toolBlockError || execError) && exitCode !== 0 ? (toolBlockError || execError) : undefined,
    };
  }

  /**
   * True when this runner execution is a repair/alternative-approach attempt
   * (the ErrorRepairEngine appends these markers to context.goal).
   */
  private isRepairAttempt(context: AgentContext): boolean {
    const goal = context.goal || '';
    return goal.includes('[REPAIR ATTEMPT') || goal.includes('[ALTERNATIVE APPROACH');
  }

  /**
   * Ask the LLM for the NEXT command after a previous command failed.
   * This is what makes the repair loop ADAPT instead of re-running the same
   * failing command: the LLM sees the task, the previous command, its captured
   * stdout/stderr, AND the full project context (written files + reference
   * docs), and proposes a corrected command (e.g. create the Cloudflare Pages
   * project before deploying, or — when the deliverable CANNOT run in this
   * environment — the PACKAGING command that produces the deployable artifact).
   */
  private async askLLMForRepairCommand(
    context: AgentContext,
    callLLM: LLMCallFn,
    taskDescription: string,
  ): Promise<string | null> {
    // DETERMINISTIC FAST-PATH: when the project is a known addon/package that
    // cannot execute in this environment (e.g. an NVDA addon needs NVDA, an
    // iOS app needs Xcode), a previous RUN attempt can never succeed — the
    // correct action is to PACKAGE it (zip the source tree into the deployable
    // artifact). Detecting this deterministically avoids asking a weak model
    // to re-guess a run command (the observed failure: 3+ useless `python3
    // globalPlugins/addon_main.py` variants). Falls through to the LLM when no
    // deterministic package target exists.
    const packaging = this.detectPackagingCommand(context);
    if (packaging) {
      if (context.metadata.verboseLogging) {
        logger.info(`     📦 Deliverable cannot run here — proposing packaging command: ${packaging}`);
      }
      return packaging;
    }

    const prev = context.metadata.runResult as RunResult | undefined;
    const prevLines = prev
      ? [
          `Previous command: ${prev.command}`,
          `Exit code: ${prev.exitCode}`,
          prev.stdout ? `stdout:\n${prev.stdout.slice(0, 1500)}` : '',
          prev.stderr ? `stderr:\n${prev.stderr.slice(0, 1500)}` : '',
        ].filter(Boolean).join('\n')
      : 'No previous run recorded.';

    const filesChanged = context.fileChanges
      .map((c) => {
        const head = (c.newContent || '').slice(0, 400);
        return `  - ${c.path} (${c.status})${head ? `:\n${head}${head.length >= 400 ? '…' : ''}` : ''}`;
      })
      .join('\n');
    const referenceSection = referenceDocsFor(`${taskDescription} ${context.goal}`);

    const prompt = [
      'A command failed during execution. Propose the NEXT command to run.',
      '',
      `Task: ${taskDescription}`,
      '',
      'Files that were just written for this task:',
      filesChanged || '  (no files recorded)',
      '',
      referenceSection,
      '',
      'The previous attempt failed:',
      prevLines,
      '',
      'Analyze the failure. IMPORTANT — decide what KIND of action is correct:',
      '- If the deliverable CANNOT RUN in this environment (a plugin/addon that needs',
      '  its host app, e.g. an NVDA addon needs NVDA; an iOS app needs Xcode), do NOT',
      '  try to execute it. Instead propose the PACKAGING command that produces the',
      '  deployable artifact (e.g. `zip -r myaddon.nvda-addon manifest.ini globalPlugins`)',
      '  or a static verification (e.g. `python3 -m py_compile`).',
      '- If it CAN run, address the error (create a missing project/config first,',
      '  use a different flag, or skip a step that is already done).',
      'Do NOT repeat the failed command unchanged.',
      '',
      'Return ONLY the single shell command to run next, with no explanation or markdown.',
    ].join('\n');

    try {
      const response = (await callLLM(prompt, { temperature: 0.2, maxTokens: 300 })).trim();
      const cleaned = response.replace(/^```(?:bash|sh)?\s*|```\s*$/g, '').trim();
      // Reject multi-line responses (a single command only), mirroring
      // askLLMForCommand — a multi-line string would break runShell.
      if (cleaned.length === 0 || cleaned.includes('\n')) return null;
      return cleaned;
    } catch {
      // LLM unavailable — fall back to the standard determination path.
      return null;
    }
  }

  /**
   * Fallback: ask the LLM what command to run based on the project context.
   * Includes the written file contents, package.json metadata, and curated
   * reference docs (referenceDocsFor) so the LLM can choose a CORRECT action —
   * including recognizing when the deliverable CANNOT run in this environment
   * (a plugin/addon that needs its host app) and proposing the PACKAGING
   * command that produces the deployable artifact instead of a useless run.
   */
  private async askLLMForCommand(context: AgentContext, callLLM: LLMCallFn): Promise<string | null> {
    // DETERMINISTIC FAST-PATH (same as the repair path): if the written project
    // is a known addon/package that cannot execute here, return the packaging
    // command directly — a weak model asked "what command runs this?" will
    // otherwise guess `python3 globalPlugins/addon_main.py` (observed live).
    const packaging = this.detectPackagingCommand(context);
    if (packaging) {
      if (context.metadata.verboseLogging) {
        logger.info(`     📦 Deliverable cannot run here — proposing packaging command: ${packaging}`);
      }
      return packaging;
    }

    const fileList = context.fileChanges
      .map((c) => {
        const head = (c.newContent || '').slice(0, 400);
        return `  - ${c.path} (${c.status})${head ? `:\n${head}${head.length >= 400 ? '…' : ''}` : ''}`;
      })
      .join('\n');

    const artifactList = context.artifacts
      .slice(0, 5)
      .map((a) => `  - ${a.path}`)
      .join('\n');

    // Read available npm scripts if package.json exists
    let scriptsInfo = '';
    try {
      const pkgPath = join(context.workingDirectory, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
        if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
          scriptsInfo = 'Available npm scripts:\n' +
            Object.entries(pkg.scripts)
              .map(([name, cmd]) => `  - npm run ${name}: ${cmd}`)
              .join('\n');
        }
      }
    } catch {
      // Ignore — scriptsInfo stays empty
    }

    const referenceSection = referenceDocsFor(context.goal);

    const prompt = [
      'You are a build-and-run expert. Given the context below, what single shell command should be executed',
      'to verify — or, when the deliverable cannot run here, to BUILD/PACKAGE — the work that was done?',
      '',
      'IMPORTANT: Check if "npm test" is available. Only suggest it if the project',
      'actually has a test script defined in package.json.',
      '',
      `Goal: ${context.goal}`,
      '',
      'Files written:',
      fileList || '  (no files changed)',
      '',
      'Relevant project files:',
      artifactList || '  (empty project)',
      '',
      scriptsInfo || 'No npm scripts available.',
      '',
      referenceSection,
      '',
      'Decide what KIND of action is correct:',
      '- If the deliverable is a plugin/addon that needs its host application (e.g. an NVDA',
      '  addon needs NVDA; an iOS app needs Xcode), it CANNOT run in this environment.',
      '  Do NOT try to execute it. Propose the PACKAGING command that produces the',
      '  deployable artifact (e.g. `zip -r myaddon.nvda-addon manifest.ini globalPlugins`)',
      '  or a static verification (e.g. `python3 -m py_compile`).',
      '- Otherwise propose the command that runs/verifies the work (e.g. "python hello.py",',
      '  "node index.js", "go run main.go").',
      '',
      'Return ONLY the command to run. Examples: "python hello.py" or "node index.js" or "go run main.go".',
      'Rules:',
      '- Return a single line command only',
      '- No backticks, no explanation, no $ prefix',
      '- Use absolute or working-directory-relative paths',
      '- If unsure, suggest the most appropriate verification command',
      '- NEVER suggest "npm test" if there is no test script in package.json!',
    ].join('\n');

    try {
      const response = await callLLM(prompt, {
        temperature: 0.1,
        maxTokens: 256,
      });

      const command = response.trim().replace(/^```(?:bash|sh)?\s*|\s*```$/g, '').trim();
      if (command && !command.includes('\n') && command.length < 500) {
        return command;
      }
    } catch {
      // LLM fallback failed — return null
    }

    return null;
  }

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
  private detectPackagingCommand(context: AgentContext): string | null {
    const cwd = context.workingDirectory;
    const hasManifest = existsSync(join(cwd, 'manifest.ini'));
    const hasPlugins = existsSync(join(cwd, 'globalPlugins'));
    if (!hasManifest || !hasPlugins) return null;

    // Only trigger for NVDA-addon goals — manifest.ini alone is ambiguous.
    const goalText = `${context.goal} ${(context.taskPlan || []).map((s) => s.description).join(' ')}`.toLowerCase();
    if (!goalText.includes('nvda') && !goalText.includes('addon')) return null;

    // Addon name: read from manifest.ini ([addon] name = X) or fall back to
    // the working-directory basename — sanitized for a safe zip target.
    let addonName = '';
    try {
      const manifest = readFileSync(join(cwd, 'manifest.ini'), 'utf-8');
      const nameMatch = manifest.match(/^\s*name\s*=\s*(.+?)\s*$/m);
      if (nameMatch) addonName = nameMatch[1].trim();
    } catch {
      // Fall through to dir basename below.
    }
    if (!addonName) addonName = cwd.split(/[\\/]/).pop() || 'addon';
    const safe = addonName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');

    return `zip -r ${safe}.nvda-addon manifest.ini globalPlugins`;
  }

  /**
   * Detect a missing system tool referenced by a command (enterprise parity).
   *
   * Scans every token of the command (so compound commands like
   * `cd addon && zip -r …` are covered), checks each against the known-tool
   * recipes, and returns the FIRST missing tool name — or null when nothing
   * is missing / unknown. Only the bare tool name is checked (paths like
   * /usr/bin/zip are unwrapped to zip).
   */
  private detectMissingSystemTool(command: string): string | null {
    if (!command) return null;
    const tokens = command.split(/[\s;&|]+/).filter(Boolean);
    for (const token of tokens) {
      if (token.startsWith('-') || token.startsWith('--')) continue; // flags
      const tool = token.split(/[\\/]/).pop() || token; // handle paths
      if (!isKnownSystemTool(tool)) continue;
      if (!this.commandExists(tool)) return tool;
    }
    return null;
  }

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
  private async ensureSystemTool(context: AgentContext, command: string): Promise<string | null> {
    const tool = this.detectMissingSystemTool(command);
    if (!tool) return null;

    const installCmd = toolInstallCommand(tool, process.platform, (name) => this.commandExists(name));
    const recommended = installCmd || `brew install ${tool}  # macOS  |  sudo apt-get install -y ${tool}  # Linux  |  winget install ${tool}  # Windows`;

    if (context.metadata.verboseLogging) {
      logger.warn(`     🛠️  Missing system tool: '${tool}' (recommended: ${recommended})`);
    }

    // Non-interactive — surface the manual steps, never block.
    if (!process.stdin.isTTY) {
      return manualInstallSteps(tool, recommended);
    }

    let choice: ToolInstallChoice;
    try {
      choice = await promptToolInstall(tool, recommended);
    } catch {
      // Prompt failed (no TTY after all) — treat as manual.
      return manualInstallSteps(tool, recommended);
    }

    if (choice === 'manual' || choice === 'skip') {
      return choice === 'manual'
        ? manualInstallSteps(tool, recommended)
        : `Skipped installing '${tool}' — the step was not run. Install it manually (${recommended}) and re-run the task.`;
    }

    // 'install' — execute the recommended command, verify, continue.
    logger.info(`     🛠️  Installing '${tool}' via: ${recommended}`);
    const installResult = this.runInstallCommand(recommended, context.workingDirectory);
    if (!installResult.success) {
      return `Failed to auto-install '${tool}' (${installResult.message || 'install command failed'}).\n${manualInstallSteps(tool, recommended)}`;
    }
    if (!this.commandExists(tool)) {
      return `Installed '${tool}' but it is not on PATH for this process yet — open a new terminal and re-run, or: ${recommended}`;
    }
    logger.success(`     ✅ Installed '${tool}' — continuing.`);
    return null;
  }
}

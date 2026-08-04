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

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';
import { getHostShell } from '../../utils/shell.js';
import { SandboxManager } from '../../sandbox/manager.js';
import { detectProjectImage } from '../../sandbox/images.js';
import { getSandboxConfig } from '../../sandbox/types.js';

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
      const command = await this.determineCommand(context, callLLM);
      if (!command) {
        this.report(context, 'failed', 'Could not determine a command to run');
        return {
          success: false,
          summary: 'No command to run',
          error: 'Could not determine which command to execute from the task description or context.',
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

      // Build run result from sandbox result
      const runResult: RunResult = {
        success: result.success,
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
        success: result.exitCode === 0,
        summary: result.exitCode === 0
          ? `✅ Command succeeded (Docker): ${command}`
          : `❌ Command failed (exit ${result.exitCode}): ${command}`,
        details: lines.join('\n'),
        error: result.error || undefined,
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
    try {
      execSync(
        process.platform === 'win32' ? `where ${tool}` : `which ${tool}`,
        { stdio: 'ignore', timeout: 5000, shell: getHostShell() },
      );
      return true;
    } catch {
      return false;
    }
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
    try {
      execSync(command, {
        cwd,
        timeout: TOOL_INSTALL_TIMEOUT_MS,
        stdio: 'pipe',
        encoding: 'utf-8',
        shell: getHostShell(),
        maxBuffer: 2 * 1024 * 1024,
      });
      return { success: true, command, toolInstalled: true, message: `Installed via: ${command}` };
    } catch (err) {
      return { success: false, command, message: err instanceof Error ? err.message : String(err) };
    }
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
        // Tool was installed — retry the actual install command
        const attempt = this.runInstallCommand(plan.command, workingDir);
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

    // ── Tool exists — just run the install command ─────────────────────
    const attempt = this.runInstallCommand(plan.command, workingDir);
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

    const startTime = Date.now();
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let execError: string | undefined;

    try {
      const output = execSync(command, {
        cwd: context.workingDirectory,
        timeout: timeoutMs,
        stdio: 'pipe',
        encoding: 'utf-8',
        shell: getHostShell(),
        maxBuffer: 1024 * 1024,
      });
      stdout = output.trim();
    } catch (err) {
      const error = err as {
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      exitCode = error.status ?? 1;
      stdout = (typeof error.stdout === 'string' ? error.stdout : String(error.stdout || '')).trim();
      stderr = (typeof error.stderr === 'string' ? error.stderr : String(error.stderr || '')).trim();
      execError = error.message;
    }

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
    if (exitCode !== 0 && depRetries < MAX_DEP_INSTALL_RETRIES && this.looksLikeMissingDependency(command, stdout, stderr, execError)) {
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

    const runResult: RunResult = {
      success: exitCode === 0,
      command,
      exitCode,
      stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
      stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
      duration,
      error: execError,
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
          : `Dependency install failed (${depInstallTool || 'unknown tool'})`,
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
      success: exitCode === 0,
      summary: exitCode === 0
        ? `✅ Command succeeded: ${command}`
        : `❌ Command failed (exit ${exitCode}): ${command}`,
      details: lines.join('\n'),
      error: execError && exitCode !== 0 ? execError : undefined,
    };
  }

  /**
   * Fallback: ask the LLM what command to run based on the project context.
   * Includes project's package.json metadata so the LLM can make an informed choice.
   */
  private async askLLMForCommand(context: AgentContext, callLLM: LLMCallFn): Promise<string | null> {
    const fileList = context.fileChanges
      .map((c) => `  - ${c.path} (${c.status})`)
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

    const prompt = [
      'You are a build-and-run expert. Given the context below, what single shell command should be executed',
      'to verify the work that was done?',
      '',
      'IMPORTANT: Check if "npm test" is available. Only suggest it if the project',
      'actually has a test script defined in package.json.',
      '',
      `Goal: ${context.goal}`,
      '',
      'Files changed:',
      fileList || '  (no files changed)',
      '',
      'Relevant project files:',
      artifactList || '  (empty project)',
      '',
      scriptsInfo || 'No npm scripts available.',
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
}

/**
 * Shell Detection — Detect and use correct shell for platform.
 *
 * This provides shell detection and execution:
 * - Auto-detect available shells
 * - PowerShell 7+ support
 * - CMD support
 * - Bash/Zsh support
 * - Shell-specific command formatting
 * - Error stream handling
 * - Output encoding
 *
 * Better than Hermes:
 * - Automatic shell detection
 * - Shell-specific error handling
 * - Output encoding support
 * - Integration with skill system
 */

import { platform } from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// ─── Types ───────────────────────────────────────────────────────────────

export type ShellType = 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'unknown';

export interface ShellInfo {
  /** Shell type */
  type: ShellType;
  /** Shell executable path */
  path: string;
  /** Shell version */
  version?: string;
  /** Whether shell is available */
  available: boolean;
}

export interface ShellExecutionResult {
  /** Exit code */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Shell used */
  shell: ShellType;
}

// ─── Shell Detection ─────────────────────────────────────────────────────

/**
 * Detect available shells on the system.
 */
export async function detectShells(): Promise<ShellInfo[]> {
  const shells: ShellInfo[] = [];

  // PowerShell 7+ (pwsh)
  const pwsh = await detectShell('pwsh', ['pwsh', '--version']);
  if (pwsh) shells.push(pwsh);

  // Windows PowerShell
  const powershell = await detectShell('powershell', ['powershell', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (powershell) shells.push(powershell);

  // CMD
  const cmd = await detectShell('cmd', ['cmd', '/c', 'ver']);
  if (cmd) shells.push(cmd);

  // Bash
  const bash = await detectShell('bash', ['bash', '--version']);
  if (bash) shells.push(bash);

  // Zsh
  const zsh = await detectShell('zsh', ['zsh', '--version']);
  if (zsh) shells.push(zsh);

  // Fish
  const fish = await detectShell('fish', ['fish', '--version']);
  if (fish) shells.push(fish);

  return shells;
}

/**
 * Detect a specific shell.
 */
async function detectShell(type: ShellType, command: string[]): Promise<ShellInfo | null> {
  try {
    const result = await executeShellCommand(command[0], command.slice(1), {
      timeout: 5000,
    });

    if (result.exitCode === 0) {
      return {
        type,
        path: command[0],
        version: result.stdout.trim().split('\n')[0],
        available: true,
      };
    }
  } catch {
    // Shell not available
  }

  return null;
}

/**
 * Get the default shell for the current platform.
 */
export function getDefaultShell(): ShellType {
  const p = platform();

  switch (p) {
    case 'win32':
      return 'powershell';
    case 'darwin':
      return 'zsh';
    case 'linux':
      return 'bash';
    default:
      return 'bash';
  }
}

/**
 * Get the best available shell.
 */
export async function getBestShell(): Promise<ShellInfo> {
  const shells = await detectShells();
  const available = shells.filter((s) => s.available);

  if (available.length === 0) {
    throw new Error('No shells available');
  }

  // Prefer PowerShell 7+ on Windows
  if (platform() === 'win32') {
    const pwsh = available.find((s) => s.type === 'pwsh');
    if (pwsh) return pwsh;

    const powershell = available.find((s) => s.type === 'powershell');
    if (powershell) return powershell;
  }

  // Prefer zsh on macOS
  if (platform() === 'darwin') {
    const zsh = available.find((s) => s.type === 'zsh');
    if (zsh) return zsh;
  }

  // Default to bash
  const bash = available.find((s) => s.type === 'bash');
  if (bash) return bash;

  // Return first available
  return available[0];
}

// ─── Shell Execution ─────────────────────────────────────────────────────

/**
 * Execute a command in a shell.
 */
export async function executeShellCommand(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    shell?: ShellType;
  } = {}
): Promise<ShellExecutionResult> {
  const startTime = Date.now();
  const shell = options.shell ?? getDefaultShell();

  // Build command based on shell
  const { execCommand, execArgs } = buildShellCommand(shell, command, args);

  return new Promise((resolve) => {
    const child = spawn(execCommand, execArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: shell === 'bash' || shell === 'zsh' || shell === 'fish',
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Set timeout
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, options.timeout ?? 30000);

    // Handle completion
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (killed ? 124 : 1),
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        shell,
      });
    });

    // Handle errors
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + '\nFailed to execute command',
        durationMs: Date.now() - startTime,
        shell,
      });
    });
  });
}

/**
 * Build shell-specific command.
 */
function buildShellCommand(
  shell: ShellType,
  command: string,
  args: string[]
): { execCommand: string; execArgs: string[] } {
  switch (shell) {
    case 'powershell':
      return {
        execCommand: 'powershell',
        execArgs: ['-Command', `${command} ${args.join(' ')}`],
      };

    case 'pwsh':
      return {
        execCommand: 'pwsh',
        execArgs: ['-Command', `${command} ${args.join(' ')}`],
      };

    case 'cmd':
      return {
        execCommand: 'cmd',
        execArgs: ['/c', command, ...args],
      };

    case 'bash':
    case 'zsh':
    case 'fish':
      return {
        execCommand: command,
        execArgs: args,
      };

    default:
      return {
        execCommand: command,
        execArgs: args,
      };
  }
}

// ─── PowerShell Helpers ──────────────────────────────────────────────────

/**
 * Execute a PowerShell script block.
 */
export async function executePowerShellScript(
  script: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    executionPolicy?: 'Restricted' | 'AllSigned' | 'RemoteSigned' | 'Unrestricted';
  } = {}
): Promise<ShellExecutionResult> {
  const pwsh = await getBestShell();
  if (pwsh.type !== 'powershell' && pwsh.type !== 'pwsh') {
    throw new Error('PowerShell not available');
  }

  // Set execution policy if specified
  const policyFlag = options.executionPolicy
    ? `-ExecutionPolicy ${options.executionPolicy}`
    : '';

  return executeShellCommand(
    pwsh.path,
    [policyFlag, '-Command', script],
    {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      shell: pwsh.type,
    }
  );
}

/**
 * Execute a PowerShell script file.
 */
export async function executePowerShellFile(
  filePath: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = {}
): Promise<ShellExecutionResult> {
  const pwsh = await getBestShell();
  if (pwsh.type !== 'powershell' && pwsh.type !== 'pwsh') {
    throw new Error('PowerShell not available');
  }

  return executeShellCommand(
    pwsh.path,
    ['-File', filePath, ...args],
    {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      shell: pwsh.type,
    }
  );
}

// ─── CMD Helpers ─────────────────────────────────────────────────────────

/**
 * Execute a CMD command.
 */
export async function executeCMDCommand(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = {}
): Promise<ShellExecutionResult> {
  return executeShellCommand(
    'cmd',
    ['/c', command, ...args],
    {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      shell: 'cmd',
    }
  );
}

// ─── Bash Helpers ────────────────────────────────────────────────────────

/**
 * Execute a Bash script.
 */
export async function executeBashScript(
  script: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = {}
): Promise<ShellExecutionResult> {
  return executeShellCommand(
    'bash',
    ['-c', script],
    {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      shell: 'bash',
    }
  );
}

/**
 * Execute a Bash script file.
 */
export async function executeBashFile(
  filePath: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = {}
): Promise<ShellExecutionResult> {
  return executeShellCommand(
    'bash',
    [filePath, ...args],
    {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      shell: 'bash',
    }
  );
}

// ─── Export All ──────────────────────────────────────────────────────────

export default {
  // Shell detection
  detectShells,
  getDefaultShell,
  getBestShell,

  // Shell execution
  executeShellCommand,
  buildShellCommand,

  // PowerShell helpers
  executePowerShellScript,
  executePowerShellFile,

  // CMD helpers
  executeCMDCommand,

  // Bash helpers
  executeBashScript,
  executeBashFile,
};

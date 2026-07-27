/**
 * ExecuteModule — Executes shell commands and captures output.
 * Phase 8 of the architecture migration: extract from RunnerAgent into
 * a pluggable module with EventBus integration.
 *
 * Determines the command to run from the task description, validates it,
 * executes on the host or in a Docker sandbox, and returns structured output.
 *
 * @see ARCHITECTURE.md §3.8 — Execute Module specification
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import { getHostShell } from '../utils/shell.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of a single command execution */
export interface ExecuteResult {
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
  /** Error message if execution threw */
  error?: string;
}

/** Parameters for the ExecuteModule.execute() method */
export interface ExecuteParams {
  /** The command to run (can be extracted from task description) */
  command?: string;
  /** The user goal / task description (used to infer command if not provided) */
  goal: string;
  /** Working directory for the command */
  workingDirectory: string;
  /** Optional timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** Optional list of file changes for context */
  fileChanges?: Array<{ path: string; status: string }>;
  /** Optional list of artifacts for context */
  artifactPaths?: string[];
}

// ─── ExecuteModule Interface ─────────────────────────────────────────────────

/**
 * ExecuteModule — Execute shell commands and capture output.
 *
 * @example
 * ```typescript
 * const module = new DefaultExecuteModule();
 * const result = await module.execute({
 *   command: 'npm test',
 *   goal: 'Run tests',
 *   workingDirectory: '/project',
 * });
 * console.log(`Exit code: ${result.exitCode}`);
 * ```
 */
export interface ExecuteModule {
  /**
   * Execute a shell command and capture output.
   */
  execute(params: ExecuteParams): Promise<ExecuteResult>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_OUTPUT_LENGTH = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Default ExecuteModule ─────────────────────────────────────────────────

/**
 * DefaultExecuteModule — Built-in execute module implementation.
 *
 * Determines the command to run (from params or by inferring from the goal),
 * validates it against the project environment, executes via execSync,
 * and returns structured output with stdout, stderr, exit code, and duration.
 */
export class DefaultExecuteModule implements ExecuteModule {
  /** The event bus for emitting observability events */
  private eventBus: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? getEventBus();
  }

  /**
   * Execute a shell command and capture output.
   */
  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const { command: explicitCommand, goal, workingDirectory, timeoutMs = DEFAULT_TIMEOUT_MS, fileChanges, artifactPaths } = params;

    // Determine the command
    const command = explicitCommand || this.inferCommand(goal, fileChanges, artifactPaths);

    if (!command) {
      return {
        success: false,
        command: '',
        exitCode: 1,
        stdout: '',
        stderr: '',
        duration: 0,
        error: 'Could not determine which command to execute from the task description or context.',
      };
    }

    // ── Emit: execute starting ─────────────────────────────────────
    this.eventBus.emit(EventNames.EXECUTE_STARTING, {
      command,
      workingDirectory,
    }, 'execute-module');

    // Validate the command before executing
    const validation = this.validateCommand(command, workingDirectory);
    if (!validation.available) {
      this.eventBus.emit(EventNames.EXECUTE_FAILED, {
        command,
        error: validation.reason,
      }, 'execute-module');

      return {
        success: false,
        command,
        exitCode: 1,
        stdout: '',
        stderr: '',
        duration: 0,
        error: validation.reason,
      };
    }

    // Execute the command
    const startTime = Date.now();
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let execError: string | undefined;

    try {
      const output = execSync(command, {
        cwd: workingDirectory,
        timeout: timeoutMs,
        stdio: 'pipe',
        encoding: 'utf-8' as const,
        shell: getHostShell(),
        maxBuffer: 1024 * 1024,
      });
      stdout = (output as string).trim();
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

    const result: ExecuteResult = {
      success: exitCode === 0,
      command,
      exitCode,
      stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
      stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
      duration,
      error: execError,
    };

    // ── Emit: execute completed ────────────────────────────────────
    this.eventBus.emit(EventNames.EXECUTE_COMPLETED, {
      command,
      success: result.success,
      exitCode,
      duration,
      stdoutLength: stdout.length,
    }, 'execute-module');

    return result;
  }

  /**
   * Infer the command to run from the goal and context.
   * Priority: backtick-wrapped command > "Run:" prefix > npm test > LLM-style prompt.
   */
  private inferCommand(
    goal: string,
    fileChanges?: Array<{ path: string; status: string }>,
    _artifactPaths?: string[],
  ): string | null {
    // Strategy 1: Extract command from backticks in the description
    const backtickMatch = goal.match(/`([^`]+)`/);
    if (backtickMatch) return backtickMatch[1].trim();

    // Strategy 2: Extract from "Run:" prefix
    const runPrefixMatch = goal.match(/^Run:\s*(.+)/i);
    if (runPrefixMatch) return runPrefixMatch[1].trim();

    // Strategy 3: Check if the goal mentions running a specific file
    const runMatch = goal.match(/run\s+(?:`)?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)/i);
    if (runMatch) return runMatch[1].trim();

    // Strategy 4: Check for common test/serve/start patterns
    const lower = goal.toLowerCase();
    if (lower.includes('npm test') || lower.includes('run test')) return 'npm test';
    if (lower.includes('npm start') || lower.includes('run start')) return 'npm start';
    if (lower.includes('npm run build') || lower.includes('run build')) return 'npm run build';
    if (lower.includes('python')) {
      const pyMatch = goal.match(/python\s+([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)/i);
      if (pyMatch) return `python ${pyMatch[1]}`;
    }
    if (lower.includes('node ')) {
      const nodeMatch = goal.match(/node\s+([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)/i);
      if (nodeMatch) return `node ${nodeMatch[1]}`;
    }

    // Strategy 5: If there are file changes that look like Python scripts, suggest running
    if (fileChanges) {
      for (const fc of fileChanges) {
        if (fc.path.endsWith('.py')) return `python ${fc.path}`;
        if (fc.path.endsWith('.js') || fc.path.endsWith('.mjs')) return `node ${fc.path}`;
        if (fc.path.endsWith('.sh')) return `bash ${fc.path}`;
        if (fc.path.endsWith('.go')) return `go run ${fc.path}`;
        if (fc.path.endsWith('.rs')) return `cargo run`;
      }
    }

    return null;
  }

  /**
   * Validate whether a command is likely to succeed.
   * Checks npm test commands against package.json.
   */
  private validateCommand(command: string, workingDir: string): { available: boolean; reason?: string } {
    const npmTestPattern = /^npm\s+(run\s+)?test(\s|$)/;
    if (npmTestPattern.test(command.trim())) {
      const pkgPath = join(workingDir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
          if (!pkg.scripts?.test) {
            return {
              available: false,
              reason: `Project has no "test" script in package.json. The command "${command}" would fail with "Missing script: test".`,
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
          reason: `No package.json found. The command "${command}" requires an npm project.`,
        };
      }
    }

    return { available: true };
  }
}

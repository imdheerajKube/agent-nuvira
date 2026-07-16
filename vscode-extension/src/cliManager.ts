/**
 * CLI Manager — Spawns the agent-nuvira CLI as a child process and
 * handles bidirectional communication for agent tasks.
 *
 * Features:
 * - Spawn CLI with proper arguments for each task type
 * - Stream stdout/stderr in real-time
 * - Parse structured output (JSON chunks) from CLI
 * - Handle errors, timeouts, and cleanup
 * - Provide progress callbacks for the webview panel
 */

import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import * as vscode from 'vscode';

import type { CLIResult, ExtensionConfig } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default timeout for CLI commands (5 minutes) */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Timeout for quick operations (e.g., explain, quick fix) */
const QUICK_TIMEOUT_MS = 60_000;

// ─── CLIManager ─────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of a CLI subprocess for agent tasks.
 * Each task gets its own subprocess instance.
 */
export class CLIManager {
  private process: ChildProcess | null = null;
  private config: ExtensionConfig;
  private workspaceRoot: string;
  private onProgress?: (phase: string, detail?: string) => void;
  private onLog?: (line: string) => void;
  private abortController: AbortController;

  constructor(config: ExtensionConfig) {
    this.config = config;
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
    this.abortController = new AbortController();
  }

  /**
   * Set progress and log callbacks for real-time updates.
   */
  setCallbacks(opts: {
    onProgress?: (phase: string, detail?: string) => void;
    onLog?: (line: string) => void;
  }): void {
    this.onProgress = opts.onProgress;
    this.onLog = opts.onLog;
  }

  /**
   * Cancel the currently running task.
   */
  cancel(): void {
    this.abortController.abort();
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      // Force kill after 3 seconds if not stopped
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  /**
   * Check if a task is currently running.
   */
  get isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  // ── Task Methods ──────────────────────────────────────────────────────────

  /**
   * Execute a general goal via the multi-agent pipeline.
   * Corresponds to: buff execute <goal>
   */
  async executeGoal(goal: string): Promise<CLIResult> {
    const args = this.buildArgs(['execute', goal]);
    return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
      phaseLabels: ['Planning', 'Gathering context', 'Writing code', 'Reviewing', 'Applying'],
    });
  }

  /**
   * Quick fix for the current file.
   * Corresponds to: buff edit <file>
   */
  async quickFix(filePath: string): Promise<CLIResult> {
    const relativePath = this.relativePath(filePath);
    const args = this.buildArgs(['edit', relativePath, '--quick']);
    return this.runCommand(args, QUICK_TIMEOUT_MS, {
      phaseLabels: ['Analyzing file', 'Generating fix', 'Applying fix'],
    });
  }

  /**
   * Review a file for bugs and improvements.
   * Corresponds to: buff execute "review <file>"
   */
  async reviewFile(filePath: string): Promise<CLIResult> {
    const relativePath = this.relativePath(filePath);
    const goal = `Review the file ${relativePath} for bugs, security issues, and improvements. Provide a detailed report.`;
    const args = this.buildArgs(['execute', goal]);
    return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
      phaseLabels: ['Analyzing file', 'Checking for issues', 'Generating report'],
    });
  }

  /**
   * Explain selected code.
   * Uses a simple chat prompt.
   */
  async explainCode(code: string, fileExtension?: string): Promise<CLIResult> {
    const prompt = `Explain the following ${fileExtension || 'code'} in detail:\n\n${code}`;
    const args = this.buildArgs(['chat', prompt, '--stream']);
    return this.runCommand(args, QUICK_TIMEOUT_MS, {
      phaseLabels: ['Analyzing code', 'Generating explanation'],
    });
  }

  /**
   * Generate tests for a file.
   * Corresponds to: buff execute "generate tests for <file>"
   */
  async generateTests(filePath: string): Promise<CLIResult> {
    const relativePath = this.relativePath(filePath);
    const goal = `Generate comprehensive unit tests for the code in ${relativePath}. Include edge cases and mock external dependencies.`;
    const args = this.buildArgs(['execute', goal]);
    return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
      phaseLabels: ['Analyzing code', 'Designing tests', 'Writing tests'],
    });
  }

  /**
   * Run a workflow template.
   * Corresponds to: buff workflow run <template> <goal>
   */
  async runWorkflow(template: string, goal: string): Promise<CLIResult> {
    const args = this.buildArgs(['workflow', 'run', template, goal]);
    return this.runCommand(args, DEFAULT_TIMEOUT_MS, {
      phaseLabels: [`Running workflow: ${template}`],
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Build CLI arguments with common options.
   */
  private buildArgs(customArgs: string[]): string[] {
    const args: string[] = [...customArgs];

    // Add provider/model if configured
    if (this.config.defaultProvider) {
      args.push('--provider', this.config.defaultProvider);
    }
    if (this.config.defaultModel) {
      args.push('--model', this.config.defaultModel);
    }

    return args;
  }

  /**
   * Get the relative path from workspace root.
   */
  private relativePath(absolutePath: string): string {
    const rel = vscode.workspace.asRelativePath(absolutePath);
    // Wrap in quotes if it contains spaces
    return rel.includes(' ') ? `"${rel}"` : rel;
  }

  /**
   * Run the CLI command and capture output with progress tracking.
   */
  private runCommand(
    args: string[],
    timeoutMs: number,
    options?: {
      phaseLabels?: string[];
    },
  ): Promise<CLIResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const { command: cliCmd, spawnArgs } = this.resolveCliCommand();
      const allArgs = [...spawnArgs, ...args];
      let stdout = '';
      let stderr = '';
      let phaseIndex = 0;
      const phaseLabels = options?.phaseLabels || ['Running'];

      // Report initial progress
      this.reportProgress(phaseLabels[0]);

      // Spawn process
      this.abortController = new AbortController();
      this.process = spawn(cliCmd, allArgs, {
        cwd: this.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: this.abortController.signal,
        env: { ...process.env, FORCE_COLOR: '0' }, // Disable color for parsing
      });

      // Handle stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        // Process lines for progress updates and logging
        const lines = text.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          this.onLog?.(line);

          // Detect phase changes from CLI output patterns
          const phaseMatch = line.match(/^[📋📂✏️🔍🧪📦🏗️📝🔄]\s+(.+?)$/);
          if (phaseMatch) {
            const newPhase = phaseMatch[1].trim();
            if (newPhase.length > 5 && newPhase.length < 80) {
              this.reportProgress(newPhase);
            }
          }

          // Detect error/warning patterns
          if (line.includes('✖') || line.includes('Error:')) {
            this.reportProgress('Error encountered', line);
          }
        }

        // Update progress through phases
        if (stdout.length > 100 * (phaseIndex + 1) && phaseIndex < phaseLabels.length - 1) {
          phaseIndex++;
          this.reportProgress(phaseLabels[phaseIndex]);
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        this.onLog?.(`[stderr] ${text}`);

        if (text.includes('error') || text.includes('Error')) {
          this.reportProgress('Error', text.slice(0, 200));
        }
      });

      // Handle errors
      this.process.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(new Error(
            `CLI '${cliCmd}' not found. Install agent-nuvira or configure 'agent-nuvira.cliPath'.\n` +
            `  Run: npm install -g agent-nuvira\n` +
            `  Or set path in VS Code settings.`
          ));
        } else if (err.name === 'AbortError') {
          reject(new Error('Task was cancelled.'));
        } else {
          reject(new Error(`CLI process error: ${err.message}`));
        }
      });

      // Handle process exit
      this.process.on('close', (exitCode) => {
        const durationMs = Date.now() - startTime;
        const result: CLIResult = {
          stdout,
          stderr,
          exitCode,
          success: exitCode === 0,
          durationMs,
        };

        this.process = null;

        if (exitCode === 0) {
          resolve(result);
        } else {
          // Non-zero exit is still resolved (not rejected) so caller can handle partial results
          resolve(result);
        }
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.reportProgress('Timeout', `Task timed out after ${(timeoutMs / 1000).toFixed(0)}s`);
          this.process.kill('SIGTERM');
        }
      }, timeoutMs);

      // Clear timeout on process exit
      this.process.on('close', () => clearTimeout(timeout));
    });
  }

  /**
   * Report progress update to the registered callback.
   */
  private reportProgress(phase: string, detail?: string): void {
    this.onProgress?.(phase, detail);
  }

  /**
   * Resolve the CLI command and arguments.
   * Returns [command, ...args] for use with spawn().
   */
  private resolveCliCommand(): { command: string; spawnArgs: string[] } {
    const configuredPath = this.config.cliPath;

    if (configuredPath && configuredPath !== 'buff') {
      // Support both simple commands and paths with spaces
      const parts = configuredPath.split(' ');
      return {
        command: parts[0],
        spawnArgs: parts.slice(1),
      };
    }

    // Default: try to use 'buff' directly (on PATH)
    return {
      command: 'buff',
      spawnArgs: [],
    };
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.cancel();
  }
}

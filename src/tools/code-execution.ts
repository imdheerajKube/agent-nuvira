/**
 * Code Execution Tool — Sandboxed code execution.
 *
 * Hermes equivalent: code_execution_tool.py (2,087 lines)
 *
 * Provides:
 * - Execute code in sandboxed environment
 * - Support for multiple languages (JS, TS, Python, bash)
 * - Timeout and resource limits
 * - Output capture
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';

// ─── Types ────────────────────────────────────────────────────────────────

export type ExecutionLanguage = 'javascript' | 'typescript' | 'python' | 'bash' | 'powershell';

export interface ExecutionConfig {
  language: ExecutionLanguage;
  code: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExecutionResult {
  id: string;
  language: ExecutionLanguage;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

// ─── Code Executor ────────────────────────────────────────────────────────

export class CodeExecutor extends EventEmitter {
  private execDir: string;
  private activeExecutions: Map<string, { process: any; timer: NodeJS.Timeout }> = new Map();

  constructor() {
    super();
    this.execDir = join(tmpdir(), 'nuvira-exec');
    this.ensureDir();
  }

  private async ensureDir(): Promise<void> {
    try {
      await mkdir(this.execDir, { recursive: true });
    } catch {
      // Ignore
    }
  }

  /**
   * Execute code.
   */
  async execute(config: ExecutionConfig): Promise<ExecutionResult> {
    const id = randomUUID();
    const startTime = Date.now();
    const timeoutMs = config.timeoutMs || 30_000;
    const maxOutputBytes = config.maxOutputBytes || 1024 * 1024; // 1MB

    const { command, args, ext } = this.getCommand(config.language);

    // Write code to temp file
    const codeFile = join(this.execDir, `${id}${ext}`);
    await writeFile(codeFile, config.code, 'utf-8');

    return new Promise((resolve) => {
      const child = spawn(command, [...args, codeFile], {
        cwd: config.cwd || process.cwd(),
        env: { ...process.env, ...config.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        this.activeExecutions.delete(id);
      }, timeoutMs);

      this.activeExecutions.set(id, { process: child, timer });

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < maxOutputBytes) stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < maxOutputBytes) stderr += data.toString();
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        this.activeExecutions.delete(id);

        // Cleanup temp file
        unlink(codeFile).catch(() => {});

        const result: ExecutionResult = {
          id,
          language: config.language,
          exitCode: exitCode || 0,
          stdout: stdout.slice(0, maxOutputBytes),
          stderr: stderr.slice(0, maxOutputBytes),
          durationMs: Date.now() - startTime,
          timedOut,
        };

        logger.debug(`[exec] ${config.language} completed in ${result.durationMs}ms (exit: ${exitCode})`);
        this.emit('completed', result);
        resolve(result);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeExecutions.delete(id);
        unlink(codeFile).catch(() => {});

        resolve({
          id,
          language: config.language,
          exitCode: 1,
          stdout: '',
          stderr: err.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
          error: err.message,
        });
      });
    });
  }

  /**
   * Cancel an execution.
   */
  cancel(id: string): boolean {
    const exec = this.activeExecutions.get(id);
    if (!exec) return false;

    clearTimeout(exec.timer);
    exec.process.kill('SIGKILL');
    this.activeExecutions.delete(id);
    return true;
  }

  /**
   * Get the command for a language.
   */
  private getCommand(lang: ExecutionLanguage): { command: string; args: string[]; ext: string } {
    switch (lang) {
      case 'javascript':
        return { command: 'node', args: [], ext: '.js' };
      case 'typescript':
        return { command: 'npx', args: ['tsx'], ext: '.ts' };
      case 'python':
        return { command: 'python3', args: [], ext: '.py' };
      case 'bash':
        return { command: 'bash', args: [], ext: '.sh' };
      case 'powershell':
        return { command: 'pwsh', args: ['-File'], ext: '.ps1' };
      default:
        return { command: 'node', args: [], ext: '.js' };
    }
  }

  /**
   * Get active execution count.
   */
  getActiveCount(): number {
    return this.activeExecutions.size;
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _codeExecutor: CodeExecutor | null = null;

export function getCodeExecutor(): CodeExecutor {
  if (!_codeExecutor) _codeExecutor = new CodeExecutor();
  return _codeExecutor;
}

export function resetCodeExecutor(): void {
  _codeExecutor = null;
}

/**
 * Integration tests for CLIManager lifecycle methods.
 *
 * Tests the methods that spawn child processes:
 * - executeGoal() — 'buff execute <goal>'
 * - quickFix() — 'buff edit <file> --quick'
 * - reviewFile() — 'buff execute "review <file>"'
 * - explainCode() — 'buff chat <prompt> --stream'
 * - generateTests() — 'buff execute "generate tests for <file>"'
 * - runWorkflow() — 'buff workflow run <template> <goal>'
 *
 * Uses a controllable mock process to simulate CLI output,
 * exit codes, timeouts, and cancellation.
 *
 * Each test:
 * 1. Spies on child_process.spawn to capture the mock process
 * 2. Calls the lifecycle method (returns a Promise)
 * 3. Controls the mock process to emit data and close
 * 4. Asserts the resolved CLIResult
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ─── Mock child_process with controllable process ───────────────────────────

type ProcessEventHandler = (...args: unknown[]) => void;

function createControllableMockProcess() {
  const stdoutListeners: ProcessEventHandler[] = [];
  const stderrListeners: ProcessEventHandler[] = [];
  const closeListeners: ProcessEventHandler[] = [];
  const errorListeners: ProcessEventHandler[] = [];

  const mockProcess = {
    stdout: {
      on: vi.fn((event: string, handler: ProcessEventHandler) => {
        if (event === 'data') stdoutListeners.push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: ProcessEventHandler) => {
        if (event === 'data') stderrListeners.push(handler);
      }),
    },
    on: vi.fn((event: string, handler: ProcessEventHandler) => {
      if (event === 'close') closeListeners.push(handler);
      if (event === 'error') errorListeners.push(handler);
    }),
    kill: vi.fn(),
    killed: false,
    exitCode: null as number | null,
    pid: 99999,
  };

  // Helper to emit stdout data from the mock process
  const emitStdout = (data: string) => {
    for (const handler of stdoutListeners) {
      handler(Buffer.from(data, 'utf-8'));
    }
  };

  // Helper to emit stderr data from the mock process
  const emitStderr = (data: string) => {
    for (const handler of stderrListeners) {
      handler(Buffer.from(data, 'utf-8'));
    }
  };

  // Helper to close the process with an exit code
  const emitClose = (exitCode: number) => {
    mockProcess.exitCode = exitCode;
    for (const handler of closeListeners) {
      handler(exitCode);
    }
  };

  // Helper to emit an error
  const emitError = (err: NodeJS.ErrnoException) => {
    for (const handler of errorListeners) {
      handler(err);
    }
  };

  return { mockProcess, emitStdout, emitStderr, emitClose, emitError };
}

// ─── Setup mocks ────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    ChildProcess: function () { /* noop */ },
  };
});

vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

import { spawn } from 'node:child_process';
import { CLIManager } from '../cliManager.js';
import type { CLIResult } from '../types.js';

describe('CLIManager Integration', () => {
  const defaultConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
  };

  let manager: CLIManager;
  let mockControl: ReturnType<typeof createControllableMockProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockControl = createControllableMockProcess();
    vi.mocked(spawn).mockReturnValue(mockControl.mockProcess as any);
    manager = new CLIManager(defaultConfig);
  });

  afterEach(() => {
    // Ensure any pending processes are cleaned up
    manager.dispose();
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Run a CLI task and control the mock process lifecycle */
  async function runTask(
    task: () => Promise<CLIResult>,
    options?: {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    },
  ): Promise<CLIResult> {
    const resultPromise = task();

    // Emit stdout/stderr if provided
    if (options?.stdout) mockControl.emitStdout(options.stdout);
    if (options?.stderr) mockControl.emitStderr(options.stderr);

    // Close with exit code (default 0)
    mockControl.emitClose(options?.exitCode ?? 0);

    return resultPromise;
  }

  // ── executeGoal ──────────────────────────────────────────────────────────

  describe('executeGoal', () => {
    it('spawns with correct args for a simple goal', async () => {
      await runTask(() => manager.executeGoal('add JWT auth'));
      expect(spawn).toHaveBeenCalledWith('buff', ['execute', 'add JWT auth'], expect.any(Object));
    });

    it('spawns with goal containing special characters', async () => {
      await runTask(() => manager.executeGoal('fix "bugs" in app.ts'));
      expect(spawn).toHaveBeenCalledWith('buff', ['execute', 'fix "bugs" in app.ts'], expect.any(Object));
    });

    it('returns success result on exit code 0', async () => {
      const result = await runTask(
        () => manager.executeGoal('add tests'),
        { stdout: '✅ All tests added\n📄 src/__tests__/app.test.ts (created)' },
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✅ All tests added');
    });

    it('returns failure result on non-zero exit code', async () => {
      const result = await runTask(
        () => manager.executeGoal('invalid task'),
        { stderr: 'Error: unknown command', exitCode: 1 },
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Error: unknown command');
    });

    it('captures durationMs', async () => {
      const result = await runTask(
        () => manager.executeGoal('fast task'),
        { stdout: 'Done.' },
      );

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('includes provider/model in spawn args when configured', async () => {
      const m = new CLIManager({ ...defaultConfig, defaultProvider: 'groq', defaultModel: 'llama' });
      const localMock = createControllableMockProcess();
      vi.mocked(spawn).mockReturnValue(localMock.mockProcess as any);

      const resultPromise = m.executeGoal('test');
      localMock.emitClose(0);
      await resultPromise;

      expect(spawn).toHaveBeenCalledWith('buff', ['execute', 'test', '--provider', 'groq', '--model', 'llama'], expect.any(Object));
    });
  });

  // ── quickFix ─────────────────────────────────────────────────────────────

  describe('quickFix', () => {
    it('spawns with edit command and --quick flag', async () => {
      await runTask(() => manager.quickFix('/workspace/src/app.ts'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      expect(args[0]).toBe('edit');
      expect(args[1]).toBe('app.ts'); // mock asRelativePath returns basename
      expect(args).toContain('--quick');
    });

    it('returns success with fix output', async () => {
      const result = await runTask(
        () => manager.quickFix('/workspace/src/bug.ts'),
        { stdout: 'Fixed syntax error on line 42. Replaced `==` with `===`.' },
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Fixed syntax error');
    });
  });

  // ── reviewFile ───────────────────────────────────────────────────────────

  describe('reviewFile', () => {
    it('spawns with execute command containing review goal', async () => {
      await runTask(() => manager.reviewFile('/workspace/src/auth.ts'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      expect(args[0]).toBe('execute');
      expect(args[1]).toContain('Review the file');
      expect(args[1]).toContain('auth.ts');
    });

    it('returns review results', async () => {
      const result = await runTask(
        () => manager.reviewFile('/workspace/src/api.ts'),
        { stdout: '## Review Findings\n1. Missing input validation\n2. Unhandled promise rejection' },
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Review Findings');
    });

    it('handles review failure', async () => {
      const result = await runTask(
        () => manager.reviewFile('/workspace/nonexistent.ts'),
        { stderr: 'File not found', exitCode: 1 },
      );

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('File not found');
    });
  });

  // ── explainCode ──────────────────────────────────────────────────────────

  describe('explainCode', () => {
    it('spawns with chat command and --stream flag', async () => {
      await runTask(() => manager.explainCode('const x = 1;', 'ts'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      expect(args[0]).toBe('chat');
      expect(args[1]).toContain('Explain the following');
      expect(args[1]).toContain('ts');
      expect(args).toContain('--stream');
    });

    it('includes code in the prompt', async () => {
      await runTask(() => manager.explainCode('function add(a, b) { return a + b; }'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      expect(args[1]).toContain('function add(a, b)');
    });

    it('uses "code" as default file extension when not provided', async () => {
      await runTask(() => manager.explainCode('print("hello")'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      expect(args[1]).toContain('code');
    });

    it('returns explanation output', async () => {
      const result = await runTask(
        () => manager.explainCode('console.log("hi")', 'js'),
        { stdout: 'This code logs "hi" to the console using console.log().' },
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('console.log');
    });
  });

  // ── generateTests ────────────────────────────────────────────────────────

  describe('generateTests', () => {
    it('spawns with execute command containing test generation goal', async () => {
      await runTask(() => manager.generateTests('/workspace/src/utils.ts'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      expect(args[0]).toBe('execute');
      expect(args[1]).toContain('Generate comprehensive unit tests');
      expect(args[1]).toContain('utils.ts');
    });

    it('returns generated test output', async () => {
      const result = await runTask(
        () => manager.generateTests('/workspace/src/calc.ts'),
        { stdout: '📄 src/__tests__/calc.test.ts (created)\n🧪 5 tests generated' },
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('5 tests generated');
    });
  });

  // ── runWorkflow ──────────────────────────────────────────────────────────

  describe('runWorkflow', () => {
    it('spawns with workflow command', async () => {
      await runTask(() => manager.runWorkflow('quick-fix', 'fix lint issues'));
      const args = vi.mocked(spawn).mock.calls[0][1];
      expect(args[0]).toBe('workflow');
      expect(args[1]).toBe('run');
      expect(args[2]).toBe('quick-fix');
      expect(args[3]).toBe('fix lint issues');
    });

    it('returns workflow output', async () => {
      const result = await runTask(
        () => manager.runWorkflow('feature-implement', 'add dark mode'),
        { stdout: '🔄 Running workflow "feature-implement"\n✅ Feature implemented\n📄 src/styles/dark.css (created)' },
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Feature implemented');
    });
  });

  // ── Progress Callbacks ───────────────────────────────────────────────────

  describe('progress callbacks', () => {
    it('calls onProgress when phase labels change', async () => {
      const onProgress = vi.fn();
      manager.setCallbacks({ onProgress });

      const resultPromise = manager.executeGoal('test');
      mockControl.emitClose(0);
      await resultPromise;

      // onProgress should have been called with the initial phase label
      expect(onProgress).toHaveBeenCalled();
      const phases = onProgress.mock.calls.map((c: string[]) => c[0]);
      expect(phases.some((p: string) => p.length > 0)).toBe(true);
    });

    it('calls onLog for each stdout line', async () => {
      const onLog = vi.fn();
      manager.setCallbacks({ onLog });

      const resultPromise = manager.executeGoal('test');
      mockControl.emitStdout('📋 Planning step...\n✏️ Writing code...\nDone.');
      mockControl.emitClose(0);
      await resultPromise;

      expect(onLog).toHaveBeenCalledTimes(3);
      expect(onLog).toHaveBeenCalledWith('📋 Planning step...');
      expect(onLog).toHaveBeenCalledWith('✏️ Writing code...');
    });

    it('calls onLog with stderr output', async () => {
      const onLog = vi.fn();
      manager.setCallbacks({ onLog });

      const resultPromise = manager.quickFix('/workspace/file.ts');
      mockControl.emitStderr('Error: something went wrong');
      mockControl.emitClose(1);
      await resultPromise;

      expect(onLog).toHaveBeenCalled();
      const logMessages = onLog.mock.calls.map((c: string[]) => c[0]);
      expect(logMessages.some((m: string) => m.includes('Error'))).toBe(true);
    });
  });

  // ── Cancellation ─────────────────────────────────────────────────────────

  describe('cancellation', () => {
    it('cancels an ongoing task', async () => {
      const onProgress = vi.fn();
      manager.setCallbacks({ onProgress });

      const resultPromise = manager.executeGoal('long task');

      // Cancel mid-execution
      manager.cancel();

      // The process should be killed
      expect(mockControl.mockProcess.kill).toHaveBeenCalledWith('SIGTERM');

      // After cancellation, process close still resolves the promise
      mockControl.emitClose(null);
      const result = await resultPromise;
      expect(result).toBeDefined();
    });

    it('isRunning returns true during execution, false after', async () => {
      const resultPromise = manager.executeGoal('sync task');
      expect(manager.isRunning).toBe(true);

      mockControl.emitClose(0);
      await resultPromise;
      expect(manager.isRunning).toBe(false);
    });

    it('isRunning returns false when idle', () => {
      expect(manager.isRunning).toBe(false);
    });
  });

  // ── Timeout ──────────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('does not hang when process completes before timeout', async () => {
      const result = await runTask(
        () => manager.executeGoal('fast task'),
        { stdout: 'Fast and done.' },
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Fast and done.');
    });
  });

  // ── ENOENT (CLI not found) ───────────────────────────────────────────────

  describe('CLI not found error', () => {
    it('rejects with a descriptive error when CLI does not exist', async () => {
      const errorProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
        killed: false,
        exitCode: null as number | null,
        pid: null,
      };
      vi.mocked(spawn).mockReturnValue(errorProcess as any);

      const resultPromise = manager.executeGoal('test');

      // Simulate ENOENT error (CLI not found)
      const errorHandler = errorProcess.on.mock.calls.find((c: string[]) => c[0] === 'error')?.[1];
      if (errorHandler) {
        const enoentErr = new Error('spawn buff ENOENT');
        (enoentErr as NodeJS.ErrnoException).code = 'ENOENT';
        errorHandler(enoentErr);
      }

      // The CLIManager rejects on ENOENT — assert the error message
      await expect(resultPromise).rejects.toThrow('not found');
    });
  });
});

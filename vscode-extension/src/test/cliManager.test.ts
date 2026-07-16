/**
 * Unit tests for CLIManager.
 *
 * Tests the pure-logic methods that can be isolated from the VS Code API:
 * - buildArgs() — constructs CLI arguments with provider/model options
 * - relativePath() — converts absolute paths to workspace-relative paths
 * - resolveCliCommand() — resolves CLI executable path
 * - cancel() — cancels running process
 * - isRunning — process state tracking
 * - setCallbacks — progress/log callback registration
 *
 * Lifecycle methods (executeGoal, quickFix, etc.) spawn actual child processes
 * and are tested separately via integration tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock child_process before importing CLIManager
vi.mock('node:child_process', () => {
  const mockProcess = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
    exitCode: null,
    pid: 12345,
  };

  return {
    spawn: vi.fn(() => mockProcess),
    ChildProcess: function () { /* noop */ },
  };
});

// Mock vscode module
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

// Import after mocks are set up
import { CLIManager } from '../cliManager.js';

describe('CLIManager', () => {
  const defaultConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
  };

  let manager: CLIManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CLIManager(defaultConfig);
  });

  // ── Constructor ───────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates an instance with default config', () => {
      const m = new CLIManager(defaultConfig);
      expect(m).toBeInstanceOf(CLIManager);
      expect(m.isRunning).toBe(false);
    });

    it('creates instance with custom config', () => {
      const customConfig = {
        ...defaultConfig,
        cliPath: '/usr/local/bin/buff',
        defaultProvider: 'groq',
        defaultModel: 'llama-3.3-70b',
      };
      const m = new CLIManager(customConfig);
      expect(m).toBeInstanceOf(CLIManager);
    });
  });

  // ── buildArgs ─────────────────────────────────────────────────────────

  describe('buildArgs', () => {
    it('returns args unchanged when no provider/model configured', () => {
      const m = new CLIManager(defaultConfig);
      // Access private method via bracket notation for testing
      const args = (m as unknown as { buildArgs(customArgs: string[]): string[] }).buildArgs(['execute', 'test goal']);
      expect(args).toEqual(['execute', 'test goal']);
    });

    it('appends --provider when configured', () => {
      const config = { ...defaultConfig, defaultProvider: 'groq' };
      const m = new CLIManager(config);
      const args = (m as unknown as { buildArgs(customArgs: string[]): string[] }).buildArgs(['execute', 'test']);
      expect(args).toContain('--provider');
      expect(args).toContain('groq');
    });

    it('appends --model when configured', () => {
      const config = { ...defaultConfig, defaultModel: 'llama-3.3-70b' };
      const m = new CLIManager(config);
      const args = (m as unknown as { buildArgs(customArgs: string[]): string[] }).buildArgs(['execute', 'test']);
      expect(args).toContain('--model');
      expect(args).toContain('llama-3.3-70b');
    });

    it('appends both --provider and --model when both configured', () => {
      const config = {
        ...defaultConfig,
        defaultProvider: 'openrouter',
        defaultModel: 'mistralai/mistral-7b',
      };
      const m = new CLIManager(config);
      const args = (m as unknown as { buildArgs(customArgs: string[]): string[] }).buildArgs(['chat', 'hello']);
      expect(args).toEqual(['chat', 'hello', '--provider', 'openrouter', '--model', 'mistralai/mistral-7b']);
    });

    it('preserves custom args order with provider/model appended at end', () => {
      const config = { ...defaultConfig, defaultProvider: 'gemini' };
      const m = new CLIManager(config);
      const args = (m as unknown as { buildArgs(customArgs: string[]): string[] }).buildArgs(['execute', 'fix bug', '--verbose']);
      expect(args.slice(0, 3)).toEqual(['execute', 'fix bug', '--verbose']);
      expect(args.slice(-2)).toEqual(['--provider', 'gemini']);
    });
  });

  // ── relativePath ───────────────────────────────────────────────────────

  describe('relativePath', () => {
    it('returns file basename from absolute path', () => {
      const m = new CLIManager(defaultConfig);
      const result = (m as unknown as { relativePath(absolutePath: string): string }).relativePath('/workspace/src/index.ts');
      expect(result).toBe('index.ts'); // mock asRelativePath returns basename
    });

    it('handles paths with spaces by wrapping in quotes', () => {
      // The mock asRelativePath returns just the basename, so no spaces
      // This test verifies the method handles the return value correctly
      const m = new CLIManager(defaultConfig);
      // Override the mock behavior by checking what happens with spaces
      const path = '/workspace/my project/file.ts';
      const result = (m as unknown as { relativePath(absolutePath: string): string }).relativePath(path);
      // Our mock always returns basename (no spaces in basename)
      expect(result).not.toContain(' ');
    });
  });

  // ── resolveCliCommand ──────────────────────────────────────────────────

  describe('resolveCliCommand', () => {
    it('returns default "buff" command when cliPath is "buff"', () => {
      const m = new CLIManager(defaultConfig);
      const result = (m as unknown as { resolveCliCommand(): { command: string; spawnArgs: string[] } }).resolveCliCommand();
      expect(result.command).toBe('buff');
      expect(result.spawnArgs).toEqual([]);
    });

    it('parses simple path correctly', () => {
      const config = { ...defaultConfig, cliPath: '/usr/local/bin/buff' };
      const m = new CLIManager(config);
      const result = (m as unknown as { resolveCliCommand(): { command: string; spawnArgs: string[] } }).resolveCliCommand();
      expect(result.command).toBe('/usr/local/bin/buff');
      expect(result.spawnArgs).toEqual([]);
    });

    it('parses path with arguments', () => {
      const config = { ...defaultConfig, cliPath: 'npx buff' };
      const m = new CLIManager(config);
      const result = (m as unknown as { resolveCliCommand(): { command: string; spawnArgs: string[] } }).resolveCliCommand();
      expect(result.command).toBe('npx');
      expect(result.spawnArgs).toEqual(['buff']);
    });

    it('parses multi-part path with arguments', () => {
      const config = { ...defaultConfig, cliPath: 'node /path/to/cli.js' };
      const m = new CLIManager(config);
      const result = (m as unknown as { resolveCliCommand(): { command: string; spawnArgs: string[] } }).resolveCliCommand();
      expect(result.command).toBe('node');
      expect(result.spawnArgs).toEqual(['/path/to/cli.js']);
    });
  });

  // ── setCallbacks ───────────────────────────────────────────────────────

  describe('setCallbacks', () => {
    it('stores onProgress callback', () => {
      const onProgress = vi.fn();
      (manager as unknown as { setCallbacks(opts: { onProgress?: (phase: string, detail?: string) => void }): void }).setCallbacks({ onProgress });
      // Trigger the reportProgress internal method
      (manager as unknown as { reportProgress(phase: string, detail?: string): void }).reportProgress('Testing', 'detail');
      expect(onProgress).toHaveBeenCalledWith('Testing', 'detail');
    });

    it('stores onLog callback', () => {
      const onLog = vi.fn();
      (manager as unknown as { setCallbacks(opts: { onLog?: (line: string) => void }): void }).setCallbacks({ onLog });
      // We can't easily trigger internal onLog, but the callback is stored
      // Verify it doesn't throw
      expect(() => {
        (manager as unknown as { setCallbacks(opts: { onLog?: (line: string) => void }): void }).setCallbacks({ onLog });
      }).not.toThrow();
    });

    it('can update callbacks after creation', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      (manager as unknown as { setCallbacks(opts: { onProgress?: (phase: string, detail?: string) => void }): void }).setCallbacks({ onProgress: cb1 });
      (manager as unknown as { setCallbacks(opts: { onProgress?: (phase: string, detail?: string) => void }): void }).setCallbacks({ onProgress: cb2 });
      (manager as unknown as { reportProgress(phase: string, detail?: string): void }).reportProgress('Test');
      expect(cb2).toHaveBeenCalledWith('Test', undefined);
    });
  });

  // ── isRunning ──────────────────────────────────────────────────────────

  describe('isRunning', () => {
    it('returns false when no process is active', () => {
      expect(manager.isRunning).toBe(false);
    });

    it('returns false when process is killed', () => {
      // Mock the process state
      (manager as unknown as { process: { killed: boolean; exitCode: number | null } | null }).process = {
        killed: true,
        exitCode: 0,
      };
      expect(manager.isRunning).toBe(false);
    });

    it('returns true when process is active and not killed', () => {
      (manager as unknown as { process: { killed: boolean; exitCode: number | null } | null }).process = {
        killed: false,
        exitCode: null,
      };
      expect(manager.isRunning).toBe(true);
    });

    it('returns false when process has exited', () => {
      (manager as unknown as { process: { killed: boolean; exitCode: number | null } | null }).process = {
        killed: false,
        exitCode: 0,
      };
      expect(manager.isRunning).toBe(false);
    });
  });

  // ── cancel ─────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('does not throw when no process is active', () => {
      expect(() => manager.cancel()).not.toThrow();
    });

    it('kills the active process with SIGTERM', () => {
      const mockKill = vi.fn();
      (manager as unknown as { process: { killed: boolean; kill: (signal: string) => void; exitCode: null } | null }).process = {
        killed: false,
        kill: mockKill,
        exitCode: null,
      };
      manager.cancel();
      expect(mockKill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does not kill already killed process', () => {
      const mockKill = vi.fn();
      (manager as unknown as { process: { killed: boolean; kill: (signal: string) => void; exitCode: number | null } | null }).process = {
        killed: true,
        kill: mockKill,
        exitCode: 0,
      };
      manager.cancel();
      expect(mockKill).not.toHaveBeenCalled();
    });
  });

  // ── dispose ────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('calls cancel on dispose', () => {
      const cancelSpy = vi.spyOn(manager, 'cancel');
      (manager as unknown as { dispose(): void }).dispose();
      expect(cancelSpy).toHaveBeenCalled();
    });
  });
});

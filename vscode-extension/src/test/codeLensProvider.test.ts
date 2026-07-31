/**
 * Unit tests for CodeLensProvider.
 *
 * Focuses on the CLI manager lifecycle — specifically that updateCliManager()
 * swaps the manager used by lens actions so config changes (auto routing,
 * provider/model) take effect immediately without a reload.
 *
 * The arg-building behavior itself is covered in cliManager.integration.test.ts
 * (executeGoal → buildArgs appends --auto-route when useAutoRouting is on).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Uri, Range, Position } from 'vscode';

// Mock vscode module before importing
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

vi.mock('../diffViewer.js', () => ({
  DiffViewer: vi.fn().mockImplementation(() => ({
    showChanges: vi.fn().mockResolvedValue(undefined),
    applyChanges: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../cliManager.js', () => ({
  CLIManager: vi.fn().mockImplementation(() => ({
    executeGoal: vi.fn().mockResolvedValue({
      success: true,
      stdout: 'lens output',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    }),
    quickFix: vi.fn(),
    reviewFile: vi.fn(),
    explainCode: vi.fn(),
    generateTests: vi.fn(),
    runWorkflow: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import { CodeLensProvider } from '../codeLensProvider.js';
import { DiagnosticFixProvider } from '../diagnosticFixer.js';
import { CLIManager } from '../cliManager.js';
import { DiffViewer } from '../diffViewer.js';
import type { ExtensionConfig } from '../types.js';

describe('CodeLensProvider', () => {
  const defaultConfig: ExtensionConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
    useAutoRouting: false,
  };

  let provider: CodeLensProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodeLensProvider(new CLIManager(defaultConfig));
  });

  /** Invoke the private lens-action path (uses this.cliManager.executeGoal). */
  async function runLensAction(p: CodeLensProvider, prompt: string): Promise<void> {
    await (p as unknown as {
      executeLensAction(title: string, prompt: string, displayLanguage: string): Promise<void>;
    }).executeLensAction('Test', prompt, 'ts');
  }

  // ── updateCliManager ────────────────────────────────────────────────────

  describe('updateCliManager', () => {
    it('swaps the CLI manager used by lens actions', async () => {
      const oldManager = new CLIManager(defaultConfig);
      const newManager = new CLIManager({ ...defaultConfig, useAutoRouting: true });
      const coder = new CodeLensProvider(oldManager);

      coder.updateCliManager(newManager);

      await runLensAction(coder, 'run tests');

      expect(oldManager.executeGoal).not.toHaveBeenCalled();
      expect(newManager.executeGoal).toHaveBeenCalledWith('run tests');
    });

    it('uses the initial manager before any update', async () => {
      const initial = new CLIManager(defaultConfig);
      const coder = new CodeLensProvider(initial);

      await runLensAction(coder, 'explain');

      expect(initial.executeGoal).toHaveBeenCalledWith('explain');
    });

    it('can be called multiple times (last manager wins)', async () => {
      const first = new CLIManager(defaultConfig);
      const second = new CLIManager({ ...defaultConfig, useAutoRouting: true });
      const third = new CLIManager(defaultConfig);
      const coder = new CodeLensProvider(first);

      coder.updateCliManager(second);
      coder.updateCliManager(third);

      await runLensAction(coder, 'review');

      expect(first.executeGoal).not.toHaveBeenCalled();
      expect(second.executeGoal).not.toHaveBeenCalled();
      expect(third.executeGoal).toHaveBeenCalledWith('review');
    });
  });

  // ── provideCodeLenses ───────────────────────────────────────────────────

  describe('provideCodeLenses', () => {
    it('returns empty array for unsupported language', () => {
      const doc = {
        languageId: 'unknownlang',
        getText: () => '',
        uri: undefined,
      } as any;

      const lenses = provider.provideCodeLenses(doc, undefined as any);
      expect(lenses).toEqual([]);
    });
  });
});

describe('DiagnosticFixProvider', () => {
  const defaultConfig: ExtensionConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
    useAutoRouting: false,
  };

  function makeFixer(cliManager: CLIManager): DiagnosticFixProvider {
    return new DiagnosticFixProvider(cliManager, new DiffViewer());
  }

  /** Force a manager down the error path so the fix flow stays simple. */
  function makeManagerFail(manager: CLIManager): void {
    (manager.executeGoal as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      stderr: 'simulated failure',
    });
  }

  it('swaps the CLI manager used by fix actions after updateCliManager', async () => {
    const oldManager = new CLIManager(defaultConfig);
    const newManager = new CLIManager(defaultConfig);
    makeManagerFail(newManager);
    const fixer = makeFixer(oldManager);

    fixer.updateCliManager(newManager);

    await fixer.handleFix(
      Uri.file('/tmp/example.ts'),
      0,
      'Test error',
      'const x = 1;',
      'ts',
      new Range(new Position(0, 0), new Position(0, 1)),
    );

    expect(oldManager.executeGoal).not.toHaveBeenCalled();
    expect(newManager.executeGoal).toHaveBeenCalled();
  });

  it('uses the initial manager before any update', async () => {
    const initial = new CLIManager(defaultConfig);
    makeManagerFail(initial);
    const fixer = makeFixer(initial);

    await fixer.handleFix(
      Uri.file('/tmp/example.ts'),
      0,
      'Test error',
      'const x = 1;',
      'ts',
      new Range(new Position(0, 0), new Position(0, 1)),
    );

    expect(initial.executeGoal).toHaveBeenCalled();
  });
});

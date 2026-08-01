/**
 * Unit tests for CommandRegistrar.
 *
 * Tests the pure-logic methods that can be isolated from the VS Code API:
 * - parseCLIOutput() — parses CLI stdout into structured AgentResult
 * - generateSummary() — generates human-readable change summaries
 * - updateConfig() — runtime config updates
 * - dispose() — cleanup
 *
 * The command registration (registerAll) and task execution methods
 * require VS Code API integration and are tested separately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode module before importing
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

// We need to mock cliManager and other deps
vi.mock('../cliManager.js', () => ({
  CLIManager: vi.fn().mockImplementation(() => ({
    setCallbacks: vi.fn(),
    executeGoal: vi.fn(),
    quickFix: vi.fn(),
    reviewFile: vi.fn(),
    explainCode: vi.fn(),
    generateTests: vi.fn(),
    runWorkflow: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    listProviderModels: vi.fn().mockResolvedValue([]),
    switchModel: vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
    getActiveModel: vi.fn().mockResolvedValue(null),
    checkModelHealth: vi.fn().mockResolvedValue({ success: true, stdout: 'health ok', stderr: '', exitCode: 0, durationMs: 0 }),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../agentPanel.js', () => ({
  AgentPanel: vi.fn().mockImplementation(() => ({
    createOrShow: vi.fn(),
    updateProgress: vi.fn(),
    updateStatus: vi.fn(),
    showResult: vi.fn(),
    showError: vi.fn(),
    showDiffs: vi.fn(),
    clear: vi.fn(),
    setCallbacks: vi.fn(),
  })),
}));

vi.mock('../diffViewer.js', () => ({
  DiffViewer: vi.fn().mockImplementation(() => ({
    showChanges: vi.fn(),
    applyChanges: vi.fn().mockResolvedValue(0),
    rejectChanges: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import { CommandRegistrar } from '../commands.js';
import { parseCLIOutput, generateSummary } from '../outputParser.js';
import type { ExtensionConfig, FileChange } from '../types.js';
import * as vscode from 'vscode';

// Re-import with actual types after mock
import { CLIManager } from '../cliManager.js';
import { AgentPanel } from '../agentPanel.js';
import { DiffViewer } from '../diffViewer.js';

describe('CommandRegistrar', () => {
  const defaultConfig: ExtensionConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
    useAutoRouting: false,
  };

  // Minimal context mock
  const contextMock = {
    subscriptions: [] as { dispose(): void }[],
  };

  let registrar: CommandRegistrar;
  let mockCliManager: CLIManager;
  let mockAgentPanel: AgentPanel;
  let mockDiffViewer: DiffViewer;

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode as any).__resetAllMocks();
    mockCliManager = new CLIManager(defaultConfig);
    mockAgentPanel = new AgentPanel();
    mockDiffViewer = new DiffViewer(contextMock as any);
    registrar = new CommandRegistrar(
      contextMock as any,
      mockCliManager,
      mockAgentPanel,
      mockDiffViewer,
      defaultConfig,
    );
  });

  // ── Constructor ───────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates an instance with required dependencies', () => {
      expect(registrar).toBeInstanceOf(CommandRegistrar);
    });
  });

  // ── updateConfig ──────────────────────────────────────────────────────

  describe('updateConfig', () => {
    it('updates the internal config', () => {
      const newConfig: ExtensionConfig = {
        ...defaultConfig,
        cliPath: '/custom/path/buff',
        autoApplyChanges: true,
      };

      // updateConfig is public
      registrar.updateConfig(newConfig);

      // Verify by checking internal state via parseCLIOutput behavior
      // (config doesn't affect parseCLIOutput directly, but updateConfig shouldn't throw)
      expect(() => registrar.updateConfig(newConfig)).not.toThrow();
    });

    it('can update config multiple times', () => {
      registrar.updateConfig({ ...defaultConfig, autoApplyChanges: true });
      registrar.updateConfig({ ...defaultConfig, cliPath: '/new/path' });
      registrar.updateConfig(defaultConfig);
      expect(() => registrar.updateConfig(defaultConfig)).not.toThrow();
    });
  });

  // ── parseCLIOutput (now from outputParser.ts) ──────────────────────────

  describe('parseCLIOutput', () => {
    it('returns success with empty changes for empty output', () => {
      const result = parseCLIOutput('');

      expect(result.success).toBe(true);
      expect(result.changes).toEqual([]);
      expect(result.output).toBe('');
    });

    it('detects created files from emoji markers', () => {
      const output = '📄 src/new-file.ts (created)\nTask completed.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/new-file.ts');
      expect(result.changes[0].type).toBe('created');
      expect(result.changes[0].applied).toBe(false);
    });

    it('detects modified files from emoji markers', () => {
      const output = '✏️ src/app.ts (modified)\nDone.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/app.ts');
      expect(result.changes[0].type).toBe('modified');
    });

    it('detects deleted files from emoji markers', () => {
      const output = '🗑️ src/old-file.ts (deleted)\nRemoved.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/old-file.ts');
      expect(result.changes[0].type).toBe('deleted');
    });

    it('detects created files from text markers', () => {
      const output = 'Created: src/new-component.tsx\nUpdated some files.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/new-component.tsx');
      expect(result.changes[0].type).toBe('created');
    });

    it('detects modified files from text markers', () => {
      const output = 'Modified: src/utils/helper.ts\nAll done.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/utils/helper.ts');
      expect(result.changes[0].type).toBe('modified');
    });

    it('detects diff headers', () => {
      const output = '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,5 +1,6 @@';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/index.ts');
    });

    it('avoids duplicate file entries', () => {
      const output = '📄 src/app.ts (created)\nModified: src/app.ts\n✏️ src/app.ts (modified)';
      const result = parseCLIOutput(output);

      // Should have exactly 1 entry for app.ts (first match wins)
      expect(result.changes).toHaveLength(1);
    });

    it('detects multiple files of different types', () => {
      const output = [
        '📄 src/new-file.ts (created)',
        '✏️ src/existing.ts (modified)',
        '🗑️ src/old.ts (deleted)',
        'Updated: src/another.ts',
      ].join('\n');

      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(4);
      const types = result.changes.map((c: FileChange) => c.type);
      expect(types).toContain('created');
      expect(types).toContain('modified');
      expect(types).toContain('deleted');
    });

    it('handles file paths with spaces', () => {
      const output = '📄 src/my components/button.tsx (created)';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/my components/button.tsx');
    });
  });

  // ── generateSummary (now from outputParser.ts) ─────────────────────────

  describe('generateSummary', () => {
    it('returns "Changes:" with counts when there are changes', () => {
      const changes: FileChange[] = [
        { path: 'a.ts', type: 'created', applied: false },
        { path: 'b.ts', type: 'modified', applied: false },
        { path: 'c.ts', type: 'modified', applied: false },
        { path: 'd.ts', type: 'deleted', applied: false },
      ];

      const summary = generateSummary(changes, '');

      expect(summary).toContain('1 created');
      expect(summary).toContain('2 modified');
      expect(summary).toContain('1 deleted');
      expect(summary).toContain('Changes:');
    });

    it('returns first meaningful line when no changes', () => {
      const output = 'ℹ Info line\n✔ Success\nThis is a meaningful result line with actual content.\n';
      const summary = generateSummary([], output);

      expect(summary).toBe('This is a meaningful result line with actual content.');
    });

    it('returns "Task completed." when no changes and no meaningful output', () => {
      const summary = generateSummary([], '');

      expect(summary).toBe('Task completed.');
    });

    it('filters out short lines', () => {
      const output = 'ok\n[x]\nA meaningful sentence describing what was done.\n';
      const summary = generateSummary([], output);

      expect(summary).toBe('A meaningful sentence describing what was done.');
    });
  });

  // ── parseCLIOutput edge cases (from outputParser.ts) ───────────────────

  // ── switchModel command ────────────────────────────────────────────────

  describe('switchModel command', () => {
    const providers = [
      { type: 'groq', label: 'Groq', icon: '🟢', configured: true, available: true, defaultModel: 'llama-3.3-70b', isActive: false, isPlugin: false },
      { type: 'gemini', label: 'Google Gemini', icon: '🔷', configured: true, available: false, defaultModel: 'gemini-2.0-flash', isActive: false, isPlugin: false },
    ];

    it('switches to Auto routing when selected', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (vscode as any).__setQuickPickResult({ label: '$(sparkle) Auto routing', value: 'auto' });

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.switchModel).toHaveBeenCalledWith('auto');
    });

    it('switches to a specific provider when auto-routing is off', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq');
    });

    it('asks for confirmation when auto-routing is on and user picks a provider', async () => {
      const registrarWithAuto = new CommandRegistrar(
        contextMock as any,
        mockCliManager,
        mockAgentPanel,
        mockDiffViewer,
        { ...defaultConfig, useAutoRouting: true },
      );
      registrarWithAuto.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setShowWarningMessageResult('Cancel');

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      // Cancelling the warning should abort the switch
      expect(mockCliManager.switchModel).not.toHaveBeenCalled();
    });

    it('switches after confirming despite auto-routing being on', async () => {
      const registrarWithAuto = new CommandRegistrar(
        contextMock as any,
        mockCliManager,
        mockAgentPanel,
        mockDiffViewer,
        { ...defaultConfig, useAutoRouting: true },
      );
      registrarWithAuto.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setShowWarningMessageResult('Switch anyway');

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq');
    });

    it('fires onModelChanged after a successful switch', async () => {
      const onModelChanged = vi.fn();
      registrar.registerAll();
      registrar.setOnModelChanged(onModelChanged);
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (vscode as any).__setQuickPickResult({ label: '$(sparkle) Auto routing', value: 'auto' });

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(onModelChanged).toHaveBeenCalled();
    });

    it('shows an error when the switch fails', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (mockCliManager.switchModel as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        stdout: '',
        stderr: 'Switch failed: provider not available',
        exitCode: 1,
        durationMs: 10,
      });

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq');
      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('does not throw when switchModel rejects (missing CLI)', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (mockCliManager.switchModel as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('CLI not found'));

      await expect((vscode.commands as any).executeCommand('agent-nuvira.switchModel')).resolves.toBeUndefined();
      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('handles a missing CLI gracefully (no crash)', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('CLI not found'));
      (vscode as any).__setQuickPickResult({ label: '$(sparkle) Auto routing', value: 'auto' });

      // Should still show the picker with only Auto routing and allow switching
      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.switchModel).toHaveBeenCalledWith('auto');
    });

    // ── Per-provider model drill-down (buff models) ───────────────────────

    it('drills into the provider models and switches to a specific model', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (mockCliManager.listProviderModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { provider: 'Groq', providerType: 'groq', name: 'Llama 3.3 70B', id: 'llama-3.3-70b-versatile' },
        { provider: 'Groq', providerType: 'groq', name: 'Mixtral', id: 'mixtral-8x7b-32768', owner: 'Mistral AI' },
      ]);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setQuickPickSelection({ label: '🧠 Llama 3.3 70B', value: 'groq', model: 'llama-3.3-70b-versatile' });

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.listProviderModels).toHaveBeenCalledWith('groq');
      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile');
    });

    it('keeps the provider default when the default-model option is chosen', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (mockCliManager.listProviderModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { provider: 'Groq', providerType: 'groq', name: 'Llama 3.3 70B', id: 'llama-3.3-70b-versatile' },
      ]);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setQuickPickSelection({ label: '$(check) Use default model', value: 'groq' });

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq');
    });

    it('keeps the provider default when the model picker is dismissed', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (mockCliManager.listProviderModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { provider: 'Groq', providerType: 'groq', name: 'Llama 3.3 70B', id: 'llama-3.3-70b-versatile' },
      ]);
      // Only the provider picker gets a result — the model picker is dismissed (undefined)
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setQuickPickSelection(undefined);

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq');
    });

    it('configures the model picker as a searchable quick pick', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (mockCliManager.listProviderModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { provider: 'Groq', providerType: 'groq', name: 'Llama 3.3 70B', id: 'llama-3.3-70b-versatile' },
        { provider: 'Groq', providerType: 'groq', name: 'Mixtral', id: 'mixtral-8x7b-32768', owner: 'Mistral AI' },
      ]);
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setQuickPickSelection({ label: '🧠 Llama 3.3 70B', value: 'groq', model: 'llama-3.3-70b-versatile' });

      const createQuickPickSpy = vi.spyOn(vscode.window as any, 'createQuickPick');

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      // The picker config is applied before show() (which resolves the queued
      // selection), and the instance survives resolution — assert on it now
      expect(createQuickPickSpy).toHaveBeenCalledTimes(1);
      const picker = createQuickPickSpy.mock.results[0].value as {
        placeholder: string;
        matchOnDescription: boolean;
        matchOnDetail: boolean;
        items: unknown[];
      };
      expect(picker.placeholder).toBe('Search Groq models (Esc keeps the default):');
      expect(picker.matchOnDescription).toBe(true);
      expect(picker.matchOnDetail).toBe(true);
      // Default-model option + one entry per fetched model
      expect(picker.items).toHaveLength(3);
      expect(picker.items[0]).toMatchObject({ label: '$(check) Use default model' });
      expect(picker.items[1]).toMatchObject({ label: '🧠 Llama 3.3 70B', model: 'llama-3.3-70b-versatile' });
      createQuickPickSpy.mockRestore();
    });

    it('falls back to provider-only switching when models fail to load', async () => {
      registrar.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (mockCliManager.listProviderModels as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('CLI not found'));
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });

      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');

      // No second picker shown; the switch still happens with the provider default
      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq');
    });

    it('asks for confirmation after drilling into models when auto-routing is on', async () => {
      const registrarWithAuto = new CommandRegistrar(
        contextMock as any,
        mockCliManager,
        mockAgentPanel,
        mockDiffViewer,
        { ...defaultConfig, useAutoRouting: true },
      );
      registrarWithAuto.registerAll();
      (mockCliManager.listModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(providers);
      (mockCliManager.listProviderModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { provider: 'Groq', providerType: 'groq', name: 'Llama 3.3 70B', id: 'llama-3.3-70b-versatile' },
      ]);

      // Cancel the warning → the specific-model switch must not happen
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setQuickPickSelection({ label: '🧠 Llama 3.3 70B', value: 'groq', model: 'llama-3.3-70b-versatile' });
      (vscode as any).__setShowWarningMessageResult('Cancel');
      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');
      expect(mockCliManager.switchModel).not.toHaveBeenCalled();

      // Confirm → the specific-model switch happens
      (vscode as any).__setShowWarningMessageResult('Switch anyway');
      (vscode as any).__setQuickPickResult({ label: '🟢 Groq', value: 'groq' });
      (vscode as any).__setQuickPickSelection({ label: '🧠 Llama 3.3 70B', value: 'groq', model: 'llama-3.3-70b-versatile' });
      await (vscode.commands as any).executeCommand('agent-nuvira.switchModel');
      expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile');
    });
  });

  // ── registerAll ────────────────────────────────────────────────────────

  describe('registerAll', () => {
    it('returns an array of disposables', () => {
      const disposables = registrar.registerAll();
      expect(Array.isArray(disposables)).toBe(true);
      expect(disposables.length).toBeGreaterThan(0);
    });

    it('registers all expected commands', () => {
      const disposables = registrar.registerAll();
      // All disposables should be registered (11 commands)
      expect(disposables).toHaveLength(11);
      // Verify registerCommand was called 11 times
      expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(11);
    });
  });

  // ── dispose ────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('disposes all registered disposables without throwing', () => {
      registrar.registerAll();
      expect(() => registrar.dispose()).not.toThrow();
    });

    it('can be called multiple times without error', () => {
      expect(() => {
        registrar.dispose();
        registrar.dispose();
      }).not.toThrow();
    });

    it('does not throw when called before registerAll', () => {
      expect(() => registrar.dispose()).not.toThrow();
    });
  });

  describe('parseCLIOutput edge cases', () => {
    it('handles newline variant (\\r\\n)', () => {
      const output = '📄 file1.ts (created)\r\n✏️ file2.ts (modified)';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(2);
    });

    it('extracts path from +++ style diff headers', () => {
      const output = '+++ b/src/components/Button.tsx';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('src/components/Button.tsx');
      expect(result.changes[0].type).toBe('modified');
    });

    it('handles New: text marker (case insensitive)', () => {
      const output = 'New: generated-file.ts\nCompleted.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('generated-file.ts');
    });

    it('handles Removed: text marker (case insensitive)', () => {
      const output = 'Removed: deprecated-module.ts\nDone.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe('deprecated-module.ts');
      expect(result.changes[0].type).toBe('deleted');
    });

    it('detects Updated: text marker', () => {
      const output = 'Updated: config.json\nDone.';
      const result = parseCLIOutput(output);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('modified');
    });
  });
});

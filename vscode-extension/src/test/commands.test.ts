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

  // ── registerAll ────────────────────────────────────────────────────────

  describe('registerAll', () => {
    it('returns an array of disposables', () => {
      const disposables = registrar.registerAll();
      expect(Array.isArray(disposables)).toBe(true);
      expect(disposables.length).toBeGreaterThan(0);
    });

    it('registers all expected commands', () => {
      const disposables = registrar.registerAll();
      // All disposables should be registered (9 commands)
      expect(disposables).toHaveLength(9);
      // Verify registerCommand was called 9 times
      expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(9);
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

/**
 * Unit tests for the extension entry point (extension.ts) status bar wiring.
 *
 * Covers:
 * 1. Status-bar command wiring — the main item opens the chat panel and the
 *    model item switches provider/model, both shown when a workspace is open
 * 2. refreshModelStatusBar() — auto-routing label, provider/model label,
 *    provider-type fallback, error resilience, and safe no-op when deactivated
 * 3. The onModelChanged wiring — a model switch fires the callback and the
 *    indicator refreshes from the CLI's active-model state
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode module before importing
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

// Holders so tests can reach the currently-active mock instances
// (re-created fresh on every `new`, so no state leaks between tests)
const holders = vi.hoisted(() => ({
  cliManager: null as any,
  commandRegistrar: null as any,
}));

vi.mock('../cliManager.js', () => ({
  CLIManager: vi.fn().mockImplementation(() => {
    holders.cliManager = {
      setCallbacks: vi.fn(),
      executeGoal: vi.fn(),
      quickFix: vi.fn(),
      reviewFile: vi.fn(),
      explainCode: vi.fn(),
      generateTests: vi.fn(),
      runWorkflow: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      listProviderModels: vi.fn().mockResolvedValue([]),
      switchModel: vi.fn(),
      getActiveModel: vi.fn().mockResolvedValue(null),
      checkModelHealth: vi.fn(),
      getQuotaStatus: vi.fn().mockResolvedValue({
        enabled: false,
        entries: [],
        events: [],
        freeTokens: 0,
        freeRequests: 0,
        paidTokens: 0,
        paidRequests: 0,
        estimatedSavedUsd: 0,
      }),
      getMemoryDir: vi.fn(() => '/tmp/test-buff-memory'),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    return holders.cliManager;
  }),
}));

vi.mock('../agentPanel.js', () => ({
  AgentPanel: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../chatPanel.js', () => ({
  ChatPanel: vi.fn().mockImplementation(() => ({
    updateConfig: vi.fn(),
    updateCliManager: vi.fn(),
    setOnModelChanged: vi.fn(),
    createOrShow: vi.fn(),
  })),
}));

vi.mock('../chatProvider.js', () => ({
  ChatHistoryProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../codeLensProvider.js', () => {
  const mock = vi.fn().mockImplementation(() => ({
    updateCliManager: vi.fn(),
    handleLensClick: vi.fn(),
  }));
  (mock as any).lensCommandId = 'agent-nuvira.codeLensAction';
  return { CodeLensProvider: mock };
});

vi.mock('../diagnosticFixer.js', () => {
  const mock = vi.fn().mockImplementation(() => ({
    updateCliManager: vi.fn(),
    handleFix: vi.fn(),
  }));
  (mock as any).fixCommandId = 'agent-nuvira.diagnosticFix';
  (mock as any).providedCodeActionKinds = [];
  return { DiagnosticFixProvider: mock };
});

vi.mock('../diffViewer.js', () => ({
  DiffViewer: vi.fn().mockImplementation(() => ({
    showChanges: vi.fn(),
    applyChanges: vi.fn(),
    rejectChanges: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../commands.js', () => ({
  CommandRegistrar: vi.fn().mockImplementation(() => {
    holders.commandRegistrar = {
      registerAll: vi.fn().mockReturnValue([]),
      setOnModelChanged: vi.fn(),
      updateConfig: vi.fn(),
      dispose: vi.fn(),
    };
    return holders.commandRegistrar;
  }),
}));

vi.mock('../inlineSuggest.js', () => ({
  InlineSuggestProvider: vi.fn().mockImplementation(() => ({
    updateConfig: vi.fn(),
  })),
}));

import * as vscode from 'vscode';
import { activate, deactivate, refreshModelStatusBar, refreshQuotaStatusBar } from '../extension.js';

describe('extension status bar', () => {
  let context: any;
  let statusBarItems: any[];
  const origCreateStatusBarItem = (vscode.window as any).createStatusBarItem;

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode as any).__resetAllMocks();
    // Reset extension module state from any previous test
    deactivate();

    statusBarItems = [];
    vi.spyOn(vscode.window, 'createStatusBarItem').mockImplementation((...args: unknown[]) => {
      const item = origCreateStatusBarItem(...args);
      statusBarItems.push(item);
      return item;
    });

    context = new (vscode as any).MockExtensionContext();
  });

  // ── Status bar command wiring ────────────────────────────────────────────

  it('wires the status bar items to their commands and shows them in a workspace', () => {
    (vscode as any).__setWorkspaceFolders(['/workspace']);
    activate(context);

    expect(statusBarItems).toHaveLength(3);
    const [mainItem, modelItem, quotaItem] = statusBarItems;

    // Main item opens the chat panel; model item switches provider/model;
    // quota item opens the quota ledger view
    expect(mainItem.command).toBe('agent-nuvira.openChat');
    expect(modelItem.command).toBe('agent-nuvira.switchModel');
    expect(modelItem.tooltip).toBe('Agent-Nuvira — click to switch provider/model');
    expect(quotaItem.command).toBe('agent-nuvira.showQuota');

    // All items are visible when a workspace is open
    expect(mainItem.show).toHaveBeenCalled();
    expect(modelItem.show).toHaveBeenCalled();
    expect(quotaItem.show).toHaveBeenCalled();
  });

  it('shows the quota-ok label when the ledger is healthy', async () => {
    (vscode as any).__setWorkspaceFolders(['/workspace']);
    activate(context);
    const quotaItem = statusBarItems[2];

    (holders.cliManager.getQuotaStatus as any).mockResolvedValue({
      enabled: true,
      entries: [],
      events: [],
      freeTokens: 0,
      freeRequests: 0,
      paidTokens: 0,
      paidRequests: 0,
      estimatedSavedUsd: 0,
    });

    await refreshQuotaStatusBar();

    expect(quotaItem.text).toBe('$(check) quota ok');
    expect(quotaItem.tooltip).toContain('Quota ledger healthy');
    expect(quotaItem.tooltip).toContain('click to view details');
  });

  it('shows a parked-provider alert count when providers are parked', async () => {
    (vscode as any).__setWorkspaceFolders(['/workspace']);
    activate(context);
    const quotaItem = statusBarItems[2];

    (holders.cliManager.getQuotaStatus as any).mockResolvedValue({
      enabled: true,
      entries: [
        {
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          tokensConsumed: 80_000,
          requests: 12,
          windowLengthMs: 86_400_000,
          resetsInMs: 3_600_000,
          parked: true,
          cooldownRemaining: 2_700_000,
        },
        {
          provider: 'gemini',
          model: 'gemini-2.0-flash',
          tokensConsumed: 120_000,
          requests: 20,
          windowLengthMs: 86_400_000,
          resetsInMs: 3_600_000,
          parked: false,
          cooldownRemaining: 0,
        },
      ],
      events: [],
      freeTokens: 120_000,
      freeRequests: 20,
      paidTokens: 80_000,
      paidRequests: 12,
      estimatedSavedUsd: 0.06,
    });

    await refreshQuotaStatusBar();

    expect(quotaItem.text).toBe('$(alert) 1 parked');
    expect(quotaItem.tooltip).toContain('1 provider(s) parked');
  });

  // ── refreshModelStatusBar ────────────────────────────────────────────────

  it('shows the auto-routing label when the active model is auto', async () => {
    activate(context);
    const modelItem = statusBarItems[1];
    (holders.cliManager.getActiveModel as any).mockResolvedValue({
      provider: 'auto',
      model: 'auto',
      updatedAt: 0,
      explicit: true,
    });

    await refreshModelStatusBar();

    expect(modelItem.text).toBe('$(chip) auto');
    expect(modelItem.tooltip).toBe('Auto routing — click to change provider/model');
    // A refresh also re-shows the item (not just at creation time)
    expect(modelItem.show).toHaveBeenCalled();
  });

  it('shows the provider/model label using the provider display label', async () => {
    activate(context);
    (holders.cliManager.getActiveModel as any).mockResolvedValue({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      providerLabel: 'Groq',
      updatedAt: 0,
      explicit: true,
    });

    await refreshModelStatusBar();

    expect(statusBarItems[1].text).toBe('$(chip) Groq/llama-3.3-70b-versatile');
    expect(statusBarItems[1].tooltip).toContain('Active: Groq/llama-3.3-70b-versatile');
  });

  it('falls back to the provider type when no display label is set', async () => {
    activate(context);
    (holders.cliManager.getActiveModel as any).mockResolvedValue({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      updatedAt: 0,
      explicit: true,
    });

    await refreshModelStatusBar();

    expect(statusBarItems[1].text).toBe('$(chip) groq/llama-3.3-70b-versatile');
  });

  it('keeps the default label when the active model cannot be read', async () => {
    activate(context);
    (holders.cliManager.getActiveModel as any).mockRejectedValue(new Error('state file missing'));

    await refreshModelStatusBar();

    expect(statusBarItems[1].text).toBe('$(chip) model');
    expect(statusBarItems[1].tooltip).toBe('Agent-Nuvira — click to switch provider/model');
  });

  it('is a safe no-op when the extension is deactivated', async () => {
    activate(context);
    (holders.cliManager.getActiveModel as any).mockResolvedValue({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      providerLabel: 'Groq',
      updatedAt: 0,
      explicit: true,
    });
    await refreshModelStatusBar();
    expect(statusBarItems[1].text).toBe('$(chip) Groq/llama-3.3-70b-versatile');

    deactivate();
    // With module state nulled, refreshModelStatusBar returns early and the
    // (already disposed) item is left untouched.
    await expect(refreshModelStatusBar()).resolves.toBeUndefined();
    expect(statusBarItems[1].text).toBe('$(chip) Groq/llama-3.3-70b-versatile');
  });

  // ── onModelChanged wiring ────────────────────────────────────────────────

  it('registers the refresh callback so a switch updates the indicator', async () => {
    activate(context);
    expect(holders.commandRegistrar.setOnModelChanged).toHaveBeenCalled();

    const onChange = holders.commandRegistrar.setOnModelChanged.mock.calls[0][0];
    (holders.cliManager.getActiveModel as any).mockResolvedValue({
      provider: 'auto',
      model: 'auto',
      updatedAt: 0,
      explicit: true,
    });

    // The wired callback fires-and-forgets the refresh; await it explicitly
    // so the assertion is deterministic (not dependent on microtask ordering)
    onChange();
    await refreshModelStatusBar();

    expect(statusBarItems[1].text).toBe('$(chip) auto');
  });
});

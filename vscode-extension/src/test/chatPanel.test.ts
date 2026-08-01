/**
 * Unit tests for the Chat Panel model switcher.
 *
 * Covers the webview-driven provider/model dropdown in the sidebar header:
 * 1. refreshModelState() — posts the provider list + active model to the webview
 * 2. switchModel message — delegates to CLIManager.switchModel, notifies via
 *    onModelChanged, and re-posts the refreshed state
 * 3. Auto routing selection and error paths (failed/rejected switch)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode module before importing
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

vi.mock('../cliManager.js', () => {
  const CLIManager = vi.fn().mockImplementation(() => ({
    listModels: vi.fn().mockResolvedValue([]),
    listProviderModels: vi.fn().mockResolvedValue([]),
    switchModel: vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
    getActiveModel: vi.fn().mockResolvedValue(null),
    cancel: vi.fn(),
    dispose: vi.fn(),
  }));
  return { CLIManager };
});

vi.mock('../chatProvider.js', () => ({
  ChatHistoryProvider: vi.fn().mockImplementation(() => ({
    getActiveSessionId: vi.fn().mockReturnValue(null),
    getActiveSession: vi.fn().mockReturnValue(null),
    getSessions: vi.fn().mockReturnValue([]),
    createSession: vi.fn(),
    switchSession: vi.fn(),
    deleteSession: vi.fn(),
    clearAllSessions: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
  })),
}));

import * as vscode from 'vscode';
import { ChatPanel } from '../chatPanel.js';
import { CLIManager } from '../cliManager.js';
import { ChatHistoryProvider } from '../chatProvider.js';
import type { ExtensionConfig } from '../types.js';

describe('ChatPanel model switcher', () => {
  const defaultConfig: ExtensionConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
    useAutoRouting: false,
  };

  let panel: any;
  let chatPanel: ChatPanel;
  let mockCliManager: CLIManager;
  let onModelChanged: ReturnType<typeof vi.fn>;

  const providers = [
    { type: 'groq', label: 'Groq', icon: '🟢', configured: true, available: true, defaultModel: 'llama-3.3-70b', isActive: false, isPlugin: false },
    { type: 'gemini', label: 'Google Gemini', icon: '🔷', configured: true, available: true, defaultModel: 'gemini-2.0-flash', isActive: false, isPlugin: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode as any).__resetAllMocks();

    mockCliManager = new CLIManager(defaultConfig);
    onModelChanged = vi.fn();
    chatPanel = new ChatPanel(
      new (vscode as any).MockExtensionContext(),
      new ChatHistoryProvider(),
      defaultConfig,
      mockCliManager,
    );
    chatPanel.setOnModelChanged(onModelChanged);

    // Capture the webview panel and expose showInformationMessage as a spy
    panel = new (vscode as any).MockWebviewPanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panel);
    vi.spyOn(vscode.window, 'showInformationMessage');
    chatPanel.createOrShow(vscode.Uri.file('/test'));
  });

  /** Invoke the webview message handler registered by the panel. */
  async function postFromWebview(message: any): Promise<void> {
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0][0];
    await handler(message);
  }

  /** Last modelState message posted to the webview (state refresh wins). */
  function lastModelState(): any {
    const states = panel.webview.postMessage.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => m && m.type === 'modelState');
    return states[states.length - 1];
  }

  it('posts the provider list and active model on initial state', async () => {
    (mockCliManager.listModels as any).mockResolvedValue(providers);
    (mockCliManager.getActiveModel as any).mockResolvedValue({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      providerLabel: 'Groq',
      updatedAt: 0,
      explicit: true,
    });

    await postFromWebview({ type: 'requestInitialState' });

    const modelState = lastModelState();
    expect(modelState).toBeDefined();
    expect(modelState.providers).toEqual(providers);
    expect(modelState.active).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
  });

  /** Post a switch message and assert the switch path re-posts modelState. */
  async function postSwitch(value: string): Promise<void> {
    // Clear history so the assertion below proves the SWITCH refreshed state
    panel.webview.postMessage.mockClear();
    await postFromWebview({ type: 'switchModel', value });
    expect(lastModelState()).toBeDefined();
  }

  it('switches to a provider when the dropdown value changes', async () => {
    await postSwitch('groq');

    expect(mockCliManager.switchModel).toHaveBeenCalledWith('groq');
    expect(onModelChanged).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('groq'),
    );
  });

  it('enables Auto routing when the dropdown selects auto', async () => {
    await postSwitch('auto');

    expect(mockCliManager.switchModel).toHaveBeenCalledWith('auto');
    expect(onModelChanged).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Auto routing'),
    );
  });

  it('shows an error and still refreshes when the switch fails', async () => {
    (mockCliManager.switchModel as any).mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'provider not available',
      exitCode: 1,
      durationMs: 10,
    });

    await postSwitch('groq');

    expect(onModelChanged).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('provider not available'),
    );
  });

  it('handles a rejected switch gracefully (missing CLI)', async () => {
    (mockCliManager.switchModel as any).mockRejectedValue(new Error('CLI not found'));

    await postSwitch('groq');

    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});

/**
 * Agent-Nuvira VS Code Extension — Main Entry Point
 *
 * This extension brings Agent-Nuvira's multi-agent AI capabilities
 * directly into the VS Code editor, allowing users to:
 * - Execute multi-agent goals (plan, write, review, test)
 * - Quick fix files with AI
 * - Review and explain code
 * - Generate unit tests
 * - Run workflow templates
 * - Preview and apply proposed changes via diff viewer
 *
 * Architecture:
 * - CLI Backend: The existing agent-nuvira CLI is spawned as a child process
 * - Webview Panel: Real-time agent progress and results
 * - Command Palette: All agent operations accessible via commands
 * - Context Menus: Right-click on files/editors for quick actions
 * - Keybindings: Ctrl+Shift+A prefix for all agent commands
 * - Diff Viewer: VS Code's native diff editor for reviewing changes
 */

import * as vscode from 'vscode';
import { CLIManager } from './cliManager.js';
import { AgentPanel } from './agentPanel.js';
import { QuotaPanel } from './quotaPanel.js';
import { ChatPanel } from './chatPanel.js';
import { ChatHistoryProvider } from './chatProvider.js';
import { CodeLensProvider } from './codeLensProvider.js';
import { DiagnosticFixProvider } from './diagnosticFixer.js';
import { DiffViewer } from './diffViewer.js';
import { CommandRegistrar } from './commands.js';
import { InlineSuggestProvider } from './inlineSuggest.js';
import type { ExtensionConfig } from './types.js';

// ─── Module State ───────────────────────────────────────────────────────────

let cliManager: CLIManager | null = null;
let agentPanel: AgentPanel | null = null;
let quotaPanel: QuotaPanel | null = null;
let chatPanel: ChatPanel | null = null;
let chatHistory: ChatHistoryProvider | null = null;
let codeLensProvider: CodeLensProvider | null = null;
let diagnosticFixer: DiagnosticFixProvider | null = null;
let diffViewer: DiffViewer | null = null;
let commandRegistrar: CommandRegistrar | null = null;
let inlineSuggestProvider: InlineSuggestProvider | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let modelStatusBarItem: vscode.StatusBarItem | null = null;
let quotaStatusBarItem: vscode.StatusBarItem | null = null;

// ─── Activate ───────────────────────────────────────────────────────────────

/**
 * Called when the extension is activated (first command is run).
 */
export function activate(context: vscode.ExtensionContext): void {
  const config = loadConfig();

  // Initialize core components
  cliManager = new CLIManager(config);
  agentPanel = new AgentPanel();
  quotaPanel = new QuotaPanel(() => cliManager?.getQuotaStatus() ?? Promise.resolve({
    enabled: false,
    entries: [],
    events: [],
    freeTokens: 0,
    freeRequests: 0,
    paidTokens: 0,
    paidRequests: 0,
    estimatedSavedUsd: 0,
  }));
  chatHistory = new ChatHistoryProvider(context);
  chatPanel = new ChatPanel(context, chatHistory, config, cliManager);
  // Refresh the status bar indicator when the model is switched from the chat panel
  chatPanel.setOnModelChanged(() => {
    void refreshModelStatusBar();
  });
  diffViewer = new DiffViewer(context);
  diagnosticFixer = new DiagnosticFixProvider(cliManager, diffViewer);
  codeLensProvider = new CodeLensProvider(cliManager);
  commandRegistrar = new CommandRegistrar(context, cliManager, agentPanel, diffViewer, config);

  // Create status bar items
  statusBarItem = createStatusBarItem();
  context.subscriptions.push(statusBarItem);

  // Remove the old panel open and replace with chat panel open
  statusBarItem.command = 'agent-nuvira.openChat';

  // Model/provider indicator — click to switch provider/model
  modelStatusBarItem = createModelStatusBarItem();
  context.subscriptions.push(modelStatusBarItem);

  // Quota indicator — click to open the quota ledger view
  quotaStatusBarItem = createQuotaStatusBarItem();
  context.subscriptions.push(quotaStatusBarItem);

  // Refresh the model indicator when a switch happens
  commandRegistrar.setOnModelChanged(() => {
    void refreshModelStatusBar();
  });
  void refreshModelStatusBar();
  void refreshQuotaStatusBar();

  // Register all commands
  const commandDisposables = commandRegistrar.registerAll();
  for (const disposable of commandDisposables) {
    context.subscriptions.push(disposable);
  }

  // Register the chat panel command
  context.subscriptions.push(
    vscode.commands.registerCommand('agent-nuvira.openChat', () => {
      chatPanel?.createOrShow(context.extensionUri);
    }),
  );

  // Register the quota panel command
  context.subscriptions.push(
    vscode.commands.registerCommand('agent-nuvira.showQuota', () => {
      quotaPanel?.createOrShow(context.extensionUri);
    }),
  );

  // Register the diagnostic fix command
  context.subscriptions.push(
    vscode.commands.registerCommand(DiagnosticFixProvider.fixCommandId, (uri, line, error, code, lang, range) =>
      diagnosticFixer?.handleFix(uri, line, error, code, lang, range),
    ),
  );

  // Register the CodeLensProvider for code lenses
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { pattern: '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,vue,svelte,mjs,cjs}' },
      codeLensProvider!,
    ),
  );

  // Register code lens command handler (single menu-based action)
  context.subscriptions.push(
    vscode.commands.registerCommand(CodeLensProvider.lensCommandId, (uri, name, lang, line, bodyRange) =>
      codeLensProvider?.handleLensClick(uri, name, lang, line, bodyRange),
    ),
  );

  // Register the CodeActionProvider for diagnostics
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,vue,svelte,mjs,cjs}' },
      diagnosticFixer!,
      { providedCodeActionKinds: DiagnosticFixProvider.providedCodeActionKinds },
    ),
  );

  // Register inline completion provider (Phase 3.1.2 — Copilot-style suggestions)
  inlineSuggestProvider = new InlineSuggestProvider(config);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,vue,svelte,mjs,cjs}' },
      inlineSuggestProvider,
    ),
  );

  // Register configuration change handler
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agent-nuvira')) {
        const newConfig = loadConfig();
        cliManager?.dispose();
        cliManager = new CLIManager(newConfig);
        commandRegistrar?.updateConfig(newConfig);
        chatPanel?.updateConfig(newConfig);
        chatPanel?.updateCliManager(cliManager);
        inlineSuggestProvider?.updateConfig(newConfig);
        codeLensProvider?.updateCliManager(cliManager);
        diagnosticFixer?.updateCliManager(cliManager);
        updateStatusBar('$(refresh) Config Updated');
        void refreshModelStatusBar();
      }
    }),
  );

  // Update status bar on save to show readiness
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      updateStatusBar('$(check) Ready');
    }),
  );

  // Update status bar
  updateStatusBar('$(robot) Agent-Baba-D Ready');

  // Output activation info
  console.log('[agent-nuvira] Extension activated');
  console.log(`[agent-nuvira] CLI path: ${config.cliPath}`);
  console.log(`[agent-nuvira] Default provider: ${config.defaultProvider || '(from config)'}`);
  console.log(`[agent-nuvira] Auto-apply: ${config.autoApplyChanges}`);
  console.log('[agent-nuvira] Chat panel registered (Ctrl+Shift+A C)');
}

// ─── Deactivate ─────────────────────────────────────────────────────────────

/**
 * Called when the extension is deactivated.
 * Clean up all resources.
 */
export function deactivate(): void {
  console.log('[agent-nuvira] Extension deactivating...');

  // Clean up CLI manager
  if (cliManager) {
    cliManager.dispose();
    cliManager = null;
  }

  // Clean up quota panel
  quotaPanel = null;

  // Clean up diff viewer temp files
  if (diffViewer) {
    diffViewer.dispose();
    diffViewer = null;
  }

  // Clean up command registrations
  if (commandRegistrar) {
    commandRegistrar.dispose();
    commandRegistrar = null;
  }

  // Dispose chat panel
  chatPanel = null;
  chatHistory = null;

  // Dispose status bar items
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }
  if (modelStatusBarItem) {
    modelStatusBarItem.dispose();
    modelStatusBarItem = null;
  }
  if (quotaStatusBarItem) {
    quotaStatusBarItem.dispose();
    quotaStatusBarItem = null;
  }

  inlineSuggestProvider = null;
  codeLensProvider = null;
  diagnosticFixer = null;
  agentPanel = null;

  console.log('[agent-nuvira] Extension deactivated');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Load extension configuration from VS Code settings.
 */
function loadConfig(): ExtensionConfig {
  const vsConfig = vscode.workspace.getConfiguration('agent-nuvira');

  return {
    cliPath: vsConfig.get<string>('cliPath', 'buff'),
    defaultProvider: vsConfig.get<string>('defaultProvider', ''),
    defaultModel: vsConfig.get<string>('defaultModel', ''),
    autoApplyChanges: vsConfig.get<boolean>('autoApplyChanges', false),
    maxTokens: vsConfig.get<number>('maxTokens', 4096),
    showProgressPanel: vsConfig.get<boolean>('showProgressPanel', true),
    useAutoRouting: vsConfig.get<boolean>('useAutoRouting', false),
  };
}

/**
 * Create the status bar item.
 */
function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  item.text = '$(robot) Agent';
  item.tooltip = 'Agent-Nuvira — Multi-agent AI coding assistant';
  item.command = 'agent-nuvira.showPanel';
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');

  // Only show when there's an active workspace
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    item.show();
  }

  // Show/hide based on workspace changes
  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      item.show();
    } else {
      item.hide();
    }
  });

  return item;
}

/**
 * Create the model/provider status bar item.
 * Shown only when there's an active workspace, mirroring the main item.
 */
function createModelStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );

  item.command = 'agent-nuvira.switchModel';
  item.tooltip = 'Agent-Nuvira — click to switch provider/model';
  item.text = '$(chip) model';

  // Only show when there's an active workspace
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    item.show();
  }

  // Show/hide based on workspace changes
  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      item.show();
    } else {
      item.hide();
    }
  });

  return item;
}

/**
 * Create the quota status bar item.
 * Shows the parked-provider count (or a check when all healthy); click to
 * open the quota ledger view. Shown only when there's an active workspace.
 */
function createQuotaStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98,
  );

  item.command = 'agent-nuvira.showQuota';
  item.tooltip = 'Agent-Nuvira — click to view quota ledger & failover timeline';
  item.text = '$(dashboard) quota';

  // Only show when there's an active workspace
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    item.show();
  }

  // Show/hide based on workspace changes
  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      item.show();
    } else {
      item.hide();
    }
  });

  return item;
}

/**
 * Update the status bar text and show it.
 */
function updateStatusBar(text: string): void {
  if (statusBarItem) {
    statusBarItem.text = text;
    statusBarItem.show();
  }
}

/**
 * Refresh the model/provider status bar indicator from the CLI's
 * active-model state (e.g. after a `buff model switch`).
 *
 * Exported for unit testing.
 */
export async function refreshModelStatusBar(): Promise<void> {
  if (!modelStatusBarItem || !cliManager) return;

  let label = 'model';
  let tooltip = 'Agent-Nuvira — click to switch provider/model';

  try {
    const active = await cliManager.getActiveModel();
    if (active) {
      if (active.provider === 'auto' || active.model === 'auto') {
        label = 'auto';
        tooltip = 'Auto routing — click to change provider/model';
      } else {
        const provider = active.providerLabel || active.provider;
        label = `${provider}/${active.model}`;
        tooltip = `Active: ${provider}/${active.model} — click to switch`;
      }
    }
  } catch {
    // Keep the default label if the state can't be read
  }

  modelStatusBarItem.text = `$(chip) ${label}`;
  modelStatusBarItem.tooltip = tooltip;
  modelStatusBarItem.show();
}

/**
 * Refresh the quota status bar indicator from the CLI's quota ledger.
 * Shows a parked-provider count when any provider is parked (window exhausted),
 * otherwise a checkmark. Best-effort — keeps the default label on read errors.
 *
 * Exported for unit testing.
 */
export async function refreshQuotaStatusBar(): Promise<void> {
  if (!quotaStatusBarItem || !cliManager) return;

  let label = '$(dashboard) quota';
  let tooltip = 'Agent-Nuvira — click to view quota ledger & failover timeline';

  try {
    const status = await cliManager.getQuotaStatus();
    if (status.enabled) {
      const parked = status.entries.filter((e) => e.parked).length;
      if (parked > 0) {
        label = `$(alert) ${parked} parked`;
        tooltip = `${parked} provider(s) parked (quota exhausted) — click for details`;
      } else {
        label = '$(check) quota ok';
        tooltip = 'Quota ledger healthy — click to view details';
      }
    }
  } catch {
    // Keep the default label if the state can't be read
  }

  quotaStatusBarItem.text = label;
  quotaStatusBarItem.tooltip = tooltip;
  quotaStatusBarItem.show();
}

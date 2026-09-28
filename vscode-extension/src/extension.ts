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
import { registerLanguageModelTools } from './lmTools.js';
import { log, logError, disposeOutputChannel } from './output.js';
import { t } from './l10n.js';
import type {
  ActiveModelInfo,
  CLIResult,
  ExtensionConfig,
  QuotaStatusInfo,
} from './types.js';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Every command this extension contributes, in the order `package.json`
 * declares them. Canonical list — the e2e suite asserts each id is both
 * announced here and actually registered in a real editor.
 */
export const EXTENSION_COMMAND_IDS = [
  'agent-nuvira.executeGoal',
  'agent-nuvira.quickFix',
  'agent-nuvira.reviewFile',
  'agent-nuvira.explainCode',
  'agent-nuvira.generateTest',
  'agent-nuvira.openChat',
  'agent-nuvira.showPanel',
  'agent-nuvira.runWorkflow',
  'agent-nuvira.acceptChanges',
  'agent-nuvira.rejectChanges',
  'agent-nuvira.switchModel',
  'agent-nuvira.modelHealth',
  'agent-nuvira.showQuota',
] as const;

/**
 * Programmatic surface returned from `activate()` and available to other
 * extensions as `vscode.extensions.getExtension(id)!.exports`. Kept small and
 * explicit: anything exported here is a compatibility promise.
 */
export interface AgentNuviraApi {
  /** Version of the running extension, from the manifest. */
  readonly version: string;
  /** Command ids the extension registers (see {@link EXTENSION_COMMAND_IDS}). */
  readonly commands: readonly string[];
  /** Open (or focus) the Agent-Nuvira chat panel. */
  openChat(): void;
  /** Run a goal through the CLI-backed multi-agent pipeline. */
  executeGoal(goal: string): Promise<CLIResult>;
  /** The active provider/model, or null when none has been chosen. */
  getActiveModel(): Promise<ActiveModelInfo | null>;
  /** Snapshot of the quota ledger and failover timeline. */
  getQuotaStatus(): Promise<QuotaStatusInfo>;
}

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
 *
 * Returns the {@link AgentNuviraApi} so the extension is usable
 * programmatically (and verifiable end-to-end) without going through the
 * command palette.
 */
export function activate(context: vscode.ExtensionContext): AgentNuviraApi {
  const config = loadConfig();

  // Initialize core components
  cliManager = new CLIManager(config);
  agentPanel = new AgentPanel();
  // The quota panel reads the ledger via getQuotaStatus() and auto-refreshes
  // live by watching the same memory dir the reader uses.
  quotaPanel = new QuotaPanel({
    loadStatus: () => cliManager?.getQuotaStatus() ?? Promise.resolve({
      enabled: false,
      entries: [],
      events: [],
      freeTokens: 0,
      freeRequests: 0,
      paidTokens: 0,
      paidRequests: 0,
      estimatedSavedUsd: 0,
    }),
    watchDir: cliManager.getMemoryDir(),
  });
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
      try {
        quotaPanel?.createOrShow(context.extensionUri);
      } catch (err) {
        logError(t('Could not open the quota ledger: {0}', err instanceof Error ? err.message : String(err)));
      }
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

  // Register Language Model tools — lets VS Code's model / Copilot Chat invoke
  // Agent-Nuvira's reviewer, explainer, and goal runner. No-op on VS Code
  // versions that don't expose the `vscode.lm` tool API.
  for (const disposable of registerLanguageModelTools(cliManager)) {
    context.subscriptions.push(disposable);
  }

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
  updateStatusBar('$(robot) Agent-Nuvira Ready');

  // Output activation info to the Agent-Nuvira output channel (View → Output).
  log('Extension activated');
  log(`CLI path: ${config.cliPath}`);
  log(`Default provider: ${config.defaultProvider || '(from config)'}`);
  log(`Auto-apply: ${config.autoApplyChanges}`);
  log('Chat panel registered (Ctrl+Shift+A C)');

  return {
    version: (context.extension?.packageJSON?.version as string | undefined) ?? '0.0.0',
    commands: EXTENSION_COMMAND_IDS,
    openChat: () => {
      chatPanel?.createOrShow(context.extensionUri);
    },
    executeGoal: (goal: string) => {
      if (!cliManager) {
        return Promise.reject(new Error('Agent-Nuvira is not active'));
      }
      return cliManager.executeGoal(goal);
    },
    getActiveModel: () => (cliManager ? cliManager.getActiveModel() : Promise.resolve(null)),
    getQuotaStatus: () => {
      if (!cliManager) {
        return Promise.reject(new Error('Agent-Nuvira is not active'));
      }
      return cliManager.getQuotaStatus();
    },
  };
}

// ─── Deactivate ─────────────────────────────────────────────────────────────

/**
 * Called when the extension is deactivated.
 * Clean up all resources.
 */
export function deactivate(): void {
  log('Extension deactivating...');

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

  log('Extension deactivated');
  disposeOutputChannel();
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
  // Capture the item and manager up front: `deactivate()` nulls the module-level
  // variables, and reading them again after the await below would throw on a
  // refresh that straddles shutdown.
  const item = modelStatusBarItem;
  const manager = cliManager;
  if (!item || !manager) return;

  let label = 'model';
  let tooltip = 'Agent-Nuvira — click to switch provider/model';

  try {
    const active = await manager.getActiveModel();
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

  item.text = `$(chip) ${label}`;
  item.tooltip = tooltip;
  item.show();
}

/**
 * Refresh the quota status bar indicator from the CLI's quota ledger.
 * Shows a parked-provider count when any provider is parked (window exhausted),
 * otherwise a checkmark. Best-effort — keeps the default label on read errors.
 *
 * Exported for unit testing.
 */
export async function refreshQuotaStatusBar(): Promise<void> {
  const item = quotaStatusBarItem;
  const manager = cliManager;
  if (!item || !manager) return;

  let label = '$(dashboard) quota';
  let tooltip = 'Agent-Nuvira — click to view quota ledger & failover timeline';

  try {
    const status = await manager.getQuotaStatus();
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

  item.text = label;
  item.tooltip = tooltip;
  item.show();
}

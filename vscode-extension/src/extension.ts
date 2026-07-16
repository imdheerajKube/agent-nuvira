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
import { DiffViewer } from './diffViewer.js';
import { CommandRegistrar } from './commands.js';
import { InlineSuggestProvider } from './inlineSuggest.js';
import type { ExtensionConfig } from './types.js';

// ─── Module State ───────────────────────────────────────────────────────────

let cliManager: CLIManager | null = null;
let agentPanel: AgentPanel | null = null;
let diffViewer: DiffViewer | null = null;
let commandRegistrar: CommandRegistrar | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;

// ─── Activate ───────────────────────────────────────────────────────────────

/**
 * Called when the extension is activated (first command is run).
 */
export function activate(context: vscode.ExtensionContext): void {
  const config = loadConfig();

  // Initialize core components
  cliManager = new CLIManager(config);
  agentPanel = new AgentPanel();
  diffViewer = new DiffViewer(context);
  commandRegistrar = new CommandRegistrar(context, cliManager, agentPanel, diffViewer, config);

  // Create status bar item
  statusBarItem = createStatusBarItem();
  context.subscriptions.push(statusBarItem);

  // Register all commands
  const commandDisposables = commandRegistrar.registerAll();
  for (const disposable of commandDisposables) {
    context.subscriptions.push(disposable);
  }

  // Register inline completion provider (Phase 3.1.2 — Copilot-style suggestions)
  const inlineSuggestProvider = new InlineSuggestProvider(config);
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
        updateStatusBar('$(refresh) Config Updated');
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

  // Dispose status bar
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }

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
 * Update the status bar text and show it.
 */
function updateStatusBar(text: string): void {
  if (statusBarItem) {
    statusBarItem.text = text;
    statusBarItem.show();
  }
}

"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
exports.refreshModelStatusBar = refreshModelStatusBar;
const vscode = __importStar(require("vscode"));
const cliManager_js_1 = require("./cliManager.js");
const agentPanel_js_1 = require("./agentPanel.js");
const chatPanel_js_1 = require("./chatPanel.js");
const chatProvider_js_1 = require("./chatProvider.js");
const codeLensProvider_js_1 = require("./codeLensProvider.js");
const diagnosticFixer_js_1 = require("./diagnosticFixer.js");
const diffViewer_js_1 = require("./diffViewer.js");
const commands_js_1 = require("./commands.js");
const inlineSuggest_js_1 = require("./inlineSuggest.js");
// ─── Module State ───────────────────────────────────────────────────────────
let cliManager = null;
let agentPanel = null;
let chatPanel = null;
let chatHistory = null;
let codeLensProvider = null;
let diagnosticFixer = null;
let diffViewer = null;
let commandRegistrar = null;
let inlineSuggestProvider = null;
let statusBarItem = null;
let modelStatusBarItem = null;
// ─── Activate ───────────────────────────────────────────────────────────────
/**
 * Called when the extension is activated (first command is run).
 */
function activate(context) {
    const config = loadConfig();
    // Initialize core components
    cliManager = new cliManager_js_1.CLIManager(config);
    agentPanel = new agentPanel_js_1.AgentPanel();
    chatHistory = new chatProvider_js_1.ChatHistoryProvider(context);
    chatPanel = new chatPanel_js_1.ChatPanel(context, chatHistory, config);
    diffViewer = new diffViewer_js_1.DiffViewer(context);
    diagnosticFixer = new diagnosticFixer_js_1.DiagnosticFixProvider(cliManager, diffViewer);
    codeLensProvider = new codeLensProvider_js_1.CodeLensProvider(cliManager);
    commandRegistrar = new commands_js_1.CommandRegistrar(context, cliManager, agentPanel, diffViewer, config);
    // Create status bar items
    statusBarItem = createStatusBarItem();
    context.subscriptions.push(statusBarItem);
    // Remove the old panel open and replace with chat panel open
    statusBarItem.command = 'agent-nuvira.openChat';
    // Model/provider indicator — click to switch provider/model
    modelStatusBarItem = createModelStatusBarItem();
    context.subscriptions.push(modelStatusBarItem);
    // Refresh the model indicator when a switch happens
    commandRegistrar.setOnModelChanged(() => {
        void refreshModelStatusBar();
    });
    void refreshModelStatusBar();
    // Register all commands
    const commandDisposables = commandRegistrar.registerAll();
    for (const disposable of commandDisposables) {
        context.subscriptions.push(disposable);
    }
    // Register the chat panel command
    context.subscriptions.push(vscode.commands.registerCommand('agent-nuvira.openChat', () => {
        chatPanel?.createOrShow(context.extensionUri);
    }));
    // Register the diagnostic fix command
    context.subscriptions.push(vscode.commands.registerCommand(diagnosticFixer_js_1.DiagnosticFixProvider.fixCommandId, (uri, line, error, code, lang, range) => diagnosticFixer?.handleFix(uri, line, error, code, lang, range)));
    // Register the CodeLensProvider for code lenses
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ pattern: '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,vue,svelte,mjs,cjs}' }, codeLensProvider));
    // Register code lens command handler (single menu-based action)
    context.subscriptions.push(vscode.commands.registerCommand(codeLensProvider_js_1.CodeLensProvider.lensCommandId, (uri, name, lang, line, bodyRange) => codeLensProvider?.handleLensClick(uri, name, lang, line, bodyRange)));
    // Register the CodeActionProvider for diagnostics
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ pattern: '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,vue,svelte,mjs,cjs}' }, diagnosticFixer, { providedCodeActionKinds: diagnosticFixer_js_1.DiagnosticFixProvider.providedCodeActionKinds }));
    // Register inline completion provider (Phase 3.1.2 — Copilot-style suggestions)
    inlineSuggestProvider = new inlineSuggest_js_1.InlineSuggestProvider(config);
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,vue,svelte,mjs,cjs}' }, inlineSuggestProvider));
    // Register configuration change handler
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agent-nuvira')) {
            const newConfig = loadConfig();
            cliManager?.dispose();
            cliManager = new cliManager_js_1.CLIManager(newConfig);
            commandRegistrar?.updateConfig(newConfig);
            chatPanel?.updateConfig(newConfig);
            inlineSuggestProvider?.updateConfig(newConfig);
            codeLensProvider?.updateCliManager(cliManager);
            diagnosticFixer?.updateCliManager(cliManager);
            updateStatusBar('$(refresh) Config Updated');
            void refreshModelStatusBar();
        }
    }));
    // Update status bar on save to show readiness
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
        updateStatusBar('$(check) Ready');
    }));
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
function deactivate() {
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
function loadConfig() {
    const vsConfig = vscode.workspace.getConfiguration('agent-nuvira');
    return {
        cliPath: vsConfig.get('cliPath', 'buff'),
        defaultProvider: vsConfig.get('defaultProvider', ''),
        defaultModel: vsConfig.get('defaultModel', ''),
        autoApplyChanges: vsConfig.get('autoApplyChanges', false),
        maxTokens: vsConfig.get('maxTokens', 4096),
        showProgressPanel: vsConfig.get('showProgressPanel', true),
        useAutoRouting: vsConfig.get('useAutoRouting', false),
    };
}
/**
 * Create the status bar item.
 */
function createStatusBarItem() {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
        }
        else {
            item.hide();
        }
    });
    return item;
}
/**
 * Create the model/provider status bar item.
 * Shown only when there's an active workspace, mirroring the main item.
 */
function createModelStatusBarItem() {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
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
        }
        else {
            item.hide();
        }
    });
    return item;
}
/**
 * Update the status bar text and show it.
 */
function updateStatusBar(text) {
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
async function refreshModelStatusBar() {
    if (!modelStatusBarItem || !cliManager)
        return;
    let label = 'model';
    let tooltip = 'Agent-Nuvira — click to switch provider/model';
    try {
        const active = await cliManager.getActiveModel();
        if (active) {
            if (active.provider === 'auto' || active.model === 'auto') {
                label = 'auto';
                tooltip = 'Auto routing — click to change provider/model';
            }
            else {
                const provider = active.providerLabel || active.provider;
                label = `${provider}/${active.model}`;
                tooltip = `Active: ${provider}/${active.model} — click to switch`;
            }
        }
    }
    catch {
        // Keep the default label if the state can't be read
    }
    modelStatusBarItem.text = `$(chip) ${label}`;
    modelStatusBarItem.tooltip = tooltip;
    modelStatusBarItem.show();
}
//# sourceMappingURL=extension.js.map
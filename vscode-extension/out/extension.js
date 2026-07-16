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
const vscode = __importStar(require("vscode"));
const cliManager_js_1 = require("./cliManager.js");
const agentPanel_js_1 = require("./agentPanel.js");
const diffViewer_js_1 = require("./diffViewer.js");
const commands_js_1 = require("./commands.js");
const inlineSuggest_js_1 = require("./inlineSuggest.js");
// ─── Module State ───────────────────────────────────────────────────────────
let cliManager = null;
let agentPanel = null;
let diffViewer = null;
let commandRegistrar = null;
let statusBarItem = null;
// ─── Activate ───────────────────────────────────────────────────────────────
/**
 * Called when the extension is activated (first command is run).
 */
function activate(context) {
    const config = loadConfig();
    // Initialize core components
    cliManager = new cliManager_js_1.CLIManager(config);
    agentPanel = new agentPanel_js_1.AgentPanel();
    diffViewer = new diffViewer_js_1.DiffViewer(context);
    commandRegistrar = new commands_js_1.CommandRegistrar(context, cliManager, agentPanel, diffViewer, config);
    // Create status bar item
    statusBarItem = createStatusBarItem();
    context.subscriptions.push(statusBarItem);
    // Register all commands
    const commandDisposables = commandRegistrar.registerAll();
    for (const disposable of commandDisposables) {
        context.subscriptions.push(disposable);
    }
    // Register inline completion provider (Phase 3.1.2 — Copilot-style suggestions)
    const inlineSuggestProvider = new inlineSuggest_js_1.InlineSuggestProvider(config);
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb,php,c,cpp,h,hpp,cs,swift,kt,scala,vue,svelte,mjs,cjs}' }, inlineSuggestProvider));
    // Register configuration change handler
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agent-nuvira')) {
            const newConfig = loadConfig();
            cliManager?.dispose();
            cliManager = new cliManager_js_1.CLIManager(newConfig);
            commandRegistrar?.updateConfig(newConfig);
            updateStatusBar('$(refresh) Config Updated');
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
function loadConfig() {
    const vsConfig = vscode.workspace.getConfiguration('agent-nuvira');
    return {
        cliPath: vsConfig.get('cliPath', 'buff'),
        defaultProvider: vsConfig.get('defaultProvider', ''),
        defaultModel: vsConfig.get('defaultModel', ''),
        autoApplyChanges: vsConfig.get('autoApplyChanges', false),
        maxTokens: vsConfig.get('maxTokens', 4096),
        showProgressPanel: vsConfig.get('showProgressPanel', true),
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
 * Update the status bar text and show it.
 */
function updateStatusBar(text) {
    if (statusBarItem) {
        statusBarItem.text = text;
        statusBarItem.show();
    }
}
//# sourceMappingURL=extension.js.map
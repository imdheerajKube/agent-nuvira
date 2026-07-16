"use strict";
/**
 * Commands — Registers all VS Code commands for the Agent-Baba-D extension.
 *
 * Commands:
 * - agent-baba-d.executeGoal    — Run a multi-agent pipeline
 * - agent-baba-d.quickFix       — Quick fix for the current file
 * - agent-baba-d.reviewFile     — Review the current file
 * - agent-baba-d.explainCode    — Explain selected code
 * - agent-baba-d.generateTest   — Generate tests
 * - agent-baba-d.showPanel      — Show the agent panel
 * - agent-baba-d.runWorkflow    — Run a workflow template
 * - agent-baba-d.acceptChanges  — Accept all proposed changes
 * - agent-baba-d.rejectChanges  — Reject all proposed changes
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
exports.CommandRegistrar = void 0;
const vscode = __importStar(require("vscode"));
// ─── CommandRegistrar ───────────────────────────────────────────────────────
class CommandRegistrar {
    cliManager;
    agentPanel;
    diffViewer;
    config;
    currentChanges = [];
    disposables = [];
    constructor(context, cliManager, agentPanel, diffViewer, config) {
        this.cliManager = cliManager;
        this.agentPanel = agentPanel;
        this.diffViewer = diffViewer;
        this.config = config;
    }
    /**
     * Register all extension commands.
     * Commands invoked from context menus receive the resource URI as first argument.
     */
    registerAll() {
        this.disposables = [
            vscode.commands.registerCommand('agent-baba-d.executeGoal', () => this.executeGoal()),
            vscode.commands.registerCommand('agent-baba-d.quickFix', (uri) => this.quickFix(uri)),
            vscode.commands.registerCommand('agent-baba-d.reviewFile', (uri) => this.reviewFile(uri)),
            vscode.commands.registerCommand('agent-baba-d.explainCode', () => this.explainCode()),
            vscode.commands.registerCommand('agent-baba-d.generateTest', (uri) => this.generateTest(uri)),
            vscode.commands.registerCommand('agent-baba-d.showPanel', () => this.showPanel()),
            vscode.commands.registerCommand('agent-baba-d.runWorkflow', () => this.runWorkflow()),
            vscode.commands.registerCommand('agent-baba-d.acceptChanges', () => this.acceptChanges()),
            vscode.commands.registerCommand('agent-baba-d.rejectChanges', () => this.rejectChanges()),
        ];
        return this.disposables;
    }
    /**
     * Update the config when settings change.
     */
    updateConfig(config) {
        this.config = config;
    }
    // ── Command Handlers ─────────────────────────────────────────────────────
    /**
     * Execute a multi-agent pipeline goal.
     * Prompts the user for a goal, then runs it through the orchestrator.
     */
    async executeGoal() {
        const goal = await vscode.window.showInputBox({
            prompt: 'What goal should the agents accomplish?',
            placeHolder: 'e.g., "Add JWT authentication to the Express app"',
            validateInput: (value) => {
                if (!value.trim())
                    return 'Please enter a goal';
                if (value.length < 3)
                    return 'Goal is too short';
                return undefined;
            },
        });
        if (!goal)
            return;
        await this.runAgentTask(`🎯 Executing: ${goal.slice(0, 60)}${goal.length > 60 ? '...' : ''}`, () => this.cliManager.executeGoal(goal));
    }
    /**
     * Quick fix for the current file or a provided URI.
     */
    async quickFix(uri) {
        const editor = vscode.window.activeTextEditor;
        // Determine file path: use provided URI (from context menu) or active editor
        let filePath;
        if (uri?.fsPath) {
            filePath = uri.fsPath;
        }
        else if (editor) {
            filePath = editor.document.uri.fsPath;
        }
        if (!filePath) {
            vscode.window.showWarningMessage('No file selected. Open a file or right-click one in the explorer.');
            return;
        }
        // If there's a selection in the active editor matching this file, use selection as context
        if (editor && editor.document.uri.fsPath === filePath && !editor.selection.isEmpty) {
            const code = editor.document.getText(editor.selection);
            await this.runAgentTask(`🔧 Quick fixing selection`, () => this.cliManager.executeGoal(`Fix any issues in this code:\n\n${code}`));
            return;
        }
        await this.runAgentTask(`🔧 Quick fixing: ${filePath.split('/').pop() || filePath}`, () => this.cliManager.quickFix(filePath));
    }
    /**
     * Review the current or selected file.
     * Accepts an optional URI from the context menu.
     */
    async reviewFile(uri) {
        // Determine file path: use provided URI (from context menu) or active editor
        let filePath;
        if (uri?.fsPath) {
            filePath = uri.fsPath;
        }
        else {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                filePath = editor.document.uri.fsPath;
            }
        }
        if (!filePath) {
            vscode.window.showWarningMessage('No file selected. Open a file or right-click one in the explorer.');
            return;
        }
        await this.runAgentTask(`📋 Reviewing: ${filePath.split('/').pop() || filePath}`, () => this.cliManager.reviewFile(filePath));
    }
    /**
     * Explain the selected code.
     */
    async explainCode() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Select code to explain.');
            return;
        }
        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showWarningMessage('Select code to explain first.');
            return;
        }
        const code = editor.document.getText(selection);
        const fileExtension = editor.document.fileName.split('.').pop();
        await this.runAgentTask(`📖 Explaining selected code`, () => this.cliManager.explainCode(code, fileExtension), { showResultInline: true });
    }
    /**
     * Generate tests for the current file or a provided URI.
     */
    async generateTest(uri) {
        // Determine file path: use provided URI (from context menu) or active editor
        let filePath;
        if (uri?.fsPath) {
            filePath = uri.fsPath;
        }
        else {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                filePath = editor.document.uri.fsPath;
            }
        }
        if (!filePath) {
            vscode.window.showWarningMessage('No file selected. Open a file or right-click one in the explorer.');
            return;
        }
        await this.runAgentTask(`🧪 Generating tests for: ${filePath.split('/').pop() || filePath}`, () => this.cliManager.generateTests(filePath));
    }
    /**
     * Show the agent progress panel.
     */
    async showPanel() {
        this.agentPanel.createOrShow(vscode.Uri.file(__dirname));
        this.agentPanel.updateStatus('Ready');
    }
    /**
     * Run a workflow template.
     */
    async runWorkflow() {
        const templates = [
            { label: 'Quick Fix', description: 'Gather context → Edit → Review', template: 'quick-fix' },
            { label: 'Feature Implementation', description: 'Plan → Gather → Write → Test → Review → Commit', template: 'feature-implement' },
            { label: 'Security Audit', description: 'Scan codebase for vulnerabilities', template: 'security-audit' },
        ];
        const selected = await vscode.window.showQuickPick(templates, {
            placeHolder: 'Select a workflow template:',
        });
        if (!selected)
            return;
        const goal = await vscode.window.showInputBox({
            prompt: `Enter the goal for the "${selected.label}" workflow:`,
            placeHolder: 'e.g., "Add input validation to the login form"',
        });
        if (!goal)
            return;
        await this.runAgentTask(`🔄 Running workflow "${selected.label}": ${goal.slice(0, 50)}${goal.length > 50 ? '...' : ''}`, () => this.cliManager.runWorkflow(selected.template, goal));
    }
    /**
     * Accept all proposed changes.
     */
    async acceptChanges() {
        if (this.currentChanges.length === 0) {
            vscode.window.showWarningMessage('No pending changes to accept.');
            return;
        }
        const applied = await this.diffViewer.applyChanges(this.currentChanges);
        this.currentChanges = [];
        // Clear the hasChanges context so accept/reject keybindings deactivate
        vscode.commands.executeCommand('setContext', 'agent-baba-d.hasChanges', false);
        if (applied > 0) {
            this.agentPanel.updateStatus('✅ Changes applied');
        }
    }
    /**
     * Reject all proposed changes.
     */
    async rejectChanges() {
        if (this.currentChanges.length === 0) {
            vscode.window.showWarningMessage('No pending changes to reject.');
            return;
        }
        this.diffViewer.rejectChanges();
        this.currentChanges = [];
        this.agentPanel.clear();
        this.agentPanel.updateStatus('Changes rejected');
        // Clear the hasChanges context so keybindings deactivate
        vscode.commands.executeCommand('setContext', 'agent-baba-d.hasChanges', false);
    }
    // ── Task Runner ───────────────────────────────────────────────────────────
    /**
     * Run an agent task with progress tracking and result handling.
     */
    async runAgentTask(title, task, options) {
        // Show the panel
        if (this.config.showProgressPanel) {
            this.agentPanel.createOrShow(vscode.Uri.file(__dirname));
        }
        // Clear previous state
        this.agentPanel.clear();
        this.currentChanges = [];
        // Set up callbacks
        this.cliManager.setCallbacks({
            onProgress: (phase, detail) => {
                this.agentPanel.updateProgress({
                    phase,
                    progress: -1, // Indeterminate
                    detail,
                    completed: false,
                    log: [],
                });
            },
            onLog: (line) => {
                this.agentPanel.updateProgress({
                    phase: title,
                    progress: -1,
                    detail: line.slice(0, 120),
                    completed: false,
                    log: [line],
                });
            },
        });
        this.agentPanel.updateProgress({
            phase: title,
            progress: 0,
            detail: 'Starting...',
            completed: false,
            log: [],
        });
        // Set up cancel handler
        this.agentPanel.setCallbacks({
            onCancelTask: () => {
                this.cliManager.cancel();
                this.agentPanel.updateStatus('Cancelled');
            },
            onAcceptChanges: async (changes) => {
                this.currentChanges = changes;
                await this.acceptChanges();
            },
            onRejectChanges: (changes) => {
                this.currentChanges = changes;
                this.rejectChanges();
            },
        });
        // Run the task
        try {
            const result = await task();
            if (result.success) {
                // Parse the result to extract file changes
                const parsedResult = this.parseCLIOutput(result.stdout);
                // Show diff previews unless auto-apply is on
                if (parsedResult.changes.length > 0 && !this.config.autoApplyChanges) {
                    this.currentChanges = parsedResult.changes;
                    // Set context so accept/reject keybindings activate
                    vscode.commands.executeCommand('setContext', 'agent-baba-d.hasChanges', true);
                    await this.diffViewer.showChanges(parsedResult.changes);
                    this.agentPanel.showDiffs(parsedResult.changes);
                }
                else if (parsedResult.changes.length > 0 && this.config.autoApplyChanges) {
                    // Auto-apply
                    const applied = await this.diffViewer.applyChanges(parsedResult.changes);
                    parsedResult.changes.forEach((c) => (c.applied = true));
                    this.currentChanges = [];
                }
                // Show result in panel
                this.agentPanel.showResult(parsedResult);
                // Show inline result if requested (e.g., for explanations)
                if (options?.showResultInline && parsedResult.output) {
                    const doc = await vscode.workspace.openTextDocument({
                        content: parsedResult.output,
                        language: 'markdown',
                    });
                    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
                }
            }
            else {
                // Partial success or failure
                this.agentPanel.showError(result.stderr || 'Task completed with warnings.');
                // Still try to show any partial output
                if (result.stdout) {
                    const parsedResult = this.parseCLIOutput(result.stdout);
                    if (parsedResult.changes.length > 0) {
                        this.currentChanges = parsedResult.changes;
                        this.agentPanel.showDiffs(parsedResult.changes);
                    }
                }
            }
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.agentPanel.showError(errorMsg);
        }
    }
    // ── Output Parser ─────────────────────────────────────────────────────────
    /**
     * Parse CLI stdout into a structured AgentResult.
     * Extracts file changes from diff-like output.
     */
    parseCLIOutput(stdout) {
        const changes = [];
        const lines = stdout.split('\n');
        // Look for file change indicators in CLI output
        const changePatterns = [
            // Pattern: 📄 path/to/file (created)
            /^📄\s+(.+?)\s+\((created|new)\)/,
            // Pattern: ✏️ path/to/file (modified)
            /^✏️\s+(.+?)\s+\((modified|updated|changed)\)/,
            // Pattern: 🗑️ path/to/file (deleted)
            /^🗑️\s+(.+?)\s+\((deleted|removed)\)/,
            // Pattern: Created: path/to/file
            /^(?:Created|New):\s+(.+)/i,
            // Pattern: Modified: path/to/file
            /^(?:Modified|Updated|Changed):\s+(.+)/i,
            // Pattern: Deleted: path/to/file
            /^(?:Deleted|Removed):\s+(.+)/i,
            // Pattern: +++ or --- style diff headers
            /^\+\+\+\s+(?:b\/)?(.+)/,
        ];
        for (const line of lines) {
            for (const pattern of changePatterns) {
                const match = line.match(pattern);
                if (match) {
                    const path = match[1].trim();
                    const typeLine = line;
                    let type = 'modified';
                    if (typeLine.includes('📄') || typeLine.match(/created|new/i)) {
                        type = 'created';
                    }
                    else if (typeLine.includes('🗑️') || typeLine.match(/deleted|removed/i)) {
                        type = 'deleted';
                    }
                    else if (typeLine.match(/^\+\+\+/)) {
                        // It's a diff header, check if it was created
                        type = 'modified';
                    }
                    // Avoid duplicates
                    if (!changes.some((c) => c.path === path)) {
                        changes.push({ path, type, applied: false });
                    }
                    break;
                }
            }
        }
        return {
            success: true,
            summary: this.generateSummary(changes, stdout),
            changes,
            durationMs: 0,
            output: stdout,
        };
    }
    /**
     * Generate a summary of what was done.
     */
    generateSummary(changes, output) {
        if (changes.length > 0) {
            const created = changes.filter((c) => c.type === 'created').length;
            const modified = changes.filter((c) => c.type === 'modified').length;
            const deleted = changes.filter((c) => c.type === 'deleted').length;
            const parts = [];
            if (created > 0)
                parts.push(`${created} created`);
            if (modified > 0)
                parts.push(`${modified} modified`);
            if (deleted > 0)
                parts.push(`${deleted} deleted`);
            return `Changes: ${parts.join(', ')}`;
        }
        // Fall back to extracting first meaningful line
        const firstLine = output.split('\n').find((l) => l.length > 20 && !l.startsWith('[') && !l.startsWith('ℹ') && !l.startsWith('✔'));
        return firstLine?.trim().slice(0, 150) || 'Task completed.';
    }
    /**
     * Clean up on deactivation.
     */
    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
exports.CommandRegistrar = CommandRegistrar;
//# sourceMappingURL=commands.js.map
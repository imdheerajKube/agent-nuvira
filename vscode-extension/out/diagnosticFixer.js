"use strict";
/**
 * Diagnostic Fixer — A VS Code CodeActionProvider that adds "Fix with Agent-Nuvira"
 * to the lightbulb menu when diagnostics (red squiggles) are present.
 *
 * How it works:
 * 1. User sees a red squiggle on line 42
 * 2. User clicks "Fix with Agent-Nuvira" in the lightbulb menu (Ctrl+.)
 * 3. Captures error message, affected code range, 3-line surrounding context
 * 4. Sends targeted fix prompt via CLI chat (lightweight, not full pipeline)
 * 5. Shows result as diff preview with Apply/Reject options
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
exports.DiagnosticFixProvider = void 0;
const vscode = __importStar(require("vscode"));
// ─── DiagnosticFixProvider ──────────────────────────────────────────────────
class DiagnosticFixProvider {
    static providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
    static fixCommandId = 'agent-nuvira.diagnosticFix';
    cliManager;
    diffViewer;
    constructor(cliManager, diffViewer) {
        this.cliManager = cliManager;
        this.diffViewer = diffViewer;
    }
    /**
     * Swap the CLI manager when extension config changes
     * (so auto-routing / provider settings take effect immediately).
     */
    updateCliManager(cliManager) {
        this.cliManager = cliManager;
    }
    /**
     * Provide code actions for diagnostics on the current line.
     */
    provideCodeActions(document, _range, context, _token) {
        if (context.diagnostics.length === 0)
            return [];
        const actions = [];
        // Group diagnostics by line
        const lineDiagnostics = new Map();
        for (const diagnostic of context.diagnostics) {
            const line = diagnostic.range.start.line;
            if (!lineDiagnostics.has(line)) {
                lineDiagnostics.set(line, []);
            }
            lineDiagnostics.get(line).push(diagnostic);
        }
        for (const [line, diagnostics] of lineDiagnostics) {
            const primary = diagnostics[0];
            const errMsg = primary.message;
            // Single diagnostic action
            actions.push(this.createFixAction(document, line, errMsg, this.getSurroundingCode(document, line), document.languageId, primary.range));
            // Group action if multiple diagnostics on same line
            if (diagnostics.length > 1) {
                const allMsgs = diagnostics.map((d) => d.message).join('; ');
                const start = diagnostics[0].range.start;
                const end = diagnostics[diagnostics.length - 1].range.end;
                actions.push(this.createFixAction(document, line, allMsgs, this.getSurroundingCode(document, line), document.languageId, new vscode.Range(start, end), diagnostics.length));
            }
        }
        return actions;
    }
    /**
     * Create a single code action.
     */
    createFixAction(document, line, errorMessage, surroundingCode, languageId, diagnosticRange, count) {
        const label = count && count > 1
            ? `Fix all ${count} issues with Agent-Nuvira`
            : `Fix with Agent-Nuvira: ${this.truncate(errorMessage, 50)}`;
        const action = new vscode.CodeAction(label, vscode.CodeActionKind.QuickFix);
        action.command = {
            command: DiagnosticFixProvider.fixCommandId,
            title: 'Fix with Agent-Nuvira',
            arguments: [document.uri, line, errorMessage, surroundingCode, languageId, diagnosticRange],
        };
        return action;
    }
    /**
     * Handle the diagnostic fix command from the lightbulb menu.
     */
    async handleFix(uri, line, errorMessage, surroundingCode, languageId, diagnosticRange) {
        // Guard: this command should only be invoked from a CodeAction (lightbulb)
        if (!uri) {
            vscode.window.showWarningMessage('Select a diagnostic first. Click the lightbulb on a red squiggle (red underline), ' +
                'then choose "Fix with Agent-Nuvira" from the menu.');
            return;
        }
        const fileName = uri.fsPath.split('/').pop() || uri.fsPath;
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Fixing error in ${fileName}: ${this.truncate(errorMessage, 60)}`,
            cancellable: true,
        }, async (_progress, cancellationToken) => {
            const prompt = this.buildFixPrompt(errorMessage, surroundingCode, languageId, fileName);
            const result = await this.cliManager.executeGoal(prompt);
            if (cancellationToken.isCancellationRequested || !result)
                return;
            if (result.success && result.stdout) {
                await this.showFixResult(result.stdout, uri, errorMessage);
            }
            else {
                this.showError(result.stderr || 'Could not generate fix.', uri, line, errorMessage, surroundingCode, languageId, diagnosticRange);
            }
        });
    }
    /**
     * Show the fix result to the user.
     */
    async showFixResult(output, uri, errorMessage) {
        // Check if output contains structured diff markers
        const changes = this.extractChanges(output, uri.fsPath);
        if (changes.length > 0) {
            await this.diffViewer.showChanges(changes);
            const choice = await vscode.window.showInformationMessage('Agent-Nuvira suggested a fix.', 'Apply', 'Reject');
            if (choice === 'Apply') {
                await this.diffViewer.applyChanges(changes);
                vscode.window.showInformationMessage('Fix applied successfully.');
            }
        }
        else {
            // Show raw output as a new document
            const doc = await vscode.workspace.openTextDocument({
                content: output,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
            vscode.window.showInformationMessage('Agent-Nuvira generated a suggestion.');
        }
    }
    /**
     * Show error and offer retry.
     */
    showError(stderr, uri, line, errorMessage, surroundingCode, languageId, diagnosticRange) {
        const choice = vscode.window.showErrorMessage('Fix failed. Retry?', 'Retry', 'Cancel');
        choice.then((selection) => {
            if (selection === 'Retry') {
                this.handleFix(uri, line, errorMessage, surroundingCode, languageId, diagnosticRange);
            }
        });
    }
    /**
     * Build a lightweight fix prompt for the CLI.
     * Asks for structured output so the result can be parsed.
     */
    buildFixPrompt(errorMessage, surroundingCode, languageId, fileName) {
        return [
            'Fix the following error quickly and precisely.',
            '',
            `File: ${fileName} (${languageId})`,
            `Error: ${errorMessage}`,
            '',
            'Affected code:',
            '```' + languageId,
            surroundingCode,
            '```',
            '',
            'Return the complete fixed code block prefixed with the file path.',
            'Format: ```' + languageId + ':' + fileName,
            '<fixed code>',
            '```',
            '',
            'Requirements:',
            '- Fix only the specific error',
            '- Preserve existing code structure and style',
            '- Keep surrounding context intact',
        ].join('\n');
    }
    /**
     * Extract file changes from CLI output by detecting code blocks with file paths.
     */
    extractChanges(output, filePath) {
        // Look for code blocks with file path prefix: ```lang:path
        const blockRegex = /```(\w+)?:?(.+?)?\n([\s\S]*?)```/g;
        const changes = [];
        let match;
        while ((match = blockRegex.exec(output)) !== null) {
            const code = match[3].trim();
            if (code.length > 10) {
                // Use the provided file path by default
                changes.push({
                    path: filePath,
                    type: 'modified',
                    newContent: code,
                    applied: false,
                });
                // Only take the first substantial code block
                break;
            }
        }
        return changes;
    }
    /**
     * Get surrounding code (3 lines before and after the affected line).
     */
    getSurroundingCode(document, line) {
        const startLine = Math.max(0, line - 3);
        const endLine = Math.min(document.lineCount - 1, line + 3);
        const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
        return document.getText(range);
    }
    /**
     * Truncate a message with ellipsis.
     */
    truncate(message, maxLen) {
        return message.length <= maxLen ? message : message.slice(0, maxLen) + '\u2026';
    }
}
exports.DiagnosticFixProvider = DiagnosticFixProvider;
//# sourceMappingURL=diagnosticFixer.js.map
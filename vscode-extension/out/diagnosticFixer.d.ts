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
import * as vscode from 'vscode';
import { CLIManager } from './cliManager.js';
import { DiffViewer } from './diffViewer.js';
export declare class DiagnosticFixProvider implements vscode.CodeActionProvider {
    static readonly providedCodeActionKinds: vscode.CodeActionKind[];
    static readonly fixCommandId = "agent-nuvira.diagnosticFix";
    private cliManager;
    private diffViewer;
    constructor(cliManager: CLIManager, diffViewer: DiffViewer);
    /**
     * Provide code actions for diagnostics on the current line.
     */
    provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext, _token: vscode.CancellationToken): vscode.CodeAction[];
    /**
     * Create a single code action.
     */
    private createFixAction;
    /**
     * Handle the diagnostic fix command from the lightbulb menu.
     */
    handleFix(uri: vscode.Uri, line: number, errorMessage: string, surroundingCode: string, languageId: string, diagnosticRange: vscode.Range): Promise<void>;
    /**
     * Show the fix result to the user.
     */
    private showFixResult;
    /**
     * Show error and offer retry.
     */
    private showError;
    /**
     * Build a lightweight fix prompt for the CLI.
     * Asks for structured output so the result can be parsed.
     */
    private buildFixPrompt;
    /**
     * Extract file changes from CLI output by detecting code blocks with file paths.
     */
    private extractChanges;
    /**
     * Get surrounding code (3 lines before and after the affected line).
     */
    private getSurroundingCode;
    /**
     * Truncate a message with ellipsis.
     */
    private truncate;
}
//# sourceMappingURL=diagnosticFixer.d.ts.map
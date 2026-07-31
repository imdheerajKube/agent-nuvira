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
import type { FileChange } from './types.js';

// ─── DiagnosticFixProvider ──────────────────────────────────────────────────

export class DiagnosticFixProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
  public static readonly fixCommandId = 'agent-nuvira.diagnosticFix';

  private cliManager: CLIManager;
  private diffViewer: DiffViewer;

  constructor(cliManager: CLIManager, diffViewer: DiffViewer) {
    this.cliManager = cliManager;
    this.diffViewer = diffViewer;
  }

  /**
   * Swap the CLI manager when extension config changes
   * (so auto-routing / provider settings take effect immediately).
   */
  updateCliManager(cliManager: CLIManager): void {
    this.cliManager = cliManager;
  }

  /**
   * Provide code actions for diagnostics on the current line.
   */
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    if (context.diagnostics.length === 0) return [];

    const actions: vscode.CodeAction[] = [];

    // Group diagnostics by line
    const lineDiagnostics = new Map<number, vscode.Diagnostic[]>();
    for (const diagnostic of context.diagnostics) {
      const line = diagnostic.range.start.line;
      if (!lineDiagnostics.has(line)) {
        lineDiagnostics.set(line, []);
      }
      lineDiagnostics.get(line)!.push(diagnostic);
    }

    for (const [line, diagnostics] of lineDiagnostics) {
      const primary = diagnostics[0];
      const errMsg = primary.message;

      // Single diagnostic action
      actions.push(this.createFixAction(
        document, line, errMsg,
        this.getSurroundingCode(document, line),
        document.languageId, primary.range,
      ));

      // Group action if multiple diagnostics on same line
      if (diagnostics.length > 1) {
        const allMsgs = diagnostics.map((d) => d.message).join('; ');
        const start = diagnostics[0].range.start;
        const end = diagnostics[diagnostics.length - 1].range.end;
        actions.push(this.createFixAction(
          document, line, allMsgs,
          this.getSurroundingCode(document, line),
          document.languageId, new vscode.Range(start, end),
          diagnostics.length,
        ));
      }
    }

    return actions;
  }

  /**
   * Create a single code action.
   */
  private createFixAction(
    document: vscode.TextDocument,
    line: number,
    errorMessage: string,
    surroundingCode: string,
    languageId: string,
    diagnosticRange: vscode.Range,
    count?: number,
  ): vscode.CodeAction {
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
  async handleFix(
    uri: vscode.Uri,
    line: number,
    errorMessage: string,
    surroundingCode: string,
    languageId: string,
    diagnosticRange: vscode.Range,
  ): Promise<void> {
    // Guard: this command should only be invoked from a CodeAction (lightbulb)
    if (!uri) {
      vscode.window.showWarningMessage(
        'Select a diagnostic first. Click the lightbulb on a red squiggle (red underline), ' +
        'then choose "Fix with Agent-Nuvira" from the menu.',
      );
      return;
    }

    const fileName = uri.fsPath.split('/').pop() || uri.fsPath;

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Fixing error in ${fileName}: ${this.truncate(errorMessage, 60)}`,
        cancellable: true,
      },
      async (_progress, cancellationToken) => {
        const prompt = this.buildFixPrompt(errorMessage, surroundingCode, languageId, fileName);
        const result = await this.cliManager.executeGoal(prompt);

        if (cancellationToken.isCancellationRequested || !result) return;

        if (result.success && result.stdout) {
          await this.showFixResult(result.stdout, uri, errorMessage);
        } else {
          this.showError(result.stderr || 'Could not generate fix.', uri, line, errorMessage, surroundingCode, languageId, diagnosticRange);
        }
      },
    );
  }

  /**
   * Show the fix result to the user.
   */
  private async showFixResult(output: string, uri: vscode.Uri, errorMessage: string): Promise<void> {
    // Check if output contains structured diff markers
    const changes = this.extractChanges(output, uri.fsPath);

    if (changes.length > 0) {
      await this.diffViewer.showChanges(changes);
      const choice = await vscode.window.showInformationMessage(
        'Agent-Nuvira suggested a fix.',
        'Apply',
        'Reject',
      );
      if (choice === 'Apply') {
        await this.diffViewer.applyChanges(changes);
        vscode.window.showInformationMessage('Fix applied successfully.');
      }
    } else {
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
  private showError(
    stderr: string,
    uri: vscode.Uri,
    line: number,
    errorMessage: string,
    surroundingCode: string,
    languageId: string,
    diagnosticRange: vscode.Range,
  ): void {
    const choice = vscode.window.showErrorMessage(
      'Fix failed. Retry?',
      'Retry',
      'Cancel',
    );
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
  private buildFixPrompt(
    errorMessage: string,
    surroundingCode: string,
    languageId: string,
    fileName: string,
  ): string {
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
  private extractChanges(output: string, filePath: string): { path: string; type: 'modified'; originalContent?: string; newContent?: string; applied: boolean }[] {
    // Look for code blocks with file path prefix: ```lang:path
    const blockRegex = /```(\w+)?:?(.+?)?\n([\s\S]*?)```/g;
    const changes: { path: string; type: 'modified'; originalContent?: string; newContent?: string; applied: boolean }[] = [];
    let match: RegExpExecArray | null;

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
  private getSurroundingCode(document: vscode.TextDocument, line: number): string {
    const startLine = Math.max(0, line - 3);
    const endLine = Math.min(document.lineCount - 1, line + 3);
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    return document.getText(range);
  }

  /**
   * Truncate a message with ellipsis.
   */
  private truncate(message: string, maxLen: number): string {
    return message.length <= maxLen ? message : message.slice(0, maxLen) + '\u2026';
  }
}

/**
 * Standalone utility functions for building suggestion prompts and
 * parsing CLI output into VS Code inline completion items.
 *
 * Extracted from InlineSuggestProvider for better testability and reuse.
 */
import * as vscode from 'vscode';
/** Max lines for a suggestion */
export declare const MAX_SUGGESTION_LINES = 20;
/** Context lines around the cursor position used to build a suggestion prompt */
export interface SuggestionContext {
    beforeCursor: string;
    afterCursor: string;
    currentLinePrefix: string;
}
/**
 * Build a prompt for the CLI to generate a code suggestion.
 *
 * @param context - Code context around the cursor
 * @param languageId - Language identifier (e.g., 'typescript', 'python')
 * @param fileExtension - File extension without dot (e.g., 'ts', 'py')
 * @returns Formatted prompt string ready to send to the CLI
 */
export declare function buildSuggestionPrompt(context: SuggestionContext, languageId: string, fileExtension: string): string;
/**
 * Parse the suggestion text into InlineCompletionItems.
 *
 * @param suggestion - Raw suggestion text from the CLI
 * @param position - Cursor position in the document
 * @returns Array of InlineCompletionItems (typically 0 or 1)
 */
export declare function parseSuggestion(suggestion: string, position: vscode.Position): vscode.InlineCompletionItem[];
//# sourceMappingURL=inlineSuggestUtils.d.ts.map
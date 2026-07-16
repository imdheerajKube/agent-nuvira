/**
 * Standalone utility functions for building suggestion prompts and
 * parsing CLI output into VS Code inline completion items.
 *
 * Extracted from InlineSuggestProvider for better testability and reuse.
 */

import * as vscode from 'vscode';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max lines for a suggestion */
export const MAX_SUGGESTION_LINES = 20;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Context lines around the cursor position used to build a suggestion prompt */
export interface SuggestionContext {
  beforeCursor: string;
  afterCursor: string;
  currentLinePrefix: string;
}

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * Build a prompt for the CLI to generate a code suggestion.
 *
 * @param context - Code context around the cursor
 * @param languageId - Language identifier (e.g., 'typescript', 'python')
 * @param fileExtension - File extension without dot (e.g., 'ts', 'py')
 * @returns Formatted prompt string ready to send to the CLI
 */
export function buildSuggestionPrompt(
  context: SuggestionContext,
  languageId: string,
  fileExtension: string,
): string {
  const prefix = context.beforeCursor.slice(-400); // Last 400 chars
  const suffix = context.afterCursor.slice(0, 200); // First 200 chars after cursor

  return [
    `You are a code completion engine for ${languageId} (.${fileExtension}).`,
    'Complete the code at the cursor position (marked by <CURSOR>).',
    'Return ONLY the completion text — no explanations, no markdown, no code fences.',
    'Your completion should be concise and idiomatic.',
    'If nothing useful to add, return "NONE".',
    '',
    '--- Code context ---',
    prefix,
    '<CURSOR>',
    suffix,
    '---',
    '',
    'Complete:',
  ].join('\n');
}

/**
 * Parse the suggestion text into InlineCompletionItems.
 *
 * @param suggestion - Raw suggestion text from the CLI
 * @param position - Cursor position in the document
 * @returns Array of InlineCompletionItems (typically 0 or 1)
 */
export function parseSuggestion(
  suggestion: string,
  position: vscode.Position,
): vscode.InlineCompletionItem[] {
  // Split into lines
  const lines = suggestion.split('\n').filter((l) => l.length > 0);

  if (lines.length === 0) {
    return [];
  }

  // Limit lines
  const truncatedLines = lines.slice(0, MAX_SUGGESTION_LINES);
  const text = truncatedLines.join('\n');

  // Create the inline completion item
  const item = new vscode.InlineCompletionItem(
    text,
    new vscode.Range(position, position.translate(truncatedLines.length - 1, 0)),
  );

  return [item];
}

"use strict";
/**
 * Standalone utility functions for building suggestion prompts and
 * parsing CLI output into VS Code inline completion items.
 *
 * Extracted from InlineSuggestProvider for better testability and reuse.
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
exports.MAX_SUGGESTION_LINES = void 0;
exports.buildSuggestionPrompt = buildSuggestionPrompt;
exports.parseSuggestion = parseSuggestion;
const vscode = __importStar(require("vscode"));
// ─── Constants ──────────────────────────────────────────────────────────────
/** Max lines for a suggestion */
exports.MAX_SUGGESTION_LINES = 20;
// ─── Functions ──────────────────────────────────────────────────────────────
/**
 * Build a prompt for the CLI to generate a code suggestion.
 *
 * @param context - Code context around the cursor
 * @param languageId - Language identifier (e.g., 'typescript', 'python')
 * @param fileExtension - File extension without dot (e.g., 'ts', 'py')
 * @returns Formatted prompt string ready to send to the CLI
 */
function buildSuggestionPrompt(context, languageId, fileExtension) {
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
function parseSuggestion(suggestion, position) {
    // Split into lines
    const lines = suggestion.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) {
        return [];
    }
    // Limit lines
    const truncatedLines = lines.slice(0, exports.MAX_SUGGESTION_LINES);
    const text = truncatedLines.join('\n');
    // Create the inline completion item
    const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position.translate(truncatedLines.length - 1, 0)));
    return [item];
}
//# sourceMappingURL=inlineSuggestUtils.js.map
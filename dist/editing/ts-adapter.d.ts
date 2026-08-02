/**
 * TS-Adapter — TypeScript Compiler API wrapper for proper AST analysis.
 *
 * Uses the TypeScript compiler's built-in parser for exact syntax trees
 * rather than regex-based heuristics. Provides:
 * - Full AST parsing via ts.createSourceFile
 * - Node finding by name, position, or type
 * - Type resolution (where possible without full program)
 * - Position mapping (offset ↔ line:column)
 * - Safe traversal with comprehensive error handling
 *
 * @see src/editing/ast.ts — Regex-based fallback for non-TS languages
 * @see ARCHITECTURE.md §4.2 — Phase 11: TS Compiler API adapter spec
 */
import * as ts from 'typescript';
import type { SupportedLanguage, StructuralNode, SourceRange } from './types.js';
/**
 * Parse source code into a TypeScript AST (SourceFile node).
 * Returns null on any parse error (e.g., empty code, binary content).
 */
export declare function parseSourceFile(code: string, filePath: string): ts.SourceFile | null;
/**
 * Find all structural nodes in the code using the TypeScript Compiler API.
 * This is a more precise alternative to analyzeStructure() from ast.ts.
 *
 * Returns an empty array if parsing fails or the language isn't supported.
 */
export declare function findStructuralNodes(code: string, filePath: string): StructuralNode[];
/**
 * Find a specific node by name within the AST.
 * Searches all declarations (functions, classes, interfaces, type aliases, variables).
 */
export declare function findNodeByName(code: string, filePath: string, name: string): {
    node: ts.Node;
    sourceFile: ts.SourceFile;
} | null;
/**
 * Find a node at a specific position (line, column) in the source.
 * Returns the most specific (deepest) node at that position.
 */
export declare function findNodeAtPosition(code: string, filePath: string, line: number, column: number): ts.Node | null;
/**
 * Get the text range of a TypeScript node as SourceRange.
 */
export declare function nodeToRange(node: ts.Node, sourceFile: ts.SourceFile): SourceRange;
/**
 * Get the body range of a function/class/interface node.
 * For brace-bodied constructs, returns the range inside the braces.
 */
export declare function getBodyRange(node: ts.Node, sourceFile: ts.SourceFile): SourceRange | undefined;
/**
 * Extract the source text of a node from the original code.
 */
export declare function getNodeText(node: ts.Node, sourceFile: ts.SourceFile, code: string): string;
/**
 * Replace a node's text in the source code with new text.
 * Returns the modified code, or null if the node can't be located.
 */
export declare function replaceNodeText(code: string, node: ts.Node, sourceFile: ts.SourceFile, newText: string): string | null;
/**
 * Insert text at a specific position in the code.
 */
export declare function insertAt(code: string, sourceFile: ts.SourceFile, line: number, column: number, text: string): string | null;
/**
 * Validate that code parses successfully as TypeScript.
 * More precise than the regex-based validateSyntax() from ast.ts.
 */
export declare function validateTSSyntax(code: string, filePath: string): boolean;
export type { StructuralNode, SourceRange, SupportedLanguage };
//# sourceMappingURL=ts-adapter.d.ts.map
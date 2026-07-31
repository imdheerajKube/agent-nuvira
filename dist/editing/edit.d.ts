/**
 * AST-aware Edit Engine — High-level operations for smart code editing.
 *
 * Provides operations like:
 * - Replace function body
 * - Add method to class
 * - Add import statement
 * - Intelligent code formatting with structural awareness
 *
 * Uses TS Compiler API for TypeScript/JavaScript files (primary tier)
 * with regex-based fallback for other languages.
 *
 * @see ARCHITECTURE.md §4.2 — Phase 11: TS Compiler API integration
 */
import { type ASTEdit, type EditResult, type SupportedLanguage } from './types.js';
import { analyzeStructure, findNodeByName as findNodeByNameRegex, validateSyntax } from './ast.js';
import { formatEditSummary } from './diff.js';
import { renameSymbol, extractFunction, inlineFunction, addParameter, changeSignature } from './transform.js';
/**
 * Replace the body of a function/method while preserving its signature.
 * Uses TS Compiler API for TypeScript/JavaScript files, falls back to regex.
 */
export declare function replaceFunctionBody(code: string, functionName: string, newBody: string, language?: SupportedLanguage, filePath?: string): EditResult;
/**
 * Add a method to a class.
 * Uses TS Compiler API for TypeScript/JavaScript files, falls back to regex.
 */
export declare function addMethodToClass(code: string, className: string, methodCode: string, language?: SupportedLanguage, filePath?: string): EditResult;
/**
 * Add an import statement.
 * Automatically deduplicates existing imports.
 */
export declare function addImport(code: string, importStatement: string, language?: SupportedLanguage): EditResult;
/**
 * Insert code before a specific structural element.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 */
export declare function insertBefore(code: string, targetName: string, newCode: string, language?: SupportedLanguage, filePath?: string): EditResult;
/**
 * Insert code after a specific structural element.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 */
export declare function insertAfter(code: string, targetName: string, newCode: string, language?: SupportedLanguage, filePath?: string): EditResult;
/**
 * Delete a structural node from the code.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 */
export declare function deleteNode(code: string, targetName: string, language?: SupportedLanguage, filePath?: string): EditResult;
/**
 * Perform an intelligent edit based on the edit type.
 * Automatically detects language and finds structural targets.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 *
 * This is the primary entry point for the WriterAgent integration.
 */
export declare function performEdit(code: string, edit: ASTEdit): EditResult;
/**
 * Build a structural context description for the LLM.
 * Uses TS Compiler API for TypeScript/JavaScript files for richer, more precise
 * structural context. Falls back to regex-based analysis for other languages.
 */
export declare function buildStructuralContext(code: string, filePath: string): string;
/**
 * Validate syntax with TS Compiler API for TS/JS, regex fallback for others.
 */
export declare function validateCodeSyntax(code: string, filePath: string): boolean;
export { analyzeStructure, findNodeByNameRegex as findNodeByName, validateSyntax, formatEditSummary, renameSymbol, extractFunction, inlineFunction, addParameter, changeSignature, };
//# sourceMappingURL=edit.d.ts.map
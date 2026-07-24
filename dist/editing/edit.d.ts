/**
 * AST-aware Edit Engine — High-level operations for smart code editing.
 *
 * Provides operations like:
 * - Replace function body
 * - Add method to class
 * - Add import statement
 * - Intelligent code formatting with structural awareness
 *
 * Falls back to original text-based editing for unsupported languages.
 */
import { type ASTEdit, type EditResult, type SupportedLanguage } from './types.js';
import { analyzeStructure, findNodeByName, validateSyntax } from './ast.js';
import { formatEditSummary } from './diff.js';
/**
 * Replace the body of a function/method while preserving its signature.
 * Detects the function using structural analysis.
 */
export declare function replaceFunctionBody(code: string, functionName: string, newBody: string, language?: SupportedLanguage): EditResult;
/**
 * Add a method to a class.
 */
export declare function addMethodToClass(code: string, className: string, methodCode: string, language?: SupportedLanguage): EditResult;
/**
 * Add an import statement.
 * Automatically deduplicates existing imports.
 */
export declare function addImport(code: string, importStatement: string, language?: SupportedLanguage): EditResult;
/**
 * Insert code before a specific structural element.
 */
export declare function insertBefore(code: string, targetName: string, newCode: string, language?: SupportedLanguage): EditResult;
/**
 * Insert code after a specific structural element.
 */
export declare function insertAfter(code: string, targetName: string, newCode: string, language?: SupportedLanguage): EditResult;
/**
 * Delete a structural node from the code.
 */
export declare function deleteNode(code: string, targetName: string, language?: SupportedLanguage): EditResult;
/**
 * Perform an intelligent edit based on the edit type.
 * Automatically detects language and finds structural targets.
 *
 * This is the primary entry point for the WriterAgent integration.
 */
export declare function performEdit(code: string, edit: ASTEdit): EditResult;
/**
 * Build a structural context description for the LLM.
 * This tells the LLM about the structure of the file so it can make more
 * precise edits.
 */
export declare function buildStructuralContext(code: string, filePath: string): string;
export { analyzeStructure, findNodeByName, validateSyntax, formatEditSummary };
//# sourceMappingURL=edit.d.ts.map
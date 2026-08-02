/**
 * Structural Transformations — TS Compiler API-powered code transformations.
 *
 * Provides high-level structural operations:
 * - RenameSymbol — Rename a function, class, variable, or parameter
 * - ExtractFunction — Extract selected code into a new function
 * - InlineFunction — Inline a function call with its body
 * - ChangeSignature — Add/remove/reorder parameters
 * - AddParameter — Add a parameter to a function signature
 *
 * All transformations work on the textual level using position data from
 * the TypeScript Compiler API for precise, safe modifications.
 *
 * @see src/editing/ts-adapter.ts — TS Compiler API wrapper
 * @see src/editing/edit.ts — High-level edit operations
 */
export interface TransformResult {
    success: boolean;
    code: string | null;
    description: string;
    error?: string;
}
export interface RenameOptions {
    /** Current name of the symbol */
    oldName: string;
    /** New name for the symbol */
    newName: string;
    /** Whether to rename all references or just the declaration */
    renameReferences?: boolean;
}
export interface ExtractFunctionOptions {
    /** The selected code to extract */
    selectedText: string;
    /** Name for the new function */
    newFunctionName: string;
    /** Parameters for the new function (comma-separated) */
    parameters?: string;
    /** Where to insert the new function (line number) */
    insertAtLine?: number;
}
export interface InlineFunctionOptions {
    /** Name of the function to inline */
    functionName: string;
    /** The call expression to replace */
    callSiteCode: string;
}
export interface AddParameterOptions {
    /** Name of the function to modify */
    functionName: string;
    /** New parameter definition (e.g., "options: ConfigOptions") */
    parameterDef: string;
    /** Optional default value (e.g., "= {}") */
    defaultValue?: string;
    /** Position: 'first', 'last', or after parameter name */
    position?: 'first' | 'last' | string;
}
export interface ChangeSignatureOptions {
    /** Name of the function to modify */
    functionName: string;
    /** Completely new parameter list (including parens, e.g., "(a: string, b: number)") */
    newParams: string;
    /** Whether to also update call sites */
    updateCallSites?: boolean;
}
/**
 * Rename a symbol (function, class, variable) in the source code.
 *
 * For a simple rename, replaces all occurrences of the old name within
 * the file. More sophisticated renames can optionally scope to specific
 * declarations and their references.
 */
export declare function renameSymbol(code: string, filePath: string, options: RenameOptions): TransformResult;
/**
 * Extract a block of code into a new function.
 * Replaces the selected code with a call to the new function.
 */
export declare function extractFunction(code: string, filePath: string, options: ExtractFunctionOptions): TransformResult;
/**
 * Inline a function call by replacing it with the function's body.
 * Works on simple functions that have a single expression or statement block.
 */
export declare function inlineFunction(code: string, filePath: string, options: InlineFunctionOptions): TransformResult;
/**
 * Add a parameter to a function signature.
 */
export declare function addParameter(code: string, filePath: string, options: AddParameterOptions): TransformResult;
/**
 * Change a function's signature (parameter list).
 * Replaces everything between the parentheses with new params.
 */
export declare function changeSignature(code: string, filePath: string, options: ChangeSignatureOptions): TransformResult;
/**
 * Detect the type of transformation needed from a description string.
 * Returns a function name to use with the appropriate transform operation.
 */
export declare function detectTransformType(description: string): 'rename' | 'extract' | 'inline' | 'add-param' | 'change-sig' | null;
//# sourceMappingURL=transform.d.ts.map
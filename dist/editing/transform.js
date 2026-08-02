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
import * as ts from 'typescript';
import { parseSourceFile, findNodeByName, getNodeText, } from './ts-adapter.js';
// ─── Transform Operations ───────────────────────────────────────────────────
/**
 * Rename a symbol (function, class, variable) in the source code.
 *
 * For a simple rename, replaces all occurrences of the old name within
 * the file. More sophisticated renames can optionally scope to specific
 * declarations and their references.
 */
export function renameSymbol(code, filePath, options) {
    const { oldName, newName, renameReferences = true } = options;
    if (!oldName || !newName) {
        return { success: false, code: null, description: 'renameSymbol', error: 'oldName and newName are required' };
    }
    if (/^\d/.test(newName)) {
        return { success: false, code: null, description: 'renameSymbol', error: 'newName cannot start with a digit' };
    }
    // Use word-boundary matching for safe text replacement
    // This is more reliable than TS Compiler API node replacement because
    // we need to replace all occurrences (declaration + references), not just
    // the declaration node. The regex approach handles both.
    try {
        const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escapedOld}\\b`, 'g');
        const modified = code.replace(pattern, newName);
        if (modified === code) {
            return { success: false, code: null, description: 'renameSymbol', error: `Symbol "${oldName}" not found in code` };
        }
        return { success: true, code: modified, description: `Renamed ${oldName} → ${newName}` };
    }
    catch (err) {
        return {
            success: false,
            code: null,
            description: 'renameSymbol',
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
/**
 * Extract a block of code into a new function.
 * Replaces the selected code with a call to the new function.
 */
export function extractFunction(code, filePath, options) {
    const { selectedText, newFunctionName, parameters = '', insertAtLine } = options;
    if (!selectedText || !newFunctionName) {
        return { success: false, code: null, description: 'extractFunction', error: 'selectedText and newFunctionName are required' };
    }
    // Find the selected text in the code
    const selectionIndex = code.indexOf(selectedText);
    if (selectionIndex === -1) {
        return { success: false, code: null, description: 'extractFunction', error: 'Selected text not found in code' };
    }
    // Determine indentation of the selected code
    const lines = code.split('\n');
    const selectionLineIdx = code.slice(0, selectionIndex).split('\n').length - 1;
    const baseIndent = selectionLineIdx >= 0 && selectionLineIdx < lines.length
        ? lines[selectionLineIdx].match(/^(\s*)/)?.[1] || ''
        : '  ';
    const functionIndent = insertAtLine !== undefined
        ? (lines[insertAtLine - 1]?.match(/^(\s*)/)?.[1] || '  ')
        : baseIndent;
    // Build the new function
    const paramStr = parameters ? `(${parameters})` : '()';
    const newFunction = `\n${functionIndent}function ${newFunctionName}${paramStr}: void {\n${functionIndent}  ${selectedText.trim()}\n${functionIndent}}\n`;
    // Replace the selected code with a function call
    const callCode = `${newFunctionName}(${parameters ? parameters.split(',').map(p => p.trim().split(':')[0].trim()).join(', ') : ''})`;
    const modified = code.slice(0, selectionIndex) + callCode + code.slice(selectionIndex + selectedText.length);
    // Insert the function definition at the specified line or near the selection
    let finalCode;
    if (insertAtLine !== undefined) {
        const insertPos = lines.slice(0, insertAtLine - 1).join('\n').length + (insertAtLine > 1 ? 1 : 0);
        finalCode = modified.slice(0, insertPos) + newFunction + modified.slice(insertPos);
    }
    else {
        // Insert before the first line that contains the selection
        const insertIdx = lines.slice(0, selectionLineIdx).join('\n').length + (selectionLineIdx > 0 ? 1 : 0);
        finalCode = modified.slice(0, insertIdx) + newFunction + modified.slice(insertIdx);
    }
    return {
        success: true,
        code: finalCode,
        description: `Extracted ${newFunctionName}() from selected code`,
    };
}
/**
 * Inline a function call by replacing it with the function's body.
 * Works on simple functions that have a single expression or statement block.
 */
export function inlineFunction(code, filePath, options) {
    const { functionName, callSiteCode } = options;
    if (!functionName) {
        return { success: false, code: null, description: 'inlineFunction', error: 'functionName is required' };
    }
    // Find the function definition using TS Compiler API
    const sourceFile = parseSourceFile(code, filePath);
    if (!sourceFile) {
        return { success: false, code: null, description: 'inlineFunction', error: 'Could not parse source file' };
    }
    const found = findNodeByName(code, filePath, functionName);
    if (!found) {
        return { success: false, code: null, description: 'inlineFunction', error: `Function "${functionName}" not found` };
    }
    const node = found.node;
    // Get the function body
    let bodyText = null;
    if (ts.isFunctionDeclaration(node) && node.body) {
        bodyText = getNodeText(node.body, found.sourceFile, code);
    }
    else if (ts.isVariableDeclaration(node) && node.initializer) {
        // Arrow function or function expression
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
            const init = node.initializer;
            if (ts.isBlock(init.body)) {
                bodyText = getNodeText(init.body, found.sourceFile, code);
            }
            else {
                // Expression body
                bodyText = code.slice(init.body.getStart(found.sourceFile), init.body.getEnd());
            }
        }
    }
    if (!bodyText) {
        return { success: false, code: null, description: 'inlineFunction', error: `No body found for "${functionName}"` };
    }
    // Remove outer braces if present
    let bodyContent = bodyText.trim();
    if (bodyContent.startsWith('{') && bodyContent.endsWith('}')) {
        bodyContent = bodyContent.slice(1, -1).trim();
    }
    // If callSiteCode is provided, replace that specific call
    if (callSiteCode && code.includes(callSiteCode)) {
        const modified = code.replace(callSiteCode, bodyContent);
        return {
            success: true,
            code: modified,
            description: `Inlined ${functionName}() at call site`,
        };
    }
    // Otherwise, replace the function call with the body text
    // This is a simple replacement - in production you'd want to resolve
    // actual call expressions
    const callPattern = new RegExp(`${functionName}\\s*\\([^)]*\\)`, 'g');
    const modified = code.replace(callPattern, bodyContent);
    return {
        success: true,
        code: modified,
        description: `Inlined ${functionName}() body at all call sites`,
    };
}
/**
 * Add a parameter to a function signature.
 */
export function addParameter(code, filePath, options) {
    const { functionName, parameterDef, defaultValue, position = 'last' } = options;
    if (!functionName || !parameterDef) {
        return { success: false, code: null, description: 'addParameter', error: 'functionName and parameterDef are required' };
    }
    const sourceFile = parseSourceFile(code, filePath);
    if (!sourceFile) {
        return { success: false, code: null, description: 'addParameter', error: 'Could not parse source file' };
    }
    const found = findNodeByName(code, filePath, functionName);
    if (!found) {
        return { success: false, code: null, description: 'addParameter', error: `Function "${functionName}" not found` };
    }
    const node = found.node;
    let paramList = null;
    // Find the parameter list node
    if (ts.isFunctionDeclaration(node)) {
        // Find the parameter list by walking children
        ts.forEachChild(node, (child) => {
            if (ts.isParameter(child) || child.kind === ts.SyntaxKind.SyntaxList) {
                // The SyntaxList contains the parameters
            }
        });
        // Use the node text to find the parameter list
        const nodeText = getNodeText(node, found.sourceFile, code);
        const parenOpen = nodeText.indexOf('(');
        const parenClose = nodeText.lastIndexOf(')');
        if (parenOpen === -1 || parenClose === -1) {
            return { success: false, code: null, description: 'addParameter', error: 'Could not find parameter list' };
        }
        const globalStart = node.getStart(found.sourceFile);
        const insertPos = globalStart + parenClose;
        // Build the new parameter entry
        const paramEntry = defaultValue
            ? `${position === 'first' ? '' : ', '}${parameterDef}${defaultValue ? ` = ${defaultValue}` : ''}${position === 'first' ? ', ' : ''}`
            : `${position === 'first' ? '' : ', '}${parameterDef}${position === 'first' ? ', ' : ''}`;
        let result;
        if (position === 'first') {
            result = code.slice(0, globalStart + parenOpen + 1) + paramEntry + code.slice(globalStart + parenOpen + 1);
        }
        else {
            result = code.slice(0, insertPos) + paramEntry + code.slice(insertPos);
        }
        return {
            success: true,
            code: result,
            description: `Added parameter "${parameterDef}" to ${functionName}()`,
        };
    }
    // Handle variable-declared functions (arrow functions, function expressions)
    if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = node.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const nodeText = code.slice(init.getStart(found.sourceFile), init.getEnd());
            const parenOpen = nodeText.indexOf('(');
            const parenClose = nodeText.indexOf(')');
            if (parenOpen === -1 || parenClose === -1) {
                return { success: false, code: null, description: 'addParameter', error: 'Could not find parameter list' };
            }
            const globalStart = init.getStart(found.sourceFile);
            const paramEntry = position === 'first'
                ? `${parameterDef}, `
                : `, ${parameterDef}${defaultValue ? ` = ${defaultValue}` : ''}`;
            const result = code.slice(0, globalStart + parenOpen + 1) + paramEntry + code.slice(globalStart + parenOpen + 1);
            return {
                success: true,
                code: result,
                description: `Added parameter "${parameterDef}" to ${functionName}()`,
            };
        }
    }
    return { success: false, code: null, description: 'addParameter', error: `Could not modify "${functionName}" parameter list` };
}
/**
 * Change a function's signature (parameter list).
 * Replaces everything between the parentheses with new params.
 */
export function changeSignature(code, filePath, options) {
    const { functionName, newParams, updateCallSites = false } = options;
    if (!functionName) {
        return { success: false, code: null, description: 'changeSignature', error: 'functionName is required' };
    }
    const sourceFile = parseSourceFile(code, filePath);
    if (!sourceFile) {
        return { success: false, code: null, description: 'changeSignature', error: 'Could not parse source file' };
    }
    const found = findNodeByName(code, filePath, functionName);
    if (!found) {
        return { success: false, code: null, description: 'changeSignature', error: `Function "${functionName}" not found` };
    }
    const node = found.node;
    const nodeText = getNodeText(node, found.sourceFile, code);
    const parenOpen = nodeText.indexOf('(');
    const parenClose = nodeText.indexOf(')');
    if (parenOpen === -1 || parenClose === -1) {
        return { success: false, code: null, description: 'changeSignature', error: 'Could not find parameter list' };
    }
    const globalStart = node.getStart(found.sourceFile);
    const oldParams = nodeText.slice(parenOpen, parenClose + 1);
    const newParamList = newParams.startsWith('(') ? newParams : `(${newParams})`;
    // Replace the old parameter list with the new one
    const paramStart = globalStart + parenOpen;
    const paramEnd = globalStart + parenClose + 1;
    let modified = code.slice(0, paramStart) + newParamList + code.slice(paramEnd);
    // Optionally update call sites
    if (updateCallSites) {
        const callPattern = new RegExp(`${functionName}\\s*\\([^)]*\\)`, 'g');
        modified = modified.replace(callPattern, (match) => {
            // Only replace calls, not the definition
            if (match === nodeText)
                return match;
            const callParenOpen = match.indexOf('(');
            const callParenClose = match.lastIndexOf(')');
            return match.slice(0, callParenOpen + 1) + match.slice(callParenClose);
        });
    }
    return {
        success: true,
        code: modified,
        description: `Changed signature of ${functionName}()`,
    };
}
// ─── Convenience: Detect and apply the best transformation ──────────────────
/**
 * Detect the type of transformation needed from a description string.
 * Returns a function name to use with the appropriate transform operation.
 */
export function detectTransformType(description) {
    const lower = description.toLowerCase();
    if (/rename|change name/i.test(lower))
        return 'rename';
    if (/extract|pull out|isolate|separate/i.test(lower))
        return 'extract';
    if (/inline|replace call|flatten/i.test(lower))
        return 'inline';
    if (/add param|new param|additional param/i.test(lower))
        return 'add-param';
    if (/change sign|change signature|modify sign|modify signature|new sign/i.test(lower))
        return 'change-sig';
    return null;
}
//# sourceMappingURL=transform.js.map
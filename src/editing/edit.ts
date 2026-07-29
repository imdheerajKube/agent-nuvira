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

import {
  type ASTEdit,
  type EditResult,
  type SupportedLanguage,
  type StructuralNode,
  detectLanguage,
} from './types.js';
import {
  analyzeStructure,
  findNodeByName as findNodeByNameRegex,
  validateSyntax,
} from './ast.js';
import { applyEdits, formatEditSummary } from './diff.js';
import {
  findStructuralNodes as findNodesTS,
  findNodeByName as findNodeByNameTS,
  validateTSSyntax,
  nodeToRange,
  getBodyRange,
} from './ts-adapter.js';
import { renameSymbol, extractFunction, inlineFunction, addParameter, changeSignature } from './transform.js';

// ─── High-Level Operations ──────────────────────────────────────────────────

/**
 * Try to find a structural node using the TS Compiler API.
 * Returns a StructuralNode if found, null otherwise.
 */
function tryFindNodeTS(
  code: string,
  filePath: string,
  name: string,
  type: 'function' | 'class' | 'interface' | 'enum' | 'type-alias' | 'variable' = 'function',
  language: SupportedLanguage,
): StructuralNode | null {
  if (language !== 'typescript' && language !== 'javascript') return null;
  if (!filePath) return null;

  const tsResult = findNodeByNameTS(code, filePath, name);
  if (!tsResult) return null;

  const { node, sourceFile } = tsResult;
  const range = nodeToRange(node, sourceFile);
  const bodyRange = getBodyRange(node, sourceFile);

  return {
    type,
    name,
    range,
    bodyRange,
    depth: 0,
    children: [],
    language,
  };
}

/**
 * Replace the body of a function/method while preserving its signature.
 * Uses TS Compiler API for TypeScript/JavaScript files, falls back to regex.
 */
export function replaceFunctionBody(
  code: string,
  functionName: string,
  newBody: string,
  language?: SupportedLanguage,
  filePath?: string,
): EditResult {
  const lang = language || detectLanguage(filePath || '');
  const resolvedPath = filePath || `file.${lang === 'typescript' ? 'ts' : lang === 'javascript' ? 'js' : 'ts'}`;

  // Try TS Compiler API first for TS/JS files
  const tsTarget = tryFindNodeTS(code, resolvedPath, functionName, 'function', lang);
  if (tsTarget) {
    if (!tsTarget.bodyRange) {
      // Abstract declaration — replace entire node
      return applyEdits(code, [{
        type: 'replace-node', filePath: '', targetNode: tsTarget, language: lang,
        newCode: newBody, description: `Replace function ${functionName}`, priority: 1,
      }]);
    }
    return applyEdits(code, [{
      type: 'replace-body', filePath: '', targetNode: tsTarget, language: lang,
      newCode: newBody, description: `Replace body of ${functionName}`, priority: 1,
    }]);
  }

  // Fallback to regex-based analysis
  const nodes = analyzeStructure(code, lang);
  const target = findNodeByNameRegex(nodes, functionName);

  if (!target) {
    return {
      success: false, conflicts: [], appliedCount: 0, totalEdits: 1,
      error: `Function "${functionName}" not found in the code`,
    };
  }

  if (!target.bodyRange) {
    return applyEdits(code, [{
      type: 'replace-node', filePath: '', targetNode: target, language: lang,
      newCode: newBody, description: `Replace function ${functionName}`, priority: 1,
    }]);
  }

  return applyEdits(code, [{
    type: 'replace-body', filePath: '', targetNode: target, language: lang,
    newCode: newBody, description: `Replace body of ${functionName}`, priority: 1,
  }]);
}

/**
 * Add a method to a class.
 * Uses TS Compiler API for TypeScript/JavaScript files, falls back to regex.
 */
export function addMethodToClass(
  code: string,
  className: string,
  methodCode: string,
  language?: SupportedLanguage,
  filePath?: string,
): EditResult {
  const lang = language || detectLanguage(filePath || '');
  const resolvedPath = filePath || `file.${lang === 'typescript' ? 'ts' : lang === 'javascript' ? 'js' : 'ts'}`;

  // Try TS Compiler API first
  const tsTarget = tryFindNodeTS(code, resolvedPath, className, 'class', lang);
  if (tsTarget) {
    if (!tsTarget.bodyRange) {
      return { success: false, conflicts: [], appliedCount: 0, totalEdits: 1, error: `Class "${className}" has no body` };
    }
    return applyEdits(code, [{
      type: 'insert-child', filePath: '', targetNode: tsTarget, language: lang,
      newCode: methodCode, description: `Add method to ${className}`, priority: 1,
    }]);
  }

  // Fallback to regex-based analysis
  const lang2 = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang2);
  const target = findNodeByNameRegex(nodes, className, 'class');

  if (!target) {
    return {
      success: false, conflicts: [], appliedCount: 0, totalEdits: 1,
      error: `Class "${className}" not found`,
    };
  }

  return applyEdits(code, [{
    type: 'insert-child', filePath: '', targetNode: target, language: lang2,
    newCode: methodCode, description: `Add method to ${className}`, priority: 1,
  }]);
}

/**
 * Add an import statement.
 * Automatically deduplicates existing imports.
 */
export function addImport(
  code: string,
  importStatement: string,
  language?: SupportedLanguage,
): EditResult {
  const lang = language || detectLanguage('');

  // Check if import already exists
  const normalized = importStatement.trim();
  if (code.includes(normalized)) {
    return {
      success: true, code, conflicts: [], appliedCount: 0, totalEdits: 1,
    };
  }

  return applyEdits(code, [{
    type: 'add-import', filePath: '', language: lang, newCode: normalized,
    description: `Add import: ${normalized.slice(0, 60)}`, priority: 2,
  }]);
}

/**
 * Insert code before a specific structural element.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 */
export function insertBefore(
  code: string,
  targetName: string,
  newCode: string,
  language?: SupportedLanguage,
  filePath?: string,
): EditResult {
  const lang = language || detectLanguage(filePath || '');
  const resolvedPath = filePath || `file.${lang === 'typescript' ? 'ts' : lang === 'javascript' ? 'js' : 'ts'}`;

  // Try TS Compiler API first
  const tsTarget = tryFindNodeTS(code, resolvedPath, targetName, 'function', lang);
  if (tsTarget) {
    return applyEdits(code, [{
      type: 'insert-before', filePath: '', targetNode: tsTarget, language: lang,
      newCode, description: `Insert before ${targetName}`, priority: 1,
    }]);
  }

  // Fallback to regex
  const lang2 = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang2);
  const target = findNodeByNameRegex(nodes, targetName);
  if (!target) {
    return { success: false, conflicts: [], appliedCount: 0, totalEdits: 1, error: `Target "${targetName}" not found` };
  }
  return applyEdits(code, [{
    type: 'insert-before', filePath: '', targetNode: target, language: lang2,
    newCode, description: `Insert before ${targetName}`, priority: 1,
  }]);
}

/**
 * Insert code after a specific structural element.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 */
export function insertAfter(
  code: string,
  targetName: string,
  newCode: string,
  language?: SupportedLanguage,
  filePath?: string,
): EditResult {
  const lang = language || detectLanguage(filePath || '');
  const resolvedPath = filePath || `file.${lang === 'typescript' ? 'ts' : lang === 'javascript' ? 'js' : 'ts'}`;

  // Try TS Compiler API first
  const tsTarget = tryFindNodeTS(code, resolvedPath, targetName, 'function', lang);
  if (tsTarget) {
    return applyEdits(code, [{
      type: 'insert-after', filePath: '', targetNode: tsTarget, language: lang,
      newCode, description: `Insert after ${targetName}`, priority: 1,
    }]);
  }

  // Fallback to regex
  const lang2 = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang2);
  const target = findNodeByNameRegex(nodes, targetName);
  if (!target) {
    return { success: false, conflicts: [], appliedCount: 0, totalEdits: 1, error: `Target "${targetName}" not found` };
  }
  return applyEdits(code, [{
    type: 'insert-after', filePath: '', targetNode: target, language: lang2,
    newCode, description: `Insert after ${targetName}`, priority: 1,
  }]);
}

/**
 * Delete a structural node from the code.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 */
export function deleteNode(
  code: string,
  targetName: string,
  language?: SupportedLanguage,
  filePath?: string,
): EditResult {
  const lang = language || detectLanguage(filePath || '');
  const resolvedPath = filePath || `file.${lang === 'typescript' ? 'ts' : lang === 'javascript' ? 'js' : 'ts'}`;

  // Try TS Compiler API first
  const tsTarget = tryFindNodeTS(code, resolvedPath, targetName, 'function', lang);
  if (tsTarget) {
    return applyEdits(code, [{
      type: 'delete-node', filePath: '', targetNode: tsTarget, language: lang,
      description: `Delete ${targetName}`, priority: 1,
    }]);
  }

  // Fallback to regex
  const lang2 = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang2);
  const target = findNodeByNameRegex(nodes, targetName);
  if (!target) {
    return { success: false, conflicts: [], appliedCount: 0, totalEdits: 1, error: `Target "${targetName}" not found` };
  }
  return applyEdits(code, [{
    type: 'delete-node', filePath: '', targetNode: target, language: lang2,
    description: `Delete ${targetName}`, priority: 1,
  }]);
}

// ─── Intelligent Edit ───────────────────────────────────────────────────────

/**
 * Perform an intelligent edit based on the edit type.
 * Automatically detects language and finds structural targets.
 * Uses TS Compiler API for TS/JS files, falls back to regex.
 *
 * This is the primary entry point for the WriterAgent integration.
 */
export function performEdit(
  code: string,
  edit: ASTEdit,
): EditResult {
  // Detect language if not provided
  const lang = edit.language === 'unknown'
    ? detectLanguage(edit.filePath)
    : edit.language;
  edit.language = lang;

  // If unknown language, use raw text replacement
  if (lang === 'unknown' && edit.type !== 'raw') {
    return applyEdits(code, [{
      ...edit,
      type: 'raw',
    }]);
  }

  // Find the target node if specified by name but not resolved
  if (edit.targetNode?.name && !edit.targetNode.range) {
    // Try TS Compiler API first for TS/JS files
    if ((lang === 'typescript' || lang === 'javascript') && edit.filePath) {
      const tsTarget = tryFindNodeTS(code, edit.filePath, edit.targetNode.name, 'function', lang);
      if (tsTarget) {
        edit.targetNode = tsTarget;
      }
    }

    // Fallback to regex
    if (!edit.targetNode.range) {
      const nodes = analyzeStructure(code, lang);
      const found = findNodeByNameRegex(nodes, edit.targetNode.name);
      if (found) {
        edit.targetNode = found;
      }
    }
  }

  return applyEdits(code, [edit]);
}

// ─── Structural Context Builder ─────────────────────────────────────────────

/**
 * Build a structural context description for the LLM.
 * Uses TS Compiler API for TypeScript/JavaScript files for richer, more precise
 * structural context. Falls back to regex-based analysis for other languages.
 */
export function buildStructuralContext(
  code: string,
  filePath: string,
): string {
  const lang = detectLanguage(filePath);
  if (lang === 'unknown') return '';

  let nodes: StructuralNode[];

  // Try TS Compiler API first for better precision
  if (lang === 'typescript' || lang === 'javascript') {
    try {
      const tsNodes = findNodesTS(code, filePath);
      nodes = tsNodes.length > 0 ? tsNodes : analyzeStructure(code, lang);
    } catch {
      nodes = analyzeStructure(code, lang);
    }
  } else {
    nodes = analyzeStructure(code, lang);
  }

  if (nodes.length === 0) return '';

  const lines: string[] = [];
  lines.push(`📐 Structural overview of ${filePath}:`);

  for (const node of nodes) {
    const range = `L${node.range.start.line}-L${node.range.end.line}`;
    lines.push(`  ${node.type}: "${node.name}" [${range}]`);

    if (node.children.length > 0) {
      for (const child of node.children) {
        const childRange = `L${child.range.start.line}-L${child.range.end.line}`;
        lines.push(`    ${child.type}: "${child.name}" [${childRange}]`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Validate syntax with TS Compiler API for TS/JS, regex fallback for others.
 */
export function validateCodeSyntax(code: string, filePath: string): boolean {
  const lang = detectLanguage(filePath);
  if (lang === 'typescript' || lang === 'javascript') {
    return validateTSSyntax(code, filePath);
  }
  return validateSyntax(code, lang);
}

// ─── Export for convenience ─────────────────────────────────────────────────

export {
  analyzeStructure,
  findNodeByNameRegex as findNodeByName,
  validateSyntax,
  formatEditSummary,
  renameSymbol,
  extractFunction,
  inlineFunction,
  addParameter,
  changeSignature,
};

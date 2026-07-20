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

import {
  type ASTEdit,
  type EditResult,
  type SupportedLanguage,
  type StructuralNode,
  detectLanguage,
} from './types.js';
import {
  analyzeStructure,
  findNodeByName,
  validateSyntax,
} from './ast.js';
import { applyEdits, formatEditSummary } from './diff.js';

// ─── High-Level Operations ──────────────────────────────────────────────────

/**
 * Replace the body of a function/method while preserving its signature.
 * Detects the function using structural analysis.
 */
export function replaceFunctionBody(
  code: string,
  functionName: string,
  newBody: string,
  language?: SupportedLanguage,
): EditResult {
  const lang = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang);
  const target = findNodeByName(nodes, functionName);

  if (!target) {
    return {
      success: false,
      conflicts: [],
      appliedCount: 0,
      totalEdits: 1,
      error: `Function "${functionName}" not found in the code`,
    };
  }

  if (!target?.bodyRange) {
    // Function has no body (abstract declaration, interface) — replace entire node
    return applyEdits(code, [{
      type: 'replace-node',
      filePath: '',
      targetNode: target,
      language: lang,
      newCode: newBody,
      description: `Replace function ${functionName}`,
      priority: 1,
    }]);
  }

  return applyEdits(code, [{
    type: 'replace-body',
    filePath: '',
    targetNode: target,
    language: lang,
    newCode: newBody,
    description: `Replace body of ${functionName}`,
    priority: 1,
  }]);
}

/**
 * Add a method to a class.
 */
export function addMethodToClass(
  code: string,
  className: string,
  methodCode: string,
  language?: SupportedLanguage,
): EditResult {
  const lang = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang);
  const target = findNodeByName(nodes, className, 'class');

  if (!target) {
    return {
      success: false,
      conflicts: [],
      appliedCount: 0,
      totalEdits: 1,
      error: `Class "${className}" not found`,
    };
  }

  return applyEdits(code, [{
    type: 'insert-child',
    filePath: '',
    targetNode: target,
    language: lang,
    newCode: methodCode,
    description: `Add method to ${className}`,
    priority: 1,
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
      success: true,
      code,
      conflicts: [],
      appliedCount: 0,
      totalEdits: 1,
    };
  }

  return applyEdits(code, [{
    type: 'add-import',
    filePath: '',
    language: lang,
    newCode: normalized,
    description: `Add import: ${normalized.slice(0, 60)}`,
    priority: 2,
  }]);
}

/**
 * Insert code before a specific structural element.
 */
export function insertBefore(
  code: string,
  targetName: string,
  newCode: string,
  language?: SupportedLanguage,
): EditResult {
  const lang = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang);
  const target = findNodeByName(nodes, targetName);

  if (!target) {
    return {
      success: false,
      conflicts: [],
      appliedCount: 0,
      totalEdits: 1,
      error: `Target "${targetName}" not found`,
    };
  }

  return applyEdits(code, [{
    type: 'insert-before',
    filePath: '',
    targetNode: target,
    language: lang,
    newCode,
    description: `Insert before ${targetName}`,
    priority: 1,
  }]);
}

/**
 * Insert code after a specific structural element.
 */
export function insertAfter(
  code: string,
  targetName: string,
  newCode: string,
  language?: SupportedLanguage,
): EditResult {
  const lang = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang);
  const target = findNodeByName(nodes, targetName);

  if (!target) {
    return {
      success: false,
      conflicts: [],
      appliedCount: 0,
      totalEdits: 1,
      error: `Target "${targetName}" not found`,
    };
  }

  return applyEdits(code, [{
    type: 'insert-after',
    filePath: '',
    targetNode: target,
    language: lang,
    newCode,
    description: `Insert after ${targetName}`,
    priority: 1,
  }]);
}

/**
 * Delete a structural node from the code.
 */
export function deleteNode(
  code: string,
  targetName: string,
  language?: SupportedLanguage,
): EditResult {
  const lang = language || detectLanguage('');
  const nodes = analyzeStructure(code, lang);
  const target = findNodeByName(nodes, targetName);

  if (!target) {
    return {
      success: false,
      conflicts: [],
      appliedCount: 0,
      totalEdits: 1,
      error: `Target "${targetName}" not found`,
    };
  }

  return applyEdits(code, [{
    type: 'delete-node',
    filePath: '',
    targetNode: target,
    language: lang,
    description: `Delete ${targetName}`,
    priority: 1,
  }]);
}

// ─── Intelligent Edit ───────────────────────────────────────────────────────

/**
 * Perform an intelligent edit based on the edit type.
 * Automatically detects language and finds structural targets.
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
    const nodes = analyzeStructure(code, lang);
    const found = findNodeByName(nodes, edit.targetNode.name);
    if (found) {
      edit.targetNode = found;
    }
  }

  return applyEdits(code, [edit]);
}

// ─── Structural Context Builder ─────────────────────────────────────────────

/**
 * Build a structural context description for the LLM.
 * This tells the LLM about the structure of the file so it can make more
 * precise edits.
 */
export function buildStructuralContext(
  code: string,
  filePath: string,
): string {
  const lang = detectLanguage(filePath);
  if (lang === 'unknown') return '';

  const nodes = analyzeStructure(code, lang);
  if (nodes.length === 0) return '';

  const lines: string[] = [];
  lines.push(`📐 Structural overview of ${filePath}:`);

  for (const node of nodes) {
    const range = `L${node.range.start.line}-L${node.range.end.line}`;
    lines.push(`  ${node.type}: "${node.name}" [${range}]`);

    if (node.children.length > 0) {
      for (const child of node.children) {
        const childRange = `L${child.range.start.line}-L${child.range.end.line}`;
        lines.push(`    method: "${child.name}" [${childRange}]`);
      }
    }
  }

  return lines.join('\n');
}

// ─── Export for convenience ─────────────────────────────────────────────────

export { analyzeStructure, findNodeByName, validateSyntax, formatEditSummary };

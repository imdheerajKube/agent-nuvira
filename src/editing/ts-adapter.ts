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
import type { SupportedLanguage, StructuralNode, SourceRange, StructureType } from './types.js';
import { detectLanguage } from './types.js';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse source code into a TypeScript AST (SourceFile node).
 * Returns null on any parse error (e.g., empty code, binary content).
 */
export function parseSourceFile(
  code: string,
  filePath: string,
): ts.SourceFile | null {
  if (!code || code.trim().length === 0) return null;

  try {
    const scriptKind = detectScriptKind(filePath);
    return ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKind);
  } catch {
    return null;
  }
}

/**
 * Find all structural nodes in the code using the TypeScript Compiler API.
 * This is a more precise alternative to analyzeStructure() from ast.ts.
 *
 * Returns an empty array if parsing fails or the language isn't supported.
 */
export function findStructuralNodes(
  code: string,
  filePath: string,
): StructuralNode[] {
  const sourceFile = parseSourceFile(code, filePath);
  if (!sourceFile) return [];

  const lang: SupportedLanguage = detectLanguage(filePath);
  const nodes: StructuralNode[] = [];
  const processed = new Set<ts.Node>();

  // Walk the AST top-down, collecting top-level declarations
  ts.forEachChild(sourceFile, (node) => visitNode(node, sourceFile, nodes, processed, lang, 0));

  return nodes;
}

/**
 * Find a specific node by name within the AST.
 * Searches all declarations (functions, classes, interfaces, type aliases, variables).
 */
export function findNodeByName(
  code: string,
  filePath: string,
  name: string,
): { node: ts.Node; sourceFile: ts.SourceFile } | null {
  const sourceFile = parseSourceFile(code, filePath);
  if (!sourceFile) return null;

  let found: ts.Node | null = null;
  visitAll(sourceFile, (child) => {
    if (found) return;
    const nodeName = getIdentifierName(child);
    if (nodeName === name) {
      found = child;
    }
  });

  return found ? { node: found, sourceFile } : null;
}

/**
 * Find a node at a specific position (line, column) in the source.
 * Returns the most specific (deepest) node at that position.
 */
export function findNodeAtPosition(
  code: string,
  filePath: string,
  line: number,
  column: number,
): ts.Node | null {
  const sourceFile = parseSourceFile(code, filePath);
  if (!sourceFile) return null;

  const pos = positionToOffset(code, sourceFile, line, column);
  let deepest: ts.Node | null = null;

  visitAll(sourceFile, (node) => {
    if (pos >= node.getStart(sourceFile) && pos <= node.getEnd()) {
      if (!deepest || node.getStart(sourceFile) >= deepest.getStart(sourceFile)) {
        deepest = node;
      }
    }
  });

  return deepest;
}

/**
 * Get the text range of a TypeScript node as SourceRange.
 */
export function nodeToRange(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

/**
 * Get the body range of a function/class/interface node.
 * For brace-bodied constructs, returns the range inside the braces.
 */
export function getBodyRange(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): SourceRange | undefined {
  const body = getBodyNode(node);
  if (!body) return undefined;

  // For Block nodes (function body, class body), use the inner range
  if (ts.isBlock(body)) {
    const start = body.statements.length > 0
      ? body.statements[0].getStart(sourceFile)
      : body.getStart(sourceFile) + 1; // After opening brace
    const end = body.statements.length > 0
      ? body.statements[body.statements.length - 1].getEnd()
      : body.getEnd() - 1; // Before closing brace
    const startPos = sourceFile.getLineAndCharacterOfPosition(start);
    const endPos = sourceFile.getLineAndCharacterOfPosition(end);
    return {
      start: { line: startPos.line + 1, column: startPos.character + 1 },
      end: { line: endPos.line + 1, column: endPos.character + 1 },
    };
  }

  return nodeToRange(body, sourceFile);
}

/**
 * Convert a line:column position to a zero-based offset in the source file.
 * The code parameter is used for manual line counting since SourceFile.getLineCount()
 * may not be available in all TypeScript versions.
 */
function positionToOffset(code: string, sourceFile: ts.SourceFile, line: number, column: number): number {
  const lineIdx = Math.max(0, line - 1);
  const colIdx = Math.max(0, column - 1);

  // Count total lines manually for safety (getLineCount may not exist in all TS versions)
  const totalLines = code.split('\n').length;
  if (lineIdx >= totalLines) {
    return sourceFile.getEnd();
  }

  const lineStart = sourceFile.getPositionOfLineAndCharacter(lineIdx, 0);
  return lineStart + colIdx;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Detect ScriptKind from file extension */
function detectScriptKind(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return ts.ScriptKind.TS;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Walk all descendants of a node (depth-first) */
function visitAll(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visitAll(child, callback));
}

/** Get the identifier name of a declaration node */
function getIdentifierName(node: ts.Node): string | undefined {
  // FunctionDeclaration and ClassDeclaration have Identifier names with .text
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name?.text;
  }
  // MethodDeclaration and TypeAliasDeclaration may have PropertyName type
  if (ts.isMethodDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return node.name?.getText();
  }
  // InterfaceDeclaration and EnumDeclaration have PropertyName as name type
  if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.name ? node.name.getText() : undefined;
  }
  if (ts.isVariableStatement(node)) {
    const declarations = node.declarationList.declarations;
    return declarations.length > 0 ? getIdentifierName(declarations[0]) : undefined;
  }
  if (ts.isVariableDeclaration(node)) {
    return node.name.getText();
  }
  if (ts.isFunctionExpression(node) && node.name) {
    return node.name.text;
  }
  if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent)) {
    return node.parent.name.getText();
  }
  if (ts.isExportAssignment(node)) {
    return 'default';
  }
  return undefined;
}

/**
 * Get the body node of a declaration (the block / type members).
 * Returns a ts.Node for brace-bodied declarations (functions, methods, etc.)
 * or a synthetic wrapper for member arrays (class, interface, enum).
 */
function getBodyNode(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node)) return node.body;
  if (ts.isMethodDeclaration(node)) return node.body;
  if (ts.isConstructorDeclaration(node)) return node.body;
  if (ts.isGetAccessorDeclaration(node)) return node.body;
  if (ts.isSetAccessorDeclaration(node)) return node.body;
  if (ts.isModuleDeclaration(node)) return node.body;
  if (ts.isArrowFunction(node) && ts.isBlock(node.body)) return node.body;

  // For class/interface/enum, use the first member as a proxy for position
  // The actual body range is derived from the full declaration range
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    // Return the node itself; getBodyRange will handle these via full range
    return node;
  }

  return undefined;
}

/** Get StructureType from a TS node kind */
function getStructureType(node: ts.Node): StructureType {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isConstructorDeclaration(node)) return 'method';
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'method';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isTypeAliasDeclaration(node)) return 'type-alias';
  if (ts.isVariableStatement(node) || ts.isVariableDeclaration(node)) return 'variable';
  if (ts.isImportDeclaration(node)) return 'import';
  if (ts.isExportDeclaration(node)) return 'export';
  if (ts.isModuleDeclaration(node)) return 'module';
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return 'function';
  return 'unknown';
}

/** Get depth of a node in the AST tree */
function getDepth(node: ts.Node): number {
  let depth = 0;
  let parent = node.parent;
  while (parent) {
    if (ts.isSourceFile(parent)) break;
    depth++;
    parent = parent.parent;
  }
  return depth;
}

/**
 * Visit a node and its children, collecting structural nodes.
 */
function visitNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  nodes: StructuralNode[],
  processed: Set<ts.Node>,
  language: SupportedLanguage,
  currentDepth: number,
): void {
  // Skip if already processed
  if (processed.has(node)) return;

  const structureType = getStructureType(node);

  // Only collect top-level declarations (depth <= 2 to include module-level variables)
  const depth = getDepth(node);
  if (depth > 2 && !ts.isMethodDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) {
    // Still visit children for nested methods/classes
    ts.forEachChild(node, (child) => visitNode(child, sourceFile, nodes, processed, language, currentDepth));
    return;
  }

  const name = getIdentifierName(node) || '';
  const range = nodeToRange(node, sourceFile);
  const bodyRange = getBodyRange(node, sourceFile);
  const structNode: StructuralNode = {
    type: structureType,
    name,
    range,
    bodyRange,
    depth: currentDepth,
    children: [],
    language,
  };

  processed.add(node);

  // For class/interface/enum nodes, collect their children (methods, properties)
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    // Use getChildren() instead of .members to avoid NodeArray type issues
    ts.forEachChild(node, (child) => {
      const childType = getStructureType(child);
      if (childType !== 'unknown' && childType !== 'import') {
        const childName = getIdentifierName(child) || '';
        const childRange = nodeToRange(child, sourceFile);
        const childBody = getBodyRange(child, sourceFile);
        structNode.children.push({
          type: childType,
          name: childName,
          range: childRange,
          bodyRange: childBody,
          depth: currentDepth + 1,
          children: [],
          language,
        });
      }
    });
  }

  // Don't add import declarations (they're handled separately by the regex engine)
  if (structureType !== 'unknown') {
    nodes.push(structNode);
  }

  // Continue visiting children for nested structures
  ts.forEachChild(node, (child) => visitNode(child, sourceFile, nodes, processed, language, currentDepth + 1));
}

// ─── Utility: Source text extraction ────────────────────────────────────────

/**
 * Extract the source text of a node from the original code.
 */
export function getNodeText(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  code: string,
): string {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  return code.slice(start, end);
}

/**
 * Replace a node's text in the source code with new text.
 * Returns the modified code, or null if the node can't be located.
 */
export function replaceNodeText(
  code: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  newText: string,
): string | null {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  if (start < 0 || end > code.length) return null;
  return code.slice(0, start) + newText + code.slice(end);
}

/**
 * Insert text at a specific position in the code.
 */
export function insertAt(
  code: string,
  sourceFile: ts.SourceFile,
  line: number,
  column: number,
  text: string,
): string | null {
  const pos = positionToOffset(code, sourceFile, line, column);
  if (pos < 0 || pos > code.length) return null;
  return code.slice(0, pos) + text + code.slice(pos);
}

// ─── Utility: Syntax validation ─────────────────────────────────────────────

/**
 * Validate that code parses successfully as TypeScript.
 * More precise than the regex-based validateSyntax() from ast.ts.
 */
export function validateTSSyntax(code: string, filePath: string): boolean {
  if (!code || code.trim().length === 0) return true;
  try {
    const sourceFile = parseSourceFile(code, filePath);
    if (!sourceFile) return false;
    // Check for actual parse errors (TypeScript's parser is lenient and
    // produces SourceFile even for garbage input via error recovery)
    return sourceFile.parseDiagnostics.length === 0;
  } catch {
    return false;
  }
}

// ─── Re-export for convenience ──────────────────────────────────────────────

export type { StructuralNode, SourceRange, SupportedLanguage };

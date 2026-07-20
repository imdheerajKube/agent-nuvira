/**
 * AST-aware Diff & Merge Engine.
 *
 * Applies structural edits to source code with conflict detection,
 * overlapping edit resolution, and syntax validation.
 */

import {
  type ASTEdit,
  type EditResult,
  type EditConflict,
  type SourceRange,
  positionToOffset,
  offsetToPosition,
} from './types.js';
import { validateSyntax } from './ast.js';

// ─── Core Edit Application ──────────────────────────────────────────────────

/**
 * Apply a single AST-aware edit to source code.
 * Returns the modified code, or null if the edit can't be applied.
 */
export function applyEdit(code: string, edit: ASTEdit): string | null {
  switch (edit.type) {
    case 'replace-node':
      return applyReplaceNode(code, edit);
    case 'replace-body':
      return applyReplaceBody(code, edit);
    case 'insert-before':
      return applyInsertBefore(code, edit);
    case 'insert-after':
      return applyInsertAfter(code, edit);
    case 'insert-child':
      return applyInsertChild(code, edit);
    case 'delete-node':
      return applyDeleteNode(code, edit);
    case 'add-import':
      return applyAddImport(code, edit);
    case 'raw':
      return applyRawReplace(code, edit);
    default:
      return null;
  }
}

/**
 * Apply multiple edits to source code with conflict detection.
 * Edits are applied in order, skipping conflicting ones.
 */
export function applyEdits(
  code: string,
  edits: ASTEdit[],
): EditResult {
  const conflicts: EditConflict[] = [];
  let modifiedCode = code;
  let appliedCount = 0;

  // First pass: detect conflicts
  for (let i = 0; i < edits.length; i++) {
    for (let j = i + 1; j < edits.length; j++) {
      const conflict = detectConflict(edits[i], edits[j]);
      if (conflict) {
        conflict.editIndex = i;
        conflict.conflictingEditIndex = j;
        conflicts.push(conflict);
      }
    }
  }

  // Second pass: apply non-conflicting edits
  const conflictedIndices = new Set<number>();
  for (const c of conflicts) {
    if (c.editIndex >= 0) conflictedIndices.add(c.editIndex);
    if (c.conflictingEditIndex >= 0) conflictedIndices.add(c.conflictingEditIndex);
  }

  // Sort by priority (higher priority first), then by position
  const sortedEdits = edits
    .map((edit, index) => ({ edit, index }))
    .filter(({ index }) => !conflictedIndices.has(index))
    .sort((a, b) => {
      // Priority-based sorting
      const priA = a.edit.priority || 0;
      const priB = b.edit.priority || 0;
      if (priA !== priB) return priB - priA;

      // Position-based sorting (later edits first to preserve offsets)
      const posA = a.edit.targetNode?.range.start.line || 0;
      const posB = b.edit.targetNode?.range.start.line || 0;
      return posB - posA;
    });

  for (const { edit } of sortedEdits) {
    const result = applyEdit(modifiedCode, edit);
    if (result !== null) {
      modifiedCode = result;
      appliedCount++;
    }
  }

  // Validate syntax after all edits
  if (appliedCount > 0 && edits.length > 0) {
    const lang = edits[0].language;
    if (lang !== 'unknown' && !validateSyntax(modifiedCode, lang)) {
      // Syntax is invalid — try to recover or report
      conflicts.push({
        editIndex: -1,
        conflictingEditIndex: -1,
        description: `Resulting code has unbalanced brackets for ${lang}`,
        resolution: 'manual',
      });
    }
  }

  return {
    success: conflicts.length === 0,
    code: modifiedCode,
    conflicts,
    appliedCount,
    totalEdits: edits.length,
  };
}

// ─── Conflict Detection ─────────────────────────────────────────────────────

/**
 * Detect if two edits conflict with each other.
 * Returns a conflict description, or null if no conflict.
 */
function detectConflict(a: ASTEdit, b: ASTEdit): EditConflict | null {
  const rangeA = getEditRange(a);
  const rangeB = getEditRange(b);

  if (!rangeA || !rangeB) return null;

  // Check if ranges overlap
  if (rangesOverlap(rangeA, rangeB)) {
    return {
      editIndex: -1, // Will be set by caller
      conflictingEditIndex: -1,
      description: `Edits overlap: "${a.description || a.type}" and "${b.description || b.type}" modify the same region`,
      resolution: 'auto' as const,
    };
  }

  // Check if edits target the same node name
  if (a.targetNode?.name && b.targetNode?.name && a.targetNode.name === b.targetNode.name) {
    return {
      editIndex: -1,
      conflictingEditIndex: -1,
      description: `Both edits target node "${a.targetNode.name}" — only one will be applied`,
      resolution: 'auto' as const,
    };
  }

  return null;
}

/**
 * Get the source range affected by an edit.
 */
function getEditRange(edit: ASTEdit): SourceRange | null {
  if (edit.targetNode?.range) return edit.targetNode.range;
  if (edit.textRange) return edit.textRange;
  return null;
}

/**
 * Check if two source ranges overlap.
 */
function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  // No overlap if one ends before the other starts
  if (a.end.line < b.start.line) return false;
  if (b.end.line < a.start.line) return false;

  // Same line — check columns
  if (a.start.line === b.end.line && a.start.column >= b.end.column) return false;
  if (b.start.line === a.end.line && b.start.column >= a.end.column) return false;

  return true;
}

// ─── Edit Operations ────────────────────────────────────────────────────────

/**
 * Replace an entire structural node with new code.
 */
function applyReplaceNode(code: string, edit: ASTEdit): string | null {
  if (!edit.targetNode) return applyRawReplace(code, edit);
  if (!edit.newCode) return null;

  const start = positionToOffset(code, edit.targetNode.range.start);
  const end = positionToOffset(code, edit.targetNode.range.end);

  return code.slice(0, start) + edit.newCode + code.slice(end);
}

/**
 * Replace only the body of a function/method/class.
 * Preserves the signature/opening and closing structure.
 */
function applyReplaceBody(code: string, edit: ASTEdit): string | null {
  if (!edit.targetNode?.bodyRange) return applyReplaceNode(code, edit);
  if (!edit.newCode) return null;

  const start = positionToOffset(code, edit.targetNode.bodyRange.start);
  const end = positionToOffset(code, edit.targetNode.bodyRange.end);

  return code.slice(0, start) + edit.newCode + code.slice(end);
}

/**
 * Insert code before a structural node.
 */
function applyInsertBefore(code: string, edit: ASTEdit): string | null {
  if (!edit.targetNode) return null;
  if (!edit.newCode) return null;

  const offset = positionToOffset(code, edit.targetNode.range.start);

  return code.slice(0, offset) + edit.newCode + '\n' + code.slice(offset);
}

/**
 * Insert code after a structural node.
 */
function applyInsertAfter(code: string, edit: ASTEdit): string | null {
  if (!edit.targetNode) return null;
  if (!edit.newCode) return null;

  const offset = positionToOffset(code, edit.targetNode.range.end);

  return code.slice(0, offset) + '\n' + edit.newCode + code.slice(offset);
}

/**
 * Insert code as a child of a parent node (e.g., add a method to a class).
 * Inserts before the closing brace of the parent's body.
 */
function applyInsertChild(code: string, edit: ASTEdit): string | null {
  if (!edit.targetNode?.bodyRange) return null;
  if (!edit.newCode) return null;

  const end = positionToOffset(code, edit.targetNode.bodyRange.end);
  const bodyEnd = edit.targetNode.bodyRange.end;
  const lines = code.slice(0, end).split('\n');
  const lastLine = lines[lines.length - 1];

  // Check if the body ends with a closing brace
  const trimmedEnd = lastLine.trim();
  if (trimmedEnd === '}') {
    // Insert before the closing brace
    const bracePos = code.lastIndexOf('}', end);
    if (bracePos === -1) return null;
    const indent = lastLine.match(/^(\s*)/)?.[1] || '';
    const insertion = '\n' + indent + edit.newCode + '\n' + indent.slice(0, -2);
    return code.slice(0, bracePos) + insertion + code.slice(bracePos);
  }

  // Insert at the end of the body
  return code.slice(0, end) + '\n' + edit.newCode + code.slice(end);
}

/**
 * Delete a structural node from the code.
 */
function applyDeleteNode(code: string, edit: ASTEdit): string | null {
  if (!edit.targetNode) return null;

  const start = positionToOffset(code, edit.targetNode.range.start);
  const end = positionToOffset(code, edit.targetNode.range.end);

  return code.slice(0, start) + code.slice(end);
}

/**
 * Add an import statement to the code.
 * Places it after existing imports, or at the top of the file.
 */
function applyAddImport(code: string, edit: ASTEdit): string | null {
  if (!edit.newCode) return null;

  // Find the insertion point: after the last import statement
  const lines = code.split('\n');
  let lastImportLine = -1;

  const importPatterns = [
    /^import\s+/,
    /^(?:const|let|var)\s+\w+\s*=\s*require\(/,
    /^use\s+/,
    /^from\s+/,
    /^#\s*(?:flake8|isort|pylint|noqa|ruff|type)\s*:/,
    /^"""[\s\S]*?"""/,  // Python docstring
    /^#!\/usr\//,       // Shebang
    /^['"]use strict['"]/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isImport = importPatterns.some((p) => p.test(line));
    if (isImport) lastImportLine = i;
  }

  const insertLine = lastImportLine + 1;
  lines.splice(insertLine, 0, edit.newCode);

  return lines.join('\n');
}

/**
 * Apply a raw text replacement (fallback for unsupported edits).
 */
function applyRawReplace(code: string, edit: ASTEdit): string | null {
  if (!edit.textRange) return null;
  if (!edit.newCode && edit.type !== 'delete-node') return null;

  const start = positionToOffset(code, edit.textRange.start);
  const end = positionToOffset(code, edit.textRange.end);

  return code.slice(0, start) + (edit.newCode || '') + code.slice(end);
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Format a diff summary showing what changed.
 */
export function formatEditSummary(
  filePath: string,
  edits: ASTEdit[],
): string {
  const lines: string[] = [];
  lines.push(`📄 ${filePath}`);

  for (const edit of edits) {
    const target = edit.targetNode?.name || 'text';
    const typeLabel = editTypeLabel(edit.type);
    lines.push(`  ${typeLabel} ${target}${edit.description ? ` — ${edit.description}` : ''}`);
  }

  return lines.join('\n');
}

function editTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    'replace-node': '🔄 Replace',
    'replace-body': '✏️  Replace body',
    'insert-before': '➕ Insert before',
    'insert-after': '➕ Insert after',
    'insert-child': '➕ Insert in',
    'delete-node': '🗑️  Delete',
    'add-import': '📥 Add import',
    'raw': '📝 Edit',
  };
  return labels[type] || '📝 Edit';
}

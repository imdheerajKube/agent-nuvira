/**
 * AST-aware Diff & Merge Engine.
 *
 * Applies structural edits to source code with conflict detection,
 * overlapping edit resolution, and syntax validation.
 */
import { type ASTEdit, type EditResult } from './types.js';
/**
 * Apply a single AST-aware edit to source code.
 * Returns the modified code, or null if the edit can't be applied.
 */
export declare function applyEdit(code: string, edit: ASTEdit): string | null;
/**
 * Apply multiple edits to source code with conflict detection.
 * Edits are applied in order, skipping conflicting ones.
 */
export declare function applyEdits(code: string, edits: ASTEdit[]): EditResult;
/**
 * Format a diff summary showing what changed.
 */
export declare function formatEditSummary(filePath: string, edits: ASTEdit[]): string;
//# sourceMappingURL=diff.d.ts.map
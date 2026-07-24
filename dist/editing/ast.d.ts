/**
 * AST (Structural Analysis) Engine — Multi-language code parser.
 *
 * Analyzes source code to find structural nodes (functions, classes, methods, etc.)
 * enabling precise, format-preserving edits. Uses language-aware regex patterns
 * rather than full parsers for maximum compatibility and zero native dependencies.
 *
 * Supported languages: JavaScript, TypeScript, Python, Go, Rust
 */
import { type SupportedLanguage, type StructuralNode, type StructureType } from './types.js';
/**
 * Analyze source code to find all structural nodes at the top level.
 * Recursively finds nested nodes for classes/enums/traits.
 *
 * NOTE: Uses regex-based heuristics rather than a full parser.
 * TODO: Replace with web-tree-sitter WASM for exact AST parsing when
 * the WASM grammar files can be bundled with the package.
 */
export declare function analyzeStructure(code: string, language?: SupportedLanguage): StructuralNode[];
/**
 * Find a specific structural node by name.
 * Searches top-level nodes and their children.
 */
export declare function findNodeByName(nodes: StructuralNode[], name: string, type?: StructureType): StructuralNode | null;
/**
 * Find a structural node at a specific source position.
 */
export declare function findNodeAtPosition(nodes: StructuralNode[], line: number, column: number): StructuralNode | null;
/**
 * Check if the code is syntactically valid at the structural level.
 * Verifies balanced braces, brackets, and parentheses.
 */
export declare function validateSyntax(code: string, language: SupportedLanguage): boolean;
/**
 * Get a formatted summary of all structural nodes in a file.
 */
export declare function formatStructureSummary(nodes: StructuralNode[]): string;
/** Get the display icon for a structure type */
export declare function getStructureIcon(type: StructureType): string;
//# sourceMappingURL=ast.d.ts.map
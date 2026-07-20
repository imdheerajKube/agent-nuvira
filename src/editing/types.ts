/**
 * Types for the AST-aware code editing engine.
 *
 * Provides structural awareness of source code (functions, classes, methods, etc.)
 * to enable precise, format-preserving edits across multiple languages.
 */

// ─── Language Detection ─────────────────────────────────────────────────────

/** Programming languages supported by the AST editing engine */
export type SupportedLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'go'
  | 'rust'
  | 'unknown';

/** Map file extensions to supported languages */
export const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

// ─── Position & Range Types ─────────────────────────────────────────────────

/** A single position in source code (1-based lines and columns) */
export interface SourcePosition {
  /** Line number (1-based) */
  line: number;
  /** Column number (1-based) */
  column: number;
}

/** A range between two positions in source code */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/** Converts a 0-based index position to SourcePosition by scanning the code */
export function offsetToPosition(code: string, offset: number): SourcePosition {
  if (offset <= 0) return { line: 1, column: 1 };
  const before = code.slice(0, offset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

/** Converts a SourcePosition back to a 0-based offset */
export function positionToOffset(code: string, pos: SourcePosition): number {
  const lines = code.split('\n');
  let offset = 0;
  for (let i = 0; i < pos.line - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  return offset + (pos.column - 1);
}

// ─── Structural Nodes ───────────────────────────────────────────────────────

/** Types of structural nodes the analyzer can detect */
export type StructureType =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'enum'
  | 'type-alias'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'module'
  | 'import'
  | 'export'
  | 'variable'
  | 'block'
  | 'unknown';

/** A structural node found in source code (function, class, method, etc.) */
export interface StructuralNode {
  type: StructureType;
  name: string;
  /** The full range of this node (including its body/children) */
  range: SourceRange;
  /** The range of just the body (e.g., function body, class body) — may be undefined for leaf nodes */
  bodyRange?: SourceRange;
  /** The range of the name/signature for display purposes */
  nameRange?: SourceRange;
  /** Depth in the AST (0 = top-level) */
  depth: number;
  /** Child nodes (e.g., methods in a class) */
  children: StructuralNode[];
  /** Language this node was parsed from */
  language: SupportedLanguage;
  /** Optional metadata */
  metadata?: Record<string, string>;
}

// ─── Edit Types ─────────────────────────────────────────────────────────────

/** Types of AST-aware edits */
export type EditType =
  | 'replace-node'    // Replace an entire structural node
  | 'replace-body'    // Replace only the body of a function/method
  | 'insert-before'   // Insert code before a specific node
  | 'insert-after'    // Insert code after a specific node
  | 'insert-child'    // Insert as a child (e.g., method → class)
  | 'delete-node'     // Delete a structural node
  | 'add-import'      // Add an import statement
  | 'raw'             // Raw text replacement (fallback)
  ;

/** A single AST-aware edit operation */
export interface ASTEdit {
  type: EditType;
  /** Target file path */
  filePath: string;
  /** Target structural node (for node-aware edits) */
  targetNode?: StructuralNode;
  /** Language of the target file */
  language: SupportedLanguage;
  /** The new code to insert (for replace/insert operations) */
  newCode?: string;
  /** The text range to replace (for raw/text edits) */
  textRange?: SourceRange;
  /** Optional comment/description for the edit */
  description?: string;
  /** Priority for conflict resolution (higher = wins) */
  priority?: number;
}

/** Result of applying one or more edits */
export interface EditResult {
  success: boolean;
  /** The modified source code (if successful) */
  code?: string;
  /** Any conflicts detected */
  conflicts: EditConflict[];
  /** Number of edits applied */
  appliedCount: number;
  /** Total edits attempted */
  totalEdits: number;
  /** Error message if failed */
  error?: string;
}

/** A conflict between two overlapping edits */
export interface EditConflict {
  editIndex: number;
  conflictingEditIndex: number;
  description: string;
  /** How the conflict was resolved ('auto' = automatic merge, 'manual' = needs user input) */
  resolution?: 'auto' | 'manual';
}

/** Configuration per language for the structural analyzer */
export interface LanguageConfig {
  name: SupportedLanguage;
  /** Line comment syntax */
  lineComment: string;
  /** Block comment pairs */
  blockComment: [string, string];
  /** Common file extensions */
  extensions: string[];
  /** Keywords that start a function definition */
  functionKeywords: string[];
  /** Keywords that indicate a type definition */
  typeKeywords: string[];
  /** Keywords that indicate a class/struct definition */
  classKeywords: string[];
  /** Import/require keywords */
  importKeywords: string[];
  /** Export keywords */
  exportKeywords: string[];
  /** Characters that act as statement terminators */
  statementTerminators: string[];
  /** Indentation unit */
  indent: string;
}

/** Language configurations for all supported languages */
export const LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
  javascript: {
    name: 'javascript',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    functionKeywords: ['function', 'async function', 'function*'],
    typeKeywords: ['interface', 'type'],
    classKeywords: ['class'],
    importKeywords: ['import', 'require'],
    exportKeywords: ['export'],
    statementTerminators: [';'],
    indent: '  ',
  },
  typescript: {
    name: 'typescript',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    functionKeywords: ['function', 'async function', 'function*'],
    typeKeywords: ['interface', 'type'],
    classKeywords: ['class'],
    importKeywords: ['import', 'require'],
    exportKeywords: ['export'],
    statementTerminators: [';'],
    indent: '  ',
  },
  python: {
    name: 'python',
    lineComment: '#',
    blockComment: ['"""', '"""'],
    extensions: ['.py', '.pyw'],
    functionKeywords: ['def', 'async def'],
    typeKeywords: ['type'],
    classKeywords: ['class'],
    importKeywords: ['import', 'from'],
    exportKeywords: ['__all__'],
    statementTerminators: [''],
    indent: '    ',
  },
  go: {
    name: 'go',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    extensions: ['.go'],
    functionKeywords: ['func'],
    typeKeywords: ['type'],
    classKeywords: ['struct', 'interface'],
    importKeywords: ['import'],
    exportKeywords: [],
    statementTerminators: [],
    indent: '\t',
  },
  rust: {
    name: 'rust',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    extensions: ['.rs'],
    functionKeywords: ['fn'],
    typeKeywords: ['type'],
    classKeywords: ['struct', 'enum', 'trait'],
    importKeywords: ['use'],
    exportKeywords: ['pub'],
    statementTerminators: [';'],
    indent: '    ',
  },
  unknown: {
    name: 'unknown',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    extensions: [],
    functionKeywords: [],
    typeKeywords: [],
    classKeywords: [],
    importKeywords: [],
    exportKeywords: [],
    statementTerminators: [';'],
    indent: '  ',
  },
};

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Detect the programming language from a file path.
 */
export function detectLanguage(filePath: string): SupportedLanguage {
  const lower = filePath.toLowerCase();
  for (const [ext, lang] of Object.entries(EXTENSION_TO_LANGUAGE)) {
    if (lower.endsWith(ext)) return lang;
  }
  return 'unknown';
}

/**
 * Get the language config for a supported language.
 */
export function getLanguageConfig(language: SupportedLanguage): LanguageConfig {
  return LANGUAGE_CONFIGS[language];
}

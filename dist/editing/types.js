/**
 * Types for the AST-aware code editing engine.
 *
 * Provides structural awareness of source code (functions, classes, methods, etc.)
 * to enable precise, format-preserving edits across multiple languages.
 */
/** Map file extensions to supported languages */
export const EXTENSION_TO_LANGUAGE = {
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
/** Converts a 0-based index position to SourcePosition by scanning the code */
export function offsetToPosition(code, offset) {
    if (offset <= 0)
        return { line: 1, column: 1 };
    const before = code.slice(0, offset);
    const lines = before.split('\n');
    return {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
    };
}
/** Converts a SourcePosition back to a 0-based offset */
export function positionToOffset(code, pos) {
    const lines = code.split('\n');
    let offset = 0;
    for (let i = 0; i < pos.line - 1 && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
    }
    return offset + (pos.column - 1);
}
/** Language configurations for all supported languages */
export const LANGUAGE_CONFIGS = {
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
export function detectLanguage(filePath) {
    const lower = filePath.toLowerCase();
    for (const [ext, lang] of Object.entries(EXTENSION_TO_LANGUAGE)) {
        if (lower.endsWith(ext))
            return lang;
    }
    return 'unknown';
}
/**
 * Get the language config for a supported language.
 */
export function getLanguageConfig(language) {
    return LANGUAGE_CONFIGS[language];
}
//# sourceMappingURL=types.js.map
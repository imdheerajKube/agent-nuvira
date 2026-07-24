/**
 * AST (Structural Analysis) Engine — Multi-language code parser.
 *
 * Analyzes source code to find structural nodes (functions, classes, methods, etc.)
 * enabling precise, format-preserving edits. Uses language-aware regex patterns
 * rather than full parsers for maximum compatibility and zero native dependencies.
 *
 * Supported languages: JavaScript, TypeScript, Python, Go, Rust
 */
import { offsetToPosition, positionToOffset, } from './types.js';
const LANGUAGE_PATTERNS = {
    javascript: {
        blockStyle: 'brace',
        functionPatterns: [
            /(?:async\s+)?function\s*(\*?\s*)(\w+)\s*\(/g,
            /(\w+)\s*:\s*(?:async\s+)?function\s*\(/g,
            /(\w+)\s*=\s*(?:async\s+)?function\s*\(/g,
            /(\w+)\s*=\s*\([^)]*\)\s*=>\s*{/g,
            /(\w+)\s*=\s*async\s*\([^)]*\)\s*=>\s*{/g,
            /(?:static\s+)?async\s+(\w+)\s*\(/g,
            /(?:static\s+)?(\w+)\s*\(/g,
        ],
        classPatterns: [
            /class\s+(\w+)/g,
        ],
        interfacePatterns: [],
        importPatterns: [
            /import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+)\s+from\s+['"][^'"]+['"]/g,
            /import\s+['"][^'"]+['"]/g,
            /(?:const|let|var)\s+\w+\s*=\s*require\s*\(['"][^'"]+['"]\)/g,
        ],
        typePatterns: [],
        specialPatterns: [
            /export\s+default\s+(?:function|class)\s+(\w*)/g,
            /module\.exports\s*=\s*/g,
        ],
    },
    typescript: {
        blockStyle: 'brace',
        functionPatterns: [
            /(?:async\s+)?function\s*(\*?\s*)(\w+)\s*\(/g,
            /(\w+)\s*:\s*(?:async\s+)?function\s*\(/g,
            /(\w+)\s*=\s*(?:async\s+)?function\s*\(/g,
            /(\w+)\s*=\s*\([^)]*\)\s*=>\s*{/g,
            /(\w+)\s*=\s*async\s*\([^)]*\)\s*=>\s*{/g,
            /(?:public|private|protected|static|abstract|async|override)\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*:/g,
            /(?:public|private|protected|static|abstract|async|override\s+)*(?:async\s+)?(\w+)\s*\(/g,
        ],
        classPatterns: [
            /(?:abstract\s+)?class\s+(\w+)/g,
        ],
        interfacePatterns: [
            /interface\s+(\w+)/g,
        ],
        importPatterns: [
            /import\s+(?:type\s+)?(?:{[^}]*}|\*\s+as\s+\w+|\w+(?:,\s*type\s*{[^}]*})?)\s+from\s+['"][^'"]+['"]/g,
            /import\s+['"][^'"]+['"]/g,
            /(?:const|let|var)\s+\w+\s*=\s*require\s*\(['"][^'"]+['"]\)/g,
        ],
        typePatterns: [
            /type\s+(\w+)\s*=/g,
        ],
        specialPatterns: [
            /export\s+default\s+(?:function|class|abstract\s+class)\s+(\w*)/g,
            /module\.exports\s*=\s*/g,
        ],
    },
    python: {
        blockStyle: 'indent',
        functionPatterns: [
            /^(?:async\s+)?def\s+(\w+)\s*\(/gm,
        ],
        classPatterns: [
            /^class\s+(\w+)/gm,
        ],
        interfacePatterns: [],
        importPatterns: [
            /^import\s+[\w.]+(?:\s+as\s+\w+)?/gm,
            /^from\s+[\w.]+\s+import\s+.*/gm,
        ],
        typePatterns: [],
    },
    go: {
        blockStyle: 'brace',
        functionPatterns: [
            /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/gm,
            /^func\s+\(?\s*\w+\s+\*?\w+\s*\)?\s+(\w+)\s*\(/g,
        ],
        classPatterns: [
            /^type\s+(\w+)\s+struct\s*{/gm,
        ],
        interfacePatterns: [
            /^type\s+(\w+)\s+interface\s*{/gm,
        ],
        importPatterns: [
            /^import\s+\(/gm,
            /^import\s+['"][^'"]+['"]/gm,
        ],
        typePatterns: [
            /^type\s+(\w+)\s+/gm,
        ],
    },
    rust: {
        blockStyle: 'brace',
        functionPatterns: [
            /^(?:\s*pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*\(/gm,
        ],
        classPatterns: [
            /^(?:\s*pub\s+)?struct\s+(\w+)/gm,
            /^(?:\s*pub\s+)?enum\s+(\w+)/gm,
        ],
        interfacePatterns: [
            /^(?:\s*pub\s+)?trait\s+(\w+)/gm,
        ],
        importPatterns: [
            /^use\s+[\w:]+(?:\s*\{[^}]*\})?(?:\s+as\s+\w+)?/gm,
        ],
        typePatterns: [
            /^(?:\s*pub\s+)?type\s+(\w+)\s*=/gm,
        ],
    },
};
// ─── Brace & Indent Helpers ─────────────────────────────────────────────────
/**
 * Find the matching closing brace for an opening brace at the given offset.
 * Handles nested braces and braces inside string literals.
 */
function findMatchingBrace(code, openOffset) {
    let depth = 1;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let i = openOffset + 1;
    while (i < code.length && depth > 0) {
        const ch = code[i];
        const prev = i > 0 ? code[i - 1] : '';
        // Track string literals to avoid matching braces inside strings
        if (ch === "'" && prev !== '\\' && !inDouble && !inTemplate)
            inSingle = !inSingle;
        else if (ch === '"' && prev !== '\\' && !inSingle && !inTemplate)
            inDouble = !inDouble;
        else if (ch === '`' && prev !== '\\' && !inSingle && !inDouble)
            inTemplate = !inTemplate;
        if (!inSingle && !inDouble && !inTemplate) {
            if (ch === '{')
                depth++;
            else if (ch === '}')
                depth--;
        }
        if (depth > 0)
            i++;
    }
    return depth === 0 ? i : -1; // Return -1 if unmatched
}
/**
 * Find the end of a Python-style indented block.
 * Returns the offset of the last line in the block.
 */
function findIndentBlockEnd(code, startLine) {
    const lines = code.split('\n');
    if (startLine >= lines.length)
        return code.length;
    const baseIndent = lines[startLine].match(/^(\s*)/)?.[1].length || 0;
    let endLine = startLine + 1;
    // Handle the case where the definition line (def/class) may have a colon
    // The body starts on the next line with indentation
    while (endLine < lines.length) {
        const line = lines[endLine];
        const trimmed = line.trim();
        // Skip empty lines within the block
        if (trimmed === '') {
            endLine++;
            continue;
        }
        const indent = line.match(/^(\s*)/)?.[1].length || 0;
        // If indentation is <= base indent, we've left the block
        if (indent <= baseIndent)
            break;
        endLine++;
    }
    // Return offset of end of block (start of line after last line of block)
    let offset = 0;
    for (let i = 0; i < endLine && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
    }
    return Math.min(offset, code.length);
}
// ─── Structural Analysis ────────────────────────────────────────────────────
/**
 * Analyze source code to find all structural nodes at the top level.
 * Recursively finds nested nodes for classes/enums/traits.
 *
 * NOTE: Uses regex-based heuristics rather than a full parser.
 * TODO: Replace with web-tree-sitter WASM for exact AST parsing when
 * the WASM grammar files can be bundled with the package.
 */
export function analyzeStructure(code, language = 'unknown') {
    if (!code || language === 'unknown')
        return [];
    const nodes = [];
    const patterns = LANGUAGE_PATTERNS[language];
    if (!patterns)
        return [];
    const lines = code.split('\n');
    const processed = new Set();
    // ── Find imports ──────────────────────────────────────────────────────
    for (const pattern of patterns.importPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(code)) !== null) {
            const startOffset = match.index;
            const startPos = offsetToPosition(code, startOffset);
            const endOffset = startOffset + match[0].length;
            const endPos = offsetToPosition(code, endOffset);
            nodes.push({
                type: 'import',
                name: match[0].slice(0, 60).replace(/\n/g, ' '),
                range: { start: startPos, end: endPos },
                depth: 0,
                children: [],
                language,
            });
        }
    }
    // ── Find functions/methods ────────────────────────────────────────────
    for (const pattern of patterns.functionPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(code)) !== null) {
            if (processed.has(match.index))
                continue;
            processed.add(match.index);
            // Find the opening paren for this function
            const name = match[match.length - 1] || '(anonymous)';
            const startOffset = match.index;
            const startPos = offsetToPosition(code, startOffset);
            // Find the opening brace or colon (for Python)
            let bodyStart = startOffset + match[0].length;
            let endOffset;
            if (patterns.blockStyle === 'brace') {
                // Find the opening brace after the signature
                let bracePos = code.indexOf('{', bodyStart);
                // Handle functions with no body (abstract, interface declarations)
                if (bracePos === -1) {
                    // Try finding semicolon (forward declaration)
                    const semiPos = code.indexOf(';', bodyStart);
                    endOffset = semiPos !== -1 ? semiPos + 1 : startOffset + match[0].length;
                    const endPos = offsetToPosition(code, endOffset);
                    nodes.push({
                        type: 'function',
                        name,
                        range: { start: startPos, end: endPos },
                        depth: 0,
                        children: [],
                        language,
                    });
                    continue;
                }
                const closingBrace = findMatchingBrace(code, bracePos);
                endOffset = closingBrace !== -1 ? closingBrace + 1 : code.length;
                const bodyRange = {
                    start: offsetToPosition(code, bracePos),
                    end: offsetToPosition(code, endOffset),
                };
                const endPos = offsetToPosition(code, endOffset);
                nodes.push({
                    type: name[0] === name[0]?.toUpperCase() && name !== '(anonymous)' ? 'class' : 'function',
                    name,
                    range: { start: startPos, end: endPos },
                    bodyRange,
                    depth: 0,
                    children: [],
                    language,
                });
            }
            else {
                // Python-style indentation block
                // Find the colon that ends the def/class line
                const colonPos = code.indexOf(':', startOffset);
                if (colonPos === -1)
                    continue;
                const defLineNum = startPos.line - 1; // 0-based
                endOffset = findIndentBlockEnd(code, defLineNum);
                const endPos = offsetToPosition(code, endOffset);
                nodes.push({
                    type: 'function',
                    name,
                    range: { start: startPos, end: endPos },
                    bodyRange: {
                        start: { line: startPos.line + 1, column: 1 },
                        end: endPos,
                    },
                    depth: 0,
                    children: [],
                    language,
                });
            }
        }
    }
    // ── Find classes/structs ──────────────────────────────────────────────
    for (const pattern of patterns.classPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(code)) !== null) {
            if (processed.has(match.index))
                continue;
            processed.add(match.index);
            const name = match[1];
            const startOffset = match.index;
            const startPos = offsetToPosition(code, startOffset);
            let endOffset;
            let bodyRange;
            if (patterns.blockStyle === 'brace') {
                // Find opening brace (might be on the same line or next line)
                const bracePos = code.indexOf('{', startOffset + match[0].length);
                if (bracePos === -1)
                    continue;
                const closingBrace = findMatchingBrace(code, bracePos);
                endOffset = closingBrace !== -1 ? closingBrace + 1 : code.length;
                bodyRange = {
                    start: offsetToPosition(code, bracePos + 1),
                    end: offsetToPosition(code, endOffset - 1),
                };
            }
            else {
                // Python-style
                const classLineNum = startPos.line - 1;
                endOffset = findIndentBlockEnd(code, classLineNum);
                bodyRange = {
                    start: { line: startPos.line + 1, column: 1 },
                    end: offsetToPosition(code, endOffset),
                };
            }
            const endPos = offsetToPosition(code, endOffset);
            const structureType = language === 'go'
                ? (match[0].includes('struct') ? 'struct' : 'interface')
                : 'class';
            nodes.push({
                type: structureType,
                name,
                range: { start: startPos, end: endPos },
                bodyRange,
                depth: 0,
                children: [],
                language,
            });
        }
    }
    // ── Find interfaces/traits ────────────────────────────────────────────
    if (patterns.interfacePatterns.length > 0) {
        for (const pattern of patterns.interfacePatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(code)) !== null) {
                if (processed.has(match.index))
                    continue;
                processed.add(match.index);
                const name = match[1];
                const startOffset = match.index;
                const startPos = offsetToPosition(code, startOffset);
                let endOffset;
                if (patterns.blockStyle === 'brace') {
                    const bracePos = code.indexOf('{', startOffset + match[0].length);
                    if (bracePos === -1)
                        continue;
                    const closingBrace = findMatchingBrace(code, bracePos);
                    endOffset = closingBrace !== -1 ? closingBrace + 1 : code.length;
                }
                else {
                    continue; // Python interfaces (ABC) aren't structural
                }
                const endPos = offsetToPosition(code, endOffset);
                const structureType = language === 'rust' ? 'trait' : 'interface';
                nodes.push({
                    type: structureType,
                    name,
                    range: { start: startPos, end: endPos },
                    bodyRange: {
                        start: offsetToPosition(code, code.indexOf('{', startOffset + match[0].length) + 1),
                        end: offsetToPosition(code, endOffset - 1),
                    },
                    depth: 0,
                    children: [],
                    language,
                });
            }
        }
    }
    // ── Find type aliases ─────────────────────────────────────────────────
    if (patterns.typePatterns.length > 0) {
        for (const pattern of patterns.typePatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(code)) !== null) {
                if (processed.has(match.index))
                    continue;
                processed.add(match.index);
                const name = match[1];
                const startOffset = match.index;
                const startPos = offsetToPosition(code, startOffset);
                // Type aliases end at semicolon or newline
                const after = code.slice(startOffset + match[0].length);
                let typeEnd;
                const semiPos = after.indexOf(';');
                const newlinePos = after.indexOf('\n');
                if (semiPos !== -1 && (newlinePos === -1 || semiPos < newlinePos)) {
                    typeEnd = startOffset + match[0].length + semiPos + 1;
                }
                else {
                    typeEnd = newlinePos !== -1
                        ? startOffset + match[0].length + newlinePos
                        : code.length;
                }
                const endPos = offsetToPosition(code, typeEnd);
                nodes.push({
                    type: 'type-alias',
                    name,
                    range: { start: startPos, end: endPos },
                    depth: 0,
                    children: [],
                    language,
                });
            }
        }
    }
    // Sort by position and remove nested nodes from top level
    const sorted = nodes.sort((a, b) => {
        const lineDiff = a.range.start.line - b.range.start.line;
        if (lineDiff !== 0)
            return lineDiff;
        return a.range.start.column - b.range.start.column;
    });
    // Filter out nodes that are nested inside other nodes (e.g., methods inside classes)
    const topLevel = [];
    for (const node of sorted) {
        const isNested = sorted.some((other) => other !== node &&
            other.bodyRange &&
            node.range.start.line >= other.bodyRange.start.line &&
            node.range.end.line <= other.bodyRange.end.line &&
            other.depth === 0);
        if (!isNested) {
            topLevel.push(node);
        }
    }
    // Find nested nodes (methods inside classes)
    for (const parent of topLevel) {
        if (!parent.bodyRange || (parent.type !== 'class' && parent.type !== 'struct' && parent.type !== 'interface' && parent.type !== 'trait'))
            continue;
        const bodyStart = positionToOffset(code, parent.bodyRange.start);
        const bodyEnd = positionToOffset(code, parent.bodyRange.end);
        const bodyCode = code.slice(bodyStart, bodyEnd);
        // Re-analyze within the class body
        const nested = findFunctionsInBlock(bodyCode, language);
        for (const n of nested) {
            n.depth = 1;
            // Offset positions back to global coordinates
            const lineOffset = parent.bodyRange.start.line - 1;
            n.range.start.line += lineOffset;
            n.range.end.line += lineOffset;
            if (n.bodyRange) {
                n.bodyRange.start.line += lineOffset;
                n.bodyRange.end.line += lineOffset;
            }
            parent.children.push(n);
        }
    }
    return topLevel;
}
/**
 * Find function/method definitions within a block of code.
 * Used for finding methods inside class bodies.
 */
function findFunctionsInBlock(code, language) {
    const nodes = [];
    const patterns = LANGUAGE_PATTERNS[language];
    if (!patterns)
        return nodes;
    // Use a simpler set of patterns for class body scanning
    // Match method definitions like: methodName(args) { ... }
    const methodPattern = /(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*{/g;
    const shortMethodPattern = /^\s*(\w+)\s*\(/gm;
    const processed = new Set();
    // Try long methods first (with body)
    let match;
    while ((match = methodPattern.exec(code)) !== null) {
        if (processed.has(match.index))
            continue;
        processed.add(match.index);
        const name = match[1];
        // Skip constructors, lifecycle methods, keywords
        if (['if', 'while', 'for', 'switch', 'catch', 'else', 'then'].includes(name))
            continue;
        const startOffset = match.index;
        const bracePos = code.indexOf('{', startOffset + match[0].length);
        if (bracePos === -1)
            continue;
        const closingBrace = findMatchingBrace(code, bracePos);
        if (closingBrace === -1)
            continue;
        nodes.push({
            type: 'method',
            name,
            range: {
                start: offsetToPosition(code, startOffset),
                end: offsetToPosition(code, closingBrace + 1),
            },
            bodyRange: {
                start: offsetToPosition(code, bracePos + 1),
                end: offsetToPosition(code, closingBrace),
            },
            depth: 1,
            children: [],
            language,
        });
    }
    // Try short methods (no body - interface/abstract declarations)
    // These are already handled by the main scan, so this is for completeness
    return nodes;
}
/**
 * Find a specific structural node by name.
 * Searches top-level nodes and their children.
 */
export function findNodeByName(nodes, name, type) {
    for (const node of nodes) {
        if (node.name === name && (!type || node.type === type))
            return node;
        if (node.children.length > 0) {
            const child = findNodeByName(node.children, name, type);
            if (child)
                return child;
        }
    }
    return null;
}
/**
 * Find a structural node at a specific source position.
 */
export function findNodeAtPosition(nodes, line, column) {
    for (const node of nodes) {
        if (line >= node.range.start.line &&
            line <= node.range.end.line) {
            // Check children first (more specific match)
            if (node.children.length > 0) {
                const child = findNodeAtPosition(node.children, line, column);
                if (child)
                    return child;
            }
            return node;
        }
    }
    return null;
}
/**
 * Check if the code is syntactically valid at the structural level.
 * Verifies balanced braces, brackets, and parentheses.
 */
export function validateSyntax(code, language) {
    if (language === 'python') {
        // Python doesn't have braces, so just check parentheses
        return checkBalanced(code, '(', ')') &&
            checkBalanced(code, '[', ']');
    }
    return checkBalanced(code, '{', '}') &&
        checkBalanced(code, '(', ')') &&
        checkBalanced(code, '[', ']');
}
/**
 * Check if brackets are balanced in source code.
 * Tracks string literals and comments to avoid false positives.
 */
function checkBalanced(code, open, close) {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        const next = i < code.length - 1 ? code[i + 1] : '';
        // Track comments
        if (!inSingle && !inDouble && !inTemplate && !inBlockComment) {
            if (ch === '/' && next === '/' && !inLineComment) {
                inLineComment = true;
                continue;
            }
            if (ch === '/' && next === '*' && !inBlockComment) {
                inBlockComment = true;
                continue;
            }
        }
        if (ch === '\n') {
            inLineComment = false;
        }
        if (ch === '*' && next === '/') {
            inBlockComment = false;
            i++;
            continue;
        }
        if (inLineComment || inBlockComment)
            continue;
        // Track string literals
        if (ch === "'" && !inDouble && !inTemplate) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle && !inTemplate) {
            inDouble = !inDouble;
            continue;
        }
        if (ch === '`' && !inSingle && !inDouble) {
            inTemplate = !inTemplate;
            continue;
        }
        if (inSingle || inDouble || inTemplate)
            continue;
        if (ch === open)
            depth++;
        if (ch === close)
            depth--;
        if (depth < 0)
            return false;
    }
    return depth === 0;
}
/**
 * Get a formatted summary of all structural nodes in a file.
 */
export function formatStructureSummary(nodes) {
    if (nodes.length === 0)
        return '(No structural elements found)';
    const lines = [];
    for (const node of nodes) {
        const range = `${node.range.start.line}:${node.range.start.column}-${node.range.end.line}:${node.range.end.column}`;
        lines.push(`  ${getStructureIcon(node.type)} ${node.type} "${node.name}" [${range}]`);
        if (node.children.length > 0) {
            for (const child of node.children) {
                const childRange = `${child.range.start.line}:${child.range.start.column}-${child.range.end.line}:${child.range.end.column}`;
                lines.push(`    ${getStructureIcon(child.type)} ${child.type} "${child.name}" [${childRange}]`);
            }
        }
    }
    return lines.join('\n');
}
// ─── StructuralNode helper methods ─────────────────────────────────────────
/** Icons for each structure type */
const STRUCTURE_ICONS = {
    function: 'ƒ',
    method: '⊞',
    class: '📦',
    interface: '📐',
    enum: '📋',
    'type-alias': '🅃',
    struct: '🏗️',
    trait: '🔧',
    impl: '⚙️',
    module: '📁',
    import: '📥',
    export: '📤',
    variable: '📌',
    block: '🔲',
    unknown: '❓',
};
/** Get the display icon for a structure type */
export function getStructureIcon(type) {
    return STRUCTURE_ICONS[type] || '•';
}
//# sourceMappingURL=ast.js.map
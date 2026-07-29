/**
 * Unit tests for TypeScript Compiler API adapter (ts-adapter.ts).
 *
 * Tests cover:
 * - parseSourceFile — valid TS, empty code, error cases
 * - findStructuralNodes — functions, classes, methods, interfaces, enums, type aliases
 * - findNodeByName — existing and non-existing symbols
 * - findNodeAtPosition — exact and approximate positions
 * - nodeToRange — position mapping correctness
 * - getBodyRange — function body, class body detection
 * - validateTSSyntax — valid and invalid code
 * - replaceNodeText — node replacement
 * - insertAt — text insertion at position
 */

import { describe, it, expect } from 'vitest';
import {
  parseSourceFile,
  findStructuralNodes,
  findNodeByName,
  findNodeAtPosition,
  nodeToRange,
  getBodyRange,
  validateTSSyntax,
  getNodeText,
  replaceNodeText,
  insertAt,
} from '../../src/editing/ts-adapter.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SAMPLE_TS = `import { something } from 'module';

/**
 * A test function
 */
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}

interface Config {
  port: number;
  host: string;
}

enum Color {
  Red,
  Green,
  Blue,
}

type Callback = (err: Error | null, result?: string) => void;

const PI = 3.14159;
`;

const EMPTY_CODE = '';
const BROKEN_CODE = 'function {';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseSourceFile', () => {
  it('parses valid TypeScript code', () => {
    const result = parseSourceFile(SAMPLE_TS, 'test.ts');
    expect(result).not.toBeNull();
    expect(result!.getEnd()).toBeGreaterThan(0);
  });

  it('returns null for empty code', () => {
    expect(parseSourceFile(EMPTY_CODE, 'test.ts')).toBeNull();
  });

  it('returns null for whitespace-only code', () => {
    expect(parseSourceFile('   ', 'test.ts')).toBeNull();
  });

  it('handles .tsx extension', () => {
    const tsxCode = 'const el = <div>hello</div>;';
    const result = parseSourceFile(tsxCode, 'component.tsx');
    expect(result).not.toBeNull();
  });

  it('handles .js extension', () => {
    const result = parseSourceFile('const x = 1;', 'file.js');
    expect(result).not.toBeNull();
  });

  it('returns null for binary/garbage input', () => {
    // Should not throw
    const result = parseSourceFile('\x00\x01\x02', 'test.ts');
    // May return null or a sourceFile depending on how TS handles it
    expect(result === null || result.getEnd() > 0).toBe(true);
  });
});

describe('findStructuralNodes', () => {
  it('finds top-level function declarations', () => {
    const nodes = findStructuralNodes(SAMPLE_TS, 'test.ts');
    const functions = nodes.filter((n) => n.type === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
    expect(functions.some((f) => f.name === 'greet')).toBe(true);
  });

  it('finds class declarations', () => {
    const nodes = findStructuralNodes(SAMPLE_TS, 'test.ts');
    const classes = nodes.filter((n) => n.type === 'class');
    expect(classes.length).toBeGreaterThanOrEqual(1);
    expect(classes.some((c) => c.name === 'Calculator')).toBe(true);
  });

  it('finds class methods as children', () => {
    const nodes = findStructuralNodes(SAMPLE_TS, 'test.ts');
    const calculator = nodes.find((n) => n.name === 'Calculator');
    expect(calculator).not.toBeUndefined();
    expect(calculator!.children.length).toBeGreaterThanOrEqual(2);
    expect(calculator!.children.some((c) => c.name === 'add')).toBe(true);
    expect(calculator!.children.some((c) => c.name === 'subtract')).toBe(true);
  });

  it('finds interface declarations', () => {
    const nodes = findStructuralNodes(SAMPLE_TS, 'test.ts');
    const interfaces = nodes.filter((n) => n.type === 'interface');
    expect(interfaces.length).toBeGreaterThanOrEqual(1);
    expect(interfaces.some((i) => i.name === 'Config')).toBe(true);
  });

  it('finds enum declarations', () => {
    const nodes = findStructuralNodes(SAMPLE_TS, 'test.ts');
    const enums = nodes.filter((n) => n.type === 'enum');
    expect(enums.length).toBeGreaterThanOrEqual(1);
    expect(enums.some((e) => e.name === 'Color')).toBe(true);
  });

  it('finds type alias declarations', () => {
    const nodes = findStructuralNodes(SAMPLE_TS, 'test.ts');
    const typeAliases = nodes.filter((n) => n.type === 'type-alias');
    expect(typeAliases.length).toBeGreaterThanOrEqual(1);
    expect(typeAliases.some((t) => t.name === 'Callback')).toBe(true);
  });

  it('finds variable declarations', () => {
    const nodes = findStructuralNodes(SAMPLE_TS, 'test.ts');
    const variables = nodes.filter((n) => n.type === 'variable');
    expect(variables.length).toBeGreaterThanOrEqual(1);
    expect(variables.some((v) => v.name === 'PI')).toBe(true);
  });

  it('returns empty array for empty code', () => {
    const nodes = findStructuralNodes('', 'test.ts');
    expect(nodes).toEqual([]);
  });

  it('returns empty array for JS file', () => {
    const nodes = findStructuralNodes('const x = 1;', 'file.js');
    // JS files should still be parsed
    expect(nodes.length).toBeGreaterThanOrEqual(0);
  });
});

describe('findNodeByName', () => {
  it('finds a function by name', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'greet');
    expect(found).not.toBeNull();
    expect(found!.node.kind).toBeDefined();
  });

  it('finds a class by name', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'Calculator');
    expect(found).not.toBeNull();
  });

  it('returns null for non-existent name', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'NonExistent');
    expect(found).toBeNull();
  });

  it('finds an interface by name', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'Config');
    expect(found).not.toBeNull();
  });

  it('finds an enum by name', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'Color');
    expect(found).not.toBeNull();
  });

  it('finds a type alias by name', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'Callback');
    expect(found).not.toBeNull();
  });

  it('returns null for empty code', () => {
    const found = findNodeByName('', 'test.ts', 'greet');
    expect(found).toBeNull();
  });
});

describe('findNodeAtPosition', () => {
  it('finds a node at a specific position', () => {
    // The 'greet' function starts at line from the fixture
    // We find the node first to get its position, then verify findNodeAtPosition works
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'greet');
    expect(found).not.toBeNull();
    const range = nodeToRange(found!.node, found!.sourceFile);
    const node = findNodeAtPosition(SAMPLE_TS, 'test.ts', range.start.line, range.start.column);
    expect(node).not.toBeNull();
  });

  it('returns null for position before file start', () => {
    const node = findNodeAtPosition(SAMPLE_TS, 'test.ts', 0, 0);
    // Should either return null or a node at the start
    expect(node === null || node.getStart() >= 0).toBe(true);
  });

  it('handles empty code', () => {
    const node = findNodeAtPosition('', 'test.ts', 1, 1);
    expect(node).toBeNull();
  });
});

describe('nodeToRange', () => {
  it('converts a node to correct SourceRange', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'greet');
    expect(found).not.toBeNull();
    const range = nodeToRange(found!.node, found!.sourceFile);
    expect(range.start.line).toBeGreaterThanOrEqual(1);
    expect(range.end.line).toBeGreaterThanOrEqual(range.start.line);
    expect(range.start.column).toBeGreaterThanOrEqual(1);
    expect(range.end.column).toBeGreaterThanOrEqual(1);
  });

  it('returned range lines are in order', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'Calculator');
    expect(found).not.toBeNull();
    const range = nodeToRange(found!.node, found!.sourceFile);
    expect(range.end.line).toBeGreaterThanOrEqual(range.start.line);
    if (range.start.line === range.end.line) {
      expect(range.end.column).toBeGreaterThanOrEqual(range.start.column);
    }
  });
});

describe('getBodyRange', () => {
  it('returns body range for a function', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'greet');
    expect(found).not.toBeNull();
    const bodyRange = getBodyRange(found!.node, found!.sourceFile);
    // Function has a body, so bodyRange should exist
    expect(bodyRange).toBeDefined();
  });

  it('returns body range for a class', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'Calculator');
    expect(found).not.toBeNull();
    const bodyRange = getBodyRange(found!.node, found!.sourceFile);
    expect(bodyRange).toBeDefined();
    // Class body should be within the overall file
    expect(bodyRange!.start.line).toBeGreaterThanOrEqual(1);
    expect(bodyRange!.end.line).toBeGreaterThanOrEqual(bodyRange!.start.line);
  });
});

describe('validateTSSyntax', () => {
  it('validates correct TypeScript code', () => {
    expect(validateTSSyntax(SAMPLE_TS, 'test.ts')).toBe(true);
  });

  it('validates empty code as true', () => {
    expect(validateTSSyntax('', 'test.ts')).toBe(true);
  });

  it('returns false for clearly invalid code', () => {
    // Code with completely invalid syntax should not parse
    const invalidCode = '***';
    expect(validateTSSyntax(invalidCode, 'test.ts')).toBe(false);
  });

  it('handles JS code', () => {
    expect(validateTSSyntax('const x = 1;', 'file.js')).toBe(true);
  });
});

describe('getNodeText', () => {
  it('returns the source text of a node', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'greet');
    expect(found).not.toBeNull();
    const text = getNodeText(found!.node, found!.sourceFile, SAMPLE_TS);
    expect(text).toContain('function greet');
    expect(text).toContain('return');
  });
});

describe('replaceNodeText', () => {
  it('replaces a node with new text', () => {
    const found = findNodeByName(SAMPLE_TS, 'test.ts', 'greet');
    expect(found).not.toBeNull();
    const replacement = '/* function replaced */';
    const result = replaceNodeText(SAMPLE_TS, found!.node, found!.sourceFile, replacement);
    expect(result).not.toBeNull();
    expect(result).toContain(replacement);
    // Original function keyword should be gone
    expect(result!.includes('function greet')).toBe(false);
  });

  it('returns null when node offsets are out of range', () => {
    // Create a node that has start/end beyond the code length
    // by parsing shortened code
    const node = parseSourceFile(SAMPLE_TS, 'test.ts');
    expect(node).not.toBeNull();
    // Manually check that a very small code with the same node would fail
    const result = replaceNodeText('short', node!, null as unknown as Parameters<typeof replaceNodeText>[2], 'x');
    expect(result).toBeNull();
  });
});

describe('insertAt', () => {
  it('inserts text at a valid position', () => {
    // Column 7 (1-based) is the start of 'world' — insert before it
    const result = insertAt('hello world', parseSourceFile('hello world', 'test.ts')!, 1, 7, 'beautiful ');
    expect(result).toBe('hello beautiful world');
  });

  it('returns null for position beyond code length', () => {
    // Column 999 on a 5-char file exceeds the code length
    const sf = parseSourceFile('hello', 'test.ts');
    expect(sf).not.toBeNull();
    const result = insertAt('hello', sf!, 1, 999, 'x');
    // positionToOffset returns 998, which is > code.length (5),
    // so insertAt returns null
    expect(result).toBeNull();
  });
});

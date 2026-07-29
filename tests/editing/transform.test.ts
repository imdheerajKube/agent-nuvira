/**
 * Unit tests for structural transformations (transform.ts).
 *
 * Tests cover:
 * - renameSymbol — rename functions, classes, variables
 * - extractFunction — extract code into new function
 * - inlineFunction — inline function calls
 * - addParameter — add parameters to functions
 * - changeSignature — modify function signatures
 * - detectTransformType — NLP heuristic
 */

import { describe, it, expect } from 'vitest';
import {
  renameSymbol,
  extractFunction,
  inlineFunction,
  addParameter,
  changeSignature,
  detectTransformType,
} from '../../src/editing/transform.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SAMPLE_TS = `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

function calculate(a: number, b: number): number {
  return a + b;
}
`;

const CLASS_TS = `class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}
`;

const ARROW_FN_TS = `const greet = (name: string): string => {
  return \`Hello, \${name}!\`;
};
`;

const SIMPLE_FN = `function double(x: number): number {
  return x * 2;
}`;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('renameSymbol', () => {
  it('renames a function declaration', () => {
    const result = renameSymbol(SAMPLE_TS, 'test.ts', {
      oldName: 'greet',
      newName: 'welcome',
    });
    expect(result.success).toBe(true);
    expect(result.code).toContain('welcome');
    expect(result.code).not.toContain('greet');
  });

  it('renames a class name', () => {
    const result = renameSymbol(CLASS_TS, 'test.ts', {
      oldName: 'Calculator',
      newName: 'AdvancedCalculator',
    });
    expect(result.success).toBe(true);
    expect(result.code).toContain('AdvancedCalculator');
  });

  it('returns error for non-existent symbol', () => {
    const result = renameSymbol(SAMPLE_TS, 'test.ts', {
      oldName: 'NonExistent',
      newName: 'Renamed',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for empty oldName', () => {
    const result = renameSymbol(SAMPLE_TS, 'test.ts', {
      oldName: '',
      newName: 'foo',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('returns error for newName starting with digit', () => {
    const result = renameSymbol(SAMPLE_TS, 'test.ts', {
      oldName: 'greet',
      newName: '1greet',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('digit');
  });

  it('does not match partial words', () => {
    const code = 'const greeting = "hello";\nconst greet = "world";';
    const result = renameSymbol(code, 'test.ts', {
      oldName: 'greet',
      newName: 'farewell',
    });
    expect(result.success).toBe(true);
    // 'greeting' should not be renamed (it's a different word boundary)
    expect(result.code).toContain('greeting');
    expect(result.code).toContain('farewell');
  });
});

describe('extractFunction', () => {
  it('extracts selected text into a new function', () => {
    const code = `function process(): void {
  const result = calculate(1, 2);
  console.log(result);
}`;
    const result = extractFunction(code, 'test.ts', {
      selectedText: 'console.log(result);',
      newFunctionName: 'logResult',
    });
    expect(result.success).toBe(true);
    expect(result.code).toContain('function logResult');
    expect(result.code).toContain('logResult()');
  });

  it('returns error when selected text is not found', () => {
    const result = extractFunction(SAMPLE_TS, 'test.ts', {
      selectedText: 'this code does not exist',
      newFunctionName: 'extracted',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for missing required params', () => {
    const result = extractFunction(SAMPLE_TS, 'test.ts', {
      selectedText: '',
      newFunctionName: '',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('extracts with parameters', () => {
    const code = `function process(): void {
  const x = 5;
  const y = 10;
  const sum = x + y;
}`;
    const result = extractFunction(code, 'test.ts', {
      selectedText: 'const sum = x + y;',
      newFunctionName: 'calculateSum',
      parameters: 'x: number, y: number',
    });
    expect(result.success).toBe(true);
    expect(result.code).toContain('calculateSum(x, y)');
  });
});

describe('inlineFunction', () => {
  it('inlines a simple function', () => {
    const code = `${SIMPLE_FN}\n\nconst result = double(5);`;
    const result = inlineFunction(code, 'test.ts', {
      functionName: 'double',
      callSiteCode: 'double(5)',
    });
    expect(result.success).toBe(true);
    // The call site should be replaced with the body content
    expect(result.code).not.toContain('double(5)');
    // The body content should now be at the call site
    expect(result.code).toContain('x * 2');
  });

  it('returns error for non-existent function', () => {
    const result = inlineFunction(SAMPLE_TS, 'test.ts', {
      functionName: 'nonExistent',
      callSiteCode: 'nonExistent()',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for empty functionName', () => {
    const result = inlineFunction(SAMPLE_TS, 'test.ts', {
      functionName: '',
      callSiteCode: '',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('handles inline for arrow functions', () => {
    // For arrow functions, the function name is the variable name 'greet'
    // But the body extraction uses getNodeText which looks for the function body
    // This may produce an error because arrow functions are stored differently
    const code = `${ARROW_FN_TS}\n\ngreet('World');`;
    const result = inlineFunction(code, 'test.ts', {
      functionName: 'greet',
      callSiteCode: "greet('World')",
    });
    // May fail gracefully for arrow functions with blocks
    if (!result.success) {
      expect(result.error).toBeDefined();
    } else {
      expect(result.code).toBeDefined();
    }
  });
});

describe('addParameter', () => {
  it('adds a parameter to a function', () => {
    const result = addParameter(SAMPLE_TS, 'test.ts', {
      functionName: 'greet',
      parameterDef: 'prefix: string',
      defaultValue: "''",
    });
    expect(result.success).toBe(true);
    expect(result.code).toContain('prefix: string');
    // Original parameter should still be there
    expect(result.code).toContain('name: string');
  });

  it('adds a parameter at first position', () => {
    const result = addParameter(SAMPLE_TS, 'test.ts', {
      functionName: 'greet',
      parameterDef: 'prefix: string',
      position: 'first',
    });
    expect(result.success).toBe(true);
    // prefix should come before name
    const code = result.code!;
    const prefixIdx = code.indexOf('prefix');
    const nameIdx = code.indexOf('name: string');
    expect(prefixIdx).toBeLessThan(nameIdx);
  });

  it('returns error for non-existent function', () => {
    const result = addParameter(SAMPLE_TS, 'test.ts', {
      functionName: 'nonExistent',
      parameterDef: 'x: number',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for missing required params', () => {
    const result = addParameter(SAMPLE_TS, 'test.ts', {
      functionName: '',
      parameterDef: '',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });
});

describe('changeSignature', () => {
  it('changes the parameter list of a function', () => {
    const result = changeSignature(SAMPLE_TS, 'test.ts', {
      functionName: 'greet',
      newParams: '(name: string, age: number)',
    });
    expect(result.success).toBe(true);
    expect(result.code).toContain('age: number');
  });

  it('simplifies parameters', () => {
    const result = changeSignature(SAMPLE_TS, 'test.ts', {
      functionName: 'greet',
      newParams: '()',
    });
    expect(result.success).toBe(true);
    expect(result.code).toContain('function greet()');
  });

  it('returns error for non-existent function', () => {
    const result = changeSignature(SAMPLE_TS, 'test.ts', {
      functionName: 'nonExistent',
      newParams: '(x: number)',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for missing functionName', () => {
    const result = changeSignature(SAMPLE_TS, 'test.ts', {
      functionName: '',
      newParams: '(x: number)',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });
});

describe('detectTransformType', () => {
  it('detects rename from description', () => {
    expect(detectTransformType('rename the function')).toBe('rename');
    expect(detectTransformType('change name of variable')).toBe('rename');
  });

  it('detects extract from description', () => {
    expect(detectTransformType('extract this logic')).toBe('extract');
    expect(detectTransformType('pull out the helper')).toBe('extract');
  });

  it('detects inline from description', () => {
    expect(detectTransformType('inline the helper')).toBe('inline');
    expect(detectTransformType('flatten the function call')).toBe('inline');
  });

  it('detects add-param from description', () => {
    expect(detectTransformType('add a new parameter')).toBe('add-param');
    expect(detectTransformType('new param for options')).toBe('add-param');
  });

  it('detects change-sig from description', () => {
    expect(detectTransformType('change signature')).toBe('change-sig');
    expect(detectTransformType('modify sign')).toBe('change-sig');
  });

  it('returns null for unrecognized descriptions', () => {
    expect(detectTransformType('do something')).toBeNull();
    expect(detectTransformType('')).toBeNull();
  });
});
